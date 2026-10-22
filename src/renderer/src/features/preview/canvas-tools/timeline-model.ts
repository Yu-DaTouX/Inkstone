import type { CanvasComposition, CanvasCompositionClip } from '../../../../../shared/html-canvas-bridge'

export const TIMELINE_FPS = 30
export const TIMELINE_SCRUB_STEP = 0.01
export const TIMELINE_MIN_CLIP_RATIO = 0.006

export interface TimelineTrack {
  track: number
  clips: CanvasCompositionClip[]
}

export interface TimelineTick {
  t: number
  major: boolean
}

export interface TimelineClipSpan {
  start: number
  end: number
  left: number
  width: number
}

function spanOf(total: number): number {
  return Number.isFinite(total) && total > 0 ? total : 0
}

export function clampTimelineTime(seconds: number, total: number): number {
  const span = spanOf(total)
  if (!Number.isFinite(seconds) || !(seconds > 0)) return 0
  if (span > 0 && seconds > span) return span
  return seconds
}

function pad(value: number, size = 2): string {
  return String(Math.floor(Math.abs(value))).padStart(size, '0')
}

export function formatTimecode(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const hundredths = Math.round(safe * 100)
  const minutes = Math.floor(hundredths / 6000)
  const rest = hundredths - minutes * 6000
  return `${pad(minutes)}:${pad(Math.floor(rest / 100))}.${pad(rest % 100)}`
}

export function formatSeconds(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  return safe.toFixed(2)
}

export function normalizeClips(clips: readonly CanvasCompositionClip[], total: number): CanvasCompositionClip[] {
  const span = spanOf(total)
  const out: CanvasCompositionClip[] = []
  for (const clip of clips ?? []) {
    if (!clip || typeof clip !== 'object') continue
    const start = Number(clip.start)
    if (!Number.isFinite(start) || start < 0) continue
    const from = span > 0 ? Math.min(start, span) : start
    const rawDuration = Number(clip.duration)
    const length =
      Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : span > 0 ? Math.max(0, span - from) : 0
    if (!(length > 0)) continue
    const end = span > 0 ? Math.min(from + length, span) : from + length
    if (!(end > from)) continue
    const rawTrack = Number(clip.track)
    const track = Number.isFinite(rawTrack) && rawTrack >= 0 ? Math.floor(rawTrack) : 0
    out.push({
      id: typeof clip.id === 'string' ? clip.id : '',
      label: typeof clip.label === 'string' ? clip.label : '',
      start: from,
      duration: end - from,
      track
    })
  }
  return out.sort((a, b) => a.start - b.start || a.track - b.track)
}

export function timelineTracks(clips: readonly CanvasCompositionClip[]): TimelineTrack[] {
  const groups = new Map<number, CanvasCompositionClip[]>()
  for (const clip of clips) {
    const list = groups.get(clip.track)
    if (list) list.push(clip)
    else groups.set(clip.track, [clip])
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([track, list]) => ({ track, clips: [...list].sort((a, b) => a.start - b.start) }))
}

export function stepFrames(seconds: number, direction: 1 | -1, total: number, fps = TIMELINE_FPS): number {
  const step = 1 / (Number.isFinite(fps) && fps > 0 ? fps : TIMELINE_FPS)
  const base = Number.isFinite(seconds) ? seconds : 0
  const next = Math.round((base + direction * step) * 1000) / 1000
  return clampTimelineTime(next, total)
}

export function stepSeconds(seconds: number, direction: 1 | -1, total: number, step = 1): number {
  const base = Number.isFinite(seconds) ? seconds : 0
  const next = Math.round((base + direction * step) * 1000) / 1000
  return clampTimelineTime(next, total)
}

export function playheadRatio(seconds: number, total: number): number {
  const span = spanOf(total)
  if (!span) return 0
  return Math.min(1, Math.max(0, seconds / span))
}

export function clipSpan(clip: Pick<CanvasCompositionClip, 'start' | 'duration'>, total: number): TimelineClipSpan {
  const span = spanOf(total)
  const start = Math.max(0, clip.start)
  const end = Math.max(start, start + clip.duration)
  if (!span) return { start, end, left: 0, width: TIMELINE_MIN_CLIP_RATIO }
  const left = Math.min(1, Math.max(0, start / span))
  const right = Math.min(1, Math.max(left, end / span))
  return { start, end, left, width: Math.max(TIMELINE_MIN_CLIP_RATIO, right - left) }
}

export function timelineTicks(total: number): TimelineTick[] {
  const span = spanOf(total)
  if (!span) return []
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60]
  const step = steps.find((candidate) => span / candidate <= 10) ?? steps[steps.length - 1]
  const ticks: TimelineTick[] = []
  let index = 0
  for (let t = 0; t <= span + 1e-6 && index < 64; t += step) {
    ticks.push({ t: Math.round(t * 1000) / 1000, major: index % 5 === 0 })
    index++
  }
  return ticks
}

export function sameComposition(a: CanvasComposition | null, b: CanvasComposition | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.id !== b.id || a.width !== b.width || a.height !== b.height || a.duration !== b.duration) return false
  if (a.hasTimeline !== b.hasTimeline) return false
  if (a.clips.length !== b.clips.length) return false
  for (let index = 0; index < a.clips.length; index++) {
    const left = a.clips[index]
    const right = b.clips[index]
    if (
      left.id !== right.id ||
      left.label !== right.label ||
      left.start !== right.start ||
      left.duration !== right.duration ||
      left.track !== right.track
    ) {
      return false
    }
  }
  return true
}

export function compositionSignature(composition: CanvasComposition | null): string {
  if (!composition) return ''
  return [
    composition.id,
    composition.width,
    composition.height,
    composition.duration,
    composition.hasTimeline ? 1 : 0,
    composition.clips.map((clip) => `${clip.track}:${clip.start}:${clip.duration}:${clip.label}`).join(',')
  ].join('|')
}
