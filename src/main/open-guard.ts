import { basename } from 'node:path'

function isUnsafeNameChar(code: number): boolean {
  return code < 0x20 || code === 0x7f || code === 0x200e || code === 0x200f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
}

function hasUnsafeNameChar(name: string): boolean {
  for (let i = 0; i < name.length; i += 1) if (isUnsafeNameChar(name.charCodeAt(i))) return true
  return false
}

export type OpenBlockReason = 'unsafe-name' | 'alternate-stream'

export function openBlockReason(target: string): OpenBlockReason | null {
  const trimmed = String(target ?? '').trim()
  if (!trimmed || /[\\/]$/.test(trimmed)) return null
  const name = basename(trimmed.replace(/\\/g, '/'))
  if (hasUnsafeNameChar(name)) return 'unsafe-name'
  if (name.includes(':')) return 'alternate-stream'
  return null
}

export function openBlockedByName(target: string): boolean {
  return openBlockReason(target) !== null
}
