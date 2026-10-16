/**
 * App 视图调用的**宿主服务器信任**判定（FIX1-app-trust）。
 *
 * 背景：A4 原先在注解判定为「只读 / 无风险」时直接放行，等于让**服务自报的注解**
 * 变成用户授权。服务（乃至被篡改的 App 页面）都能自称 `readOnlyHint:true`，所以
 * danger 档下即使注解说只读，也必须先拿到**宿主注入的服务器 App 授权**，否则仍然
 * 询问或拒绝。
 *
 * 信任边界：
 *   · 服务器身份指纹只能由宿主从**已加载配置**计算（`mcpServerIdentityFingerprint`）
 *     并在宿主 context 里注入；iframe / 请求体里的 `trust`、`meta`、`source` 都不算。
 *   · 授权是**类型化的 grant 列表**，每条都绑定服务器指纹、范围、授权人、有效期，
 *     可按会话 / 项目 / 权限档收窄；不接受裸 `boolean` 作为正式持久授权。
 *   · 指纹不符（跨服务器 / 旧指纹）、已过期、已撤销、owner 不符的 grant 一律失效，
 *     失败方向是「不可信」——调用方按缺省继续询问或拒绝。
 *
 * 本模块只做纯判定，不做 IO、不落库；持久化存储与界面属于 A6 / 授权中心，不在本任务。
 */
import { createHash } from 'node:crypto'
import { normalizePermissionMode, type PermissionMode } from '../../shared/approval'

/** 服务器身份指纹（sha256 hex）。宿主计算，永不来自 iframe。 */
export type McpServerFingerprint = string

/** 授权覆盖面：整台服务器，或单个工具。 */
export type HostTrustScope = 'server' | 'tool'

/** 授权人；grant 走宿主注入通道，因此 iframe 无法伪造这个字段。 */
export type HostTrustAuthorizer = 'user' | 'host'

/** 一条正式的服务器 App 授权。 */
export interface HostTrustGrant {
  /** 宿主计算的服务身份指纹；与当前指纹不符即失效（跨 server / 旧指纹）。 */
  serverFingerprint: McpServerFingerprint
  /** 授权范围。 */
  scope: HostTrustScope
  /** `scope==='tool'` 时必填；命中该工具名才算授权。 */
  tool?: string
  /** 授权人；正式用户授权为 `'user'`，`'host'` 保留给宿主策略。 */
  authorizer: HostTrustAuthorizer
  /** 绑定会话；缺失表示不限（仅宿主策略建议省略），用户授权应绑定以缩小范围。 */
  sessionId?: string
  /** 绑定项目；缺失表示不限。 */
  projectId?: string
  /** 仅在指定权限档有效；缺失表示不限档。 */
  permissionMode?: PermissionMode
  /** 有效期（epoch ms），必须是正的有限数。 */
  expiresAt: number
  /** 是否已撤销。 */
  revoked?: boolean
  /** 审计标识（可选，便于 A6 关联记录）。 */
  grantId?: string
}

/** 信任判定结论。`bypassed` 表示未进入信任判定（visibility 拒绝 / all 档 / 破坏性）。 */
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
  /** 判定时采用的服务器指纹；缺失指纹时为空串。 */
  serverFingerprint: string
  scope?: HostTrustScope
  authorizer?: HostTrustAuthorizer
  expiresAt?: number
  grantId?: string
  reason: string
}

/** 纯判定输入；`grants` 必须来自宿主持久层，不能来自请求 / iframe。 */
export interface HostTrustQuery {
  serverFingerprint?: unknown
  tool?: unknown
  sessionId?: unknown
  projectId?: unknown
  permissionMode?: unknown
  grants?: unknown
  now?: unknown
}

/**
 * 从已加载配置算服务器身份指纹。
 *
 * 字段集与 `app-host.ts` 的连接指纹保持一致（id / transport / command / args / env /
 * url / enabled / ownedBy / projectScope），但哈希后输出，避免把 env 里的凭证带进
 * grant / 审计。A6 必须用本函数计算指纹，并同时用于授权与判定。
 */
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

/** 构造「未进入信任判定」的结论，供 visibility 拒绝 / all 档 / 破坏性调用写审计。 */
export function bypassedTrustDecision(serverFingerprint: unknown, reason: string): HostTrustDecision {
  const fingerprint = typeof serverFingerprint === 'string' ? serverFingerprint.trim() : ''
  return { trusted: false, verdict: 'bypassed', serverFingerprint: fingerprint, reason }
}

/**
 * 在**已注入的** grant 里找一条命中当前服务器 / 工具 / owner / 档位且未失效的授权。
 *
 * 任何缺失都按不可信处理，交由调用方决定询问还是拒绝；本函数不会因为「没有 grant」
 * 而放行，也不会接受任何非 grant 形状的真值（例如 `true`）。
 */
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

    /* 必须绑定当前服务器：旧指纹 / 跨 server 直接失效。 */
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
