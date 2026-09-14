import React, { useRef, useEffect, useCallback } from 'react'
import { FileCode, Copy, Pencil, CircleDot } from 'lucide-react'
import { useApp, FILE_EXT } from '../context/AppContext'

const LINE_HEIGHT = 21  // px — must match CSS
const PAD_TOP     = 12  // px — must match CSS

export default function Editor({ onTrace, onEdit, onCopy }) {
  const { state, dispatch, editorRef } = useApp()
  const { language, isVisualizing, traceData, currentStep } = state

  const gutterRef    = useRef(null)
  const highlightRef = useRef(null)
  const codeRef      = editorRef   // shared ref so App can read .value

  // ---- line count state driven by textarea content ----
  const [lineCount, setLineCount] = React.useState(1)
  const [activeLine, setActiveLine] = React.useState(null)  // 0-indexed

  // Keep line count in sync with textarea
  const syncLines = useCallback(() => {
    const ta = codeRef.current
    if (!ta) return
    const n = ta.value.split('\n').length
    setLineCount(n)
    // Sync gutter scroll
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop
  }, [codeRef])

  // Sync active line from traceData
  useEffect(() => {
    if (!traceData || !isVisualizing) {
      setActiveLine(null)
      if (highlightRef.current) highlightRef.current.style.opacity = '0'
      return
    }
    const step = traceData.steps[currentStep]
    if (!step) return
    const line = step.line
    if (line == null || line < 0) {
      setActiveLine(null)
      if (highlightRef.current) highlightRef.current.style.opacity = '0'
      return
    }
    setActiveLine(line)

    // Position highlight strip
    const ta = codeRef.current
    if (ta && highlightRef.current) {
      const topPx = PAD_TOP + line * LINE_HEIGHT - ta.scrollTop
      highlightRef.current.style.top    = topPx + 'px'
      highlightRef.current.style.opacity = '1'
    }

    // Auto-scroll textarea to keep active line in view
    if (ta) {
      const lineTop    = PAD_TOP + line * LINE_HEIGHT
      const lineBottom = lineTop + LINE_HEIGHT
      if (lineTop < ta.scrollTop + LINE_HEIGHT * 2)
        ta.scrollTop = Math.max(0, lineTop - LINE_HEIGHT * 3)
      else if (lineBottom > ta.scrollTop + ta.clientHeight - LINE_HEIGHT * 2)
        ta.scrollTop = lineBottom - ta.clientHeight + LINE_HEIGHT * 3
    }
  }, [traceData, currentStep, isVisualizing, codeRef])

  // Reposition highlight on scroll
  const handleScroll = useCallback(() => {
    const ta = codeRef.current
    if (!ta) return
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop
    if (highlightRef.current && activeLine != null) {
      const topPx = PAD_TOP + activeLine * LINE_HEIGHT - ta.scrollTop
      highlightRef.current.style.top = topPx + 'px'
    }
  }, [activeLine, codeRef])

  // Detect input() / cin >> for the Input tab
  const checkInputStatements = useCallback(() => {
    const ta = codeRef.current
    if (!ta) return
    const pattern = language === 'python' ? /input\s*\(/g : /\bcin\s*>>/g
    const has = pattern.test(ta.value)
    dispatch({ type: 'SET_HAS_INPUT', has })
  }, [language, dispatch, codeRef])

  const handleInput = useCallback(() => {
    syncLines()
    checkInputStatements()
  }, [syncLines, checkInputStatements])

  const handlePaste = useCallback(() => {
    setTimeout(() => {
      syncLines()
      checkInputStatements()
    }, 0)
  }, [syncLines, checkInputStatements])

  // Initialise on mount
  useEffect(() => { syncLines() }, [syncLines])

  const filename = FILE_EXT[language]

  return (
    <div className="editor-card">
      {/* Header */}
      <div className="editor-header">
        <div className="editor-header-left">
          <FileCode size={15} style={{ color: 'var(--accent)' }} />
          <span className="filename">{filename}</span>
        </div>
        <div className="editor-header-right">
          {isVisualizing && (
            <span className="tracing-badge active">
              <CircleDot size={9} />
              Tracing Active
            </span>
          )}
          <button className="small-btn" onClick={onCopy} title="Copy code">
            <Copy size={12} /> Copy
          </button>
          {isVisualizing && (
            <button className="small-btn" onClick={onEdit}>
              <Pencil size={12} /> Edit
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="editor-body">
        {/* Gutter */}
        <div id="lineNumbers" ref={gutterRef}>
          {Array.from({ length: lineCount }, (_, i) => (
            <div
              key={i}
              className={`line-row${activeLine === i ? ' active-line' : ''}`}
              data-line={i}
            >
              <span className={`line-num${activeLine === i ? ' active' : ''}`}>
                {i + 1}
              </span>
            </div>
          ))}
        </div>

        {/* Textarea wrapper */}
        <div className="editor-textarea-wrap">
          <div id="lineHighlight" ref={highlightRef} />
          <textarea
            ref={codeRef}
            id="codeEditor"
            spellCheck={false}
            placeholder="Write or paste your code here..."
            readOnly={isVisualizing}
            className={isVisualizing ? 'readonly' : ''}
            onInput={handleInput}
            onPaste={handlePaste}
            onScroll={handleScroll}
          />
        </div>
      </div>
    </div>
  )
}
