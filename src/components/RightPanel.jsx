import React from 'react'
import { LayoutGrid, Terminal, Keyboard, ListChecks, AlertTriangle, CheckCircle, Edit3 } from 'lucide-react'
import { useApp } from '../context/AppContext'
import Visualizer from './Visualizer'

const CATEGORY_LABELS = {
  validation: 'Invalid Request', syntax: 'Syntax Error', compile: 'Compile Error',
  runtime: 'Runtime Error', timeout: 'Timed Out', resource_limit: 'Resource Limit',
  tool_unavailable: 'Server Unavailable', rate_limited: 'Rate Limited',
  internal: 'Internal Error', network: 'Connection Problem',
}

function ErrorPanel({ errorInfo }) {
  if (!errorInfo) return (
    <div className="empty-state"><CheckCircle size={26} /><p>No errors</p></div>
  )
  const { result, code = '' } = errorInfo
  const error     = result?.error || { message: 'Unknown error' }
  const badge     = CATEGORY_LABELS[error.category] || 'Error'
  const codeLines = code.split('\n')
  const lineCode  = error.line && codeLines[error.line - 1]

  return (
    <div className="error-card">
      <div className="error-title-row">
        <span className="error-badge">{badge}</span>
      </div>
      <div className="error-title">{error.type || 'Error'}: {error.message || ''}</div>
      {error.line && (
        <div className="error-location">
          Line {error.line}{error.column ? `, column ${error.column}` : ''}
        </div>
      )}
      {lineCode && <div className="error-code-line">{lineCode}</div>}
      {error.hint && (
        <div className="error-hint">
          <span>💡 {error.hint}</span>
        </div>
      )}
    </div>
  )
}

function DiagnosticsPanel({ diagnostics }) {
  if (!diagnostics.length) return (
    <div className="empty-state"><CheckCircle size={26} /><p>No warnings</p></div>
  )
  return (
    <div>
      {diagnostics.map((d, i) => (
        <div key={i} className={`diagnostic-item${d.severity === 'warning' ? ' warning' : ''}`}>
          <div className="diagnostic-loc">{d.line ? `Line ${d.line}${d.column ? ':' + d.column : ''}` : ''}</div>
          <div className="diagnostic-msg">{d.message}</div>
          {d.hint && <div className="diagnostic-msg" style={{ color: 'var(--accent)', marginTop: 3 }}>💡 {d.hint}</div>}
          {d.context?.length > 0 && <div className="diagnostic-context">{d.context.join('\n')}</div>}
        </div>
      ))}
    </div>
  )
}

function OutputPanel() {
  const { state } = useApp()
  const { traceData, currentStep } = state
  const text = traceData?.output || ''
  return (
    <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      <div className="card-header">
        <span className="card-title"><Terminal size={13} /> Console Output</span>
      </div>
      <div className="card-body" style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
        <div id="outputContent" style={{ flex: 1 }}>
          {text
            ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, whiteSpace: 'pre-wrap', color: '#d1fae5' }}>{text}</span>
            : <span className="console-waiting">(waiting for output...)</span>
          }
        </div>
      </div>
    </div>
  )
}

function InputPanel({ userInput, onUserInputChange }) {
  const { state } = useApp()
  const { hasInputStatements, language } = state
  const pattern = language === 'python' ? /input\s*\(/g : /\bcin\s*>>/g
  const count   = (userInput.match(pattern) || []).length

  if (!hasInputStatements) return (
    <div className="card">
      <div className="card-header"><span className="card-title"><Edit3 size={13} /> Program Input</span></div>
      <div className="card-body">
        <div className="empty-state"><Edit3 size={26} /><p>No inputs required</p></div>
      </div>
    </div>
  )
  return (
    <div className="card">
      <div className="card-header"><span className="card-title"><Edit3 size={13} /> Program Input</span></div>
      <div className="card-body">
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>
          Enter one value per line:
        </div>
        <textarea
          rows={Math.min(6, Math.max(2, count))}
          placeholder="Enter one value per line..."
          value={userInput}
          onChange={e => onUserInputChange(e.target.value)}
          style={{
            width: '100%', background: 'var(--bg-primary)', border: '1px solid var(--border)',
            borderRadius: 6, padding: '8px 10px', color: 'var(--text-primary)',
            fontFamily: 'var(--font-mono)', fontSize: 12.5, resize: 'vertical'
          }}
        />
      </div>
    </div>
  )
}

export default function RightPanel({ onHeapClick, userInput, onUserInputChange }) {
  const { state, dispatch } = useApp()
  const { activeTab, errorInfo, diagnostics, diagTabVisible, language } = state

  const tabs = [
    { id: 'visualization', label: 'Visualize',   Icon: LayoutGrid },
    { id: 'output',        label: 'Output',       Icon: Terminal },
    { id: 'input',         label: 'Input',        Icon: Keyboard },
    ...(diagTabVisible || language === 'cpp'
      ? [{ id: 'diagnostics', label: 'Warnings', Icon: ListChecks, badge: diagnostics.length || 0 }]
      : []),
    { id: 'error', label: 'Errors', Icon: AlertTriangle },
  ]

  return (
    <div className="right-panel">
      {/* Tab bar */}
      <div className="tabs">
        {tabs.map(({ id, label, Icon, badge }) => (
          <button
            key={id}
            className={`tab-btn${activeTab === id ? ' active' : ''}`}
            data-tab={id}
            onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: id })}
          >
            <Icon size={14} />{label}
            {badge > 0 && <span className="tab-badge">{badge}</span>}
          </button>
        ))}
      </div>

      {/* Panels */}
      <div className="tab-content">
        <div className={`tab-panel${activeTab === 'visualization' ? ' active' : ''}`} id="visualizationPanel">
          <div id="vizPanelContent" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <Visualizer onHeapClick={onHeapClick} />
          </div>
        </div>

        <div className={`tab-panel${activeTab === 'output' ? ' active' : ''}`} id="outputPanel">
          <OutputPanel />
        </div>

        <div className={`tab-panel${activeTab === 'input' ? ' active' : ''}`} id="inputPanel">
          <InputPanel userInput={userInput} onUserInputChange={onUserInputChange} />
        </div>

        <div className={`tab-panel${activeTab === 'diagnostics' ? ' active' : ''}`} id="diagnosticsPanel">
          <div className="card">
            <div className="card-header"><span className="card-title"><ListChecks size={13} /> Compiler Warnings</span></div>
            <div className="card-body"><DiagnosticsPanel diagnostics={diagnostics} /></div>
          </div>
        </div>

        <div className={`tab-panel${activeTab === 'error' ? ' active' : ''}`} id="errorPanel">
          <div className="card">
            <div className="card-header"><span className="card-title"><AlertTriangle size={13} /> Errors</span></div>
            <div className="card-body"><ErrorPanel errorInfo={errorInfo} /></div>
          </div>
        </div>
      </div>
    </div>
  )
}
