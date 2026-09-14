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
 * Returns the adjacency map { node: [neighbor, ...] } or null.
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
      // Build adjacency map
      const adj = {}
      for (const e of heapObj.entries) {
        const key = e.key?.replace(/['"]/g, '')
        const inner = heapState[String(e.value?.heap_id)]
        adj[key] = (inner?.elements || [])
          .filter(el => el.type === 'value')
          .map(el => String(el.value ?? '').replace(/['"]/g, ''))
      }
      return adj
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

  // Graph?
  const adj = detectGraph(heapState, locals)
  if (adj) {
    return (
      <Section icon={BarChart2} title="Graph Visualization">
        <GraphViz adj={adj} locals={locals} />
      </Section>
    )
  }

  // Generic heap objects
  return (
    <Section icon={Grid3x3} title="Heap / Memory">
      <div className="heap-section">
        {Object.entries(remaining).map(([id, obj]) => {
          const prevObj = prevHeapState?.[id]
          return (
            <div className="heap-obj-wrap" key={id} id={`heap-obj-${id}`}>
              <div className="heap-obj-header">
                <Grid3x3 size={11} />
                H{id} · {obj.label || obj.type}
                {obj.truncated && ' (truncated)'}
              </div>
              <div className="heap-obj-body">
                {(obj.type === 'list' || obj.type === 'tuple') &&
                  <ArrayViz heapObj={obj} varName="" locals={locals} prevHeapObj={prevObj} onHeapClick={onHeapClick} />}
                {obj.type === 'dict'   && <DictViz heapObj={obj} onHeapClick={onHeapClick} />}
                {obj.type === 'object' && <ObjectViz heapObj={obj} onHeapClick={onHeapClick} />}
                {(obj.type === 'set' || obj.type === 'frozenset') && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {(obj.elements || []).map((e, i) => (
                      <span key={i} style={{
                        background: 'var(--bg-card)', border: '1px solid var(--border)',
                        borderRadius: 5, padding: '3px 8px',
                        fontFamily: 'var(--font-mono)', fontSize: 12,
                      }}>
                        {e.type === 'ref' ? `→H${e.heap_id}` : String(e.value ?? '')}
                      </span>
                    ))}
                  </div>
                )}
                {obj.value != null &&
                  <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{String(obj.value)}</code>}
              </div>
            </div>
          )
        })}
      </div>
    </Section>
  )
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
  const graphAdj = detectGraph(heapState, locals)

  // ---- Find list/tuple variables to feature as smart diagrams --------
  const listVars = Object.entries(locals).filter(([name, val]) => {
    if (name.startsWith('__')) return false
    return (val?.type === 'list' || val?.type === 'tuple') && val.heap_ref != null
  })
  const featuredIds = new Set(listVars.map(([, v]) => String(v.heap_ref)))

  // Also exclude graph dict from heap section
  if (graphAdj) {
    for (const [, val] of Object.entries(locals)) {
      if (val?.type === 'dict' && val.heap_ref != null) featuredIds.add(String(val.heap_ref))
    }
  }

  return (
    <div className="viz-grid">
      {/* Current executing line */}
      <CurrentLineBanner step={step} />

      {/* Graph (if detected) */}
      {graphAdj && (
        <Section icon={BarChart2} title="Graph Visualization">
          <GraphViz adj={graphAdj} locals={locals} />
        </Section>
      )}

      {/* Smart array / stack / queue diagrams */}
      {listVars.map(([name, val]) => {
        const heapId  = String(val.heap_ref)
        const heapObj = heapState[heapId]
        if (!heapObj?.elements) return null
        const prevObj = prevHeapState[heapId]
        const role    = detectListRole(name, heapObj)

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
