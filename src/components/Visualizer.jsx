import React, { useMemo, useRef } from 'react'
import { Layers, Database, Grid3x3, Terminal, Link2, BarChart2, List, AlignJustify } from 'lucide-react'
import { useApp } from '../context/AppContext'

/* ================================================================
   HELPERS
   ================================================================ */

const SKIP_KEYS = new Set([
  '__return__', 'changed_vars', 'class_name', 'code', 'decorator_chain',
  'event', 'exception_info', 'function_name', 'generator_state', 'globals_used',
  'heap_state', 'is_generator', 'line', 'stack_locals', 'stdout', 'step_id',
])

function fmt(val) {
  if (!val) return '—'
  if (val.heap_ref != null) return val.preview || val.display || `→ Heap[${val.heap_ref}]`
  return String(val.display ?? val.value ?? JSON.stringify(val))
}

/* ================================================================
   STRUCTURE DETECTION
   Analyses variables + heap to decide how to render each structure.
   ================================================================ */

/**
 * Returns the integer value of a variable if it's a numeric int/float,
 * otherwise null.
 */
function numVal(v) {
  if (!v) return null
  const n = Number(v.value ?? v.display)
  return Number.isFinite(n) ? n : null
}

/**
 * Detect if variables reference rows or columns of a matrix.
 * Returns { rowRefs: [{varName, rowIndex, heapId}], colRefs: [...] }
 */
function detectMatrixRowColRefs(locals, heapState, matrixHeapId, rows, cols) {
  const rowRefs = []
  const colRefs = []
  
  // Get matrix's row heap IDs
  const matrixObj = heapState[String(matrixHeapId)]
  if (!matrixObj?.elements) return { rowRefs, colRefs }
  
  const matrixRowHeapIds = new Set(
    matrixObj.elements
      .filter(el => el.type === 'ref')
      .map(el => String(el.heap_id))
  )
  
  // Check each local variable
  for (const [varName, val] of Object.entries(locals)) {
    if (varName.startsWith('__')) continue
    if (!val || val.type !== 'list' || val.heap_ref == null) continue
    
    const varHeapId = String(val.heap_ref)
    const varHeapObj = heapState[varHeapId]
    if (!varHeapObj?.elements) continue
    
    // Check if this variable references a matrix row
    if (matrixRowHeapIds.has(varHeapId)) {
      // Find which row index this corresponds to
      for (let i = 0; i < matrixObj.elements.length; i++) {
        const rowEl = matrixObj.elements[i]
        if (rowEl.type === 'ref' && String(rowEl.heap_id) === varHeapId) {
          rowRefs.push({ varName, rowIndex: i, heapId: varHeapId })
          break
        }
      }
    }
  }
  
  return { rowRefs, colRefs }
}

/**
 * Detect recursion in call tree and check if there's meaningful recursion.
 * Returns { isRecursive, recursiveFunctions: Set }
 */
function detectRecursion(callTree) {
  if (!callTree || callTree.length === 0) {
    return { isRecursive: false, recursiveFunctions: new Set() }
  }
  
  const functionCallCounts = {}
  const recursiveFunctions = new Set()
  
  // Count calls to each function
  for (const node of callTree) {
    const funcName = node.function_name
    functionCallCounts[funcName] = (functionCallCounts[funcName] || 0) + 1
    
    // A function is recursive if called more than once
    if (functionCallCounts[funcName] > 1) {
      recursiveFunctions.add(funcName)
    }
  }
  
  return {
    isRecursive: recursiveFunctions.size > 0,
    recursiveFunctions
  }
}

/**
 * Build a tree structure for visualization at a given step.
 * Only includes calls that have been made up to currentStep.
 */
function buildRecursionTreeAtStep(callTree, currentStep) {
  if (!callTree || callTree.length === 0) return []
  
  // Filter to calls that have been made by currentStep
  const activeCalls = callTree.filter(node => node.step_id <= currentStep)
  
  // Build tree structure with children
  const nodeMap = {}
  const roots = []
  
  for (const node of activeCalls) {
    const treeNode = {
      ...node,
      children: [],
      isActive: node.step_id <= currentStep && 
                (node.return_step_id === null || node.return_step_id > currentStep),
      hasReturned: node.return_step_id !== null && node.return_step_id <= currentStep
    }
    nodeMap[node.call_id] = treeNode
  }
  
  // Link children to parents
  for (const node of Object.values(nodeMap)) {
    if (node.parent_id === null) {
      roots.push(node)
    } else if (nodeMap[node.parent_id]) {
      nodeMap[node.parent_id].children.push(node)
    }
  }
  
  return roots
}

/**
 * Format function arguments for display
 */
function formatFunctionArgs(args) {
  if (!args || Object.keys(args).length === 0) return ''
  
  const argStrs = Object.entries(args)
    .filter(([key]) => key !== '__return__')
    .map(([key, val]) => {
      const value = val?.value ?? val?.display ?? String(val)
      return `${key}=${value}`
    })
  
  return argStrs.join(', ')
}

/**
 * Find variables that look like array pointers (mid, left, right, i, j, lo, hi…)
 * and return { name, index, colorIdx }.
 */
const PTR_NAMES = ['mid', 'left', 'right', 'lo', 'hi', 'i', 'j', 'k', 'low', 'high', 'start', 'end', 'ptr', 'cur', 'head', 'tail']

function detectPointers(locals, arrayLen) {
  const ptrs = []
  let colorIdx = 0
  for (const name of PTR_NAMES) {
    const v = locals[name]
    if (!v) continue
    const idx = numVal(v)
    if (idx == null) continue
    if (idx >= 0 && idx < arrayLen) {
      ptrs.push({ name, index: idx, colorIdx: colorIdx % 4 })
      colorIdx++
    }
  }
  return ptrs
}

/**
 * Detect if a list looks like a stack (variable named stack/s/st and only
 * append/pop operations implied) or queue (deque / queue variable name).
 */
function detectListRole(varName, heapObj) {
  const n = varName.toLowerCase()
  if (n === 'stack' || n === 'st' || n === 's') return 'stack'
  if (n === 'queue' || n === 'q' || n === 'deque' || n === 'dq') return 'queue'
  return 'array'
}

/**
 * Detect graph: a dict whose values are lists of nodes.
 * Returns { adj: adjacency map, excludeIds: Set of heap IDs to exclude from heap section } or null.
 */
function detectGraph(heapState, locals) {
  // Look for a dict variable — adjacency list
  for (const [, val] of Object.entries(locals)) {
    if (val?.type !== 'dict' || val.heap_ref == null) continue
    const heapObj = heapState[String(val.heap_ref)]
    if (!heapObj?.entries) continue
    // Check if all values are lists
    const allListVals = heapObj.entries.every(e => {
      if (e.value?.type === 'ref') {
        const inner = heapState[String(e.value.heap_id)]
        return inner?.type === 'list' || inner?.type === 'tuple'
      }
      return false
    })
    if (allListVals && heapObj.entries.length >= 2) {
      // Build adjacency map and collect all related heap IDs
      const adj = {}
      const excludeIds = new Set([String(val.heap_ref)]) // Exclude the dict itself
      
      for (const e of heapObj.entries) {
        const key = e.key?.replace(/['"]/g, '')
        const listHeapId = String(e.value?.heap_id)
        excludeIds.add(listHeapId) // Exclude the adjacency lists
        
        const inner = heapState[listHeapId]
        adj[key] = (inner?.elements || [])
          .filter(el => el.type === 'value')
          .map(el => String(el.value ?? '').replace(/['"]/g, ''))
      }
      return { adj, excludeIds }
    }
  }
  return null
}

/**
 * Detect binary tree: heap contains objects where at least some have
 * attributes named 'left' and/or 'right' that are refs (or null values).
 * Returns the root heap-id string, or null if not a binary tree.
 */
function detectBinaryTree(heapState) {
  const objs = Object.entries(heapState).filter(([, o]) => o.type === 'object')
  if (objs.length < 2) return null

  // An object qualifies as a tree node if it has a 'left' OR 'right' attribute
  const treeNodes = objs.filter(([, o]) => {
    const attrs = o.attributes || []
    return attrs.some(a => a.name === 'left') || attrs.some(a => a.name === 'right')
  })
  if (treeNodes.length < 2) return null

  // Find root: the node not referenced as left/right by any other node
  const referenced = new Set()
  for (const [, obj] of treeNodes) {
    for (const a of (obj.attributes || [])) {
      if ((a.name === 'left' || a.name === 'right') && a.type === 'ref') {
        referenced.add(String(a.heap_id))
      }
    }
  }
  const roots = treeNodes.filter(([id]) => !referenced.has(String(id)))
  return roots.length ? roots[0][0] : treeNodes[0][0]
}

/**
 * Detect linked list: heap contains multiple objects each with exactly one
 * ref attribute (the "next" pointer).
 */
function isLinkedListHeap(heapState) {
  const objs = Object.values(heapState || {}).filter(o => o.type === 'object')
  if (objs.length < 2) return false
  return objs.filter(o =>
    (o.attributes || []).filter(a => a.type === 'ref').length === 1
  ).length >= 2
}

/* ================================================================
   SECTION WRAPPER
   ================================================================ */
function Section({ icon: Icon, title, children }) {
  return (
    <div className="viz-section">
      <div className="viz-section-header">
        {Icon && <Icon size={13} />}
        {title}
      </div>
      <div className="viz-section-body">{children}</div>
    </div>
  )
}

/* ================================================================
   CURRENT LINE BANNER
   ================================================================ */
function CurrentLineBanner({ step }) {
  const badge = step.event || 'line'
  return (
    <div className="viz-current-line">
      <span className={`event-badge ${badge}`}>{badge}</span>
      <code style={{ flex: 1, wordBreak: 'break-all' }}>{step.code || ''}</code>
    </div>
  )
}

/* ================================================================
   CALL STACK
   ================================================================ */
function CallStack({ step }) {
  if (step.exception_info) {
    const exc = step.exception_info
    return (
      <div className="exception-banner">
        <div className="exception-type">{exc.type || 'Error'}: {exc.message || ''}</div>
        {exc.hint && <div className="exception-hint">💡 {exc.hint}</div>}
      </div>
    )
  }
  const fname = step.function_name
  const isModule = !fname || fname === '<module>'
  const classPrefix = step.class_name ? `${step.class_name}.` : ''
  const lineNum = (step.line ?? 0) + 1
  return (
    <div className="callstack-viz">
      {!isModule && <div className="cs-frame"><div className="cs-frame-name">&lt;module&gt;</div></div>}
      <div className={`cs-frame active`}>
        <div className="cs-frame-tag">Current</div>
        <div className="cs-frame-name">{isModule ? '<module>' : `${classPrefix}${fname}()`}</div>
        <div className="cs-frame-line">Line {lineNum}</div>
      </div>
    </div>
  )
}

/* ================================================================
   VARIABLES TABLE
   ================================================================ */
function Variables({ step, prevStep, onHeapClick }) {
  const locals  = step.stack_locals || {}
  const changed = new Set(step.changed_vars || [])
  const prev    = prevStep?.stack_locals || {}

  if (step.event === 'return') {
    const ret = locals['__return__']
    if (ret) return (
      <div className="return-banner">
        <span className="label">return</span>
        &nbsp;{fmt(ret)}
      </div>
    )
  }

  const filtered = Object.entries(locals).filter(([name, val]) => {
    if (SKIP_KEYS.has(name) || name.startsWith('__')) return false
    if (val?.type === 'function') return false
    return true
  })

  if (!filtered.length)
    return <div className="viz-empty"><p>No variables in this scope</p></div>

  return (
    <table className="vz-var-table">
      <tbody>
        {filtered.map(([name, val]) => {
          const isNew     = !prev[name]
          const isChanged = changed.has(name)
          const rowClass  = isNew ? 'v-new' : isChanged ? 'v-changed' : ''
          const isRef     = val?.heap_ref != null
          return (
            <tr key={name} className={rowClass}>
              <td className="vz-var-name">{name}</td>
              <td className="vz-var-type">{val?.type || ''}</td>
              <td className="vz-var-value">
                {isRef
                  ? <span className="vz-heap-link" onClick={() => onHeapClick(val.heap_ref)}>{fmt(val)}</span>
                  : fmt(val)
                }
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/* ================================================================
   ARRAY VIZ  (with animated pointer arrows + swap detection)
   ================================================================ */
function ArrayViz({ heapObj, varName, locals, prevHeapObj, onHeapClick }) {
  const els     = heapObj.elements || []
  const prevEls = prevHeapObj?.elements || []

  // Detect swapped indices: two cells that exchanged values
  const swappedIndices = useMemo(() => {
    const s = new Set()
    if (prevEls.length === els.length) {
      for (let i = 0; i < els.length; i++) {
        const cur  = String(els[i]?.value ?? '')
        const prev = String(prevEls[i]?.value ?? '')
        if (cur !== prev) s.add(i)
      }
      // Only mark as "swap" when exactly 2 cells changed and values crossed
      if (s.size === 2) {
        const [a, b] = [...s]
        if (
          String(els[a]?.value) === String(prevEls[b]?.value) &&
          String(els[b]?.value) === String(prevEls[a]?.value)
        ) return s
      }
    }
    return new Set()
  }, [els, prevEls])

  // Changed indices (not swaps)
  const changedIndices = useMemo(() => {
    const s = new Set()
    if (prevEls.length === els.length) {
      for (let i = 0; i < els.length; i++) {
        if (String(els[i]?.value ?? '') !== String(prevEls[i]?.value ?? '') && !swappedIndices.has(i))
          s.add(i)
      }
    }
    return s
  }, [els, prevEls, swappedIndices])

  // Integer pointer variables pointing into this array
  const ptrs = useMemo(() => detectPointers(locals || {}, els.length), [locals, els.length])
  const ptrMap = useMemo(() => {
    const m = {}
    for (const p of ptrs) {
      if (!m[p.index]) m[p.index] = []
      m[p.index].push(p)
    }
    return m
  }, [ptrs])

  if (!els.length)
    return <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>empty {heapObj.type}</div>

  return (
    <div className="array-section-wrap">
      <div className="array-viz">
        {els.map((el, i) => {
          const isRef   = el.type === 'ref'
          const isTrunc = el.type === 'truncated'
          const val     = isTrunc ? '…' : isRef ? `→${el.heap_id}` : String(el.value ?? '')
          const cellPtrs = ptrMap[i] || []

          // Determine highlight class
          let highlight = ''
          if (swappedIndices.has(i))   highlight = 'swapped'
          else if (changedIndices.has(i)) highlight = 'changed'
          else if (cellPtrs.length > 0) {
            const minColor = Math.min(...cellPtrs.map(p => p.colorIdx))
            highlight = ['ptr-primary', 'ptr-secondary', 'ptr-tertiary', 'ptr-tertiary'][minColor]
          } else if (isRef) highlight = 'ref'

          return (
            <div className="array-cell" key={`${i}-${val}`}>
              {/* Pointer labels above cell */}
              {cellPtrs.map(p => (
                <div key={p.name} className={`ptr-label c${p.colorIdx}`}>
                  <span className="ptr-label-name">{p.name}</span>
                  <span className="ptr-label-arrow">↓</span>
                </div>
              ))}
              <div
                className={`array-cell-box ${highlight}`}
                onClick={isRef ? () => onHeapClick(el.heap_id) : undefined}
                style={isRef ? { cursor: 'pointer' } : {}}
              >
                {val}
              </div>
              <div className="array-cell-index">{el.index != null ? el.index : i}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ================================================================
   MATRIX 2D VIZ  (grid layout with row/column indices)
   ================================================================ */
function Matrix2DViz({ heapObj, varName, locals, prevHeapObj, onHeapClick, heapState, matrixHeapId }) {
  const dimensions = heapObj.dimensions || []
  const [rows, cols] = dimensions
  
  if (!rows || !cols) {
    return <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>invalid matrix dimensions</div>
  }

  // Detect row/column variable references
  const { rowRefs, colRefs } = useMemo(() => 
    detectMatrixRowColRefs(locals, heapState, matrixHeapId, rows, cols),
    [locals, heapState, matrixHeapId, rows, cols]
  )

  // Build 2D grid from heap structure
  const matrix = useMemo(() => {
    const grid = []
    const outerElements = heapObj.elements || []
    
    for (let i = 0; i < Math.min(rows, outerElements.length); i++) {
      const rowElement = outerElements[i]
      if (rowElement?.type === 'ref') {
        const rowHeapObj = heapState[String(rowElement.heap_id)]
        if (rowHeapObj?.elements) {
          grid.push(rowHeapObj.elements.slice(0, cols))
        } else {
          grid.push([])
        }
      } else {
        grid.push([])
      }
    }
    return grid
  }, [heapObj, heapState, rows, cols])

  // Build previous matrix for change detection
  const prevMatrix = useMemo(() => {
    if (!prevHeapObj?.elements) return []
    const grid = []
    const prevOuterElements = prevHeapObj.elements || []
    
    for (let i = 0; i < Math.min(rows, prevOuterElements.length); i++) {
      const rowElement = prevOuterElements[i]
      if (rowElement?.type === 'ref') {
        const rowHeapObj = heapState[String(rowElement.heap_id)]
        if (rowHeapObj?.elements) {
          grid.push(rowHeapObj.elements.slice(0, cols))
        } else {
          grid.push([])
        }
      } else {
        grid.push([])
      }
    }
    return grid
  }, [prevHeapObj, heapState, rows, cols])

  // Detect 2D pointer patterns (i, j) or (row, col)
  const matrixPointers = useMemo(() => {
    const pointers = []
    
    // Check for i, j pattern (both indices present - highlights single cell)
    const i = locals?.i
    const j = locals?.j
    if (i && j) {
      const iVal = numVal(i)
      const jVal = numVal(j)
      if (iVal != null && jVal != null && iVal >= 0 && iVal < rows && jVal >= 0 && jVal < cols) {
        pointers.push({ row: iVal, col: jVal, name: '[i][j]', colorIdx: 0 })
      }
    } else if (i && !j) {
      // Only i present - check if it's being used as row index
      const iVal = numVal(i)
      if (iVal != null && iVal >= 0 && iVal < rows) {
        // Check if there's a 'value' variable that might be accessing matrix[i][something]
        const value = locals?.value
        if (value) {
          // We're likely iterating: for value in row
          pointers.push({ row: iVal, col: null, name: 'i', colorIdx: 0, isRowHighlight: true })
        } else {
          // Just highlight the row
          pointers.push({ row: iVal, col: null, name: 'i', colorIdx: 0, isRowHighlight: true })
        }
      }
    }
    
    // Check for row, col pattern (both present - highlights single cell)
    const row = locals?.row
    const col = locals?.col
    if (row && col) {
      const rowVal = numVal(row)
      const colVal = numVal(col)
      if (rowVal != null && colVal != null && rowVal >= 0 && rowVal < rows && colVal >= 0 && colVal < cols) {
        pointers.push({ row: rowVal, col: colVal, name: '[row][col]', colorIdx: 1 })
      }
    } else if (row && !col) {
      // Only row present - highlight entire row
      const rowVal = numVal(row)
      if (rowVal != null && rowVal >= 0 && rowVal < rows) {
        pointers.push({ row: rowVal, col: null, name: 'row', colorIdx: 1, isRowHighlight: true })
      }
    }
    
    // Check for r, c pattern
    const r = locals?.r
    const c = locals?.c
    if (r && c) {
      const rVal = numVal(r)
      const cVal = numVal(c)
      if (rVal != null && cVal != null && rVal >= 0 && rVal < rows && cVal >= 0 && cVal < cols) {
        pointers.push({ row: rVal, col: cVal, name: '[r][c]', colorIdx: 2 })
      }
    } else if (r && !c) {
      // Only r present - highlight entire row
      const rVal = numVal(r)
      if (rVal != null && rVal >= 0 && rVal < rows) {
        pointers.push({ row: rVal, col: null, name: 'r', colorIdx: 2, isRowHighlight: true })
      }
    }
    
    return pointers
  }, [locals, rows, cols])

  // Build pointer map for quick lookup
  const pointerMap = useMemo(() => {
    const map = {}
    for (const ptr of matrixPointers) {
      if (ptr.isRowHighlight) {
        // Mark entire row
        for (let c = 0; c < cols; c++) {
          const key = `${ptr.row},${c}`
          if (!map[key]) map[key] = []
          map[key].push(ptr)
        }
      } else if (ptr.col !== null) {
        const key = `${ptr.row},${ptr.col}`
        if (!map[key]) map[key] = []
        map[key].push(ptr)
      }
    }
    return map
  }, [matrixPointers, cols])

  // Build row highlight map
  const rowHighlightMap = useMemo(() => {
    const map = {}
    for (const ref of rowRefs) {
      map[ref.rowIndex] = ref
    }
    return map
  }, [rowRefs])

  // Detect changed cells
  const changedCells = useMemo(() => {
    const changed = new Set()
    for (let i = 0; i < Math.min(matrix.length, prevMatrix.length); i++) {
      for (let j = 0; j < Math.min(matrix[i]?.length || 0, prevMatrix[i]?.length || 0); j++) {
        const curVal = String(matrix[i]?.[j]?.value ?? '')
        const prevVal = String(prevMatrix[i]?.[j]?.value ?? '')
        if (curVal !== prevVal) {
          changed.add(`${i},${j}`)
        }
      }
    }
    return changed
  }, [matrix, prevMatrix])

  return (
    <div className="matrix-2d-wrap">
      {/* Show variable labels for row references */}
      {rowRefs.length > 0 && (
        <div className="matrix-var-labels">
          {rowRefs.map(ref => (
            <div key={ref.varName} className="matrix-var-label">
              <span className="matrix-var-name">{ref.varName}</span>
              <span className="matrix-var-arrow">→</span>
              <span className="matrix-var-target">row {ref.rowIndex}</span>
            </div>
          ))}
        </div>
      )}
      
      <div className="matrix-2d-container">
        {/* Column headers */}
        <div className="matrix-2d-grid" style={{ gridTemplateColumns: `40px repeat(${cols}, 50px)` }}>
          <div className="matrix-corner-cell"></div>
          {Array.from({ length: cols }, (_, j) => (
            <div key={`col-${j}`} className="matrix-header-cell">
              {j}
            </div>
          ))}
          
          {/* Rows with data */}
          {matrix.map((row, i) => (
            <React.Fragment key={`row-${i}`}>
              {/* Row header */}
              <div className={`matrix-header-cell ${rowHighlightMap[i] ? 'matrix-header-highlighted' : ''} ${matrixPointers.some(p => p.isRowHighlight && p.row === i) ? 'matrix-header-active' : ''}`}>
                {i}
                {rowHighlightMap[i] && (
                  <div className="matrix-row-badge">{rowHighlightMap[i].varName}</div>
                )}
                {matrixPointers.some(p => p.isRowHighlight && p.row === i) && !rowHighlightMap[i] && (
                  <div className="matrix-row-indicator">●</div>
                )}
              </div>
              
              {/* Row cells */}
              {Array.from({ length: cols }, (_, j) => {
                const cell = row[j]
                const cellKey = `${i},${j}`
                const cellPtrs = pointerMap[cellKey] || []
                const isRef = cell?.type === 'ref'
                const val = !cell ? '—' : isRef ? `→${cell.heap_id}` : String(cell.value ?? '')
                
                // Check if this row is highlighted by a variable reference or pointer
                const isRowHighlighted = rowHighlightMap[i] != null
                const isRowPointerActive = matrixPointers.some(p => p.isRowHighlight && p.row === i)
                
                let highlight = ''
                if (changedCells.has(cellKey)) {
                  highlight = 'changed'
                } else if (cellPtrs.length > 0 && !cellPtrs[0].isRowHighlight) {
                  // Specific cell pointer (takes priority)
                  const minColor = Math.min(...cellPtrs.map(p => p.colorIdx))
                  highlight = ['ptr-primary', 'ptr-secondary', 'ptr-tertiary'][minColor]
                } else if (isRowPointerActive) {
                  // Row is being accessed via index variable
                  const activePointer = matrixPointers.find(p => p.isRowHighlight && p.row === i)
                  const colorClass = ['row-highlight-primary', 'row-highlight-secondary', 'row-highlight-tertiary'][activePointer?.colorIdx || 0]
                  highlight = colorClass
                } else if (isRowHighlighted) {
                  // Row has a named variable reference
                  highlight = 'row-highlight'
                } else if (isRef) {
                  highlight = 'ref'
                }
                
                return (
                  <div
                    key={`cell-${i}-${j}`}
                    className={`matrix-cell ${highlight}`}
                    onClick={isRef ? () => onHeapClick(cell.heap_id) : undefined}
                    style={isRef ? { cursor: 'pointer' } : {}}
                  >
                    {cellPtrs.length > 0 && !cellPtrs[0].isRowHighlight && (
                      <div className="matrix-cell-pointer-badge">
                        {cellPtrs[0].name}
                      </div>
                    )}
                    <span className="matrix-cell-value">{val}</span>
                  </div>
                )
              })}
            </React.Fragment>
          ))}
        </div>
      </div>
      <div className="matrix-dimensions-label">{rows} × {cols} matrix</div>
    </div>
  )
}

/* ================================================================
   MATRIX 3D VIZ  (layered matrices with depth indicator)
   ================================================================ */
function Matrix3DViz({ heapObj, varName, locals, prevHeapObj, onHeapClick, heapState }) {
  const dimensions = heapObj.dimensions || []
  const [depth, rows, cols] = dimensions
  
  if (!depth || !rows || !cols) {
    return <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>invalid 3D matrix dimensions</div>
  }

  // Build 3D array from heap structure
  const matrix3d = useMemo(() => {
    const cube = []
    const outerElements = heapObj.elements || []
    
    for (let d = 0; d < Math.min(depth, outerElements.length); d++) {
      const depthElement = outerElements[d]
      const layer = []
      
      if (depthElement?.type === 'ref') {
        const depthHeapObj = heapState[String(depthElement.heap_id)]
        if (depthHeapObj?.elements) {
          for (let i = 0; i < Math.min(rows, depthHeapObj.elements.length); i++) {
            const rowElement = depthHeapObj.elements[i]
            if (rowElement?.type === 'ref') {
              const rowHeapObj = heapState[String(rowElement.heap_id)]
              if (rowHeapObj?.elements) {
                layer.push(rowHeapObj.elements.slice(0, cols))
              } else {
                layer.push([])
              }
            } else {
              layer.push([])
            }
          }
        }
      }
      cube.push(layer)
    }
    return cube
  }, [heapObj, heapState, depth, rows, cols])

  // Detect 3D pointer patterns (i, j, k) or (d, r, c)
  const matrixPointers = useMemo(() => {
    const pointers = []
    
    // Check for i, j, k pattern
    const i = locals?.i
    const j = locals?.j
    const k = locals?.k
    if (i && j && k) {
      const iVal = numVal(i)
      const jVal = numVal(j)
      const kVal = numVal(k)
      if (iVal != null && jVal != null && kVal != null && 
          iVal >= 0 && iVal < depth && jVal >= 0 && jVal < rows && kVal >= 0 && kVal < cols) {
        pointers.push({ depth: iVal, row: jVal, col: kVal, name: '[i][j][k]', colorIdx: 0 })
      }
    }
    
    return pointers
  }, [locals, depth, rows, cols])

  // Build pointer map for quick lookup
  const pointerMap = useMemo(() => {
    const map = {}
    for (const ptr of matrixPointers) {
      const key = `${ptr.depth},${ptr.row},${ptr.col}`
      if (!map[key]) map[key] = []
      map[key].push(ptr)
    }
    return map
  }, [matrixPointers])

  return (
    <div className="matrix-3d-wrap">
      {matrix3d.map((layer, d) => (
        <div key={`layer-${d}`} className="matrix-3d-layer">
          <div className="matrix-3d-layer-label">Layer {d}</div>
          <div className="matrix-2d-container">
            <div className="matrix-2d-grid" style={{ gridTemplateColumns: `40px repeat(${cols}, 50px)` }}>
              <div className="matrix-corner-cell"></div>
              {Array.from({ length: cols }, (_, j) => (
                <div key={`col-${j}`} className="matrix-header-cell">
                  {j}
                </div>
              ))}
              
              {layer.map((row, i) => (
                <React.Fragment key={`row-${i}`}>
                  <div className="matrix-header-cell">{i}</div>
                  
                  {Array.from({ length: cols }, (_, j) => {
                    const cell = row[j]
                    const cellKey = `${d},${i},${j}`
                    const cellPtrs = pointerMap[cellKey] || []
                    const isRef = cell?.type === 'ref'
                    const val = !cell ? '—' : isRef ? `→${cell.heap_id}` : String(cell.value ?? '')
                    
                    let highlight = ''
                    if (cellPtrs.length > 0) {
                      const minColor = Math.min(...cellPtrs.map(p => p.colorIdx))
                      highlight = ['ptr-primary', 'ptr-secondary', 'ptr-tertiary'][minColor]
                    } else if (isRef) highlight = 'ref'
                    
                    return (
                      <div
                        key={`cell-${i}-${j}`}
                        className={`matrix-cell ${highlight}`}
                        onClick={isRef ? () => onHeapClick(cell.heap_id) : undefined}
                        style={isRef ? { cursor: 'pointer' } : {}}
                      >
                        {cellPtrs.length > 0 && (
                          <div className="matrix-cell-pointer-badge">
                            {cellPtrs[0].name}
                          </div>
                        )}
                        <span className="matrix-cell-value">{val}</span>
                      </div>
                    )
                  })}
                </React.Fragment>
              ))}
            </div>
          </div>
        </div>
      ))}
      <div className="matrix-dimensions-label">{depth} × {rows} × {cols} matrix (3D)</div>
    </div>
  )
}

/* ================================================================
   PROFESSIONAL STACK SPACE VISUALIZATION
   Single vertical stack with newest call at top, accurate push/pop
   ================================================================ */
function StackSpaceViz({ callTree, currentStep, heapState, locals }) {
  // ALL HOOKS MUST BE AT THE TOP LEVEL
  const containerRef = useRef(null)
  const [containerWidth, setContainerWidth] = React.useState(800)
  const prevStepRef = useRef(currentStep)
  
  // Detect container width for responsive layout
  React.useEffect(() => {
    if (!containerRef.current) return
    
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width)
      }
    })
    
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [])

  // Track previous step for animation detection
  React.useEffect(() => {
    prevStepRef.current = currentStep
  }, [currentStep])

  // Build stack frames with accurate push/pop behavior
  const stackState = useMemo(() => {
    if (!callTree || callTree.length === 0) {
      return { 
        frames: [], 
        activeId: null, 
        returningId: null, 
        justPushedId: null,
        justPoppedId: null,
        maxDepth: 0 
      }
    }
    
    const prevStep = prevStepRef.current
    
    // Get all calls made up to current step
    const allCalls = callTree.filter(node => node.step_id <= currentStep)
    
    // Current stack: called but not yet fully returned
    const currentStack = allCalls
      .filter(node => node.return_step_id === null || node.return_step_id >= currentStep)
      .sort((a, b) => a.depth - b.depth) // Bottom to top
    
    // Previous stack for animation detection
    const prevStack = callTree
      .filter(node => node.step_id <= prevStep)
      .filter(node => node.return_step_id === null || node.return_step_id >= prevStep)
      .sort((a, b) => a.depth - b.depth)
    
    // Detect push: new frame appeared
    const justPushed = currentStack.find(frame => 
      !prevStack.find(pf => pf.call_id === frame.call_id)
    )
    
    // Detect pop: frame disappeared
    const justPopped = prevStack.find(frame =>
      !currentStack.find(cf => cf.call_id === frame.call_id)
    )
    
    // Find returning frame (showing return value this step)
    const returningFrame = allCalls.find(node =>
      node.return_step_id !== null && node.return_step_id === currentStep
    )
    
    // Active frame: deepest on stack (most recent call) or returning
    let activeId = null
    if (returningFrame && currentStack.find(f => f.call_id === returningFrame.call_id)) {
      activeId = returningFrame.call_id
    } else if (currentStack.length > 0) {
      activeId = currentStack[currentStack.length - 1].call_id
    }
    
    const maxD = Math.max(...callTree.map(n => n.depth || 0), 1)
    
    return {
      frames: currentStack,
      activeId,
      returningId: returningFrame?.call_id || null,
      justPushedId: justPushed?.call_id || null,
      justPoppedId: justPopped?.call_id || null,
      maxDepth: maxD
    }
  }, [callTree, currentStep])

  const { frames, activeId, returningId, justPushedId, maxDepth } = stackState
  const currentDepth = frames.length

  // Responsive sizing
  const isMobile = containerWidth < 640
  const isTablet = containerWidth >= 640 && containerWidth < 1024
  
  const FRAME_HEIGHT = isMobile ? 56 : isTablet ? 64 : 72
  const FRAME_GAP = 2
  const FONT_FUNC = isMobile ? 13 : 14
  const FONT_DETAIL = isMobile ? 11 : 12

  // Early returns after all hooks
  if (!callTree || callTree.length === 0) {
    return (
      <div className="stack-viz-professional" ref={containerRef}>
        <div className="stack-viz-empty">
          No recursive calls detected
        </div>
      </div>
    )
  }

  if (frames.length === 0 && maxDepth > 0) {
    return (
      <div className="stack-viz-professional" ref={containerRef}>
        <div className="stack-viz-header">
          <div className="stack-viz-metric">
            <span className="metric-label">Max Depth:</span>
            <span className="metric-value">{maxDepth}</span>
          </div>
          <div className="stack-viz-metric">
            <span className="metric-label">Status:</span>
            <span className="metric-value success">All Returned</span>
          </div>
        </div>
        <div className="stack-viz-empty">
          Stack empty — all calls completed
        </div>
      </div>
    )
  }

  // Reverse frames: newest (deepest) at top, oldest at bottom
  const displayFrames = [...frames].reverse()

  return (
    <div className="stack-viz-professional" ref={containerRef}>
      {/* Header with metrics */}
      <div className="stack-viz-header">
        <div className="stack-viz-metric">
          <span className="metric-label">Depth:</span>
          <span className="metric-value">{currentDepth}</span>
        </div>
        <div className="stack-viz-metric">
          <span className="metric-label">Max:</span>
          <span className="metric-value">{maxDepth}</span>
        </div>
        <div className="stack-viz-metric">
          <span className="metric-label">Memory:</span>
          <div className="memory-bar-container">
            <div 
              className="memory-bar-fill"
              style={{ 
                width: `${(currentDepth / maxDepth) * 100}%`,
                backgroundColor: currentDepth / maxDepth > 0.75 ? '#ef4444' : 
                                currentDepth / maxDepth > 0.5 ? '#f59e0b' : '#22c55e'
              }}
            />
          </div>
        </div>
        <div className="stack-viz-indicators">
          <div className="stack-indicator push-indicator">
            <span className="indicator-arrow">↓</span>
            <span className="indicator-label">PUSH</span>
          </div>
          <div className="stack-indicator pop-indicator">
            <span className="indicator-arrow">↑</span>
            <span className="indicator-label">POP</span>
          </div>
        </div>
      </div>

      {/* Stack container */}
      <div className="stack-viz-container">
        <div className="stack-viz-frames">
          {displayFrames.map((frame, visualIndex) => {
            const isActive = frame.call_id === activeId
            const isReturning = frame.call_id === returningId
            const isWaiting = !isActive && !isReturning
            const isPushing = frame.call_id === justPushedId
            
            // Format function call
            const argsStr = formatFunctionArgs(frame.args)
            const funcCall = `${frame.function_name}(${argsStr})`
            
            // Get return value ONLY if returning
            const returnValue = isReturning && frame.return_value !== undefined ?
              (frame.return_value?.value ?? frame.return_value?.display ?? String(frame.return_value)) :
              null
            
            // Get locals (exclude __return__)
            const frameVars = Object.entries(frame.args || {})
              .filter(([key]) => key !== '__return__')
              .slice(0, isMobile ? 2 : 3)
            
            return (
              <div
                key={frame.call_id}
                className={`stack-frame-pro ${isActive ? 'frame-active' : ''} ${isReturning ? 'frame-returning' : ''} ${isWaiting ? 'frame-waiting' : ''} ${isPushing ? 'frame-pushing' : ''}`}
                style={{ 
                  height: `${FRAME_HEIGHT}px`,
                  marginBottom: visualIndex < displayFrames.length - 1 ? `${FRAME_GAP}px` : '0'
                }}
              >
                {/* Left section: Function call */}
                <div className="frame-left">
                  <div className="frame-function" style={{ fontSize: `${FONT_FUNC}px` }}>
                    {funcCall}
                  </div>
                  {frameVars.length > 0 && (
                    <div className="frame-locals" style={{ fontSize: `${FONT_DETAIL}px` }}>
                      {frameVars.map(([key, val]) => {
                        const v = val?.value ?? val?.display ?? String(val)
                        return (
                          <span key={key} className="frame-local-item">
                            {key}={v}
                          </span>
                        )
                      })}
                    </div>
                  )}
                </div>

                {/* Right section: Return value */}
                <div className="frame-right">
                  {returnValue !== null && (
                    <div className="frame-return" style={{ fontSize: `${FONT_DETAIL}px` }}>
                      <span className="return-label">return</span>
                      <span className="return-value">{returnValue}</span>
                    </div>
                  )}
                </div>

                {/* Status badge */}
                {isActive && !isReturning && (
                  <div className="frame-badge badge-active">ACTIVE</div>
                )}
                {isReturning && (
                  <div className="frame-badge badge-returning">RETURNING</div>
                )}
              </div>
            )
          })}
        </div>

        {/* Stack direction labels */}
        <div className="stack-viz-labels">
          <div className="stack-label stack-label-top">
            <span className="label-arrow">↑</span>
            <span className="label-text">TOP</span>
          </div>
          <div className="stack-label stack-label-bottom">
            <span className="label-text">BASE</span>
            <span className="label-arrow">↓</span>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ================================================================
   STACK VIZ  (vertical, top at top)
   ================================================================ */
function StackViz({ heapObj }) {
  const els = (heapObj.elements || []).filter(e => e.type === 'value' || e.type === 'ref')
  if (!els.length) return <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>empty stack</div>

  return (
    <div>
      <div className="stack-viz">
        {els.map((el, i) => {
          const isTop = i === els.length - 1
          const val   = el.type === 'ref' ? `→H${el.heap_id}` : String(el.value ?? '')
          return (
            <div key={`${i}-${val}`} className={`stack-item${isTop ? ' top' : ''}`}>
              <span className="stack-item-label">{isTop ? 'TOP' : `[${i}]`}</span>
              {val}
            </div>
          )
        })}
      </div>
      <div className="stack-base-label">▲ BOTTOM</div>
    </div>
  )
}

/* ================================================================
   QUEUE VIZ  (horizontal, front=left)
   ================================================================ */
function QueueViz({ heapObj }) {
  const els = (heapObj.elements || []).filter(e => e.type === 'value' || e.type === 'ref')
  if (!els.length) return <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>empty queue</div>

  return (
    <div className="queue-viz">
      <div className="queue-end-label">FRONT →</div>
      {els.map((el, i) => {
        const isFront = i === 0
        const isBack  = i === els.length - 1
        const val     = el.type === 'ref' ? `→H${el.heap_id}` : String(el.value ?? '')
        return (
          <div key={`${i}-${val}`} className={`queue-item${isFront ? ' front' : isBack ? ' back' : ''}`}>
            {val}
          </div>
        )
      })}
      <div className="queue-end-label">← BACK</div>
    </div>
  )
}

/* ================================================================
   GRAPH VIZ  (SVG force-layout approximation with circle layout)
   ================================================================ */
function GraphViz({ adj, locals }) {
  const nodes = Object.keys(adj)
  const n     = nodes.length
  if (n === 0) return null

  // Detect "visited" and "active" node from variables
  const visitedSet = useMemo(() => {
    // Look for a 'visited' variable that is a set/list
    for (const [vname, val] of Object.entries(locals || {})) {
      if (vname === 'visited' && val?.display) {
        const raw = val.display.replace(/[{}\[\]'"\s]/g, '')
        return new Set(raw.split(',').filter(Boolean))
      }
    }
    return new Set()
  }, [locals])

  const activeNode = useMemo(() => {
    for (const [vname, val] of Object.entries(locals || {})) {
      if (['node', 'vertex', 'v', 'u', 'curr', 'current', 'src'].includes(vname)) {
        return String(val?.value ?? val?.display ?? '').replace(/['"]/g, '')
      }
    }
    return null
  }, [locals])

  // Layout nodes in a circle
  const W = Math.max(320, Math.min(500, n * 80))
  const H = Math.max(260, Math.min(400, n * 70))
  const cx = W / 2, cy = H / 2
  const r  = Math.min(cx, cy) - 40

  const positions = useMemo(() => {
    const pos = {}
    nodes.forEach((nd, i) => {
      const angle = (2 * Math.PI * i) / n - Math.PI / 2
      pos[nd] = {
        x: cx + r * Math.cos(angle),
        y: cy + r * Math.sin(angle),
      }
    })
    return pos
  }, [nodes, n, cx, cy, r])

  // Build edges (deduplicate undirected)
  const edges = []
  const seen  = new Set()
  for (const [src, neighbors] of Object.entries(adj)) {
    for (const tgt of neighbors) {
      const key = [src, tgt].sort().join('--')
      if (seen.has(key) || !positions[tgt]) continue
      seen.add(key)
      edges.push({ src, tgt })
    }
  }

  // Check if directed (any asymmetric edge)
  const isDirected = Object.entries(adj).some(([src, nbrs]) =>
    nbrs.some(t => !(adj[t] || []).includes(src))
  )

  const NODE_R = Math.max(18, Math.min(26, Math.floor(r / n * 2.5)))

  return (
    <div className="graph-viz-wrap">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        {isDirected && (
          <defs>
            <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" className="graph-edge-arrow" />
            </marker>
            <marker id="arrowhead-active" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" className="graph-edge-arrow active" />
            </marker>
          </defs>
        )}

        {/* Edges */}
        {edges.map(({ src, tgt }) => {
          const s = positions[src], t = positions[tgt]
          const isActive = (src === activeNode || tgt === activeNode)
          // Shorten line to stop at node circle edge
          const dx = t.x - s.x, dy = t.y - s.y
          const dist = Math.sqrt(dx * dx + dy * dy)
          const ux = dx / dist, uy = dy / dist
          const x1 = s.x + ux * NODE_R, y1 = s.y + uy * NODE_R
          const x2 = t.x - ux * NODE_R, y2 = t.y - uy * NODE_R
          return (
            <line
              key={`${src}-${tgt}`}
              x1={x1} y1={y1} x2={x2} y2={y2}
              className={`graph-edge${isActive ? ' active' : ''}`}
              markerEnd={isDirected ? (isActive ? 'url(#arrowhead-active)' : 'url(#arrowhead)') : undefined}
            />
          )
        })}

        {/* Nodes */}
        {nodes.map(nd => {
          const pos   = positions[nd]
          const isVis = visitedSet.has(nd)
          const isAct = nd === activeNode
          return (
            <g key={nd} className={`graph-node${isVis ? ' visited' : ''}${isAct ? ' active' : ''}`}
               transform={`translate(${pos.x},${pos.y})`}>
              <circle r={NODE_R} />
              <text>{nd}</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

/* ================================================================
   BINARY TREE VIZ  (SVG, top-down layout)
   ================================================================ */
function TreeViz({ heapState, rootId, locals }) {
  // Detect active node from variables (node, curr, current, p, q…)
  const activeId = useMemo(() => {
    for (const [vname, val] of Object.entries(locals || {})) {
      if (['node', 'curr', 'current', 'root', 'p', 'q', 'temp', 'ptr'].includes(vname) && val?.heap_ref != null) {
        return String(val.heap_ref)
      }
    }
    return null
  }, [locals])

  // Collect all tree node ids reachable from rootId
  const allNodes = useMemo(() => {
    const visited = new Set()
    const stack = [String(rootId)]
    while (stack.length) {
      const id = stack.pop()
      if (visited.has(id) || !heapState[id]) continue
      visited.add(id)
      const attrs = heapState[id].attributes || []
      for (const a of attrs) {
        if ((a.name === 'left' || a.name === 'right') && a.type === 'ref') {
          stack.push(String(a.heap_id))
        }
      }
    }
    return visited
  }, [heapState, rootId])

  // Compute tree layout using a simple recursive level-order approach
  // Returns { id -> { x, y, level, parent, leftChild, rightChild } }
  const layout = useMemo(() => {
    const result = {}
    const NODE_R = 22
    const H_GAP  = 56    // horizontal gap between siblings at deepest level
    const V_GAP  = 64    // vertical gap between levels

    // First pass: compute subtree widths
    function subtreeWidth(id, depth) {
      if (!id || !heapState[id] || !allNodes.has(id)) return 0
      const attrs  = heapState[id].attributes || []
      const leftA  = attrs.find(a => a.name === 'left'  && a.type === 'ref')
      const rightA = attrs.find(a => a.name === 'right' && a.type === 'ref')
      const lw = leftA  ? subtreeWidth(String(leftA.heap_id),  depth + 1) : 0
      const rw = rightA ? subtreeWidth(String(rightA.heap_id), depth + 1) : 0
      return Math.max(NODE_R * 2 + H_GAP, lw + rw + H_GAP)
    }

    // Second pass: assign positions
    function assign(id, x, y, level) {
      if (!id || !heapState[id] || !allNodes.has(id)) return
      const attrs  = heapState[id].attributes || []
      const leftA  = attrs.find(a => a.name === 'left'  && a.type === 'ref')
      const rightA = attrs.find(a => a.name === 'right' && a.type === 'ref')
      const lChild = leftA  ? String(leftA.heap_id)  : null
      const rChild = rightA ? String(rightA.heap_id) : null

      const lw = lChild ? subtreeWidth(lChild, level + 1) : 0
      const rw = rChild ? subtreeWidth(rChild, level + 1) : 0

      result[id] = { x, y, level, lChild, rChild }

      if (lChild) assign(lChild, x - (lw / 2 + H_GAP / 4), y + V_GAP, level + 1)
      if (rChild) assign(rChild, x + (rw / 2 + H_GAP / 4), y + V_GAP, level + 1)
    }

    const rootW = subtreeWidth(String(rootId), 0)
    assign(String(rootId), rootW / 2, 30, 0)

    return result
  }, [heapState, rootId, allNodes])

  if (!Object.keys(layout).length) return null

  // Compute SVG dimensions
  const xs = Object.values(layout).map(n => n.x)
  const ys = Object.values(layout).map(n => n.y)
  const minX = Math.min(...xs) - 30
  const maxX = Math.max(...xs) + 30
  const maxY = Math.max(...ys) + 40
  const W = Math.max(200, maxX - minX)
  const H = Math.max(80, maxY)
  const NODE_R = 22

  return (
    <div className="graph-viz-wrap" style={{ overflowX: 'auto' }}>
      <svg width={W} height={H} viewBox={`${minX} 0 ${W} ${H}`} style={{ display: 'block', margin: '0 auto' }}>
        {/* Edges first (behind nodes) */}
        {Object.entries(layout).map(([id, pos]) => {
          const edges = []
          for (const childKey of ['lChild', 'rChild']) {
            const cid = pos[childKey]
            if (!cid || !layout[cid]) continue
            const cp = layout[cid]
            const isActive = id === activeId || cid === activeId
            edges.push(
              <line
                key={`${id}-${cid}`}
                x1={pos.x} y1={pos.y + NODE_R}
                x2={cp.x}  y2={cp.y - NODE_R}
                stroke={isActive ? 'var(--accent)' : 'var(--border-light)'}
                strokeWidth={isActive ? 2.5 : 1.5}
              />
            )
          }
          return edges
        })}

        {/* Nodes */}
        {Object.entries(layout).map(([id, pos]) => {
          const obj     = heapState[id]
          const attrs   = obj?.attributes || []
          // Get the data/val attribute (not left/right)
          const dataA   = attrs.find(a => a.name !== 'left' && a.name !== 'right' && a.type === 'value')
          const label   = dataA ? String(dataA.value ?? '') : id
          const isActive = id === activeId

          return (
            <g key={id} transform={`translate(${pos.x},${pos.y})`}>
              <circle
                r={NODE_R}
                fill={isActive ? 'var(--accent)' : 'var(--bg-card)'}
                stroke={isActive ? 'var(--accent-hover)' : 'var(--accent)'}
                strokeWidth="2"
                style={{ transition: 'fill 250ms, stroke 250ms' }}
              />
              <text
                dominantBaseline="middle"
                textAnchor="middle"
                fill={isActive ? '#fff' : 'var(--text-primary)'}
                fontFamily="var(--font-mono)"
                fontSize="12"
                fontWeight="700"
                style={{ pointerEvents: 'none' }}
              >
                {label}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

/* ================================================================
   LINKED LIST  (simplified with direct node highlighting only)
   ================================================================ */
function LinkedListViz({ heapState, locals }) {
  // Find the head node
  const entries = Object.entries(heapState)
    .filter(([, o]) => o.type === 'object' && o.attributes)
    .sort(([a], [b]) => Number(a) - Number(b))

  if (!entries.length) return null

  const referenced = new Set()
  for (const [, obj] of entries)
    for (const a of (obj.attributes || []))
      if (a.type === 'ref') referenced.add(String(a.heap_id))

  const roots = entries.filter(([id]) => !referenced.has(String(id)))
  const start = roots.length ? roots[0] : entries[0]

  // Build the linked list chain
  const visited = new Set()
  const chain   = []
  let cur = start
  while (cur && !visited.has(cur[0])) {
    visited.add(cur[0])
    chain.push(cur)
    const refAttr = (cur[1].attributes || []).find(a => a.type === 'ref')
    cur = refAttr
      ? (Object.entries(heapState).find(([id]) => id === String(refAttr.heap_id)) || null)
      : null
  }

  // Determine node highlight based on pointer variables
  const getNodeHighlight = (nodeId) => {
    for (const [varName, val] of Object.entries(locals || {})) {
      if (val?.heap_ref === nodeId) {
        const name = varName.toLowerCase()
        // Priority: current > prev > next > head
        if (name === 'current' || name === 'curr' || name === 'cur') {
          return 'current' // Green
        } else if (name === 'prev' || name === 'previous') {
          return 'prev' // Red
        } else if (name === 'next') {
          return 'next' // Blue
        } else if (name === 'head') {
          return 'head' // Neutral with accent
        }
      }
    }
    return null
  }

  return (
    <div className="linked-list-container">
      {chain.map(([id, obj]) => {
        const valAttr  = (obj.attributes || []).find(a => a.type !== 'ref')
        const val      = valAttr ? String(valAttr.value ?? '') : id
        const ptrLabel = (obj.attributes || []).find(a => a.type === 'ref')?.name || 'next'
        const highlight = getNodeHighlight(Number(id))
        
        let nodeClass = 'll-node'
        if (highlight === 'current') nodeClass += ' ll-highlight-current'
        else if (highlight === 'prev') nodeClass += ' ll-highlight-prev'
        else if (highlight === 'next') nodeClass += ' ll-highlight-next'
        else if (highlight === 'head') nodeClass += ' ll-highlight-head'
        
        return (
          <React.Fragment key={id}>
            <div className={nodeClass}>
              <div className="ll-node-data">{val}</div>
              <div className="ll-node-ptr">{ptrLabel}</div>
            </div>
            <div className="ll-connector">→</div>
          </React.Fragment>
        )
      })}
      <div className="ll-null">None</div>
    </div>
  )
}

/* ================================================================
   DICT VIZ
   ================================================================ */
function DictViz({ heapObj, onHeapClick }) {
  const entries = heapObj.entries || []
  if (!entries.length)
    return <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>empty dict</div>
  return (
    <div className="dict-viz">
      {entries.map((e, i) => {
        const isRef = e.value?.type === 'ref'
        const val   = isRef ? `→ H${e.value.heap_id}` : (e.value?.value ?? '')
        return (
          <div className="dict-entry" key={i}>
            <span className="dict-key">{e.key}</span>
            <span className="dict-arrow">:</span>
            <span
              className={`dict-value${isRef ? ' is-ref' : ''}`}
              onClick={isRef ? () => onHeapClick(e.value.heap_id) : undefined}
            >{val}</span>
          </div>
        )
      })}
    </div>
  )
}

/* ================================================================
   OBJECT VIZ
   ================================================================ */
function ObjectViz({ heapObj, onHeapClick }) {
  const label = heapObj.label || `${heapObj.class || 'object'} instance`
  const attrs = heapObj.attributes || []
  return (
    <div className="obj-card">
      <div className="obj-card-title">{label}</div>
      <div className="obj-card-attrs">
        {attrs.map((a, i) => {
          const isRef = a.type === 'ref'
          return (
            <div className="obj-attr-row" key={i}>
              <span className="obj-attr-name">{a.name}</span>
              <span
                className={`obj-attr-value${isRef ? ' is-ref' : ''}`}
                onClick={isRef ? () => onHeapClick(a.heap_id) : undefined}
              >
                {isRef ? `→ H${a.heap_id}` : String(a.value ?? '')}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ================================================================
   OUTPUT
   ================================================================ */
function OutputSection() {
  const { state } = useApp()
  const { traceData, currentStep, outputLines, currentOutputLineIdx } = state
  if (!traceData?.output)
    return (
      <div className="viz-output-box">
        <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>(waiting for output…)</span>
      </div>
    )
  const isLast = currentStep >= traceData.steps.length - 1
  const text   = isLast ? traceData.output : outputLines.slice(0, currentOutputLineIdx).join('\n')
  return (
    <div className="viz-output-box">
      {text
        ? <span style={{ color: '#d1fae5' }}>{text}</span>
        : <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>(waiting for output…)</span>
      }
    </div>
  )
}

/* ================================================================
   HEAP SECTION  (dispatches to correct sub-renderer)
   ================================================================ */
function HeapSection({ heapState, prevHeapState, featuredIds, locals, onHeapClick }) {
  const remaining = Object.fromEntries(
    Object.entries(heapState).filter(([id]) => !featuredIds.has(id))
  )
  if (!Object.keys(remaining).length) return null

  // Binary tree? (check before linked list — BST has left+right refs)
  const treeRootId = detectBinaryTree(remaining)
  if (treeRootId) {
    return (
      <Section icon={Grid3x3} title="Binary Tree">
        <TreeViz heapState={remaining} rootId={treeRootId} locals={locals} />
      </Section>
    )
  }

  // Linked list?
  if (isLinkedListHeap(remaining)) {
    return (
      <Section icon={Link2} title="Linked List — Memory Diagram">
        <LinkedListViz heapState={remaining} locals={locals} />
      </Section>
    )
  }

  // NO generic heap display - only show specific data structures
  return null
}

/* ================================================================
   MAIN VISUALIZER
   ================================================================ */
export default function Visualizer({ onHeapClick }) {
  const { state } = useApp()
  const { traceData, currentStep } = state

  if (!traceData || !traceData.steps.length) {
    return (
      <div className="viz-grid">
        <div className="viz-empty">
          <p>Paste your code and click <strong>Trace &amp; Visualize</strong> to see execution step by step.</p>
        </div>
      </div>
    )
  }

  const step      = traceData.steps[currentStep]
  const prevStep  = currentStep > 0 ? traceData.steps[currentStep - 1] : null
  if (!step) return null

  const heapState     = step.heap_state || {}
  const prevHeapState = prevStep?.heap_state || {}
  const locals        = step.stack_locals || {}

  // ---- Detect graph first (uses dict + heap) -------------------------
  const graphResult = detectGraph(heapState, locals)
  const graphAdj = graphResult?.adj || null
  const graphExcludeIds = graphResult?.excludeIds || new Set()

  // ---- Find matrices first to identify their row heap IDs ------------
  const matrixVars = Object.entries(locals).filter(([name, val]) => {
    if (name.startsWith('__')) return false
    if (!val || val.type !== 'list' || val.heap_ref == null) return false
    const heapObj = heapState[String(val.heap_ref)]
    return heapObj?.is_matrix && heapObj?.dimensions
  })

  // Collect all matrix row heap IDs to exclude from separate display
  const matrixRowHeapIds = new Set()
  for (const [, val] of matrixVars) {
    const matrixObj = heapState[String(val.heap_ref)]
    if (matrixObj?.elements) {
      for (const el of matrixObj.elements) {
        if (el.type === 'ref') {
          matrixRowHeapIds.add(String(el.heap_id))
        }
      }
    }
  }

  // ---- Find list/tuple variables to feature as smart diagrams --------
  const listVars = Object.entries(locals).filter(([name, val]) => {
    if (name.startsWith('__')) return false
    if (!val || (val.type !== 'list' && val.type !== 'tuple') || val.heap_ref == null) return false
    // Exclude matrix row references
    if (matrixRowHeapIds.has(String(val.heap_ref))) return false
    return true
  })
  
  const featuredIds = new Set([
    ...listVars.map(([, v]) => String(v.heap_ref)),
    ...matrixRowHeapIds,  // Exclude matrix rows from heap section
    ...graphExcludeIds    // Exclude all graph-related heap objects
  ])

  // ---- Detect recursion -----------------------------------------------
  const callTree = traceData.call_tree || []
  const { isRecursive, recursiveFunctions } = useMemo(
    () => detectRecursion(callTree),
    [callTree]
  )

  return (
    <div className="viz-grid">
      {/* Current executing line */}
      <CurrentLineBanner step={step} />

      {/* Stack Space Visualization (if recursive functions detected) */}
      {isRecursive && callTree.length > 0 && (
        <Section icon={Layers} title={`Stack Space — ${[...recursiveFunctions].join(', ')}`}>
          <StackSpaceViz 
            callTree={callTree} 
            currentStep={currentStep} 
            heapState={heapState} 
            locals={locals} 
          />
        </Section>
      )}

      {/* Graph (if detected) */}
      {graphAdj && (
        <Section icon={BarChart2} title="Graph Visualization">
          <GraphViz adj={graphAdj} locals={locals} />
        </Section>
      )}

      {/* Smart array / stack / queue / matrix diagrams */}
      {listVars.map(([name, val]) => {
        const heapId  = String(val.heap_ref)
        const heapObj = heapState[heapId]
        if (!heapObj?.elements) return null
        const prevObj = prevHeapState[heapId]
        const role    = detectListRole(name, heapObj)

        // Check if it's a matrix (2D or 3D array)
        if (heapObj.is_matrix && heapObj.dimensions) {
          const dims = heapObj.dimensions
          
          // 3D Matrix
          if (dims.length === 3) {
            return (
              <Section key={name} icon={Layers} title={`3D Matrix — ${name}`}>
                <Matrix3DViz
                  heapObj={heapObj}
                  varName={name}
                  locals={locals}
                  prevHeapObj={prevObj}
                  onHeapClick={onHeapClick}
                  heapState={heapState}
                />
              </Section>
            )
          }
          
          // 2D Matrix
          if (dims.length === 2) {
            return (
              <Section key={name} icon={Grid3x3} title={`2D Matrix — ${name}`}>
                <Matrix2DViz
                  heapObj={heapObj}
                  varName={name}
                  locals={locals}
                  prevHeapObj={prevObj}
                  onHeapClick={onHeapClick}
                  heapState={heapState}
                  matrixHeapId={heapId}
                />
              </Section>
            )
          }
        }

        if (role === 'stack') {
          return (
            <Section key={name} icon={List} title={`Stack — ${name}`}>
              <StackViz heapObj={heapObj} />
            </Section>
          )
        }
        if (role === 'queue') {
          return (
            <Section key={name} icon={AlignJustify} title={`Queue — ${name}`}>
              <QueueViz heapObj={heapObj} />
            </Section>
          )
        }
        return (
          <Section key={name} icon={Grid3x3} title={`Array — ${name}`}>
            <ArrayViz
              heapObj={heapObj}
              varName={name}
              locals={locals}
              prevHeapObj={prevObj}
              onHeapClick={onHeapClick}
            />
          </Section>
        )
      })}

      {/* Variables table */}
      <Section icon={Database} title="Variables (Current Frame)">
        <Variables step={step} prevStep={prevStep} onHeapClick={onHeapClick} />
      </Section>

      {/* Heap / memory (remaining objects) */}
      <HeapSection
        heapState={heapState}
        prevHeapState={prevHeapState}
        featuredIds={featuredIds}
        locals={locals}
        onHeapClick={onHeapClick}
      />

      {/* Console output */}
      <Section icon={Terminal} title="Console Output">
        <OutputSection />
      </Section>
    </div>
  )
}
