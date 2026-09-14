import React, { createContext, useContext, useReducer, useRef } from 'react'

const DEFAULT_API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000'
export const REQUEST_TIMEOUT_MS = { python: 15000, cpp: 25000 }
export const FILE_EXT = { python: 'main.py', cpp: 'main.cpp' }

const initialState = {
  apiUrl:                localStorage.getItem('codeviz_api_url') || DEFAULT_API_URL,
  language:              localStorage.getItem('codeviz_language') || 'python',
  theme:                 localStorage.getItem('codeviz_theme') || 'dark',

  // Trace data
  traceData:             null,
  currentStep:           0,
  isVisualizing:         false,
  playSpeed:             1,
  isPlaying:             false,

  // Output reveal
  outputLines:           [],
  currentOutputLineIdx:  0,

  // Right panel
  activeTab:             'visualization',
  errorInfo:             null,   // { result, code }
  diagnostics:           [],
  diagTabVisible:        false,
  stepProgressTitle:     '',

  // Status
  status:                'ready',   // ready | tracing | running | error | offline
  backendOnline:         null,
  languagesInfo:         null,
  cppDegraded:           false,
  cppDegradedNote:       '',
  offlineBannerVisible:  false,

  // Modals
  settingsOpen:          false,
  shortcutsOpen:         false,

  // User input (for programs that use input())
  userInput:             '',
  hasInputStatements:    false,
}

function reducer(state, action) {
  switch (action.type) {
    case 'SET_LANGUAGE':          return { ...state, language: action.language }
    case 'SET_THEME':             return { ...state, theme: action.theme }
    case 'SET_API_URL':           return { ...state, apiUrl: action.url }
    case 'SET_STATUS':            return { ...state, status: action.status }
    case 'SET_BACKEND_ONLINE':    return { ...state, backendOnline: action.online, offlineBannerVisible: action.online === false }
    case 'SET_LANGUAGES_INFO':    return { ...state, languagesInfo: action.info }
    case 'SET_CPP_DEGRADED':      return { ...state, cppDegraded: action.degraded, cppDegradedNote: action.note || '' }
    case 'SET_ACTIVE_TAB':        return { ...state, activeTab: action.tab }
    case 'SET_ERROR':             return { ...state, errorInfo: action.payload, activeTab: action.payload ? 'error' : state.activeTab }
    case 'CLEAR_ERROR':           return { ...state, errorInfo: null, activeTab: state.activeTab === 'error' ? 'visualization' : state.activeTab }
    case 'SET_DIAGNOSTICS':       return { ...state, diagnostics: action.diagnostics, diagTabVisible: action.diagnostics.length > 0 }
    case 'CLEAR_DIAGNOSTICS':     return { ...state, diagnostics: [], diagTabVisible: false }
    case 'SET_STEP_PROGRESS_TITLE': return { ...state, stepProgressTitle: action.title }
    case 'START_VISUALIZING':
      return {
        ...state,
        isVisualizing:     true,
        status:            'tracing',
        traceData:         null,
        currentStep:       0,
        outputLines:       [],
        currentOutputLineIdx: 0,
        errorInfo:         null,
        diagnostics:       [],
        diagTabVisible:    false,
      }
    case 'TRACE_SUCCESS':
      return {
        ...state,
        traceData:           action.data,
        currentStep:         0,
        outputLines:         action.data.output ? action.data.output.split('\n') : [],
        currentOutputLineIdx: 0,
        status:              'running',
        isVisualizing:       true,
        activeTab:           action.data.no_step_trace ? 'output' : 'visualization',
      }
    case 'EXIT_VISUALIZATION':
      return {
        ...state,
        isVisualizing:       false,
        traceData:           null,
        currentStep:         0,
        outputLines:         [],
        currentOutputLineIdx: 0,
        isPlaying:           false,
        status:              state.backendOnline === false ? 'offline' : 'ready',
      }
    case 'SET_STEP':
      return { ...state, currentStep: action.step }
    case 'SET_PLAY_SPEED':        return { ...state, playSpeed: action.speed }
    case 'SET_PLAYING':           return { ...state, isPlaying: action.playing }
    case 'SET_USER_INPUT':        return { ...state, userInput: action.value }
    case 'SET_HAS_INPUT':         return { ...state, hasInputStatements: action.has }
    case 'ADVANCE_OUTPUT_LINE':
      return { ...state, currentOutputLineIdx: Math.min(state.currentOutputLineIdx + 1, state.outputLines.length) }
    case 'OPEN_SETTINGS':         return { ...state, settingsOpen: true }
    case 'CLOSE_SETTINGS':        return { ...state, settingsOpen: false }
    case 'OPEN_SHORTCUTS':        return { ...state, shortcutsOpen: true }
    case 'CLOSE_SHORTCUTS':       return { ...state, shortcutsOpen: false }
    default:                      return state
  }
}

const AppContext = createContext(null)

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  // Ref to the textarea DOM node — passed down for line-number sync
  const editorRef = useRef(null)

  return (
    <AppContext.Provider value={{ state, dispatch, editorRef }}>
      {children}
    </AppContext.Provider>
  )
}

export function useApp() {
  return useContext(AppContext)
}
