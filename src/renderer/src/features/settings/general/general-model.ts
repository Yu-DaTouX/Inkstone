import type { SoundSettings } from '../../../../../shared/ipc'
import type { PermissionMode } from '../../../../../shared/approval'

export type GeneralSectionId = 'session' | 'notifications' | 'security' | 'devices' | 'data' | 'about'

export const GENERAL_LEGACY_MAP: Readonly<Record<string, GeneralSectionId>> = {
  workspace: 'session',
  devices: 'devices',
  remote: 'devices',
  peer: 'devices',
  about: 'about',
  status: 'about'
}

export const DEFAULT_SOUND_SETTINGS: SoundSettings = {
  enabled: false,
  volume: 0.4,
  notifications: true,
  events: { done: true, question: true, error: true }
}

export function bytesText(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${Math.round(bytes / 1024 ** 2)} MB`
}

export function formatWhen(at: number | null | undefined, never: string, lang: string): string {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return never
  try {
    return new Date(at).toLocaleString(lang === 'en-US' ? 'en-US' : 'zh-CN')
  } catch {
    return never
  }
}

export function mergeSound(base: SoundSettings, patch: Partial<SoundSettings>): SoundSettings {
  return {
    ...base,
    ...patch,
    events: { ...base.events, ...(patch.events ?? {}) }
  }
}

export function removeAllowRoot(roots: readonly string[], path: string): string[] {
  return roots.filter((item) => item !== path)
}

export function permissionNeedsConfirm(next: PermissionMode): boolean {
  return next === 'all'
}

export function piSourceLabel(source: string | undefined): string {
  switch (source) {
    case 'bundled':
      return 'bundled'
    case 'global':
      return 'global'
    case 'override':
      return 'override'
    case 'env':
      return 'env'
    case 'path':
      return 'path'
    case 'shell':
      return 'shell'
    default:
      return '—'
  }
}
