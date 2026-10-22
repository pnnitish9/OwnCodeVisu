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
   RECURSION TREE VIZ  (hierarchical function call tree with zoom/pan)
   ================================================================ */
function RecursionTreeViz({ callTree, currentStep }) {
  // ALL HOOKS MUST BE AT THE TOP LEVEL - NEVER AFTER CONDITIONAL RETURNS
  const containerRef = useRef(null)
  const svgRef = useRef(null)
  const [containerWidth, setContainerWidth] = React.useState(800)
  
  // Zoom and pan state
  const [zoom, setZoom] = React.useState(1)
  const [panOffset, setPanOffset] = React.useState({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = React.useState(false)
  const [panStart, setPanStart] = React.useState({ x: 0, y: 0 })

  // Memoize tree roots - MUST be before early return
  const treeRoots = useMemo(
    () => buildRecursionTreeAtStep(callTree, currentStep),
    [callTree, currentStep]
  )

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

  // Responsive dimensions based on container width
  const isMobile = containerWidth < 640
  const isTablet = containerWidth >= 640 && containerWidth < 1024
  
  const NODE_MIN_WIDTH = isMobile ? 80 : 100
  const NODE_HEIGHT = isMobile ? 50 : 60
  const HORIZONTAL_SPACING = isMobile ? 20 : isTablet ? 30 : 40
  const VERTICAL_SPACING = isMobile ? 60 : 80
  const PADDING = isMobile ? 8 : 12

  // Measure text width for dynamic node sizing
  const measureText = React.useCallback((text, fontSize = 13) => {
    if (typeof document === 'undefined') return text.length * 8
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    context.font = `600 ${fontSize}px var(--font-mono, monospace)`
    return context.measureText(text).width
  }, [])

  // Calculate node width based on content
  const calculateNodeWidth = React.useCallback((node) => {
    const args = formatFunctionArgs(node.args)
    const text = `${node.function_name}(${args})`
    const textWidth = measureText(text, isMobile ? 11 : 13)
    return Math.max(NODE_MIN_WIDTH, Math.min(textWidth + PADDING * 2, isMobile ? 150 : 200))
  }, [measureText, isMobile, NODE_MIN_WIDTH, PADDING])

  // Stable node dimensions - memoize to prevent recalculation
  const nodeWidths = useMemo(() => {
    if (treeRoots.length === 0) return {}
    
    const widths = {}
    const measure = (nodes) => {
      for (const node of nodes) {
        widths[node.call_id] = calculateNodeWidth(node)
        if (node.children?.length > 0) {
          measure(node.children)
        }
      }
    }
    measure(treeRoots)
    return widths
  }, [treeRoots, calculateNodeWidth])

  // Calculate positions with stable layout
  const calculateNodePositions = React.useCallback((node, depth = 0, offsetX = 0) => {
    const positions = []
    const childCount = node.children.length
    const nodeWidth = nodeWidths[node.call_id] || NODE_MIN_WIDTH

    // Position for current node
    const nodePos = {
      node,
      x: offsetX,
      y: depth * (NODE_HEIGHT + VERTICAL_SPACING),
      width: nodeWidth,
      height: NODE_HEIGHT
    }
    positions.push(nodePos)

    // Position children
    if (childCount > 0) {
      const childWidths = node.children.map(c => nodeWidths[c.call_id] || NODE_MIN_WIDTH)
      const totalChildWidth = childWidths.reduce((sum, w) => sum + w, 0) + 
                              (childCount - 1) * HORIZONTAL_SPACING
      let childX = offsetX - totalChildWidth / 2 + nodeWidth / 2

      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i]
        const childWidth = childWidths[i]
        const childPositions = calculateNodePositions(child, depth + 1, childX)
        positions.push(...childPositions)
        childX += childWidth + HORIZONTAL_SPACING
      }
    }

    return positions
  }, [nodeWidths, NODE_HEIGHT, VERTICAL_SPACING, HORIZONTAL_SPACING, NODE_MIN_WIDTH])

  // Calculate positions for all trees - memoized for stability
  const allPositions = useMemo(() => {
    if (treeRoots.length === 0) return []
    
    const positions = []
    let currentX = 60
    
    for (const root of treeRoots) {
      const rootWidth = nodeWidths[root.call_id] || NODE_MIN_WIDTH
      const rootPositions = calculateNodePositions(root, 0, currentX + rootWidth / 2)
      positions.push(...rootPositions)
      
      // Calculate width of this tree
      const maxX = Math.max(...rootPositions.map(p => p.x + p.width))
      currentX = maxX + (isMobile ? 40 : 80)
    }
    
    return positions
  }, [treeRoots, nodeWidths, calculateNodePositions, isMobile, NODE_MIN_WIDTH])

  // Find parent position for drawing arrows
  const positionMap = useMemo(() => {
    const map = {}
    for (const pos of allPositions) {
      map[pos.node.call_id] = pos
    }
    return map
  }, [allPositions])

  // Calculate SVG dimensions and bounds
  const treeBounds = useMemo(() => {
    if (allPositions.length === 0) {
      return { minX: 0, minY: 0, maxX: 400, maxY: 200, width: 400, height: 200 }
    }
    
    const minX = Math.min(...allPositions.map(p => p.x)) - 40
    const minY = Math.min(...allPositions.map(p => p.y)) - 40
    const maxX = Math.max(...allPositions.map(p => p.x + p.width)) + 40
    const maxY = Math.max(...allPositions.map(p => p.y + p.height)) + 40
    
    return {
      minX,
      minY,
      maxX,
      maxY,
      width: maxX - minX,
      height: maxY - minY
    }
  }, [allPositions])

  // Zoom controls
  const handleZoomIn = React.useCallback(() => {
    setZoom(z => Math.min(z * 1.2, 3))
  }, [])

  const handleZoomOut = React.useCallback(() => {
    setZoom(z => Math.max(z / 1.2, 0.3))
  }, [])

  const handleResetView = React.useCallback(() => {
    setZoom(1)
    setPanOffset({ x: 0, y: 0 })
  }, [])

  const handleFitToView = React.useCallback(() => {
    if (!containerRef.current || allPositions.length === 0) return
    
    const containerRect = containerRef.current.getBoundingClientRect()
    const padding = 40
    
    const scaleX = (containerRect.width - padding * 2) / treeBounds.width
    const scaleY = (containerRect.height - padding * 2) / treeBounds.height
    const newZoom = Math.min(scaleX, scaleY, 1.5)
    
    // Center the tree
    const centerX = (containerRect.width - treeBounds.width * newZoom) / 2
    const centerY = (containerRect.height - treeBounds.height * newZoom) / 2
    
    setZoom(newZoom)
    setPanOffset({
      x: centerX - treeBounds.minX * newZoom,
      y: centerY - treeBounds.minY * newZoom
    })
  }, [treeBounds, allPositions.length])

  // Mouse wheel zoom
  const handleWheel = React.useCallback((e) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    setZoom(z => Math.max(0.3, Math.min(3, z * delta)))
  }, [])

  // Pan handlers
  const handleMouseDown = React.useCallback((e) => {
    if (e.button === 0) { // Left mouse button
      setIsPanning(true)
      setPanStart({ x: e.clientX - panOffset.x, y: e.clientY - panOffset.y })
    }
  }, [panOffset])

  const handleMouseMove = React.useCallback((e) => {
    if (isPanning) {
      setPanOffset({
        x: e.clientX - panStart.x,
        y: e.clientY - panStart.y
      })
    }
  }, [isPanning, panStart])

  const handleMouseUp = React.useCallback(() => {
    setIsPanning(false)
  }, [])

  // Touch handlers for mobile
  const handleTouchStart = React.useCallback((e) => {
    if (e.touches.length === 1) {
      setIsPanning(true)
      setPanStart({ 
        x: e.touches[0].clientX - panOffset.x, 
        y: e.touches[0].clientY - panOffset.y 
      })
    }
  }, [panOffset])

  const handleTouchMove = React.useCallback((e) => {
    if (isPanning && e.touches.length === 1) {
      e.preventDefault()
      setPanOffset({
        x: e.touches[0].clientX - panStart.x,
        y: e.touches[0].clientY - panStart.y
      })
    }
  }, [isPanning, panStart])

  const handleTouchEnd = React.useCallback(() => {
    setIsPanning(false)
  }, [])

  // Attach event listeners
  React.useEffect(() => {
    const svg = svgRef.current
    if (!svg) return

    svg.addEventListener('wheel', handleWheel, { passive: false })
    return () => svg.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  React.useEffect(() => {
    if (isPanning) {
      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
      return () => {
        window.removeEventListener('mousemove', handleMouseMove)
        window.removeEventListener('mouseup', handleMouseUp)
      }
    }
  }, [isPanning, handleMouseMove, handleMouseUp])

  // Auto fit on first load or when tree changes significantly
  React.useEffect(() => {
    if (allPositions.length > 0 && zoom === 1 && panOffset.x === 0 && panOffset.y === 0) {
      // Small delay to ensure container is rendered
      const timer = setTimeout(handleFitToView, 100)
      return () => clearTimeout(timer)
    }
  }, [allPositions.length, zoom, panOffset, handleFitToView])

  // NOW we can do early return - ALL HOOKS have been called
  if (treeRoots.length === 0) {
    return (
      <div className="recursion-tree-wrap" ref={containerRef}>
        <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: '20px' }}>
          No recursion tree available
        </div>
      </div>
    )
  }

  const containerHeight = Math.max(400, treeBounds.height * zoom + 100)

  return (
    <div className="recursion-tree-wrap" ref={containerRef}>
      {/* Zoom controls */}
      <div className="recursion-controls">
        <button 
          className="recursion-control-btn" 
          onClick={handleZoomIn}
          title="Zoom In"
        >
          +
        </button>
        <button 
          className="recursion-control-btn" 
          onClick={handleZoomOut}
          title="Zoom Out"
        >
          −
        </button>
        <button 
          className="recursion-control-btn" 
          onClick={handleFitToView}
          title="Fit to View"
        >
          ⊡
        </button>
        <button 
          className="recursion-control-btn" 
          onClick={handleResetView}
          title="Reset View"
        >
          ⟲
        </button>
        <span className="recursion-zoom-label">{Math.round(zoom * 100)}%</span>
      </div>

      {/* SVG with pan and zoom */}
      <div 
        className="recursion-tree-container"
        style={{ 
          height: `${Math.min(containerHeight, 800)}px`,
          cursor: isPanning ? 'grabbing' : 'grab'
        }}
      >
        <svg 
          ref={svgRef}
          width="100%"
          height="100%"
          className="recursion-tree-svg"
          onMouseDown={handleMouseDown}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          <g transform={`translate(${panOffset.x}, ${panOffset.y}) scale(${zoom})`}>
            {/* Arrow marker definition */}
            <defs>
              <marker
                id="arrowhead"
                markerWidth="10"
                markerHeight="10"
                refX="5"
                refY="5"
                orient="auto"
              >
                <polygon points="0 0, 10 5, 0 10" fill="var(--border-light)" />
              </marker>
              <marker
                id="arrowhead-active"
                markerWidth="10"
                markerHeight="10"
                refX="5"
                refY="5"
                orient="auto"
              >
                <polygon points="0 0, 10 5, 0 10" fill="var(--accent)" />
              </marker>
            </defs>

            {/* Draw arrows first (so they appear behind nodes) */}
            {allPositions.map(pos => {
              if (pos.node.parent_id && positionMap[pos.node.parent_id]) {
                const parentPos = positionMap[pos.node.parent_id]
                const x1 = parentPos.x + parentPos.width / 2
                const y1 = parentPos.y + parentPos.height
                const x2 = pos.x + pos.width / 2
                const y2 = pos.y

                const isActiveConnection = pos.node.isActive || parentPos.node.isActive

                return (
                  <line
                    key={`arrow-${pos.node.call_id}`}
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    className={`recursion-arrow ${isActiveConnection ? 'active' : ''}`}
                    markerEnd={isActiveConnection ? 'url(#arrowhead-active)' : 'url(#arrowhead)'}
                  />
                )
              }
              return null
            })}

            {/* Draw nodes */}
            {allPositions.map(pos => {
              const { node, x, y, width, height } = pos
              const args = formatFunctionArgs(node.args)
              const returnVal = node.return_value?.value ?? node.return_value?.display
              
              let nodeClass = 'recursion-node'
              if (node.isActive) nodeClass += ' active'
              if (node.hasReturned) nodeClass += ' returned'

              const fontSize = isMobile ? 11 : 13
              const returnFontSize = isMobile ? 9 : 11

              return (
                <g key={`node-${node.call_id}`} className={nodeClass}>
                  {/* Node rectangle */}
                  <rect
                    x={x}
                    y={y}
                    width={width}
                    height={height}
                    rx={6}
                    className="recursion-node-box"
                  />
                  
                  {/* Function name and args */}
                  <text
                    x={x + width / 2}
                    y={y + height / 2 - (node.hasReturned && returnVal !== undefined ? 6 : 0)}
                    className="recursion-node-title"
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize={fontSize}
                  >
                    {node.function_name}({args})
                  </text>
                  
                  {/* Return value if available */}
                  {node.hasReturned && returnVal !== undefined && (
                    <text
                      x={x + width / 2}
                      y={y + height / 2 + 12}
                      className="recursion-node-return"
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fontSize={returnFontSize}
                    >
                      → {String(returnVal)}
                    </text>
                  )}
                </g>
              )
            })}
          </g>
        </svg>
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
   LINKED LIST  (enhanced with active node)
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

  // Active node: "current" / "cur" / "node" variable
  const activeNodeRef = useMemo(() => {
    for (const [vname, val] of Object.entries(locals || {})) {
      if (['current', 'cur', 'node', 'temp', 'p', 'ptr'].includes(vname) && val?.heap_ref != null) {
        return val.heap_ref
      }
    }
    return null
  }, [locals])

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

  return (
    <div className="linked-list-viz">
      {chain.map(([id, obj]) => {
        const valAttr  = (obj.attributes || []).find(a => a.type !== 'ref')
        const val      = valAttr ? String(valAttr.value ?? '') : id
        const ptrLabel = (obj.attributes || []).find(a => a.type === 'ref')?.name || 'next'
        const isActive = Number(id) === activeNodeRef
        return (
          <React.Fragment key={id}>
            <div className={`ll-node${isActive ? ' active-node' : ''}`}>
              <div className="ll-node-data">{val}</div>
              <div className="ll-node-ptr">{ptrLabel}</div>
            </div>
            <div className="ll-arrow">→</div>
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

      {/* Recursion Tree (if recursive functions detected) */}
      {isRecursive && callTree.length > 0 && (
        <Section icon={Layers} title={`Recursion Tree — ${[...recursiveFunctions].join(', ')}`}>
          <RecursionTreeViz callTree={callTree} currentStep={currentStep} />
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
