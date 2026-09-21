/**
 * 会话运行实例注册表（N12）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要它
 * ══════════════════════════════════════════════════════════════════
 * 之前主进程只有**一个** `AgentController`：
 *   · 切换会话 = 让这一个 pi 子进程 `switch_session`；
 *   · 换工作目录 = 把子进程停掉重起。
 * 于是「A 会话正在跑，点一下 B 会话」会直接掐断 A —— 因为 A 的进程
 * 就是 B 的进程。用户报的就是这个：切走之后后台任务没了。
 *
 * 现在：一个**运行中**的会话 = 一个 pi 子进程（`AgentController` 实例）。
 * 注册表负责：
 *   · 按会话文件找到已有实例（命中就直接切视图，不发停止命令）；
 *   · 复用**空闲**实例（pi 进程不便宜：空闲的会话不该常驻占内存）；
 *   · 预算上限（默认 3 个进程）。满了就给明确提示，**不通过停掉旧会话腾位置**；
 *   · 给每个实例一个稳定 `runnerId`：IPC 事件用它标身份，
 *     前端才能把「后台会话的输出」与「当前正在看的会话」分开。
 *
 * 不在这里做的事：消息缓存（那是渲染端的事）、pi 协议细节（在 agent.ts）。
 *
 * ── 身份在渲染端的落点（改这里要一起看）──
 * `runtimeOf()` 产生的封套带 `sessionId` / `runId` / `generation`；前端 `store.applyPush`
 * 拿它做闸门：只有 `activeRunnerId === runtime.runId` 的补丁才写当前投影，
 * 其余的进 `state/session-runtime.ts` 的按会话缓存。
 *
 * ⚠️ 实测：`runId` 恒等于实例自己的 `id`（`runners[0] = { id:"r1", runId:"r1" }`），
 *   而 `sessionId` 在启动期是 `pending:<runId>`、pi 就绪后才换成真实 uuid
 *   （实测 `Object.keys(sessionRuntimes)` = `["pending:r1", "<真实 uuid>"]` —— 同一个实例
 *   先后以两个键存在）。所以**判断响应是否过期只能用 runId**：拿 sessionId 做等值比较
 *   会把这条正常过渡当成过期响应丢掉。判定在 `renderer/src/state/capability-request.ts`，有单测。
 */
import type { AgentController } from './agent'
import type { RunnerStatus, RuntimeEnvelope, SessionScope, SessionState } from '../shared/ipc'

/**
 * 同时运行的会话实例上限（含当前正在查看的那个）。
 *
 * 为什么是 3：每个实例是一个完整的 pi 子进程 + 它的 token 统计与工具进程，
 * 再多对普通机器不友好。到上限时的行为是**明确拒绝并提示**，
 * 而不是悄悄停掉某个旧会话 —— 那正是用户报的 bug。
 */
export const RUNNER_LIMIT = 3

/**
 * 工作目录是并发写入边界：Windows 的斜杠、大小写和末尾分隔符不能让
 * 同一个目录绕过冲突检查。这里不做 realpath，因为 runner 的 cwd 还
 * 可能是一个合法的符号链接；是否允许该路径由主进程目录校验决定。
 */
function canonicalCwd(value: string): string {
  return value.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
}

interface Runner {
  id: string
  agent: AgentController
  cwd: string
  projectId?: string
  /** 每次换会话/新建会话都会递增；迟到事件不能覆盖新代次。 */
  generation: number
  createdAt: number
  lastActiveAt: number
}

export interface SelectTarget {
  /** 目标会话文件；缺省 = 新会话（未落盘） */
  sessionFile?: string
  /** 稳定会话 id；优先于文件名匹配，避免标题/路径变化破坏身份。 */
  sessionId?: string
  /** 产品语义归属，不等同于 cwd。 */
  projectId?: string
  /** 新建/选择时的产品范围；runner 本身不负责持久化，只透传给上层。 */
  scope?: SessionScope
  /** false 时只准备后台运行实例，不改变桌面当前选中的 runner。 */
  activate?: boolean
  cwd: string
}

export interface SelectResult {
  ok: boolean
  /** 命中 / 复用 / 新建出来的实例 id */
  id?: string
  /** `id` 的明确命名；新调用方按这个字段传递运行实例身份。 */
  runId?: string
  sessionId?: string
  generation?: number
  /** 复用了哪个实例（'hit' 命中已有、'reuse' 复用空闲、'new' 新建） */
  via?: 'hit' | 'reuse' | 'new'
  error?: string
}

export class RunnerRegistry {
  private runners = new Map<string, Runner>()
  private activeId: string | null = null
  private seq = 0
  /** 防止两个快速点击的会话切换交叉执行。 */
  private selectTail: Promise<void> = Promise.resolve()
  /** 同一 runner 的资源激活请求合并，避免同时启动两个替代 pi 进程。 */
  private restartOperations = new Map<string, Promise<SelectResult>>()

  constructor(
    private opts: {
      limit?: number
      /** 造一个新的 pi 会话实例。id 用于给 IPC 事件标身份 */
      createAgent: (id: string, cwd: string, generation?: number) => AgentController
      /** 实例集合或状态变化时通知主进程（推给渲染端） */
      onChanged?: () => void
    }
  ) {}

  get limit(): number {
    return this.opts.limit ?? RUNNER_LIMIT
  }

  get activeRunnerId(): string | null {
    return this.activeId
  }

  active(): AgentController | null {
    if (!this.activeId) return null
    return this.runners.get(this.activeId)?.agent ?? null
  }

  activeRunner(): { id: string; cwd: string } | null {
    if (!this.activeId) return null
    const r = this.runners.get(this.activeId)
    return r ? { id: r.id, cwd: r.cwd } : null
  }

  /** 取指定运行实例；主进程推送快照时不能重新读取“当前实例”。 */
  agentOf(id: string): AgentController | null {
    return this.runners.get(id)?.agent ?? null
  }

  /**
   * 让**所有**实例重推一帧上下文策略（N21-7 设置改动后）。
   * 后台会话的右栏也能看到同一个工作集，不能只刷新当前那条。
   */
  refreshPolicyViews(): void {
    for (const runner of this.runners.values()) runner.agent.refreshPolicyView()
  }

  /** 按稳定 sessionId 取运行实例；重生成标题等只读动作不应切换视图。 */
  agentForSession(sessionId: string): AgentController | null {
    return this.findBySessionId(sessionId)?.agent ?? null
  }

  /** 给主进程为每条事件附上统一身份封套。 */
  runtimeOf(id: string): RuntimeEnvelope | null {
    const runner = this.runners.get(id)
    if (!runner) return null
    const sessionId = runner.agent.getState()?.sessionId || `pending:${id}`
    return {
      sessionId,
      runId: runner.id,
      ...(runner.projectId ? { projectId: runner.projectId } : {}),
      generation: runner.generation
    }
  }

  /** 某个实例此刻「忙着」吗：回合在跑，或有请求在等用户回答 */
  private busy(runner: Runner): boolean {
    const st = runner.agent.getState()
    if (st?.isAgentRunning === true || st?.isCompacting === true || st?.isStreaming === true) return true
    /* 直执行 shell 也算忙：它同样在改工作目录（L05） */
    if (runner.agent.hasRunningBash()) return true
    return runner.agent.getPendingUiCount() > 0
  }

  /** 按会话文件找实例 */
  private findBySessionFile(sessionFile: string): Runner | undefined {
    for (const r of this.runners.values()) {
      if (r.agent.getState()?.sessionFile === sessionFile) return r
    }
    return undefined
  }

  private findBySessionId(sessionId: string): Runner | undefined {
    for (const r of this.runners.values()) {
      if (r.agent.getState()?.sessionId === sessionId) return r
    }
    return undefined
  }

  private result(runner: Runner, via: SelectResult['via']): SelectResult {
    return {
      ok: true,
      id: runner.id,
      runId: runner.id,
      sessionId: runner.agent.getState()?.sessionId,
      generation: runner.generation,
      via
    }
  }

  /**
   * 选到某个会话并切换视图。
   *
   * 顺序：已有实例命中 → 复用空闲实例 → 新建（受预算限制）。
   * **任何一条路径都不会停止别的实例。**
   */
  async select(target: SelectTarget): Promise<SelectResult> {
    const next = this.selectTail.then(
      () => this.selectNow(target),
      () => this.selectNow(target)
    )
    this.selectTail = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  private async selectNow(target: SelectTarget): Promise<SelectResult> {
    if (target.sessionId || target.sessionFile) {
      const hit = (target.sessionId && this.findBySessionId(target.sessionId)) ||
        (target.sessionFile ? this.findBySessionFile(target.sessionFile) : undefined)
      if (hit) {
        hit.lastActiveAt = Date.now()
        if (target.activate !== false) this.activeId = hit.id
        this.opts.onChanged?.()
        return this.result(hit, 'hit')
      }
    }

    /*
     * 两个忙碌实例不能共用一个物理 cwd：即使它们是不同会话文件，
     * 工具调用仍可能同时修改同一工作树。命中已有实例必须在上面优先
     * 返回；这里只有“要创建/载入另一个运行实例”时才拒绝。
     */
    const conflict = [...this.runners.values()].find(
      (runner) => canonicalCwd(runner.cwd) === canonicalCwd(target.cwd) && this.busy(runner)
    )
    if (conflict) {
      const sessionId = conflict.agent.getState()?.sessionId ?? conflict.id
      return {
        ok: false,
        error:
          `同一工作目录已有运行中的会话（${sessionId}）。` +
          '为避免文件写入冲突，请先等待它完成，或使用隔离工作目录。'
      }
    }

    /* 复用空闲实例：不忙的那个可以被切到别的会话（旧会话已落盘，随时能载回） */
    const idle = [...this.runners.values()]
      .filter((runner) => !this.busy(runner) && (target.activate !== false || runner.id !== this.activeId))
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0]

    if (idle) {
      const oldGeneration = idle.generation
      const oldProjectId = idle.projectId
      idle.generation += 1
      idle.agent.setRunnerGeneration(idle.generation)
      idle.projectId = target.projectId
      this.opts.onChanged?.()

      /*
       * pi 进程的 cwd 只在 spawn 时确定：`new_session` 只接受
       * `parentSession`（0.85.1 实测），`switch_session` 只换会话文件。
       * 所以跨项目复用必须**换一个进程**，否则新会话会落在旧项目目录里
       * （D5）—— 只改注册表上的 `cwd` 字段是骗自己的。
       *
       * 顺序：先把新实例起起来，失败就整体回退（旧实例原样留着、仍可用）；
       * 成功后再停旧进程。被复用的实例一定是空闲的（没有流、没有等待），
       * 所以这段窗口里旧进程不会自己推事件。
       */
      if (canonicalCwd(idle.cwd) !== canonicalCwd(target.cwd)) {
        const previous = idle.agent
        const replacement = this.opts.createAgent(idle.id, target.cwd, idle.generation)
        const started = await replacement.start()
        if (!started.ok) {
          /* 新进程没起来也要收掉，别留下半个 pi。 */
          try {
            await replacement.stop()
          } catch {
            /* 已经死了 */
          }
          idle.generation = oldGeneration
          idle.agent.setRunnerGeneration(oldGeneration)
          idle.projectId = oldProjectId
          this.opts.onChanged?.()
          return { ok: false, error: started.error }
        }
        idle.agent = replacement
        idle.cwd = target.cwd
        try {
          await previous.stop()
        } catch {
          /* 旧进程自己已经退了 */
        }
      }

      const res = target.sessionFile
        ? await idle.agent.switchSession(target.sessionFile)
        : await idle.agent.newSession()
      if (!res.ok) {
        idle.generation = oldGeneration
        idle.agent.setRunnerGeneration(oldGeneration)
        idle.projectId = oldProjectId
        this.opts.onChanged?.()
        return { ok: false, error: res.error }
      }
      idle.cwd = target.cwd
      idle.lastActiveAt = Date.now()
      if (target.activate !== false) this.activeId = idle.id
      this.opts.onChanged?.()
      return this.result(idle, 'reuse')
    }

    if (this.runners.size >= this.limit) {
      return {
        ok: false,
        error:
          `同时运行的会话已达上限（${this.limit} 个）。` +
          '先等其中一个跑完，或停止它，再切换 —— 不会为了腾位置停掉正在跑的会话。'
      }
    }

    const id = `r${++this.seq}`
    const agent = this.opts.createAgent(id, target.cwd, 1)
    const runner: Runner = {
      id,
      agent,
      cwd: target.cwd,
      projectId: target.projectId,
      generation: 1,
      createdAt: Date.now(),
      lastActiveAt: Date.now()
    }
    const previousActive = this.activeId
    this.runners.set(id, runner)
    if (target.activate !== false) this.activeId = id

    // 新实例一旦失败就不能只摘登记：`stopAll` 只遍历仍登记的对象，
    // 漏登记等于漏回收（R02）。start / switch 的失败返回和抛异常都走同一条回收路径。
    let failure: string | undefined
    try {
      const started = await agent.start()
      if (!started.ok) {
        failure = started.error ?? '实例启动失败'
      } else if (target.sessionFile) {
        const sw = await agent.switchSession(target.sessionFile)
        if (!sw.ok) failure = sw.error ?? '切换会话失败'
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    if (failure !== undefined) {
      await this.discardNewRunner(id, runner, previousActive)
      return { ok: false, error: failure }
    }
    this.opts.onChanged?.()
    return this.result(runner, 'new')
  }

  /**
   * 新实例创建失败时的统一回收：先摘登记并还原 activeId，再尽力停掉已经起来的进程。
   * stop 失败只说明进程本来就没了，不能让它盖掉真正的失败原因（R02）。
   */
  private async discardNewRunner(id: string, runner: Runner, previousActive: string | null): Promise<void> {
    this.runners.delete(id)
    this.activeId = previousActive
    try {
      await runner.agent.stop()
    } catch {
      /* 进程可能从未启动或已经退出 */
    }
    this.opts.onChanged?.()
  }

  /** 启动时创建「主实例」（当前查看的会话就跑在它上面） */
  async startPrimary(cwd: string, sessionFile?: string, projectId?: string): Promise<SelectResult> {
    const existing = this.active()
    if (existing) {
      const id = this.activeId
      const runner = id ? this.runners.get(id) : undefined
      return runner ? this.result(runner, 'hit') : { ok: true, id: id ?? undefined, via: 'hit' }
    }
    return this.select({ cwd, sessionFile, projectId, scope: 'project' })
  }

  /**
   * 只重建指定的空闲 runner，并载回原会话及未投递队列。
   *
   * pi 扩展在进程启动时加载；安装包后切会话不会刷新它们。该路径专供受管能力
   * 激活：不停止其它 runner；先让替代进程启动并载入原会话，失败则保留旧进程；
   * 只有新进程和队列都恢复成功后才关闭旧进程。整个目标 cwd 必须空闲，避免
   * 同一工作树的其它会话在资源切换窗口继续写入。
   */
  restartOne(id: string): Promise<SelectResult> {
    const current = this.restartOperations.get(id)
    if (current) return current
    const operation = this.restartOneNow(id)
    this.restartOperations.set(id, operation)
    void operation.finally(() => {
      if (this.restartOperations.get(id) === operation) this.restartOperations.delete(id)
    }).catch(() => undefined)
    return operation
  }

  private async restartOneNow(id: string): Promise<SelectResult> {
    const runner = this.runners.get(id)
    if (!runner) return { ok: false, error: `运行实例不存在：${id}` }
    if (this.busy(runner)) return { ok: false, error: '目标运行实例仍忙，拒绝重载' }
    if (this.hasBusyCwd(runner.cwd, id)) {
      return { ok: false, error: '同一工作目录还有其它运行实例在工作，拒绝重载' }
    }
    const sessionFile = runner.agent.getState()?.sessionFile
    if (!sessionFile) return { ok: false, error: '目标会话尚无已保存的会话文件，无法安全重载' }

    const previous = runner.agent
    const previousGeneration = runner.generation
    const queue = previous.queueSnapshot()
    const replacement = this.opts.createAgent(runner.id, runner.cwd, runner.generation + 1)
    runner.agent = replacement
    runner.generation += 1
    this.opts.onChanged?.()

    let failure: string | undefined
    try {
      const started = await replacement.start()
      if (!started.ok) failure = started.error ?? '替代运行实例启动失败'
      if (!failure) {
        const switched = await replacement.switchSession(sessionFile)
        if (!switched.ok) failure = switched.error ?? '替代运行实例载入原会话失败'
      }
      if (!failure) {
        const restored = await replacement.restoreQueueSnapshot(queue)
        if (!restored.ok) failure = restored.error ?? '替代运行实例恢复排队消息失败'
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }

    if (failure) {
      runner.agent = previous
      runner.generation = previousGeneration
      try {
        await replacement.stop()
      } catch {
        /* 保留的 previous 才是可继续使用的实例；尽力回收半启动的新进程。 */
      }
      this.opts.onChanged?.()
      return { ok: false, error: failure }
    }

    try {
      await previous.stop()
    } catch {
      /* 替代实例已就绪；旧实例停止失败不应切回一个可能已半停的进程。 */
    }
    runner.lastActiveAt = Date.now()
    this.opts.onChanged?.()
    return this.result(runner, 'reuse')
  }

  /** 当前实例的 id（渲染端回报事件身份时用得上） */
  idOf(agent: AgentController): string | null {
    for (const r of this.runners.values()) if (r.agent === agent) return r.id
    return null
  }

  /**
   * 停止并移除一个实例。作用域**只到这一个会话**
   * （用户单独停 B 不该影响 A）。
   */
  async stopOne(id: string): Promise<boolean> {
    const r = this.runners.get(id)
    if (!r) return false
    this.runners.delete(id)
    if (this.activeId === id) this.activeId = null
    try {
      await r.agent.stop()
    } catch {
      /* 已经死了 */
    }
    this.opts.onChanged?.()
    return true
  }

  /** 按会话文件停（删除会话、归档项目时用） */
  async stopBySessionFile(sessionFile: string): Promise<boolean> {
    const hit = this.findBySessionFile(sessionFile)
    if (!hit) return false
    return this.stopOne(hit.id)
  }

  /**
   * 停掉某个工作目录下的所有实例（N05：换项目时的作用域界定）。
   * 只影响该目录，不动别的项目里正在跑的会话。
   */
  async stopByCwd(cwd: string): Promise<number> {
    const normalized = canonicalCwd(cwd)
    const ids = [...this.runners.values()]
      .filter((r) => canonicalCwd(r.cwd) === normalized)
      .map((r) => r.id)
    for (const id of ids) await this.stopOne(id)
    return ids.length
  }

  /** 顶掉所有实例（退出、语言/凭证变更需要重建进程时用） */
  async stopAll(): Promise<void> {
    const all = [...this.runners.values()]
    this.runners.clear()
    this.activeId = null
    for (const r of all) {
      try {
        await r.agent.stop()
      } catch {
        /* 已经死了 */
      }
    }
    this.opts.onChanged?.()
  }

  /** 有实例正在干活（重启前要等它们） */
  hasBusy(): boolean {
    return [...this.runners.values()].some((r) => this.busy(r))
  }

  /** 指定工作目录是否有会被包变更 / 重载打扰的运行实例。 */
  hasBusyCwd(cwd: string, exceptRunId?: string): boolean {
    const key = canonicalCwd(cwd)
    return [...this.runners.values()].some(
      (runner) => runner.id !== exceptRunId && canonicalCwd(runner.cwd) === key && this.busy(runner)
    )
  }

  /**
   * Recover the process-local runner for a durable capability target.
   * Runner ids/generations can reset after an app restart; the session file,
   * cwd and AgentController's bound project identity are the stable match.
   */
  activationSnapshot(target: {
    runnerId: string
    cwd: string
    sessionFile: string
    projectId: string
  }): {
    id: string
    generation: number
    cwd: string
    sessionFile: string | null
    projectId: string | null
    ready: boolean
    busy: boolean
  } | null {
    const expectedCwd = canonicalCwd(target.cwd)
    const expectedSession = canonicalCwd(target.sessionFile)
    const matches = [...this.runners.values()].filter((runner) => {
      const state = runner.agent.getState()
      const projectId = runner.agent.capabilityProjectId ?? runner.projectId ?? null
      return canonicalCwd(runner.cwd) === expectedCwd &&
        canonicalCwd(state?.sessionFile ?? '') === expectedSession &&
        projectId === target.projectId
    })
    const runner = matches.find((item) => item.id === target.runnerId) ?? matches[0]
    if (!runner) return null
    const state = runner.agent.getState()
    return {
      id: runner.id,
      generation: runner.generation,
      cwd: runner.cwd,
      sessionFile: state?.sessionFile ?? null,
      projectId: runner.agent.capabilityProjectId ?? runner.projectId ?? null,
      ready: runner.agent.getConn().state === 'ready',
      busy: this.busy(runner)
    }
  }

  /** 当前视图对应的状态（渲染端拉取 / 推送都用它） */
  statuses(): RunnerStatus[] {
    return [...this.runners.values()].map((r) => {
      const st: SessionState | null = r.agent.getState()
      const conn = r.agent.getConn().state
      return {
        id: r.id,
        runId: r.id,
        sessionFile: st?.sessionFile,
        sessionId: st?.sessionId,
        projectId: r.projectId,
        generation: r.generation,
        cwd: st?.cwd ?? r.cwd,
        running: st?.isAgentRunning === true,
        waiting: r.agent.getPendingUiCount() > 0,
        failed: conn === 'error' || conn === 'exited',
        conn,
        createdAt: r.createdAt,
        lastActiveAt: r.lastActiveAt,
        isActive: r.id === this.activeId
      }
    })
  }

  get size(): number {
    return this.runners.size
  }
}
