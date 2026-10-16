/**
 * 会话级提问频率覆盖的 IPC 适配。
 *
 * 全局三档在 `desktop.json`（设置页写），这里只处理**按会话**的覆盖：
 * `inherit`（跟随全局）/ `sparse` / `balanced` / `eager`。记录复用工作模式的
 * 存储（同一条稳定会话记录、同一个 revision、同一个逐轮快照），不新建状态机：
 *   · 持久化在 `work-modes.json`（键 = 稳定会话文件路径或 `pending:<runnerId>`）；
 *   · 模型侧读的是 `work-mode/<runnerId>.json` 快照。
 *
 * 归属与并发是本文件的存在理由：
 *   · 请求必须带**预期身份**（真实存在的 runnerId + 稳定 sessionId / sessionFile），
 *     不盲取「当前 active」—— 否则后台会话切回来时，A 的迟到设置会写到 B；
 *   · 缺失必要身份（不存在的 runner、没有稳定会话键、非有限 revision）一律拒绝，
 *     不落任何记录 —— 否则会留下永远接不上的 `pending` 悬空项；
 *   · 持久化与快照 `await` 前后各核对一次归属：期间实例被复用到别的会话，就
 *     不再把旧会话的快照 / 推送落到新会话上；
 *   · `expectedRevision` 是乐观锁，不一致不写并回传当前值供界面恢复。
 *
 * 模式语义不在这里改：投影与快照都固定 `standard`，不从旧快照恢复
 * `clarify` / `autonomous`，只保留 `planApprovalPending` 这个待审标记。
 */
import type { IpcRegistrar } from './registrar'
import {
  adoptPendingWorkMode,
  normalizeSessionFileKey,
  readWorkModeSnapshot,
  sameWorkModeIdentity,
  writeWorkModeSnapshot,
  type WorkModeStore
} from '../work-mode-service'
import {
  normalizeSessionQuestionFrequency,
  resolveQuestionFrequency,
  type QuestionFrequency,
  type SessionQuestionFrequency
} from '../../shared/question-frequency'
import type { RunnerRegistry } from '../runners'
import type { MainPush } from '../../shared/ipc'
import { DEFAULT_WORK_MODE, type WorkModeState } from '../../shared/work-mode'

export interface QuestionFrequencyIpcDeps {
  registry(): RunnerRegistry | null
  workModes: WorkModeStore
  /** 稳定会话键（goal-coordinator 的实现；注入以便本模块独立测试） */
  workModeKeyFor(id: string): string
  /** 当前全局档（设置页写；会话 inherit 时用它） */
  globalQuestionFrequency(): Promise<QuestionFrequency>
  pushFrom(runnerId: string, msg: MainPush): void
}

export interface QuestionFrequencyView {
  runnerId: string
  sessionId?: string
  sessionFile?: string
  key: string
  revision: number
  preference: SessionQuestionFrequency
  effective: QuestionFrequency
  global: QuestionFrequency
}

/** 解析到的目标身份：runner 必须真实存在，才拿得到它的会话键。 */
interface ResolvedIdentity {
  id: string
  generation?: number
  sessionId?: string
  sessionFile?: string
}

/** 快照归属：记录这条快照写时属于哪个稳定会话（扩展读时核对）。 */
function snapshotOwner(identity: ResolvedIdentity | null): { sessionId?: string; sessionFile?: string } {
  if (!identity) return {}
  const sessionFile = normalizeSessionFileKey(identity.sessionFile) ?? undefined
  return {
    ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
    ...(sessionFile ? { sessionFile } : {})
  }
}

export function registerQuestionFrequencyIpc(ipc: IpcRegistrar, deps: QuestionFrequencyIpcDeps): void {
  const { handle } = ipc
  const { registry, workModes, workModeKeyFor, globalQuestionFrequency, pushFrom } = deps

  /**
   * 解析目标身份：显式 runnerId 优先（支持非 active），其次 active。
   *
   * ⚠️ 指定的 runner 必须真的在注册表里 —— 旧实现对不存在的 id 也返回 `{ id }`，
   * 于是任意 `pending:<id>` 都能被写出来。返回 null 表示「不能改」。
   */
  function resolveIdentity(requestedRunnerId: unknown): ResolvedIdentity | null {
    const runners = registry()
    if (!runners) return null
    const requested =
      typeof requestedRunnerId === 'string' && requestedRunnerId.trim() ? requestedRunnerId.trim() : undefined
    const id = requested ?? runners.activeRunner()?.id
    if (!id) return null
    const agent = runners.agentOf(id)
    if (!agent) return null
    const state = agent.getState()
    if (!state) return null
    return { id, generation: runners.runtimeOf?.(id)?.generation, sessionId: state.sessionId, sessionFile: state.sessionFile }
  }

  /**
   * 读取当前值并推给界面。
   *
   * `globalQuestionFrequency` 也是 `await`：之后重新解析一次身份，返回的 key 与
   * session 身份必须来自**同一次**解析，不能返回「新 key + 旧 session」的混合体。
   */
  async function describe(identity: ResolvedIdentity): Promise<QuestionFrequencyView> {
    await workModes.load()
    let current = resolveIdentity(identity.id) ?? identity
    let key = workModeKeyFor(current.id)
    /* 会话刚拿到稳定文件：把同实例的 pending 覆盖按归属安全迁过来，再读 */
    await adoptPendingWorkMode(workModes, current.id, current.sessionId, key)
    let state = workModes.state(key)
    const global = await globalQuestionFrequency()
    const after = resolveIdentity(identity.id)
    if (after && !sameWorkModeIdentity(current, after)) {
      current = after
      key = workModeKeyFor(current.id)
      await adoptPendingWorkMode(workModes, current.id, current.sessionId, key)
      state = workModes.state(key)
    }
    const preference = normalizeSessionQuestionFrequency(state.questionFrequency)
    return {
      runnerId: current.id,
      sessionId: current.sessionId,
      sessionFile: current.sessionFile,
      key,
      revision: state.revision,
      preference,
      effective: resolveQuestionFrequency(preference, global),
      global
    }
  }

  /**
   * 把当前 store 值写进快照并推给界面（成功与版本冲突共用）。
   *
   * 模式固定兼容层的 `standard`：不从旧快照恢复历史模式。频率取 store 的权威值；
   * 快照始终带频率（`inherit` 也写，擦掉上一轮显式残留），并保留旧快照里的
   * `planApprovalPending`，不能因为改频率把「待批准计划」标记冲掉。
   *
   * `readWorkModeSnapshot` 与 `writeWorkModeSnapshot` 都是 `await`，期间同一
   * `runnerId` 可能被复用到别的会话：每次 `await` 后都核对「身份 + 预期键」，
   * 变了就返回 null，不写 B 的快照、不把 A 的 payload 推给 B。
   */
  async function publish(identity: ResolvedIdentity): Promise<WorkModeState | null> {
    const id = identity.id
    const key = workModeKeyFor(id)
    /* 身份 + 预期键双校验：`await` 期间实例被复用就不再写 B 的快照 */
    const guard = () => sameWorkModeIdentity(identity, resolveIdentity(id)) && workModeKeyFor(id) === key
    const existing = await readWorkModeSnapshot(id).catch(() => null)
    if (!guard()) return null
    /* 读快照期间 store 也可能被另一入口推进：写/推之前重新取权威 revision */
    const state = workModes.state(key)
    const payload: WorkModeState & { planApprovalPending?: boolean } = {
      mode: DEFAULT_WORK_MODE,
      revision: state.revision,
      questionFrequency: normalizeSessionQuestionFrequency(state.questionFrequency),
      ...(existing?.planApprovalPending ? { planApprovalPending: true } : {})
    }
    /* guard 在写入关键段（rename 前）复校；失败不落盘，不覆盖新会话的有效快照 */
    const committed = await writeWorkModeSnapshot(id, payload, undefined, {
      guard,
      owner: snapshotOwner(identity)
    }).catch(() => false)
    if (!committed || !guard()) return null
    pushFrom(id, { ch: 'work-mode', payload })
    return payload
  }

  handle('yan:getSessionQuestionFrequency', async (requestedRunnerId: unknown) => {
    const identity = resolveIdentity(requestedRunnerId)
    if (!identity) return { ok: false as const, error: 'no_session' as const }
    return { ok: true as const, ...(await describe(identity)) }
  })

  handle('yan:setSessionQuestionFrequency', async (input: unknown) => {
    const request = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    const requestedRunnerId = typeof request.runnerId === 'string' ? request.runnerId.trim() : ''
    /* 身份必填且必须真实存在：不存在的 runner / 空 input 不产生任何记录 */
    if (!requestedRunnerId) return { ok: false as const, error: 'no_session' as const }
    const identity = resolveIdentity(requestedRunnerId)
    if (!identity) return { ok: false as const, error: 'no_session' as const }

    const sessionId = typeof request.sessionId === 'string' && request.sessionId ? request.sessionId : undefined
    const sessionFile = typeof request.sessionFile === 'string' && request.sessionFile ? request.sessionFile : undefined
    /* 必须有稳定会话身份，否则只会在 `pending:<runnerId>` 上留一条接不上的覆盖 */
    if (!sessionId && !sessionFile) return { ok: false as const, error: 'no_session' as const }

    /* 身份核对（下达时）：显式 sessionId / sessionFile 必须与宿主当前看到的一致 */
    const stale =
      (sessionId !== undefined && sessionId !== identity.sessionId) ||
      (sessionFile !== undefined && normalizeSessionFileKey(sessionFile) !== normalizeSessionFileKey(identity.sessionFile))
    if (stale) {
      return { ok: false as const, error: 'stale_session' as const, ...(await describe(identity)) }
    }

    const expectedRevision = request.expectedRevision
    if (typeof expectedRevision !== 'number' || !Number.isFinite(expectedRevision) || expectedRevision < 0) {
      return { ok: false as const, error: 'bad-revision' as const }
    }

    /* 先固定目标键，后面所有写入都用它 —— 绝不在 await 之后重新取 active */
    const key = workModeKeyFor(identity.id)
    const preference = normalizeSessionQuestionFrequency(request.questionFrequency)
    const owner = identity.sessionId

    await workModes.load()
    /* 会话已经拿到稳定文件：先把同实例 pending 的旧覆盖按归属迁过来，再写 */
    await adoptPendingWorkMode(workModes, identity.id, identity.sessionId, key)
    const res = await workModes.setQuestionFrequency(key, preference, expectedRevision, owner)

    /* 持久化之后再核对归属：期间被切走就不把快照 / 推送落到新会话 */
    const identityStable = sameWorkModeIdentity(identity, resolveIdentity(identity.id))

    if (!res.ok) {
      if (identityStable) await publish(identity)
      const current = workModes.state(key)
      const global = await globalQuestionFrequency()
      return {
        ok: false as const,
        error: res.error ?? 'version-mismatch',
        revision: current.revision,
        preference: normalizeSessionQuestionFrequency(current.questionFrequency),
        effective: resolveQuestionFrequency(current.questionFrequency, global),
        global
      }
    }

    if (!identityStable) {
      const global = await globalQuestionFrequency()
      return {
        ok: false as const,
        error: 'identity-changed' as const,
        revision: res.state.revision,
        preference: normalizeSessionQuestionFrequency(res.state.questionFrequency),
        effective: resolveQuestionFrequency(res.state.questionFrequency, global),
        global
      }
    }

    const payload = await publish(identity)
    if (!payload) return { ok: false as const, error: 'identity-changed' as const }
    const global = await globalQuestionFrequency()
    return {
      ok: true as const,
      runnerId: identity.id,
      sessionId: identity.sessionId,
      sessionFile: identity.sessionFile,
      key,
      revision: payload.revision,
      preference: normalizeSessionQuestionFrequency(payload.questionFrequency),
      effective: resolveQuestionFrequency(payload.questionFrequency, global),
      global
    }
  })
}
