import React, { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import { useApp } from '../context/AppContext'

function ModalOverlay({ show, onClose, children }) {
  // Close on backdrop click or Escape
  useEffect(() => {
    if (!show) return
    const handler = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [show, onClose])

  if (!show) return null
  return (
    <div className="modal-overlay show" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal">{children}</div>
    </div>
  )
}

export function SettingsModal() {
  const { state, dispatch } = useApp()
  const [draft, setDraft] = useState(state.apiUrl)

  useEffect(() => { if (state.settingsOpen) setDraft(state.apiUrl) }, [state.settingsOpen, state.apiUrl])

  function save() {
    const val = draft.trim().replace(/\/+$/, '')
    if (val) {
      dispatch({ type: 'SET_API_URL', url: val })
      localStorage.setItem('codeviz_api_url', val)
    }
    dispatch({ type: 'CLOSE_SETTINGS' })
    // checkHealth will be triggered by App effect watching apiUrl
  }

  return (
    <ModalOverlay show={state.settingsOpen} onClose={() => dispatch({ type: 'CLOSE_SETTINGS' })}>
      <div className="modal-header">
        <h3>Settings</h3>
        <button className="modal-close" onClick={() => dispatch({ type: 'CLOSE_SETTINGS' })}><X size={16} /></button>
      </div>
      <div className="modal-body">
        <div className="settings-row">
          <span className="settings-hint">No any settings available.</span>
        </div>
        <div className="modal-actions">
          <button onClick={() => dispatch({ type: 'CLOSE_SETTINGS' })}>Cancel</button>
          <button className="primary" onClick={save}>Save</button>
        </div>
      </div>
    </ModalOverlay>
  )
}

export function ShortcutsModal() {
  const { state, dispatch } = useApp()
  const close = () => dispatch({ type: 'CLOSE_SHORTCUTS' })
  return (
    <ModalOverlay show={state.shortcutsOpen} onClose={close}>
      <div className="modal-header">
        <h3>Keyboard Shortcuts</h3>
        <button className="modal-close" onClick={close}><X size={16} /></button>
      </div>
      <div className="modal-body">
        <div className="shortcuts-list">
          {[
            ['Next step', '→'],
            ['Previous step', '←'],
            ['Play / Pause', 'Space'],
            ['First step', 'Home'],
            ['Last step', 'End'],
            ['Trace / Re-trace', 'Ctrl + Enter'],
          ].map(([label, key]) => (
            <div className="row" key={label}>
              <span>{label}</span>
              <span className="kbd">{key}</span>
            </div>
          ))}
        </div>
      </div>
    </ModalOverlay>
  )
}
