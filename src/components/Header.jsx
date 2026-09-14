import React from 'react'
import { Binary, Moon, Sun, Keyboard, Settings } from 'lucide-react'
import { useApp } from '../context/AppContext'
import { FILE_EXT } from '../context/AppContext'

export default function Header({ onSelectLanguage, onToggleTheme, onOpenShortcuts, onOpenSettings }) {
  const { state } = useApp()
  const { language, theme, status, traceData, currentStep, backendOnline, cppDegraded, languagesInfo } = state

  const statusLabel = {
    ready:   'Status: Ready',
    tracing: 'Status: Tracing...',
    running: 'Status: Running',
    error:   'Status: Error',
    offline: 'Status: Backend Offline',
  }[status] || 'Status: Ready'

  const dotClass = ['status-dot',
    status === 'ready'   ? 'idle'    : '',
    status === 'error'   ? 'error'   : '',
    status === 'offline' ? 'offline' : '',
  ].filter(Boolean).join(' ')

  const stepText = traceData
    ? `Step ${currentStep + 1} / ${traceData.steps.length}`
    : ''

  const cppAvailable = languagesInfo?.cpp?.available !== false

  return (
    <header className="header">
      <div className="header-left">
        <div className="logo">
          <Binary size={20} style={{ color: 'var(--accent)' }} />
          <span>CodeViz</span>
        </div>
        <div className="lang-switch">
          <button
            className={`lang-btn ${language === 'python' ? 'active' : ''}`}
            onClick={() => onSelectLanguage('python')}
          >
            🐍 Python
          </button>
          <button
            className={`lang-btn ${language === 'cpp' ? 'active' : ''} ${cppDegraded ? 'degraded' : ''}`}
            onClick={() => onSelectLanguage('cpp')}
            disabled={!cppAvailable}
          >
            {cppDegraded && <span className="dot" />}
            ⚙️ C++
          </button>
        </div>
      </div>

      <div className="header-center">
        <div className="status-indicator">
          <span className={dotClass} />
          <span>{statusLabel}</span>
        </div>
        {stepText && <div className="step-progress">{stepText}</div>}
      </div>

      <div className="header-right">
        <button className="icon-btn" onClick={onToggleTheme} title="Toggle theme" aria-label="Toggle theme">
          {theme === 'dark' ? <Moon size={17} /> : <Sun size={17} />}
        </button>
        <button className="icon-btn" onClick={onOpenShortcuts} title="Keyboard shortcuts" aria-label="Keyboard shortcuts">
          <Keyboard size={17} />
        </button>
        <button className="icon-btn" onClick={onOpenSettings} title="Settings" aria-label="Settings">
          <Settings size={17} />
        </button>
      </div>
    </header>
  )
}
