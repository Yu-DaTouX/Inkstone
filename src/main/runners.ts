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
import type { RunnerStatus, RuntimeEnvelope, SessionScope } from '../shared/ipc'
import { executionBusy, runEnvelope, runStatus } from '../core/run-state'
import { canReclaimIdle, IDLE_RECLAIM_ENABLED, IDLE_RECLAIM_SCAN_MS } from './runner-reclaim'

/**
 * 同时运行的会话实例上限（含当前正在查看的那个）。
 *
 * 为什么是 3：每个实例是一个完整的 pi 子进程 + 它的 token 统计与工具进程，
 * 再多对普通机器不友好。到上限时的行为是**明确拒绝并提示**，
 * 而不是悄悄停掉某个旧会话 —— 那正是用户报的 bug。
 */
export const RUNNER_LIMIT = 3

/**
 * 代次在整个主进程内单调递增，跨注册表重建也不回落。
 *
 * 渲染端按会话缓存后台状态，并丢弃代次更旧的事件。保存凭证、安装 Git 等会
 * `restartAgent` → 新建注册表，runner id 会从 r1 重新编号；代次若也回到 1，
 * 新实例的事件会被当成旧代次挡在缓存外，切走再切回时只剩重建前的内容。
 */
let lastGeneration = 0
function nextGeneration(): number {
  lastGeneration += 1
  return lastGeneration
}

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
  hidden?: boolean
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
  /**
   * 只是「看一眼」这条会话：不建实例、更不建隔离工作树。
   *
   * 命中已有实例仍然会正常切视图；需要新建/复用实例时直接返回 `deferred`，
   * 等用户真的发消息（不带 preview 的 select）时再说。
   */
  preview?: boolean
  /** 未提交的交接片段不复用其它会话，也不暴露到侧栏。 */
  hidden?: boolean
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
  /** `preview` 时没动实例：调用方必须保持「未激活」状态，别当成切换成功 */
  deferred?: boolean
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
  private reclaimOperation?: Promise<string | null>
  private reclaimTimer?: ReturnType<typeof setInterval>
  private disposed = false

  constructor(
    private opts: {
      limit?: number
      now?: () => number
      isSessionVisible?: (state: ReturnType<AgentController['getState']>) => boolean
      /** 首版保守保护所有有子代理归属的会话，包括结束通知尚未投递的窗口。 */
      isParentProtected?: (sessionId: string | undefined, runId: string) => boolean
      onReclaimed?: (entry: { id: string; sessionId?: string; idleMs: number; remaining: number }) => void
      /** 造一个新的 pi 会话实例。id 用于给 IPC 事件标身份 */
      createAgent: (id: string, cwd: string, generation?: number) => AgentController
      /** Apply desktop defaults only to a new conversation, never to restored history. */
      prepareNewSession?: (agent: AgentController) => Promise<{ ok: boolean; error?: string }>
      /** 实例集合或状态变化时通知主进程（推给渲染端） */
      onChanged?: () => void
      /**
       * 同一 cwd 冲突时的**自动隔离**（宿主注入）。
       *
       * 返回 `{ cwd }`：换一个不冲突的物理目录继续（宿主负责建库与告知用户）；
       * 返回 `{ reason }`：隔离没成，把原因并进原来的冲突报错；
       * 返回 `null`：宿主不处理，按原来的报错走。
       */
      resolveCwdConflict?: (target: SelectTarget) => Promise<{ cwd: string } | { reason: string } | null>
      /**
       * 隔离状态的同步查询（主进程维护的那张小表）：按 runner 的 cwd 问
       * 「这棵隔离工作树现在什么状态」。
       *
       * 为什么必须同步：`statuses()` 是快照构造，整条推送链上没有 await 的位置；
       * 查询本身也只是一次 Map 命中。
       */
      isolationOf?: (cwd: string) => { state: 'waiting' | 'blocked'; branch: string } | undefined
    }
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  /** 运行事件也算活动；回合结束、bash/提问/队列收尾均重新起算空闲时间。 */
  noteActivity(id: string): void {
    const runner = this.runners.get(id)
    if (runner) runner.lastActiveAt = this.now()
  }

  /** 显示集合更新前触碰旧集合，关掉分屏列之后从此刻重新起算。 */
  noteVisibleActivity(): void {
    for (const runner of this.runners.values()) {
      if (this.opts.isSessionVisible?.(runner.agent.getState()) ?? true) this.noteActivity(runner.id)
    }
  }

  private activateRunner(id: string): void {
    if (this.activeId && this.activeId !== id) this.noteActivity(this.activeId)
    this.activeId = id
  }

  startIdleReclaim(): void {
    if (!IDLE_RECLAIM_ENABLED || this.disposed || this.reclaimTimer) return
    this.reclaimTimer = setInterval(() => {
      void this.reclaimIdle().catch((error) => console.error('[runner-reclaim]', error))
    }, IDLE_RECLAIM_SCAN_MS)
    this.reclaimTimer.unref?.()
  }

  /** 与选择和重载共用串行链；并行扫描合并，不积压多个回收请求。 */
  reclaimIdle(): Promise<string | null> {
    if (this.reclaimOperation) return this.reclaimOperation
    const operation = this.serialize(async () => {
      if (!IDLE_RECLAIM_ENABLED || this.disposed) return null
      const now = this.now()
      for (const runner of [...this.runners.values()].sort((a, b) => a.lastActiveAt - b.lastActiveAt)) {
        const state = runner.agent.getState()
        const queue = runner.agent.queueSnapshot()
        const facts = {
          active: runner.id === this.activeId,
          hidden: runner.hidden === true,
          busy: this.busy(runner),
          busyCwd: this.hasBusyCwd(runner.cwd, runner.id),
          ready: runner.agent.getConn().state === 'ready',
          saved: !!state?.sessionFile,
          queued: queue.steering.length > 0 || queue.followUp.length > 0,
          visible: this.opts.isSessionVisible?.(state) ?? true,
          parentProtected: this.opts.isParentProtected?.(state?.sessionId, runner.id) ?? false,
          restarting: this.restartOperations.has(runner.id),
          lastActiveAt: runner.lastActiveAt
        }
        if (facts.active || facts.busy || facts.busyCwd || facts.queued || facts.visible || facts.parentProtected || facts.restarting || !facts.ready) {
          runner.lastActiveAt = now
        }
        if (!canReclaimIdle(facts, now)) continue
        const idleMs = now - runner.lastActiveAt
        // 判定到摘登记之间没有 await；后到的 select 只能在关闭完成后载回。
        if (await this.stopOne(runner.id)) {
          this.opts.onReclaimed?.({ id: runner.id, sessionId: state?.sessionId, idleMs, remaining: this.size })
          return runner.id
        }
      }
      return null
    })
    this.reclaimOperation = operation
    void operation.finally(() => {
      if (this.reclaimOperation === operation) this.reclaimOperation = undefined
    }).catch(() => undefined)
    return operation
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.selectTail.then(work, work)
    this.selectTail = next.then(() => undefined, () => undefined)
    return next
  }

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

  /**
   * 延长某个待回答问题的等待（宿主提问专用）。
   *
   * 在**所有**实例里找持有该 id 的那个 —— 提问与回答都带实例身份，但延长是
   * 「用户对着屏幕上的面板点的」，渲染端只知道 request id。逐个问一遍的代价
   * 最大也就是三个实例的 Map 命中。
   */
  extendHostUi(id: string, extraMs?: unknown): { ok: boolean; timeout?: number; deadline?: number; error?: string } {
    for (const runner of this.runners.values()) {
      const result = runner.agent.extendHostUi(id, extraMs)
      if (result.ok) return result
    }
    return { ok: false, error: 'question_not_pending' }
  }

  /**
   * 回答一个待答问题：交给**持有该 id 的实例**。
   *
   * 后台会话也会弹问题，用户答的时候可能正看着别的会话；按「当前实例」投递会把答复
   * 发给错的 pi 进程。没有实例持有该 id（已超时 / 已答）时退回当前实例，行为同旧路径。
   */
  respondUi(res: Parameters<AgentController['respondUi']>[0]): void {
    for (const runner of this.runners.values()) {
      if (runner.agent.pendingUiRequests().some((item) => item.id === res.id)) {
        runner.agent.respondUi(res)
        return
      }
    }
    this.active()?.respondUi(res)
  }

  /**
   * 「用户看到这一条了」→ 让持有它的实例开始计时。
   *
   * 与 `extendHostUi` 同一套查找：渲染端只知道 request id，不知道它属于哪个实例。
   */
  startHostUiTimer(id: string): { ok: boolean; timeout?: number; deadline?: number; error?: string } {
    for (const runner of this.runners.values()) {
      const result = runner.agent.startHostUiTimer(id)
      if (result.ok) return result
    }
    return { ok: false, error: 'question_not_pending' }
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

  /** MCP 配置变了：所有实例丢掉旧连接，下次调用按新配置连 */
  async reloadMcpServers(): Promise<void> {
    await Promise.all([...this.runners.values()].map((runner) => runner.agent.reloadMcpServers()))
  }

  /** 按稳定 sessionId 取运行实例；重生成标题等只读动作不应切换视图。 */
  agentForSession(sessionId: string): AgentController | null {
    return this.findBySessionId(sessionId)?.agent ?? null
  }

  /** 给主进程为每条事件附上统一身份封套。 */
  runtimeOf(id: string): RuntimeEnvelope | null {
    const runner = this.runners.get(id)
    if (!runner) return null
    return runEnvelope(runner, runner.agent.getState())
  }

  /** 某个实例此刻「忙着」吗：回合在跑，或有请求在等用户回答 */
  private busy(runner: Runner): boolean {
    return executionBusy(
      runner.agent.getState(),
      () => runner.agent.hasRunningBash(),
      () => runner.agent.getPendingUiCount()
    )
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
    return this.serialize(() => this.selectNow(target))
  }

  private async selectNow(target: SelectTarget): Promise<SelectResult> {
    if (target.sessionId || target.sessionFile) {
      const hit = (target.sessionId && this.findBySessionId(target.sessionId)) ||
        (target.sessionFile ? this.findBySessionFile(target.sessionFile) : undefined)
      if (hit) {
        hit.lastActiveAt = this.now()
        if (target.activate !== false) this.activateRunner(hit.id)
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
      (runner) =>
        canonicalCwd(runner.cwd) === canonicalCwd(target.cwd) &&
        this.busy(runner) &&
        /* 只读 / 聊天的会话不动文件，不算冲突；直执行 bash 一律按写文件处理 */
        (runner.agent.hasRunningBash() || (runner.agent.hasWrittenThisRun?.() ?? true))
    )
    if (conflict) {
      /*
       * 只是「看一下」这条会话（`preview`）：冲突时不建隔离工作树、也不动实例 ——
       * 等用户真的发消息时再说（届时再发一次不带 preview 的 select）。
       * 建树是「要在两处同时干活」的代价，「翻一眼历史」不该付这个代价。
       *
       * ⚠️ 只在这个分支里生效：**没有冲突时照常建/复用实例**。否则重启后
       * （一个实例都没有）点开会话会一直停在「未激活」，右栏那些依赖活跃实例的
       * 显示（上下文策略、模型入口等）就全空着 —— 用户报的「重启后不显示上下文」。
       */
      if (target.preview) return { ok: true, deferred: true, sessionId: target.sessionId }
      /*
       * 先问宿主能不能自动隔离（换一个不冲突的物理目录继续）。
       * 隔离结果必须**真的换了目录**才继续：返回同一个 cwd 等于没解决问题，
       * 放行会直接违反下面这条并发边界的全部意义。
       */
      const escalated = await this.opts.resolveCwdConflict?.(target)
      if (escalated && 'cwd' in escalated && canonicalCwd(escalated.cwd) !== canonicalCwd(target.cwd)) {
        target = { ...target, cwd: escalated.cwd }
      }
      /* 隔离不了（如目录不是 Git 仓库）就静默放行：不拦、不弹提示 */
    }

    /* 复用空闲实例：不忙的那个可以被切到别的会话（旧会话已落盘，随时能载回） */
    const idle = [...this.runners.values()]
      .filter((runner) => !target.hidden && !runner.hidden && !this.busy(runner) && (target.activate !== false || runner.id !== this.activeId))
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0]

    if (idle) {
      /* 跨 cwd 先在未登记的替代进程上准备；成功前旧实例及其身份始终不变。 */
      if (canonicalCwd(idle.cwd) !== canonicalCwd(target.cwd)) {
        const previous = idle.agent
        const generation = nextGeneration()
        let replacement: AgentController | undefined
        let failure: string | undefined
        try {
          replacement = this.opts.createAgent(idle.id, target.cwd, generation)
          replacement.setRunnerGeneration(generation)
          const started = await replacement.start()
          if (!started.ok) {
            failure = started.error ?? '替代运行实例启动失败'
          } else {
            let prepared = target.sessionFile
              ? await replacement.switchSession(target.sessionFile)
              : await replacement.newSession()
            if (prepared.ok && !target.sessionFile && this.opts.prepareNewSession) {
              prepared = await this.opts.prepareNewSession(replacement)
            }
            if (!prepared.ok) failure = prepared.error ?? '替代运行实例准备会话失败'
          }
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
        }
        if (failure !== undefined) {
          try {
            await replacement?.stop()
          } catch {
            /* 尽力回收半启动的替代进程，不覆盖原始失败原因。 */
          }
          return { ok: false, error: failure }
        }

        idle.agent = replacement!
        idle.cwd = target.cwd
        idle.generation = generation
        idle.projectId = target.projectId
        idle.lastActiveAt = this.now()
        if (target.activate !== false) this.activateRunner(idle.id)
        try {
          await previous.stop()
        } catch {
          /* 已提交就绪的新实例，不切回可能已经半停的旧进程。 */
        }
        this.opts.onChanged?.()
        return this.result(idle, 'reuse')
      }

      const oldGeneration = idle.generation
      const oldProjectId = idle.projectId
      const oldSessionFile = idle.agent.getState()?.sessionFile
      idle.generation = nextGeneration()
      idle.agent.setRunnerGeneration(idle.generation)
      idle.projectId = target.projectId
      this.opts.onChanged?.()

      let res = target.sessionFile
        ? await idle.agent.switchSession(target.sessionFile)
        : await idle.agent.newSession()
      if (res.ok && !target.sessionFile && this.opts.prepareNewSession) res = await this.opts.prepareNewSession(idle.agent)
      if (!res.ok) {
        // A failed remembered default must not replace the conversation being reused.
        if (!target.sessionFile && oldSessionFile) {
          try { await idle.agent.switchSession(oldSessionFile) } catch { /* Keep the original setup error. */ }
        }
        idle.generation = oldGeneration
        idle.agent.setRunnerGeneration(oldGeneration)
        idle.projectId = oldProjectId
        this.opts.onChanged?.()
        return { ok: false, error: res.error }
      }
      idle.cwd = target.cwd
      idle.lastActiveAt = this.now()
      if (target.activate !== false) this.activateRunner(idle.id)
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
    const generation = nextGeneration()
    const agent = this.opts.createAgent(id, target.cwd, generation)
    const runner: Runner = {
      id,
      agent,
      cwd: target.cwd,
      projectId: target.projectId,
      generation,
      createdAt: this.now(),
      hidden: target.hidden,
      lastActiveAt: this.now()
    }
    const previousActive = this.activeId
    this.runners.set(id, runner)
    if (target.activate !== false) this.activateRunner(id)

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
      } else {
        if (this.opts.prepareNewSession) {
          const prepared = await this.opts.prepareNewSession(agent)
          if (!prepared.ok) failure = prepared.error ?? '新会话模型初始化失败'
        }
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
    const operation = this.serialize(() => this.restartOneNow(id))
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
    const generation = nextGeneration()
    const replacement = this.opts.createAgent(runner.id, runner.cwd, generation)
    runner.agent = replacement
    runner.generation = generation
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
    runner.lastActiveAt = this.now()
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
  async stopOne(id: string, preserveSelection = false): Promise<boolean> {
    const r = this.runners.get(id)
    if (!r) return false
    this.runners.delete(id)
    if (this.activeId === id && !preserveSelection) this.activeId = null
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
    this.disposed = true
    if (this.reclaimTimer) clearInterval(this.reclaimTimer)
    this.reclaimTimer = undefined
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

  /** 只在用户仍选中源时原地接续；用户中途切走则保留其选择。 */
  publishReplacement(sourceId: string, destinationId: string): boolean {
    const runner = this.runners.get(destinationId)
    if (!runner) return false
    runner.hidden = false
    const activate = this.activeId === sourceId
    runner.lastActiveAt = this.now()
    if (activate) this.activateRunner(destinationId)
    return activate
  }

  /** 当前视图对应的状态（渲染端拉取 / 推送都用它） */
  statuses(): RunnerStatus[] {
    return [...this.runners.values()].filter((r) => !r.hidden).map((r) => {
      const st = r.agent.getState()
      const conn = r.agent.getConn().state
      /* 隔离状态按注册表的 cwd 查（spawn 时就定了），不看 state.cwd —— 后者在过渡期会漂 */
      const isolation = this.opts.isolationOf?.(r.cwd)
      return runStatus({
        id: r.id,
        projectId: r.projectId,
        generation: r.generation,
        cwd: r.cwd,
        state: st,
        pendingUiCount: r.agent.getPendingUiCount(),
        conn,
        createdAt: r.createdAt,
        lastActiveAt: r.lastActiveAt,
        isActive: r.id === this.activeId,
        isolation
      })
    })
  }

  get size(): number {
    return this.runners.size
  }
}
