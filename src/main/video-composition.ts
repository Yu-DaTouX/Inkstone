export interface VideoClipTiming {
  start: number
  duration: number
}

export interface VideoCompositionInfo {
  id: string
  width: number
  height: number
  duration: number
  ready: boolean
  clips: VideoClipTiming[]
}

export interface VideoPreviewPixelSize {
  width: number
  height: number
  scale: number
  zoom: number
}

export const PREVIEW_VIDEO_MAX_SAMPLES = 8
export const PREVIEW_VIDEO_MAX_EDGE = 1280
export const PREVIEW_VIDEO_END_EPSILON = 0.001
export const PREVIEW_VIDEO_TIMELINE_TIMEOUT_MS = 8_000
export const PREVIEW_VIDEO_OVERFLOW_SLACK_PX = 4

export const VIDEO_COMPOSITION_PROBE = `(() => {
  const stage = document.querySelector('[data-composition-id]');
  if (!stage) return null;
  const id = stage.getAttribute('data-composition-id') || '';
  const list = window.__timelines;
  const controller = id && list && typeof list === 'object' ? list[id] : null;
  const ready = Boolean(controller && typeof controller.seek === 'function');
  let duration = 0;
  if (controller && typeof controller.duration === 'function') {
    try { duration = Number(controller.duration()); } catch (_) { duration = 0; }
  }
  if (!Number.isFinite(duration) || duration <= 0) duration = Number(stage.getAttribute('data-duration'));
  const width = Number(stage.getAttribute('data-width'));
  const height = Number(stage.getAttribute('data-height'));
  const clips = [];
  stage.querySelectorAll('[data-start]').forEach((el) => {
    const start = Number(el.getAttribute('data-start'));
    const span = Number(el.getAttribute('data-duration'));
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(span) || span <= 0) return;
    clips.push({ start: start, duration: span });
  });
  return {
    id: id,
    width: Number.isFinite(width) && width > 0 ? width : stage.clientWidth || 0,
    height: Number.isFinite(height) && height > 0 ? height : stage.clientHeight || 0,
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    ready: ready,
    clips: clips
  };
})()`

export function videoSeekScript(id: string, time: number): string {
  return `(async () => {
  const list = window.__timelines;
  const controller = list && typeof list === 'object' ? list[${JSON.stringify(id)}] : null;
  if (!controller || typeof controller.seek !== 'function') throw new Error('no_timeline');
  controller.seek(${time});
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))));
  return true;
})()`
}

export function normalizeVideoComposition(value: unknown): VideoCompositionInfo | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const clips: VideoClipTiming[] = []
  if (Array.isArray(raw.clips)) {
    for (const entry of raw.clips) {
      if (!entry || typeof entry !== 'object') continue
      const clip = entry as Record<string, unknown>
      const start = Number(clip.start)
      const duration = Number(clip.duration)
      if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0) continue
      clips.push({ start, duration })
    }
  }
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    width: Number(raw.width) || 0,
    height: Number(raw.height) || 0,
    duration: Number(raw.duration) || 0,
    ready: raw.ready === true,
    clips
  }
}

export function videoPreviewPixelSize(width: number, height: number): VideoPreviewPixelSize {
  const sourceWidth = Number.isFinite(width) && width > 0 ? width : 1280
  const sourceHeight = Number.isFinite(height) && height > 0 ? height : 720
  const scale = Math.min(1, PREVIEW_VIDEO_MAX_EDGE / Math.max(sourceWidth, sourceHeight))
  const outWidth = Math.max(2, Math.round(sourceWidth * scale))
  const outHeight = Math.max(2, Math.round(sourceHeight * scale))
  return { width: outWidth, height: outHeight, scale, zoom: outWidth / sourceWidth }
}

export function roundSampleTime(time: number): number {
  return Math.round(time * 1000) / 1000
}

export function previewSampleLabel(time: number): string {
  const rounded = roundSampleTime(time)
  return `t=${Number(rounded.toFixed(3))}s`
}

function spreadTimes(times: number[], max: number): number[] {
  if (times.length <= max) return times
  if (max <= 1) return [times[times.length - 1]]
  const kept: number[] = []
  const step = (times.length - 1) / (max - 1)
  for (let index = 0; index < max; index++) kept.push(times[Math.round(index * step)])
  return [...new Set(kept)]
}

export function previewSampleTimes(input: {
  duration: number
  clips?: VideoClipTiming[]
  at?: number[]
  max?: number
}): number[] {
  const duration = Number(input.duration)
  if (!Number.isFinite(duration) || duration <= 0) return []
  const max = Number.isFinite(input.max) ? Math.max(1, Math.trunc(input.max as number)) : PREVIEW_VIDEO_MAX_SAMPLES
  const last = roundSampleTime(Math.max(0, duration - PREVIEW_VIDEO_END_EPSILON))
  const explicit = (input.at ?? []).filter((time) => Number.isFinite(time) && time >= 0)
  const candidates: number[] = []
  if (explicit.length) {
    for (const time of explicit) candidates.push(time)
  } else {
    for (const clip of input.clips ?? []) {
      if (!Number.isFinite(clip.start) || !Number.isFinite(clip.duration) || clip.duration <= 0) continue
      candidates.push(clip.start + clip.duration / 2)
    }
    candidates.push(duration - PREVIEW_VIDEO_END_EPSILON)
  }
  const clamped = candidates.map((time) => roundSampleTime(Math.min(Math.max(time, 0), last)))
  const unique = [...new Set(clamped)].sort((left, right) => left - right)
  return spreadTimes(unique, max)
}

export interface PreviewAtParse {
  times: number[]
  invalid: string | null
}

export function parsePreviewAt(value: unknown): PreviewAtParse {
  if (value === undefined || value === null || value === true || value === '') return { times: [], invalid: null }
  const items = Array.isArray(value)
    ? value
    : typeof value === 'number'
      ? [value]
      : typeof value === 'string'
        ? value.split(',')
        : null
  if (!items) return { times: [], invalid: String(value).slice(0, 60) }
  const times: number[] = []
  for (const item of items) {
    const text = typeof item === 'string' ? item.trim() : item
    if (text === '') continue
    const time = typeof text === 'number' ? text : Number(text)
    if (!Number.isFinite(time) || time < 0) return { times: [], invalid: String(item).slice(0, 60) }
    times.push(roundSampleTime(time))
  }
  const unique = [...new Set(times)].sort((left, right) => left - right)
  return { times: unique, invalid: null }
}
