import { canonicalJson, shortHash } from './canonical'
import type { ConflictRecord, SyncRecord, SyncRecordKind } from './types'

function deviceTag(name: string): string {
  const clean = name.replace(/[^\w\u4e00-\u9fa5.-]+/g, ' ').trim()
  return clean || '未知设备'
}

function asciiTag(name: string, id: string): string {
  const clean = name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
  return clean || `device-${shortHash(id, 6)}`
}

function keyTail(key: string, prefix: string): string | undefined {
  const name = key.startsWith(prefix) ? key.slice(prefix.length) : ''
  if (!name || name.includes('/') || name.includes('\\') || name.includes('\u0000')) return undefined
  return name
}

export function buildConflictCopy(conflict: ConflictRecord): SyncRecord | null {
  const copyId = shortHash(conflict.id, 32)
  const tag = `${deviceTag(conflict.remoteDeviceName)}-${copyId}`
  switch (conflict.kind) {
    case 'prompt': {
      const name = keyTail(conflict.key, 'prompt:')
      if (!name) return null
      return {
        key: `prompt:${name}（${tag}）`,
        kind: 'prompt',
        payload: conflict.remotePayload,
        modifiedAt: conflict.remoteModifiedAt
      }
    }
    case 'skill': {
      const name = keyTail(conflict.key, 'skill:')
      if (!name || !/^[\w.-]+$/.test(name)) return null
      const suffix = `${asciiTag(conflict.remoteDeviceName, conflict.id)}-${copyId}`
      return {
        key: `skill:${name}-from-${suffix}`,
        kind: 'skill',
        payload: conflict.remotePayload,
        modifiedAt: conflict.remoteModifiedAt
      }
    }
    case 'bookmark': {
      let parsed: { session?: unknown; key?: unknown; value?: unknown }
      try {
        parsed = JSON.parse(conflict.remotePayload) as typeof parsed
      } catch {
        return null
      }
      const session = typeof parsed.session === 'string' ? parsed.session : ''
      const valueKey = typeof parsed.key === 'string' ? parsed.key : ''
      if (!session || !valueKey.startsWith('bookmark:') || typeof parsed.value !== 'string') return null
      return {
        key: `bookmark:${shortHash(`${conflict.id}\u0000${valueKey}`, 32)}`,
        kind: 'bookmark',
        payload: canonicalJson({ session, key: `${valueKey}（${tag}）`, value: parsed.value }),
        modifiedAt: conflict.remoteModifiedAt
      }
    }
    case 'schedule': {
      let parsed: Record<string, unknown>
      try {
        const raw = JSON.parse(conflict.remotePayload) as unknown
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
        parsed = raw as Record<string, unknown>
      } catch {
        return null
      }
      const id = typeof parsed.id === 'string' ? parsed.id : ''
      if (!id || !/^[\w.-]+$/.test(id)) return null
      const nextId = `${id}-conflict-${copyId}`
      const name = typeof parsed.name === 'string' && parsed.name ? `${parsed.name}（${tag}）` : undefined
      return {
        key: `schedule:${nextId}`,
        kind: 'schedule',
        payload: canonicalJson({ ...parsed, id: nextId, ...(name ? { name } : {}) }),
        modifiedAt: conflict.remoteModifiedAt
      }
    }
    case 'settings':
      return null
    default: {
      const never: never = conflict.kind
      void never
      return null
    }
  }
}

export function supportsConflictCopy(kind: SyncRecordKind): boolean {
  return kind !== 'settings'
}
