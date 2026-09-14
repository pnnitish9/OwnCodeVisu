import React from 'react'
import {
  Play, Pause, SkipBack, SkipForward, ChevronLeft, ChevronRight
} from 'lucide-react'
import { useApp } from '../context/AppContext'

export default function Controls({ onTrace, onFirst, onPrev, onPlay, onNext, onLast, onSeek, onSpeed }) {
  const { state } = useApp()
  const { isVisualizing, traceData, currentStep, playSpeed, isPlaying, status } = state

  const totalSteps = traceData?.steps?.length ?? 0
  const hasTrace   = !!traceData && totalSteps > 0
  const atStart    = currentStep <= 0
  const atEnd      = currentStep >= totalSteps - 1

  const traceBtnLabel = isVisualizing ? 'Re-Trace' : 'Trace & Visualize'
  const tracing       = status === 'tracing'

  return (
    <div className="controls-card">
      {/* Trace button */}
      <div className="trace-row">
        <button id="traceBtn" onClick={onTrace} disabled={tracing}>
          <Play size={14} />
          <span>{traceBtnLabel}</span>
        </button>
      </div>

      {/* Playback row */}
      <div className="playback-row">
        <button className="nav-btn" onClick={onFirst} disabled={!hasTrace || atStart} title="First step (Home)">
          <SkipBack size={16} />
        </button>
        <button className="nav-btn" onClick={onPrev} disabled={!hasTrace || atStart} title="Previous (←)">
          <ChevronLeft size={16} />
        </button>
        <button className="nav-btn" id="playBtn" onClick={onPlay} disabled={!hasTrace} title="Play/Pause (Space)"
          style={{ background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' }}>
          {isPlaying ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button className="nav-btn" onClick={onNext} disabled={!hasTrace || atEnd} title="Next (→)">
          <ChevronRight size={16} />
        </button>
        <button className="nav-btn" onClick={onLast} disabled={!hasTrace || atEnd} title="Last step (End)">
          <SkipForward size={16} />
        </button>

        <div className="speed-group">
          {[0.5, 1, 2, 4].map(s => (
            <button
              key={s}
              className={`speed-btn${playSpeed === s ? ' active' : ''}`}
              onClick={() => onSpeed(s)}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>

      {/* Timeline */}
      <div className="timeline-row">
        <input
          type="range"
          id="timelineSlider"
          min={0}
          max={Math.max(0, totalSteps - 1)}
          value={hasTrace ? currentStep : 0}
          disabled={!hasTrace}
          onChange={e => onSeek(parseInt(e.target.value, 10))}
        />
        <span id="timelineValue">
          {hasTrace ? `Step ${currentStep + 1} / ${totalSteps}` : 'Step 0 / 0'}
        </span>
      </div>
    </div>
  )
}
