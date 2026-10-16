/**
 * 快速提问的发送逻辑（v3 WP-25d）。
 *
 * 主进程不重复会话状态机：这里只通过窄接口把「新会话 / 当前会话」翻译成
 * 宿主已有的 send / select 调用。真正的 `Runners` 与 `AgentController` 由
 * `src/main/index.ts` 注入（见补丁说明），因此本模块能用一个假宿主直接回归
 * 发送顺序与错误码（见 scripts/test-v3-aux-windows.mjs）。
 */
import type { QuickAskResult, QuickAskSubmit } from './aux-types'
import { validateQuickAsk } from './aux-state'

/** 快速提问需要的最小 Agent 面（结构兼容 `AgentController`）。 */
export interface QuickAskAgentPort {
  send(text: string): Promise<{ ok: boolean; error?: string }>
  getState(): { sessionId?: string; sessionFile?: string } | null
}

export interface QuickAskSubmitDeps {
  /** 当前激活运行实例；没有则返回 null。 */
  activeRunId(): string | null
  agentOf(runId: string): QuickAskAgentPort | null
  /** 确保 pi 已启动。 */
  start(): Promise<{ ok: boolean; error?: string }>
  /** 在指定项目（缺省 = 最近项目）新建会话，返回运行实例 id。 */
  createSession(opts: { projectId?: string }): Promise<{ ok: boolean; error?: string; id?: string }>
  /** 切换所选模型（可选）；缺省时忽略 `payload.model`。 */
  applyModel?(runId: string, model: { provider: string; id: string }): Promise<{ ok: boolean; error?: string }>
}

/**
 * 发送一个问题。
 *
 * 顺序：校验 → （新会话先起 pi 再建会话）→ 取 Agent → send。任一步失败都返回
 * 稳定错误码，让渲染端按语言显示；`message` 只带宿主原始细节。
 */
export async function submitQuickAsk(deps: QuickAskSubmitDeps, payload: QuickAskSubmit): Promise<QuickAskResult> {
  const hasCurrent = deps.activeRunId() !== null
  const invalid = validateQuickAsk(payload.prompt, payload.target, hasCurrent)
  if (invalid) return { ok: false, code: invalid }

  let runId: string | null = null
  if (payload.target === 'new') {
    const started = await deps.start()
    if (!started.ok) return { ok: false, code: 'start-failed', message: started.error }
    const created = await deps.createSession({
      ...(payload.projectId ? { projectId: payload.projectId } : {})
    })
    if (!created.ok || !created.id) return { ok: false, code: 'create-failed', message: created.error }
    runId = created.id
  } else {
    runId = deps.activeRunId()
  }

  const agent = runId ? deps.agentOf(runId) : null
  if (!agent || !runId) return { ok: false, code: 'unavailable' }

  if (payload.model) {
    if (!deps.applyModel) return { ok: false, code: 'model-failed' }
    const applied = await deps.applyModel(runId, payload.model)
    if (!applied.ok) return { ok: false, code: 'model-failed', message: applied.error }
  }

  const sent = await agent.send(payload.prompt.trim())
  if (!sent.ok) return { ok: false, code: 'send-failed', message: sent.error }
  const state = agent.getState()
  return {
    ok: true,
    runId,
    ...(state?.sessionId ? { sessionId: state.sessionId } : {}),
    ...(state?.sessionFile ? { sessionPath: state.sessionFile } : {})
  }
}
