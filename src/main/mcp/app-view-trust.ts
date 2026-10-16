import { createHash } from 'node:crypto'
import { normalizePermissionMode, type PermissionMode } from '../../shared/approval'

export type McpServerFingerprint = string

export type HostTrustScope = 'server' | 'tool'

export type HostTrustAuthorizer = 'user' | 'host'

export interface HostTrustGrant {
  serverFingerprint: McpServerFingerprint
  scope: HostTrustScope
  tool?: string
  authorizer: HostTrustAuthorizer
  sessionId?: string
  projectId?: string
  permissionMode?: PermissionMode
  expiresAt: number
  revoked?: boolean
  grantId?: string
}

export type HostTrustVerdict =
  | 'trusted'
  | 'bypassed'
  | 'no-fingerprint'
  | 'no-grant'
  | 'mismatch'
  | 'expired'
  | 'revoked'
  | 'wrong-owner'

export interface HostTrustDecision {
  trusted: boolean
  verdict: HostTrustVerdict
  serverFingerprint: string
  scope?: HostTrustScope
  authorizer?: HostTrustAuthorizer
  expiresAt?: number
  grantId?: string
  reason: string
}

export interface HostTrustQuery {
  serverFingerprint?: unknown
  tool?: unknown
  sessionId?: unknown
  projectId?: unknown
  permissionMode?: unknown
  grants?: unknown
  now?: unknown
}

export function mcpServerIdentityFingerprint(config: unknown): McpServerFingerprint {
  const source =
    config && typeof config === 'object' && !Array.isArray(config) ? (config as Record<string, unknown>) : {}
  const canonical = JSON.stringify({
    id: source.id ?? null,
    transport: source.transport ?? null,
    command: source.command ?? null,
    args: source.args ?? null,
    env: source.env ?? null,
    url: source.url ?? null,
    enabled: source.enabled ?? true,
    ownedBy: source.ownedBy ?? null,
    projectScope: source.projectScope ?? null
  })
  return createHash('sha256').update(canonical).digest('hex')
}

function untrusted(verdict: HostTrustVerdict, serverFingerprint: string, reason: string): HostTrustDecision {
  return { trusted: false, verdict, serverFingerprint, reason }
}

export function bypassedTrustDecision(serverFingerprint: unknown, reason: string): HostTrustDecision {
  const fingerprint = typeof serverFingerprint === 'string' ? serverFingerprint.trim() : ''
  return { trusted: false, verdict: 'bypassed', serverFingerprint: fingerprint, reason }
}

export function evaluateHostTrust(query: HostTrustQuery): HostTrustDecision {
  const fingerprint = typeof query.serverFingerprint === 'string' ? query.serverFingerprint.trim() : ''
  if (!fingerprint) {
    return untrusted('no-fingerprint', '', '宿主未提供服务器身份指纹，不能信任（缺省 fail-closed）')
  }
  const tool = String(query.tool ?? '')
  const sessionId = typeof query.sessionId === 'string' && query.sessionId ? query.sessionId : undefined
  const projectId = typeof query.projectId === 'string' && query.projectId ? query.projectId : undefined
  const mode = normalizePermissionMode(query.permissionMode)
  const now = typeof query.now === 'number' && Number.isFinite(query.now) ? query.now : Date.now()
  const grants = Array.isArray(query.grants) ? query.grants : []

  let sawExpired = false
  let sawRevoked = false
  let sawMismatch = false
  let sawWrongOwner = false

  for (const raw of grants) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const grant = raw as Partial<HostTrustGrant>

    if (typeof grant.serverFingerprint !== 'string' || grant.serverFingerprint !== fingerprint) {
      sawMismatch = true
      continue
    }
    if (grant.revoked === true) {
      sawRevoked = true
      continue
    }
    if (typeof grant.expiresAt !== 'number' || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= now) {
      sawExpired = true
      continue
    }
    if (grant.authorizer !== 'user' && grant.authorizer !== 'host') continue
    if (grant.permissionMode !== undefined && normalizePermissionMode(grant.permissionMode) !== mode) continue
    if (grant.sessionId !== undefined && grant.sessionId !== sessionId) {
      sawWrongOwner = true
      continue
    }
    if (grant.projectId !== undefined && grant.projectId !== projectId) {
      sawWrongOwner = true
      continue
    }

    if (grant.scope === 'server') {
      return {
        trusted: true,
        verdict: 'trusted',
        serverFingerprint: fingerprint,
        scope: 'server',
        authorizer: grant.authorizer,
        expiresAt: grant.expiresAt,
        ...(grant.grantId ? { grantId: grant.grantId } : {}),
        reason: '已获宿主注入的服务器 App 授权（server 范围）'
      }
    }
    if (grant.scope === 'tool' && grant.tool === tool) {
      return {
        trusted: true,
        verdict: 'trusted',
        serverFingerprint: fingerprint,
        scope: 'tool',
        authorizer: grant.authorizer,
        expiresAt: grant.expiresAt,
        ...(grant.grantId ? { grantId: grant.grantId } : {}),
        reason: `已获宿主注入的服务器 App 授权（tool 范围：${tool}）`
      }
    }
  }

  if (sawRevoked) return untrusted('revoked', fingerprint, '服务器 App 授权已撤销，不能信任')
  if (sawExpired) return untrusted('expired', fingerprint, '服务器 App 授权已过期，不能信任')
  if (sawMismatch) {
    return untrusted('mismatch', fingerprint, '授权指纹与当前服务器不符（旧指纹或跨服务器），不能信任')
  }
  if (sawWrongOwner) {
    return untrusted('wrong-owner', fingerprint, '授权 owner（会话 / 项目）与当前调用不符，不能信任')
  }
  return untrusted('no-grant', fingerprint, '没有该服务器的 App 授权，不能信任')
}
