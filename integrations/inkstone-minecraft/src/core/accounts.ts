import { offline } from '@xmcl/user'
import type { Account, AccountKind, PclAccountRef } from '../shared/api.ts'

const OFFLINE_NAME = /^[A-Za-z0-9_]{3,16}$/
const UUID = /^[0-9a-f]{32}$/
const KINDS: readonly AccountKind[] = ['offline', 'microsoft', 'yggdrasil']

export function validOfflineName(name: unknown): name is string {
  return typeof name === 'string' && OFFLINE_NAME.test(name)
}

export function normalizeUuid(value: string): string {
  return value.replace(/-/g, '').toLowerCase()
}

function serverHost(server: string | null): string {
  if (!server) return 'unknown'
  try {
    return new URL(server).host.toLowerCase()
  } catch {
    return 'unknown'
  }
}

export function accountId(kind: AccountKind, uuid: string, server: string | null): string {
  return kind === 'yggdrasil' ? `${kind}:${serverHost(server)}:${uuid}` : `${kind}:${uuid}`
}

export function offlineAccount(name: string): Account {
  if (!validOfflineName(name)) throw new Error('离线用户名只能是 3–16 位字母、数字或下划线')
  const uuid = normalizeUuid(offline(name).selectedProfile.id)
  return { id: accountId('offline', uuid, null), kind: 'offline', name, uuid, server: null, serverName: null, source: 'local', signedIn: true }
}

export function accountFromPcl(ref: PclAccountRef): Account | null {
  if (ref.type === 'offline') {
    try {
      return { ...offlineAccount(ref.username), source: 'pcl' }
    } catch {
      return null
    }
  }
  const uuid = normalizeUuid(ref.uuid)
  if (!UUID.test(uuid)) return null
  if (ref.type === 'microsoft') {
    return { id: accountId('microsoft', uuid, null), kind: 'microsoft', name: ref.username, uuid, server: null, serverName: null, source: 'pcl', signedIn: false }
  }
  if (ref.type === 'authlib' && ref.server && /^https:\/\//i.test(ref.server)) {
    return { id: accountId('yggdrasil', uuid, ref.server), kind: 'yggdrasil', name: ref.username, uuid, server: ref.server, serverName: ref.serverName, source: 'pcl', signedIn: false }
  }
  return null
}

export function normalizeAccount(raw: unknown): Account | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<Account>
  if (!KINDS.includes(value.kind as AccountKind) || typeof value.name !== 'string' || typeof value.uuid !== 'string') return null
  const uuid = normalizeUuid(value.uuid)
  if (!UUID.test(uuid)) return null
  const kind = value.kind as AccountKind
  if (kind === 'offline' && !validOfflineName(value.name)) return null
  const server = typeof value.server === 'string' && /^https:\/\//i.test(value.server) ? value.server : null
  if (kind === 'yggdrasil' && !server) return null
  return {
    id: accountId(kind, uuid, server),
    kind,
    name: value.name,
    uuid,
    server: kind === 'yggdrasil' ? server : null,
    serverName: kind === 'yggdrasil' && typeof value.serverName === 'string' ? value.serverName : null,
    source: value.source === 'pcl' ? 'pcl' : 'local',
    signedIn: kind === 'offline' ? true : value.signedIn === true
  }
}

export function mergeAccounts(current: Account[], incoming: Account[]): Account[] {
  const merged = [...current]
  for (const account of incoming) {
    if (!merged.some((item) => item.id === account.id)) merged.push(account)
  }
  return merged
}
