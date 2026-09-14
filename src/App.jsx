import React, { useEffect, useRef, useCallback, useState } from 'react'
import { AppProvider, useApp, FILE_EXT } from './context/AppContext'
import { checkHealth, fetchLanguagesInfo, postTrace, NetworkIssue } from './api/client'
import Header from './components/Header'
import Editor from './components/Editor'
import Controls from './components/Controls'
import RightPanel from './components/RightPanel'
import { SettingsModal, ShortcutsModal } from './components/Modals'

function AppInner() {
  const { state, dispatch, editorRef } = useApp()
  const {
    apiUrl, language, theme, isVisualizing, traceData, currentStep,
    playSpeed, isPlaying, backendOnline, languagesInfo,
  } = state

  // User input for programs that read from stdin
  const [userInput, setUserInput] = useState('')

  // Auto-play interval ref
  const playIntervalRef = useRef(null)

  // ── Theme ──────────────────────────────────────────────────────────────
  useEffect(() => {
    document.body.setAttribute('data-theme', theme)
    localStorage.setItem('codeviz_theme', theme)
  }, [theme])

  // ── Health check ───────────────────────────────────────────────────────
  const doHealthCheck = useCallback(async () => {
    const online = await checkHealth(apiUrl)
    dispatch({ type: 'SET_BACKEND_ONLINE', online })
    if (online) {
      const info = await fetchLanguagesInfo(apiUrl)
      if (info) {
        dispatch({ type: 'SET_LANGUAGES_INFO', info })
        const cppDegraded = info.cpp?.available && !info.cpp?.trace
        dispatch({ type: 'SET_CPP_DEGRADED', degraded: cppDegraded, note: info.cpp?.note || '' })
        if (!info.cpp?.available && language === 'cpp') {
          dispatch({ type: 'SET_LANGUAGE', language: 'python' })
        }
      }
    }
  }, [apiUrl, dispatch, language])

  useEffect(() => {
    doHealthCheck()
    const online  = () => doHealthCheck()
    const offline = () => dispatch({ type: 'SET_BACKEND_ONLINE', online: false })
    window.addEventListener('online',  online)
    window.addEventListener('offline', offline)
    return () => { window.removeEventListener('online', online); window.removeEventListener('offline', offline) }
  }, [doHealthCheck, dispatch])

  // Re-check health when apiUrl changes (saved from settings)
  useEffect(() => { doHealthCheck() }, [apiUrl])

  // ── Language ───────────────────────────────────────────────────────────
  const handleSelectLanguage = useCallback((lang) => {
    if (isVisualizing) handleExit()
    dispatch({ type: 'SET_LANGUAGE', language: lang })
    localStorage.setItem('codeviz_language', lang)
    if (editorRef.current) editorRef.current.value = ''
  }, [isVisualizing, dispatch, editorRef])

  // ── Trace ──────────────────────────────────────────────────────────────
  const handleTrace = useCallback(async () => {
    const ta = editorRef.current
    if (!ta) return
    const code = ta.value.trim()
    if (!code) return

    if (isVisualizing) {
      handleExit()
      setTimeout(() => startTrace(code), 80)
    } else {
      startTrace(code)
    }
  }, [isVisualizing, editorRef, apiUrl, language, userInput, backendOnline])

  async function startTrace(code) {
    if (backendOnline === false) {
      const ok = await checkHealth(apiUrl)
      dispatch({ type: 'SET_BACKEND_ONLINE', online: ok })
      if (!ok) return
    }

    dispatch({ type: 'START_VISUALIZING' })

    try {
      const { body } = await postTrace(apiUrl, language, code, userInput)

      if (!body.success) {
        dispatch({ type: 'SET_ERROR', payload: { result: body, code } })
        if (body.diagnostics?.length) dispatch({ type: 'SET_DIAGNOSTICS', diagnostics: body.diagnostics })
        dispatch({ type: 'SET_STATUS', status: 'error' })
        dispatch({ type: 'EXIT_VISUALIZATION' })
        return
      }

      const data = body.data
      if (data.compiler_warnings?.length)
        dispatch({ type: 'SET_DIAGNOSTICS', diagnostics: data.compiler_warnings })

      dispatch({ type: 'TRACE_SUCCESS', data })

    } catch (err) {
      const message = err instanceof NetworkIssue ? err.message : 'Unexpected error contacting the backend.'
      dispatch({ type: 'SET_ERROR', payload: { result: { error: { message, category: 'network', hint: 'Check Settings.' } }, code } })
      dispatch({ type: 'SET_BACKEND_ONLINE', online: false })
      dispatch({ type: 'SET_STATUS', status: 'error' })
      dispatch({ type: 'EXIT_VISUALIZATION' })
    }
  }

  // ── Exit visualization ─────────────────────────────────────────────────
  const handleExit = useCallback(() => {
    stopAutoPlay()
    dispatch({ type: 'EXIT_VISUALIZATION' })
    if (editorRef.current) editorRef.current.focus()
  }, [dispatch, editorRef])

  // ── Step navigation ────────────────────────────────────────────────────
  const totalSteps = traceData?.steps?.length ?? 0

  const goToStep = useCallback((idx) => {
    if (!traceData) return
    const resolved = idx === -1 ? totalSteps - 1 : Math.max(0, Math.min(idx, totalSteps - 1))
    dispatch({ type: 'SET_STEP', step: resolved })

    // Advance output reveal heuristic
    const step = traceData.steps[resolved]
    if (step && /print\s*\(|cout\s*<</.test(step.code || '')) {
      dispatch({ type: 'ADVANCE_OUTPUT_LINE' })
    }
  }, [traceData, totalSteps, dispatch])

  const nextStep = useCallback(() => {
    if (!traceData || currentStep >= totalSteps - 1) return
    goToStep(currentStep + 1)
  }, [traceData, currentStep, totalSteps, goToStep])

  const prevStep = useCallback(() => {
    if (!traceData || currentStep <= 0) return
    goToStep(currentStep - 1)
  }, [traceData, currentStep, goToStep])

  // ── Auto-play ──────────────────────────────────────────────────────────
  function stopAutoPlay() {
    if (playIntervalRef.current) {
      clearInterval(playIntervalRef.current)
      playIntervalRef.current = null
    }
    dispatch({ type: 'SET_PLAYING', playing: false })
  }

  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      stopAutoPlay()
    } else {
      if (!traceData || currentStep >= totalSteps - 1) return
      dispatch({ type: 'SET_PLAYING', playing: true })
      playIntervalRef.current = setInterval(() => {
        dispatch(prev => {
          // Use functional update pattern via a ref instead
        })
      }, 1000 / playSpeed)
    }
  }, [isPlaying, traceData, currentStep, totalSteps, playSpeed, dispatch])

  // Better auto-play using a ref for currentStep to avoid stale closure
  const currentStepRef = useRef(currentStep)
  currentStepRef.current = currentStep
  const isPlayingRef = useRef(isPlaying)
  isPlayingRef.current = isPlaying

  useEffect(() => {
    if (!isPlaying) return
    const id = setInterval(() => {
      const step = currentStepRef.current
      const total = traceData?.steps?.length ?? 0
      if (step >= total - 1) {
        clearInterval(id)
        dispatch({ type: 'SET_PLAYING', playing: false })
      } else {
        goToStep(step + 1)
      }
    }, 1000 / playSpeed)
    return () => clearInterval(id)
  }, [isPlaying, playSpeed, traceData, goToStep, dispatch])

  const handlePlayPauseFixed = useCallback(() => {
    if (isPlaying) {
      dispatch({ type: 'SET_PLAYING', playing: false })
    } else {
      if (!traceData || currentStep >= totalSteps - 1) return
      dispatch({ type: 'SET_PLAYING', playing: true })
    }
  }, [isPlaying, traceData, currentStep, totalSteps, dispatch])

  // ── Keyboard shortcuts ─────────────────────────────────────────────────
  useEffect(() => {
    const handler = e => {
      const inField = e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT'
      if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); handleTrace(); return }
      if (inField) return
      if (e.key === 'ArrowRight') { e.preventDefault(); nextStep() }
      else if (e.key === 'ArrowLeft')  { e.preventDefault(); prevStep() }
      else if (e.key === ' ')          { e.preventDefault(); handlePlayPauseFixed() }
      else if (e.key === 'Home')       { e.preventDefault(); goToStep(0) }
      else if (e.key === 'End')        { e.preventDefault(); goToStep(-1) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleTrace, nextStep, prevStep, handlePlayPauseFixed, goToStep])

  // ── Copy code ──────────────────────────────────────────────────────────
  const handleCopy = useCallback(() => {
    const code = editorRef.current?.value || ''
    navigator.clipboard?.writeText(code).catch(() => {})
  }, [editorRef])

  // ── Heap click ─────────────────────────────────────────────────────────
  const handleHeapClick = useCallback((id) => {
    dispatch({ type: 'SET_ACTIVE_TAB', tab: 'visualization' })
    setTimeout(() => {
      const el = document.getElementById('heap-obj-' + id)
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        el.style.outline = '2px solid var(--accent)'
        setTimeout(() => { el.style.outline = '' }, 900)
      }
    }, 50)
  }, [dispatch])

  // ── Theme toggle ───────────────────────────────────────────────────────
  const handleToggleTheme = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark'
    dispatch({ type: 'SET_THEME', theme: next })
  }, [theme, dispatch])

  // ── Banners ────────────────────────────────────────────────────────────
  const { offlineBannerVisible, cppDegraded, cppDegradedNote } = state

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <Header
        onSelectLanguage={handleSelectLanguage}
        onToggleTheme={handleToggleTheme}
        onOpenShortcuts={() => dispatch({ type: 'OPEN_SHORTCUTS' })}
        onOpenSettings={() => dispatch({ type: 'OPEN_SETTINGS' })}
      />

      <main className="main">
        {/* LEFT */}
        <div className="left-panel">
          {offlineBannerVisible && (
            <div className="banner warn show">
              <span>
                Can't reach the backend at <b>{apiUrl}</b>.{' '}
                <a href="#" style={{ color: 'inherit' }} onClick={e => { e.preventDefault(); doHealthCheck() }}>retry</a>
                {' '}or open Settings to change the URL.
              </span>
            </div>
          )}
          {cppDegraded && cppDegradedNote && (
            <div className="banner info show">
              <span>{cppDegradedNote}</span>
            </div>
          )}

          <Editor onTrace={handleTrace} onEdit={handleExit} onCopy={handleCopy} />
          <Controls
            onTrace={handleTrace}
            onFirst={() => goToStep(0)}
            onPrev={prevStep}
            onPlay={handlePlayPauseFixed}
            onNext={nextStep}
            onLast={() => goToStep(-1)}
            onSeek={goToStep}
            onSpeed={s => dispatch({ type: 'SET_PLAY_SPEED', speed: s })}
          />
        </div>

        {/* RIGHT */}
        <RightPanel
          onHeapClick={handleHeapClick}
          userInput={userInput}
          onUserInputChange={setUserInput}
        />
      </main>

      <SettingsModal />
      <ShortcutsModal />
    </div>
  )
}

export default function App() {
  return (
    <AppProvider>
      <AppInner />
    </AppProvider>
  )
}
