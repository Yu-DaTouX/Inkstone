import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { QuotaWindow } from '../shared/ipc'
import {
  QUOTA_SAMPLE_KEEP_MS,
  appendQuotaSample,
  forecastQuota,
  windowUsedPct,
  type QuotaSample
} from '../shared/quota-forecast'
import { YAN_DIR } from './paths'

interface QuotaSeries {
  resetAt?: number
  samples: QuotaSample[]
}

const CYCLE_SHIFT_MS = 10 * 60_000
const WRITE_DELAY_MS = 3_000

export interface QuotaSampleStore {
  withForecasts(seriesKey: string, windows: QuotaWindow[], now?: number): Promise<QuotaWindow[]>
  flush(): Promise<void>
}

function readSeries(raw: unknown): Record<string, QuotaSeries> {
  const root = raw && typeof raw === 'object' ? (raw as { version?: unknown; series?: unknown }) : {}
  if (root.version !== 1 || !root.series || typeof root.series !== 'object') return {}
  const out: Record<string, QuotaSeries> = {}
  for (const [key, value] of Object.entries(root.series as Record<string, unknown>)) {
    const entry = value && typeof value === 'object' ? (value as { resetAt?: unknown; samples?: unknown }) : null
    if (!entry || !Array.isArray(entry.samples)) continue
    const samples = entry.samples
      .filter((s): s is QuotaSample => !!s && typeof s === 'object' && Number.isFinite((s as QuotaSample).at) && Number.isFinite((s as QuotaSample).pct))
      .map((s) => ({ at: s.at, pct: s.pct }))
      .sort((a, b) => a.at - b.at)
    if (!samples.length) continue
    out[key] = { ...(Number.isFinite(entry.resetAt) ? { resetAt: entry.resetAt as number } : {}), samples }
  }
  return out
}

export function createQuotaSampleStore(file: string): QuotaSampleStore {
  let loading: Promise<Record<string, QuotaSeries>> | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let writing: Promise<void> = Promise.resolve()

  const load = (): Promise<Record<string, QuotaSeries>> => {
    loading ??= readFile(file, 'utf8')
      .then((text) => readSeries(JSON.parse(text)))
      .catch(() => ({}))
    return loading
  }

  const write = async (): Promise<void> => {
    const series = await load()
    const tmp = `${file}.${process.pid}.tmp`
    await mkdir(dirname(file), { recursive: true })
    await writeFile(tmp, JSON.stringify({ version: 1, series }), 'utf8')
    await rename(tmp, file)
  }

  const schedule = (): void => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      writing = writing.then(write).catch(() => undefined)
    }, WRITE_DELAY_MS)
  }

  return {
    async withForecasts(seriesKey, windows, now = Date.now()) {
      if (!windows.length) return windows
      const series = await load()
      const out = windows.map((window) => {
        const pct = windowUsedPct(window)
        if (pct === null || window.informational) return window
        const key = `${seriesKey}|${window.id}`
        const prior = series[key]
        const newCycle = prior?.resetAt !== undefined && window.resetAt !== undefined && window.resetAt - prior.resetAt > CYCLE_SHIFT_MS
        const samples = appendQuotaSample(newCycle ? [] : prior?.samples ?? [], { at: now, pct })
        series[key] = { ...(window.resetAt !== undefined ? { resetAt: window.resetAt } : {}), samples }
        const next: QuotaWindow = { ...window }
        const forecast = forecastQuota(samples, window, now)
        if (forecast) next.forecast = forecast
        else delete next.forecast
        return next
      })
      for (const [key, entry] of Object.entries(series)) {
        const last = entry.samples[entry.samples.length - 1]
        if (!last || now - last.at > QUOTA_SAMPLE_KEEP_MS) delete series[key]
      }
      schedule()
      return out
    },
    async flush() {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
        writing = writing.then(write).catch(() => undefined)
      }
      await writing
    }
  }
}

export const quotaSamples = createQuotaSampleStore(join(YAN_DIR, 'quota-samples.json'))
