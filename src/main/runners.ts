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
 */
import type { AgentController } from './agent'
import type { RunnerStatus, SessionState } from '../shared/ipc'

/**
 * 同时运行的会话实例上限（含当前正在查看的那个）。
 *
 * 为什么是 3：每个实例是一个完整的 pi 子进程 + 它的 token 统计与工具进程，
 * 再多对普通机器不友好。到上限时的行为是**明确拒绝并提示**，
 * 而不是悄悄停掉某个旧会话 —— 那正是用户报的 bug。
 */
export const RUNNER_LIMIT = 3

interface Runner {
  id: string
  agent: AgentController
  cwd: string
  createdAt: number
  lastActiveAt: number
}

export interface SelectTarget {
  /** 目标会话文件；缺省 = 新会话（未落盘） */
  sessionFile?: string
  cwd: string
}

export interface SelectResult {
  ok: boolean
  /** 命中 / 复用 / 新建出来的实例 id */
  id?: string
  /** 复用了哪个实例（'hit' 命中已有、'reuse' 复用空闲、'new' 新建） */
  via?: 'hit' | 'reuse' | 'new'
  error?: string
}

export class RunnerRegistry {
  private runners = new Map<string, Runner>()
  private activeId: string | null = null
  private seq = 0

  constructor(
    private opts: {
      limit?: number
      /** 造一个新的 pi 会话实例。id 用于给 IPC 事件标身份 */
      createAgent: (id: string, cwd: string) => AgentController
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

  /** 某个实例此刻「忙着」吗：回合在跑，或有请求在等用户回答 */
  private busy(runner: Runner): boolean {
    const st = runner.agent.getState()
    if (st?.isAgentRunning === true || st?.isCompacting === true || st?.isStreaming === true) return true
    return runner.agent.getPendingUiCount() > 0
  }

  /** 按会话文件找实例 */
  private findBySessionFile(sessionFile: string): Runner | undefined {
    for (const r of this.runners.values()) {
      if (r.agent.getState()?.sessionFile === sessionFile) return r
    }
    return undefined
  }

  /**
   * 选到某个会话并切换视图。
   *
   * 顺序：已有实例命中 → 复用空闲实例 → 新建（受预算限制）。
   * **任何一条路径都不会停止别的实例。**
   */
  async select(target: SelectTarget): Promise<SelectResult> {
    if (target.sessionFile) {
      const hit = this.findBySessionFile(target.sessionFile)
      if (hit) {
        hit.lastActiveAt = Date.now()
        this.activeId = hit.id
        this.opts.onChanged?.()
        return { ok: true, id: hit.id, via: 'hit' }
      }
    }

    /* 复用空闲实例：不忙的那个可以被切到别的会话（旧会话已落盘，随时能载回） */
    const idle = [...this.runners.values()]
      .filter((r) => !this.busy(r))
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0]

    if (idle) {
      const res = target.sessionFile
        ? await idle.agent.switchSession(target.sessionFile)
        : await idle.agent.newSession()
      if (!res.ok) return { ok: false, error: res.error }
      idle.cwd = target.cwd
      idle.lastActiveAt = Date.now()
      this.activeId = idle.id
      this.opts.onChanged?.()
      return { ok: true, id: idle.id, via: 'reuse' }
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
    const agent = this.opts.createAgent(id, target.cwd)
    const runner: Runner = { id, agent, cwd: target.cwd, createdAt: Date.now(), lastActiveAt: Date.now() }
    this.runners.set(id, runner)
    this.activeId = id

    const started = await agent.start()
    if (!started.ok) {
      this.runners.delete(id)
      this.activeId = null
      this.opts.onChanged?.()
      return { ok: false, error: started.error }
    }
    if (target.sessionFile) {
      const sw = await agent.switchSession(target.sessionFile)
      if (!sw.ok) {
        this.runners.delete(id)
        this.activeId = null
        this.opts.onChanged?.()
        return { ok: false, error: sw.error }
      }
    }
    this.opts.onChanged?.()
    return { ok: true, id, via: 'new' }
  }

  /** 启动时创建「主实例」（当前查看的会话就跑在它上面） */
  async startPrimary(cwd: string, sessionFile?: string): Promise<SelectResult> {
    const existing = this.active()
    if (existing) return { ok: true, id: this.activeId ?? undefined, via: 'hit' }
    return this.select({ cwd, sessionFile })
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
    const ids = [...this.runners.values()].filter((r) => r.cwd === cwd).map((r) => r.id)
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

  /** 当前视图对应的状态（渲染端拉取 / 推送都用它） */
  statuses(): RunnerStatus[] {
    return [...this.runners.values()].map((r) => {
      const st: SessionState | null = r.agent.getState()
      const conn = r.agent.getConn().state
      return {
        id: r.id,
        sessionFile: st?.sessionFile,
        sessionId: st?.sessionId,
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
