import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type ReactElement } from 'react'
import { ChevronLeft, ChevronRight, Clapperboard, Film, Pause, Play, SkipBack, SkipForward } from 'lucide-react'
import { Button, CloseButton, IconButton, Slider } from '../../../ui'
import type { CanvasTool, CanvasToolPanelProps } from './types'
import {
  clampTimelineTime,
  clipSpan,
  formatTimecode,
  normalizeClips,
  playheadRatio,
  stepFrames,
  stepSeconds,
  timelineTicks,
  timelineTracks
} from './timeline-model'
import { timelineText } from './timeline-text'
import './timeline.css'

const EDITABLE_TARGET = 'input, textarea, select, [role="textbox"], [contenteditable="true"]'

type VideoExportPhase =
  | { kind: 'idle' }
  | { kind: 'running'; id: string; frame: number; total: number }
  | { kind: 'done'; path: string }
  | { kind: 'failed'; error: string; detail?: string }

function newExportId(): string {
  return `export-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

const IDLE_EXPORT: VideoExportPhase = { kind: 'idle' }
const exportPhases = new Map<string, VideoExportPhase>()
const exportListeners = new Set<() => void>()
let exportProgressBound = false

function setExportPhase(abs: string, phase: VideoExportPhase): void {
  if (phase.kind === 'idle') exportPhases.delete(abs)
  else exportPhases.set(abs, phase)
  for (const listener of exportListeners) listener()
}

function bindExportProgress(): void {
  if (exportProgressBound) return
  exportProgressBound = true
  window.yan.videoExport.onProgress((progress) => {
    for (const [abs, phase] of exportPhases) {
      if (phase.kind === 'running' && phase.id === progress.id) {
        setExportPhase(abs, { kind: 'running', id: progress.id, frame: progress.frame, total: progress.total })
      }
    }
  })
}

function runningExportId(abs: string): string | null {
  const phase = exportPhases.get(abs)
  return phase?.kind === 'running' ? phase.id : null
}

function useVideoExport(abs: string, cwd: string): {
  phase: VideoExportPhase
  start: () => void
  cancel: () => void
  reset: () => void
} {
  const subscribe = useCallback((listener: () => void) => {
    bindExportProgress()
    exportListeners.add(listener)
    return () => {
      exportListeners.delete(listener)
    }
  }, [])
  const phase = useSyncExternalStore(subscribe, () => exportPhases.get(abs) ?? IDLE_EXPORT)

  const start = useCallback(() => {
    if (runningExportId(abs)) return
    const id = newExportId()
    setExportPhase(abs, { kind: 'running', id, frame: 0, total: 0 })
    window.yan.videoExport
      .start({ id, path: abs, cwd })
      .then((result) => {
        if (runningExportId(abs) !== id) return
        if (result.ok) setExportPhase(abs, { kind: 'done', path: result.path })
        else if (result.error === 'cancelled') setExportPhase(abs, IDLE_EXPORT)
        else setExportPhase(abs, { kind: 'failed', error: result.error, detail: result.detail })
      })
      .catch((error: unknown) => {
        if (runningExportId(abs) !== id) return
        setExportPhase(abs, { kind: 'failed', error: 'failed', detail: error instanceof Error ? error.message : String(error) })
      })
  }, [abs, cwd])

  const cancel = useCallback(() => {
    const id = runningExportId(abs)
    if (id) void window.yan.videoExport.cancel(id)
  }, [abs])

  const reset = useCallback(() => {
    if (!runningExportId(abs)) setExportPhase(abs, IDLE_EXPORT)
  }, [abs])

  return { phase, start, cancel, reset }
}

export function TimelinePanel({ context }: CanvasToolPanelProps): ReactElement | null {
  const text = timelineText(context.labels.lang)
  const composition = context.composition
  const total = composition && Number.isFinite(composition.duration) ? composition.duration : 0
  const time = Math.min(clampTimelineTime(context.currentTime ?? 0, total), total)
  const playing = context.playing
  const clips = useMemo(() => normalizeClips(composition?.clips ?? [], total), [composition, total])
  const tracks = useMemo(() => timelineTracks(clips), [clips])
  const ticks = useMemo(() => timelineTicks(total), [total])
  const live = useRef({ total, time, playing, context })
  live.current = { total, time, playing, context }
  const exporter = useVideoExport(context.abs, context.cwd)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || target.closest(EDITABLE_TARGET))) return
      const current = live.current
      if (!current.context.composition) return
      const inPanel = Boolean(target?.closest('[data-canvas-timeline]'))
      const key = event.key
      if (key === ' ' || key === 'Spacebar') {
        if (target?.closest('button')) return
        event.preventDefault()
        if (current.playing) current.context.pauseComposition()
        else current.context.playComposition()
        return
      }
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        if (inPanel) return
        event.preventDefault()
        const direction = key === 'ArrowLeft' ? -1 : 1
        const next = event.shiftKey
          ? stepSeconds(current.time, direction, current.total)
          : stepFrames(current.time, direction, current.total)
        current.context.seekComposition(next)
        return
      }
      if (key === 'Home' || key === 'End') {
        if (inPanel) return
        event.preventDefault()
        current.context.seekComposition(key === 'Home' ? 0 : current.total)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!composition) return null
  const exportedPath = exporter.phase.kind === 'done' ? exporter.phase.path : ''

  const seek = (value: number): void => {
    context.seekComposition(clampTimelineTime(value, total))
  }
  const toggle = (): void => {
    if (playing) context.pauseComposition()
    else context.playComposition()
  }
  const ratio = playheadRatio(time, total)

  return (
    <footer
      className="v3-canvas-timeline"
      data-canvas-interactive
      data-canvas-timeline
      role="region"
      aria-label={text.panelTitle}
      data-testid="v3-canvas-timeline"
    >
      <div className="v3-canvas-timeline-bar">
        <div className="v3-canvas-timeline-buttons">
          <IconButton size="sm" aria-label={text.start} tooltip={text.start} data-testid="v3-canvas-timeline-start" onPress={() => seek(0)}>
            <SkipBack size={14} />
          </IconButton>
          <IconButton
            size="sm"
            aria-label={text.prevFrame}
            tooltip={text.prevFrame}
            data-testid="v3-canvas-timeline-prev"
            onPress={() => seek(stepFrames(time, -1, total))}
          >
            <ChevronLeft size={14} />
          </IconButton>
          <IconButton
            size="sm"
            variant="secondary"
            aria-label={playing ? text.pause : text.play}
            tooltip={playing ? text.pause : text.play}
            aria-pressed={playing}
            data-testid="v3-canvas-timeline-play"
            onPress={toggle}
          >
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </IconButton>
          <IconButton
            size="sm"
            aria-label={text.nextFrame}
            tooltip={text.nextFrame}
            data-testid="v3-canvas-timeline-next"
            onPress={() => seek(stepFrames(time, 1, total))}
          >
            <ChevronRight size={14} />
          </IconButton>
          <IconButton size="sm" aria-label={text.end} tooltip={text.end} data-testid="v3-canvas-timeline-end" onPress={() => seek(total)}>
            <SkipForward size={14} />
          </IconButton>
        </div>
        <span className="v3-canvas-timeline-clock" data-testid="v3-canvas-timeline-clock" title={text.keys}>
          <span className="v3-canvas-timeline-now">{formatTimecode(time)}</span>
          <span className="v3-canvas-timeline-total">/ {formatTimecode(total)}</span>
        </span>
        <Slider
          className="v3-canvas-timeline-scrub"
          aria-label={text.scrub}
          minValue={0}
          maxValue={total > 0 ? total : 1}
          step={0.01}
          value={time}
          onChange={(value) => seek(typeof value === 'number' ? value : value[0] ?? 0)}
          data-testid="v3-canvas-timeline-scrub"
        />
      </div>
      <div className="v3-canvas-timeline-scroll">
        <div className="v3-canvas-timeline-grid">
          <div className="v3-canvas-timeline-row" data-role="ruler">
            <span className="v3-canvas-timeline-track-label" aria-hidden />
            <div className="v3-canvas-timeline-lane" aria-hidden>
              {ticks.map((tick) => (
                <span
                  key={tick.t}
                  className="v3-canvas-timeline-tick"
                  data-major={tick.major || undefined}
                  style={{ left: `${total > 0 ? (tick.t / total) * 100 : 0}%` }}
                >
                  {tick.major ? <em>{formatTimecode(tick.t)}</em> : null}
                </span>
              ))}
            </div>
          </div>
          {tracks.map((track) => (
            <div className="v3-canvas-timeline-row" key={track.track} data-testid={`v3-canvas-timeline-track-${track.track}`}>
              <span className="v3-canvas-timeline-track-label">{text.trackLabel(track.track)}</span>
              <div
                className="v3-canvas-timeline-lane"
                role="group"
                aria-label={text.trackLabel(track.track)}
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest('[data-timeline-clip]')) return
                  const box = event.currentTarget.getBoundingClientRect()
                  if (!(box.width > 0)) return
                  seek(((event.clientX - box.left) / box.width) * total)
                }}
              >
                {track.clips.map((clip, index) => {
                  const span = clipSpan(clip, total)
                  const label = clip.label || clip.id || text.trackLabel(track.track)
                  return (
                    <button
                      key={`${track.track}-${index}-${clip.start}`}
                      type="button"
                      className="v3-canvas-timeline-clip"
                      data-timeline-clip={clip.id || undefined}
                      data-testid="v3-canvas-timeline-clip"
                      style={{ left: `${span.left * 100}%`, width: `${span.width * 100}%` }}
                      title={text.clipHint(label, formatTimecode(span.start), formatTimecode(span.end))}
                      aria-label={text.clipHint(label, formatTimecode(span.start), formatTimecode(span.end))}
                      onClick={(event) => {
                        event.stopPropagation()
                        seek(clip.start)
                      }}
                    >
                      <span className="v3-canvas-timeline-clip-label">{label}</span>
                    </button>
                  )
                })}
                <span className="v3-canvas-timeline-playhead" style={{ left: `${ratio * 100}%` }} aria-hidden />
              </div>
            </div>
          ))}
          {composition.hasTimeline ? null : <p className="v3-canvas-timeline-note">{text.fallback}</p>}
        </div>
      </div>
      <div className="v3-canvas-timeline-foot">
        <span className="v3-canvas-timeline-count">{text.clipCount(clips.length)}</span>
        <div className="v3-canvas-timeline-export" data-testid="v3-canvas-timeline-export">
          {exporter.phase.kind === 'idle' ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<Film size={14} />}
              tooltip={text.exportHint}
              data-testid="v3-canvas-timeline-export-start"
              isDisabled={context.generating}
              onPress={exporter.start}
            >
              {text.exportVideo}
            </Button>
          ) : null}
          {exporter.phase.kind === 'running' ? (
            <>
              <span className="v3-canvas-timeline-export-status" data-testid="v3-canvas-timeline-export-progress">
                {text.exporting(exporter.phase.frame, exporter.phase.total)}
              </span>
              <CloseButton
                size="sm"
                aria-label={text.exportCancel}
                tooltip={text.exportCancel}
                data-testid="v3-canvas-timeline-export-cancel"
                onPress={exporter.cancel}
              />
            </>
          ) : null}
          {exporter.phase.kind === 'done' ? (
            <>
              <span className="v3-canvas-timeline-export-status" data-testid="v3-canvas-timeline-export-done">
                {text.exportReady(fileNameOf(exportedPath))}
              </span>
              <Button size="sm" variant="ghost" onPress={() => void window.yan.openPath(exportedPath)}>
                {text.exportOpen}
              </Button>
              <Button size="sm" variant="ghost" onPress={() => void window.yan.revealPath(exportedPath)}>
                {text.exportReveal}
              </Button>
              <CloseButton size="sm" aria-label={text.exportDismiss} tooltip={text.exportDismiss} onPress={exporter.reset} />
            </>
          ) : null}
          {exporter.phase.kind === 'failed' ? (
            <>
              <span
                className="v3-canvas-timeline-export-status"
                data-tone="error"
                data-testid="v3-canvas-timeline-export-error"
                title={exporter.phase.detail ?? exporter.phase.error}
              >
                {text.exportFailed(
                  exporter.phase.error === 'ffmpeg-missing' ? text.exportFfmpegMissing : exporter.phase.detail ?? exporter.phase.error
                )}
              </span>
              <CloseButton size="sm" aria-label={text.exportDismiss} tooltip={text.exportDismiss} onPress={exporter.reset} />
            </>
          ) : null}
        </div>
        <span className="v3-canvas-timeline-keys">{text.keys}</span>
      </div>
    </footer>
  )
}

export const timelineTool: CanvasTool = {
  id: 'timeline',
  icon: Clapperboard,
  label: (labels) => timelineText(labels.lang).tool,
  shortcut: 't',
  frameInput: 'none',
  available: (context) => context.composition !== null,
  Panel: TimelinePanel
}
