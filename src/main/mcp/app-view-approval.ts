/**
 * App 视图发起调用的宿主侧审批判定。
 *
 * 视图里的 App 通过桥请求 `tools/call` 时，宿主不能因为「请求来自自己的 WebContents」
 * 就放行：这里与模型路径复用 `shared/mcp-approval.ts` 的同口径注解判定，叠加**宿主
 * 服务器信任**（`app-view-trust.ts`），再经注入的 `ask`（对接 `ApprovalBroker`）取得
 * 用户答复。卡片的实际弹出、超时与窗口判断留在 `ApprovalBroker`，本模块只做纯判定，
 * 便于用合成 ask 验收。
 *
 * 规则（FIX1-app-trust 之后）：
 *   · `visibility` 只接受**宿主归一化数组**（只含 `model` / `app`）；缺失、非数组或含
 *     未知值一律按最严拒绝。绝不相信 iframe 自报的 `_meta` / `source`。
 *   · `permissionMode='all'`：不额外拦截，但每次都要求写审计记录。
 *   · `danger`（缺省）：注解只决定风险理由，**不构成授权**。无风险（只读 / 显式安全）
 *     的调用仍需宿主注入的服务器 App 授权：命中 grant 才可直接 call；没有 grant 就询问
 *     （`once`/`remember` 都只对本次生效，不静默升级为持久信任）或拒绝。
 *   · 破坏性 / 未知注解：无论如何都按原规则逐次询问，grant 不能绕过。
 *   · `ask` 拒绝、无答复、超时、抛异常都判拒绝；不做旧「只读直接放行」的回退。
 *
 * `recorded` 的含义是「本次判定**应当**写审计记录」，本模块不落库：A6 必须读取
 * `audit` 字段，把允许 / 拒绝 / `all` / visibility 拒绝 / 询问异常每条真正落库。
 */

import {
  normalizePermissionMode,
  type ApprovalChoice,
  type ApprovalRequest,
  type PermissionMode
} from '../../shared/approval'
import { mcpCallDanger, mcpTarget } from '../../shared/mcp-approval'
import {
  bypassedTrustDecision,
  evaluateHostTrust,
  type HostTrustDecision,
  type HostTrustGrant,
  type HostTrustVerdict
} from './app-view-trust'

/** 视图调用涉及的 MCP 工具信息（由宿主从工具快照 / `_meta.ui` 汇总）。 */
export interface AppViewCall {
  server: string
  tool: string
  /** 宿主归一化后的 `_meta.ui.visibility`；缺失 / 非法 / 含未知值按最严处理。 */
  visibility?: unknown
  /** 服务自报注解；缺失等同未知，按要问处理。 */
  annotations?: unknown
  args?: unknown
  sessionId?: string
  runId?: string
  cwd?: string
  /** `danger`（缺省）/ `all`。 */
  permissionMode?: unknown
}

/**
 * 宿主注入的信任上下文（A6 提供）。
 *
 * 这些字段绝不能来自 iframe / 桥请求：服务器指纹由宿主从已加载配置算，
 * grants 由宿主持久层读出。任何 `trust: true` 之类的裸布尔都不被接受。
 */
export interface AppViewHostContext {
  /** 宿主算出的服务器身份指纹（`mcpServerIdentityFingerprint`）。 */
  serverFingerprint?: string
  /** 宿主注入的正式授权列表；iframe 不能提供这个字段。 */
  grants?: readonly HostTrustGrant[]
  /** 可信会话身份；缺失时退回 `call.sessionId`。 */
  sessionId?: string
  /** 可信项目身份；缺省按「无项目绑定」处理。 */
  projectId?: string
  /** 判定时间（测试注入，缺省 `Date.now()`）。 */
  now?: number
}

/** 与 `ApprovalBroker.ask` 同形的注入点；返回 null 表示无窗口 / 超时 / 没有答复。 */
export type AppViewAsk = (request: Omit<ApprovalRequest, 'id' | 'createdAt'>) => Promise<ApprovalChoice | null>

/**
 * A6 必须落库的审计记录。
 *
 * 本模块不写任何存储：A6 要在每次视图调用后把这份 `audit`（连同会话 / 工具 / 时间）
 * 写进该会话步骤，覆盖允许、拒绝、`all`、visibility 拒绝与询问异常全部路径。
 */
export interface AppViewAuditRecord {
  allowed: boolean
  asked: boolean
  reasons: string[]
  /** 信任判定结论；未进入判定时为 `bypassed` / `no-fingerprint` 等。 */
  trustVerdict: HostTrustVerdict
  serverFingerprint: string
  permissionMode: PermissionMode
  /** 本次是否写入了持久授权；本模块恒为 `false`（持久化由 A6 / 授权中心承担）。 */
  persistentGrant: boolean
  at: number
}

export interface AppViewApprovalResult {
  allowed: boolean
  /** 是否弹过卡片（供会话步骤记录）。 */
  asked: boolean
  /** 命中的风险理由；`all` 档也会填，用于记录。 */
  reasons: string[]
  /** **应记录**：本模块不落库；A6 必须按 `audit` 落库。 */
  recorded: boolean
  /** `allowed===false` 时的拒绝原因。 */
  reason?: string
  /** 信任判定结果；未进入判定时 `verdict` 说明原因。 */
  trust: HostTrustDecision
  /** 强制审计记录：A6 必须把这份落库。 */
  audit: AppViewAuditRecord
}

const KNOWN_VISIBILITIES: readonly string[] = ['model', 'app']

/**
 * 只接受**宿主归一化后的**字符串数组（只含 `model` / `app`）。
 *
 * 原始 `_meta.ui` 对象、字符串、含未知值的数组都返回 null，与「不含 app」区分，
 * 便于给出准确原因；判定结果一律拒绝。
 */
function readVisibility(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  if (!value.every((item) => typeof item === 'string' && KNOWN_VISIBILITIES.includes(item))) return null
  return value as string[]
}

/**
 * 判定一次视图发起的调用是否放行。
 *
 * @param call    视图调用信息
 * @param ask     注入的询问函数；生产接 `ApprovalBroker.ask`，测试接合成实现
 * @param context 宿主注入的信任上下文（服务器指纹 / grants / owner / 时间）；缺省
 *                时按 fail-closed：无风险调用也会询问，绝不静默放行
 */
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
      // 「应记录」：本模块不落库，A6 必须持久化 audit。
      recorded: true,
      trust: input.trust,
      audit: {
        allowed: input.allowed,
        asked: input.asked,
        reasons: input.reasons,
        trustVerdict: input.trust.verdict,
        serverFingerprint: input.trust.serverFingerprint,
        permissionMode: mode,
        // 本模块不建立持久授权；卡片上的 remember 也必须由宿主 grant 通道显式创建。
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
    /* 无风险（只读 / 显式安全）：注解不构成授权，必须有宿主注入的服务器 grant。 */
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
    askReasons = [`该 App 调用缺少宿主服务器授权，只读工具也需每次确认：${server} / ${tool}`]
  } else {
    /* 破坏性 / 未知注解：grant 不适用，永远逐次询问。 */
    trust = bypassedTrustDecision(context?.serverFingerprint, '破坏性 / 未知注解，授权不适用，按原规则逐次询问')
    askReasons = risks
  }

  const { server: shownServer, tool: shownTool } = mcpTarget(toolName)
  const request: Omit<ApprovalRequest, 'id' | 'createdAt'> = {
    kind: 'danger',
    tool: toolName,
    title: `App 视图请求调用 ${shownServer} / ${shownTool}`,
    detail: JSON.stringify(call.args ?? {}).slice(0, 2000),
    reasons: askReasons,
    cwd: String(call.cwd ?? ''),
    canRemember: false,
    sessionId,
    runId: call.runId
  }

  let choice: ApprovalChoice | null
  try {
    choice = await ask(request)
  } catch {
    /* 询问通道异常按「没有答复」处理，与 ApprovalBroker 的失败方向一致。 */
    choice = null
  }

  const allowed = choice === 'once' || choice === 'remember'
  return finish({
    allowed,
    asked: true,
    reasons: askReasons,
    trust,
    /* `remember` 也只对本次生效：持久授权必须走宿主 grant 通道，不由卡片悄悄建立。 */
    reason: allowed
      ? undefined
      : choice === 'deny'
        ? '用户拒绝了 App 视图的调用'
        : '没有得到用户确认（无窗口或超时）'
  })
}
