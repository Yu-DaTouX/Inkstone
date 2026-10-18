import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  PiCacheWarming,
  PiNativeSettings,
  PiNativeSettingsResult,
  PiProjectTrustDefault,
  PiRuntimePrefs,
  PiShareDestination,
  QueueMode
} from '../shared/ipc'
import { PI_AGENT_DIR } from './paths'
import { readJson, withPiSettingsLock, writeAtomic } from './native-compaction-line'

type Json = Record<string, unknown>

const CACHE_WARMING: readonly PiCacheWarming[] = ['off', 'streaming', 'idle']
const PROJECT_TRUST: readonly PiProjectTrustDefault[] = ['ask', 'always', 'never']
const SHARE_DESTINATIONS: readonly PiShareDestination[] = ['auto', 'gist', 'radius']
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000
const MAX_TIMEOUT_MS = 3_600_000

const settingsFile = (): string => join(PI_AGENT_DIR, 'settings.json')
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const oneOf = <T extends string>(list: readonly T[], value: unknown, fallback: T): T =>
  list.includes(value as T) ? (value as T) : fallback

function queueMode(value: unknown): QueueMode {
  return value === 'all' ? 'all' : 'one-at-a-time'
}

export function piRuntimePrefsOf(raw: unknown): PiRuntimePrefs {
  const settings = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const retry = settings.retry && typeof settings.retry === 'object' ? (settings.retry as Record<string, unknown>) : {}
  return {
    autoRetry: retry.enabled !== false,
    steeringMode: queueMode(settings.steeringMode),
    followUpMode: queueMode(settings.followUpMode)
  }
}

export async function readPiRuntimePrefs(file = settingsFile()): Promise<PiRuntimePrefs> {
  try {
    return piRuntimePrefsOf(JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, '')))
  } catch {
    return piRuntimePrefsOf({})
  }
}

function idleTimeoutOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value)
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase()
    if (trimmed === 'disabled') return 0
    const parsed = Number(trimmed)
    if (trimmed && Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed)
  }
  return DEFAULT_HTTP_IDLE_TIMEOUT_MS
}

function intIn(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

function thinkingLevelsOf(value: unknown): Record<string, string> {
  if (!isObj(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, level] of Object.entries(value)) {
    if (key.includes('/') && typeof level === 'string' && THINKING_LEVELS.includes(level)) out[key] = level
  }
  return out
}

export function piNativeSettingsOf(raw: unknown): PiNativeSettings {
  const settings = isObj(raw) ? raw : {}
  const retry = isObj(settings.retry) ? settings.retry : {}
  const images = isObj(settings.images) ? settings.images : {}
  const compaction = isObj(settings.compaction) ? settings.compaction : {}
  return {
    compactionEnabled: compaction.enabled !== false,
    retryMaxRetries: intIn(retry.maxRetries, 0, 100, 3),
    retryBaseDelayMs: intIn(retry.baseDelayMs, 0, MAX_TIMEOUT_MS, 2000),
    httpIdleTimeoutMs: idleTimeoutOf(settings.httpIdleTimeoutMs),
    cacheWarming: oneOf(CACHE_WARMING, settings.cacheWarming, 'streaming'),
    imagesAutoResize: images.autoResize !== false,
    imagesBlockImages: images.blockImages === true,
    defaultProjectTrust: oneOf(PROJECT_TRUST, settings.defaultProjectTrust, 'ask'),
    sessionShareDestination: oneOf(SHARE_DESTINATIONS, settings.sessionShareDestination, 'auto'),
    modelThinkingLevels: thinkingLevelsOf(settings.modelThinkingLevels)
  }
}

export function validatePiNativePatch(input: unknown): { ok: true; patch: Partial<PiNativeSettings> } | { ok: false; error: string } {
  if (!isObj(input)) return { ok: false, error: 'pi 设置参数无效' }
  const patch: Partial<PiNativeSettings> = {}
  for (const [key, value] of Object.entries(input)) {
    switch (key) {
      case 'retryMaxRetries':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) return { ok: false, error: '重试次数无效' }
        patch.retryMaxRetries = value
        break
      case 'retryBaseDelayMs':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_TIMEOUT_MS) return { ok: false, error: '重试等待时间无效' }
        patch.retryBaseDelayMs = value
        break
      case 'httpIdleTimeoutMs':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_TIMEOUT_MS) return { ok: false, error: '空闲超时无效' }
        patch.httpIdleTimeoutMs = value
        break
      case 'cacheWarming':
        if (!CACHE_WARMING.includes(value as PiCacheWarming)) return { ok: false, error: '缓存预热模式无效' }
        patch.cacheWarming = value as PiCacheWarming
        break
      case 'compactionEnabled':
        if (typeof value !== 'boolean') return { ok: false, error: '自动压缩设置无效' }
        patch.compactionEnabled = value
        break
      case 'imagesAutoResize':
      case 'imagesBlockImages':
        if (typeof value !== 'boolean') return { ok: false, error: '图片设置无效' }
        patch[key] = value
        break
      case 'defaultProjectTrust':
        if (!PROJECT_TRUST.includes(value as PiProjectTrustDefault)) return { ok: false, error: '项目信任默认值无效' }
        patch.defaultProjectTrust = value as PiProjectTrustDefault
        break
      case 'sessionShareDestination':
        if (!SHARE_DESTINATIONS.includes(value as PiShareDestination)) return { ok: false, error: '分享目的地无效' }
        patch.sessionShareDestination = value as PiShareDestination
        break
      case 'modelThinkingLevels': {
        if (!isObj(value)) return { ok: false, error: '模型思考档位无效' }
        const levels = thinkingLevelsOf(value)
        if (Object.keys(levels).length !== Object.keys(value).length || Object.keys(levels).length > 500) return { ok: false, error: '模型思考档位无效' }
        patch.modelThinkingLevels = levels
        break
      }
      default:
        return { ok: false, error: `不支持的 pi 设置：${key}` }
    }
  }
  return { ok: true, patch }
}

export function applyPiNativePatch(settings: Json, patch: Partial<PiNativeSettings>): Json {
  const next: Json = { ...settings }
  const nested = (key: string): Json => {
    const value: Json = isObj(next[key]) ? { ...(next[key] as Json) } : {}
    next[key] = value
    return value
  }
  if (patch.compactionEnabled !== undefined) nested('compaction').enabled = patch.compactionEnabled
  if (patch.retryMaxRetries !== undefined) nested('retry').maxRetries = patch.retryMaxRetries
  if (patch.retryBaseDelayMs !== undefined) nested('retry').baseDelayMs = patch.retryBaseDelayMs
  if (patch.httpIdleTimeoutMs !== undefined) next.httpIdleTimeoutMs = patch.httpIdleTimeoutMs
  if (patch.cacheWarming !== undefined) next.cacheWarming = patch.cacheWarming
  if (patch.imagesAutoResize !== undefined) nested('images').autoResize = patch.imagesAutoResize
  if (patch.imagesBlockImages !== undefined) nested('images').blockImages = patch.imagesBlockImages
  if (patch.defaultProjectTrust !== undefined) next.defaultProjectTrust = patch.defaultProjectTrust
  if (patch.sessionShareDestination !== undefined) next.sessionShareDestination = patch.sessionShareDestination
  if (patch.modelThinkingLevels !== undefined) {
    if (Object.keys(patch.modelThinkingLevels).length) next.modelThinkingLevels = { ...patch.modelThinkingLevels }
    else delete next.modelThinkingLevels
  }
  return next
}

export async function readPiNativeSettings(file = settingsFile()): Promise<PiNativeSettingsResult> {
  const settings = await readJson(file)
  if (!settings) return { ok: false, error: 'pi 的 settings.json 无法解析，未读取', settings: piNativeSettingsOf({}) }
  return { ok: true, settings: piNativeSettingsOf(settings) }
}

export function writePiNativeSettings(input: unknown, file = settingsFile()): Promise<PiNativeSettingsResult> {
  const checked = validatePiNativePatch(input)
  if (!checked.ok) return Promise.resolve({ ok: false, error: checked.error })
  return withPiSettingsLock(async () => {
    const settings = await readJson(file)
    if (!settings) return { ok: false as const, error: 'pi 的 settings.json 无法解析，未写入' }
    const next = applyPiNativePatch(settings, checked.patch)
    await writeAtomic(file, next)
    return { ok: true as const, settings: piNativeSettingsOf(next) }
  })
}
