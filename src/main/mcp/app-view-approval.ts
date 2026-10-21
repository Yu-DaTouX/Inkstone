import {
  normalizePermissionMode,
  type ApprovalAnswer,
  type ApprovalRequest,
  type PermissionMode
} from '../../shared/approval'
import { mcpCallDanger } from '../../shared/mcp-approval'
import {
  bypassedTrustDecision,
  evaluateHostTrust,
  type HostTrustDecision,
  type HostTrustGrant,
  type HostTrustVerdict
} from './app-view-trust'

export interface AppViewCall {
  server: string
  tool: string
  visibility?: unknown
  annotations?: unknown
  args?: unknown
  sessionId?: string
  runId?: string
  cwd?: string
  permissionMode?: unknown
}

export interface AppViewHostContext {
  serverFingerprint?: string
  grants?: readonly HostTrustGrant[]
  sessionId?: string
  projectId?: string
  now?: number
}

export type AppViewAsk = (request: Omit<ApprovalRequest, 'id' | 'createdAt'>) => Promise<ApprovalAnswer | null>

export interface AppViewAuditRecord {
  allowed: boolean
  asked: boolean
  reasons: string[]
  trustVerdict: HostTrustVerdict
  serverFingerprint: string
  permissionMode: PermissionMode
  persistentGrant: boolean
  at: number
}

export interface AppViewApprovalResult {
  allowed: boolean
  asked: boolean
  reasons: string[]
  recorded: boolean
  reason?: string
  trust: HostTrustDecision
  audit: AppViewAuditRecord
}

const KNOWN_VISIBILITIES: readonly string[] = ['model', 'app']

function readVisibility(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  if (!value.every((item) => typeof item === 'string' && KNOWN_VISIBILITIES.includes(item))) return null
  return value as string[]
}

export async function approveAppViewCall(
  call: AppViewCall,
  ask: AppViewAsk,
  context?: AppViewHostContext
): Promise<AppViewApprovalResult> {
  const server = String(call.server ?? '')
  const tool = String(call.tool ?? '')
  const toolName = `mcp__${server}__${tool}`
  const mode = normalizePermissionMode(call.permissionMode)
  const at = typeof context?.now === 'number' && Number.isFinite(context.now) ? context.now : Date.now()
  const sessionId = context?.sessionId ?? call.sessionId
  const projectId = context?.projectId

  const finish = (input: {
    allowed: boolean
    asked: boolean
    reasons: string[]
    trust: HostTrustDecision
    reason?: string
  }): AppViewApprovalResult => {
    const result: AppViewApprovalResult = {
      allowed: input.allowed,
      asked: input.asked,
      reasons: input.reasons,
      recorded: true,
      trust: input.trust,
      audit: {
        allowed: input.allowed,
        asked: input.asked,
        reasons: input.reasons,
        trustVerdict: input.trust.verdict,
        serverFingerprint: input.trust.serverFingerprint,
        permissionMode: mode,
        persistentGrant: false,
        at
      }
    }
    if (input.reason !== undefined) result.reason = input.reason
    return result
  }

  const visibility = readVisibility(call.visibility)
  if (!visibility || !visibility.includes('app')) {
    return finish({
      allowed: false,
      asked: false,
      reasons: [],
      trust: bypassedTrustDecision(context?.serverFingerprint, 'visibility 门槛未过，未进入信任判定'),
      reason:
        visibility === null
          ? '缺少 visibility 声明（或形状非法），按最严处理：不对 App 视图开放'
          : '工具未向 App 视图开放（visibility 不含 app）'
    })
  }

  const risks = mcpCallDanger(toolName, call.annotations)

  if (mode === 'all') {
    return finish({
      allowed: true,
      asked: false,
      reasons: risks,
      trust: bypassedTrustDecision(context?.serverFingerprint, 'all 档不额外拦截，仅要求记录')
    })
  }

  let trust: HostTrustDecision
  let askReasons: string[]

  if (risks.length === 0) {
    trust = evaluateHostTrust({
      serverFingerprint: context?.serverFingerprint,
      tool,
      sessionId,
      projectId,
      permissionMode: mode,
      grants: context?.grants,
      now: at
    })
    if (trust.trusted) {
      return finish({ allowed: true, asked: false, reasons: [], trust })
    }
    askReasons = [`该 App 调用缺少宿主服务器授权，只读工具也需要确认（可选「在此会话中允许」）：${server} / ${tool}`]
  } else {
    trust = bypassedTrustDecision(context?.serverFingerprint, '破坏性 / 未知注解，授权不适用，按原规则逐次询问')
    askReasons = risks
  }

  const request: Omit<ApprovalRequest, 'id' | 'createdAt'> = {
    kind: 'danger',
    tool: toolName,
    title: `App 视图请求调用 ${server} / ${tool}`,
    detail: JSON.stringify(call.args ?? {}).slice(0, 2000),
    reasons: askReasons,
    cwd: String(call.cwd ?? ''),
    canRemember: false,
    sessionId,
    runId: call.runId
  }

  let answer: ApprovalAnswer | null
  try {
    answer = await ask(request)
  } catch {
    answer = null
  }
  const choice = answer?.choice ?? null

  const allowed = choice === 'once' || choice === 'remember'
  return finish({
    allowed,
    asked: true,
    reasons: askReasons,
    trust,
    reason: allowed
      ? undefined
      : choice === 'deny'
        ? answer?.feedback
          ? `用户拒绝了 App 视图的调用：${answer.feedback}`
          : '用户拒绝了 App 视图的调用'
        : '没有得到用户确认（无窗口或超时）'
  })
}
