/**
 * 冲突解决时的「两份都留」副本构造（纯函数）。
 *
 * 语义：本机版本继续作为主记录，他端版本落成一个**带来源后缀的新记录**，
 * 让两份都能在本地使用：
 *   · prompt / skill / bookmark / schedule 可以复制成另一个 key；
 *   · settings 是单例（一个 `desktop.json`），无法复制成两份，返回 null，
 *     由调用方改成把远端快照另存到数据目录（见 service.ts 的 resolveConflict）。
 *
 * 只构造数据，不碰文件系统：便于单测，也避免把各存储的路径知识搬到这里。
 */
import { canonicalJson, shortHash } from './canonical'
import type { ConflictRecord, SyncRecord, SyncRecordKind } from './types'

/** 人类可读的来源后缀；与冲突记录里展示的 suffix 同源。 */
function deviceTag(name: string): string {
  const clean = name.replace(/[^\w\u4e00-\u9fa5.-]+/g, ' ').trim()
  return clean || '未知设备'
}

/** 可作 key / 文件名的 ASCII 后缀；中文设备名退化为短哈希，保证 skill / schedule id 合法。 */
function asciiTag(name: string, id: string): string {
  const clean = name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
  return clean || `device-${shortHash(id, 6)}`
}

function keyTail(key: string, prefix: string): string | undefined {
  const name = key.startsWith(prefix) ? key.slice(prefix.length) : ''
  if (!name || name.includes('/') || name.includes('\\') || name.includes('\u0000')) return undefined
  return name
}

/**
 * 为他端版本构造一条可落地的本机记录；无法复制（settings / 形状损坏）时返回 null。
 * 永不修改原冲突记录，也不覆盖原 key。
 */
export function buildConflictCopy(conflict: ConflictRecord): SyncRecord | null {
  const tag = deviceTag(conflict.remoteDeviceName)
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
      const suffix = asciiTag(conflict.remoteDeviceName, conflict.id)
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
      const nextId = `${id}-conflict-${shortHash(conflict.id, 6)}`
      const name = typeof parsed.name === 'string' && parsed.name ? `${parsed.name}（${tag}）` : undefined
      return {
        key: `schedule:${nextId}`,
        kind: 'schedule',
        payload: canonicalJson({ ...parsed, id: nextId, ...(name ? { name } : {}) }),
        modifiedAt: conflict.remoteModifiedAt
      }
    }
    case 'settings':
      /* 单例设置不能复制成第二份本地记录：由调用方另存快照。 */
      return null
    default: {
      const never: never = conflict.kind
      void never
      return null
    }
  }
}

/** 供测试与调用方判断某类别是否支持「复制成两份」。 */
export function supportsConflictCopy(kind: SyncRecordKind): boolean {
  return kind !== 'settings'
}
