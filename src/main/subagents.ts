/**
 * 子代理运行（方案第 8 节）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么是「自有进程管理适配」而不是直接装上游扩展
 * ══════════════════════════════════════════════════════════════════
 * 方案 8.2 的门槛（Windows 路径 / Electron 起子进程 / RPC 事件流 /
 * 取消与恢复）必须**实测**才能算通过，而上游候选扩展在本机没有装、
 * 也没有可复现的 Windows RPC 事件协议证据。方案 8.2 自己写了兜底：
 *   「若两者都无法提供稳定流，采用 Yan 自有进程管理适配，但保留同一前端模型」。
 * 这里就是那条兜底路线：
 *   · 每个子任务 = **一个独立的 `pi --mode rpc` 子进程**（真正的进程隔离）；
 *   · 事件流复用主进程已有的 `PiRpc` 与 `normalizeMessage`（不解析终端画面）；
 *   · 前端模型（SubagentRun + 转录）与「未来接上游扩展」时**完全一致** ——
 *     换实现只需要换这个文件里的 spawn 部分。
 *
 * ── 边界（方案 8.4）──
 *   · 并发上限 2、不嵌套（子代理不会再起子代理）；
 *   · 单次运行超时上限（默认 10 分钟），到点标记 error 并杀掉进程；
 *   · 转录有界（保留最后 200 条），避免 IPC 越推越大；
 *   · 子任务只拿到自己的工作目录，不继承桌面端能力；
 *   · 不把子任务的用量计入父会话（父工具汇总与子会话重复计费是坑）。
 */
import { randomBytes } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { YAN_DIR } from './paths'
import type { SubagentRun, UIMessage } from '../shared/ipc'
import { normalizeMessage, type PiMessage } from './normalize'
import { PiRpc } from './protocol'
import {
  applyPatch,
  cleanupWorkspace,
  collectDiff,
  prepareWorkspace,
  type PreparedWorkspace
} from './subagent-isolation'

/** 同时最多跑几个（方案 8.4 建议首期 2 个） */
const MAX_CONCURRENT = 2
/** 单次运行上限：到点标记失败并杀进程，避免僵尸任务占着额度 */
const RUN_TIMEOUT_MS = 10 * 60 * 1000
/**
 * 实际用的运行上限。
 *
 * `YAN_SUBAGENT_TIMEOUT_MS` 只为测试能真跑一次超时分支（真实验证等不起 10 分钟）——
 * 与 `YAN_AUTO_CONTINUE` 同一个先例；不设时就是上面那个常量。
 */
function runTimeoutMs(): number {
  const override = Number(process.env.YAN_SUBAGENT_TIMEOUT_MS)
  return Number.isFinite(override) && override > 0 ? override : RUN_TIMEOUT_MS
}

/** 超时提示要报**实际上限**：测试把它压到几百毫秒时不能再写「超过 10 分钟」 */
function runTimeoutText(ms: number): string {
  if (ms >= 60_000) return `运行超时（超过 ${Math.round(ms / 60_000)} 分钟）`
  if (ms >= 1_000) return `运行超时（超过 ${Math.round(ms / 1000)} 秒）`
  return `运行超时（超过 ${ms} 毫秒）`
}
/** 转录最多保留多少条 */
const MAX_TRANSCRIPT = 200
/**
 * 只读子代理的工具白名单（D4）。
 *
 * `controlled-cwd` 只是"不另开 worktree"，它本身**不限制写入** ——
 * 真正兑现"只读"要在 pi 侧传 `--tools`（0.85.1 支持，语义是
 * `Comma-separated allowlist of tool names to enable`）。
 * 没有 write / edit / bash，子任务就不可能改主工作目录。
 */
const READONLY_TOOLS = 'read,grep,find,ls'

/**
 * 子代理真正用到的 pi 客户端能力。
 *
 * 抽成接口是为了让单测注入假实现：并发槽位、退出清理这些策略的验证
 * 不该依赖真的 spawn 一个 pi 进程（慢、要凭证、还会花额度）。
 */
export interface SubagentRpc {
  readonly running: boolean
  on(event: string, listener: (...args: never[]) => void): unknown
  spawn(): void
  command(
    type: string,
    payload?: Record<string, unknown>,
    opts?: { timeoutMs?: number }
  ): Promise<{ success: boolean; error?: string; data?: unknown }>
  close(): Promise<void>
}

interface Run extends SubagentRun {
  rpc: SubagentRpc
  timer: NodeJS.Timeout
  /** 收到过 agent_settled / agent_end 就认为这一轮结束 */
  settled: boolean
  workspace: PreparedWorkspace
  finalizing?: Promise<void>
  /** worktree 已经归档或确认无需保留（退出清理据此避免重复 git 操作） */
  worktreeDone?: boolean
  /**
   * 转录消息的序号，只在**真的落一条新消息**时 +1。
   *
   * 不能再用 `transcript.length`：toolResult 是回填（不 push），
   * 用它做序号会错位，同一条流式回复就会被拆成多条、最终文本也会被盖掉。
   */
  msgSeq: number
  /** 正在流式的那条消息（message_start 打开、message_end 关闭） */
  streamingId?: string
  /**
   * 这一轮最后一个 `stopReason`（pi 把「模型返回错误」只放在这里）。
   * 子代理以前不看它，于是模型失败会被 settled 当成「已完成」（实测 2026-09-19）。
   */
  stopReason?: string
}

export interface SubagentOptions {
  /** 父会话当前工作目录；写入任务不会直接使用它。 */
  cwd: string
  piBin?: string
  parentSessionId?: string
  parentRunId?: string
  projectId?: string
  /** 退出 / 重启时的可恢复补丁目录。 */
  archiveDir?: string
  /** 传给子进程的扩展（默认不传：子代理不需要浏览器/提问扩展） */
  extensions?: string[]
  /** 追加系统提示（例如「你是子代理，目标明确、少寒暄」） */
  appendSystemPrompt?: string
  /** 运行状态变化时回调（主进程转成 push） */
  onChange: (run: SubagentRun) => void
  onRemove?: (id: string) => void
  /** 造 pi 客户端（默认真的 PiRpc；单测注入假实现） */
  createRpc?: (opts: { cwd: string; piBin?: string; args: string[] }) => SubagentRpc
  /** 准备隔离工作区（默认真的 git worktree；单测注入以便控制准备阶段的时长） */
  prepare?: (rootCwd: string, id: string, isolation: 'worktree' | 'controlled-cwd') => Promise<PreparedWorkspace>
}

export class SubagentController {
  private runs = new Map<string, Run>()
  /**
   * 正在准备隔离工作区、还没有进入 `runs` 的启动请求数。
   * 它们同样是"占用中"的槽位，见 `runningCount`。
   */
  private preparing = 0
  private opts: SubagentOptions

  constructor(opts: SubagentOptions) {
    this.opts = opts
  }

  /**
   * 子代理属于启动它的父会话。切换查看对象不会改已有 run 的归属，
   * 但下一次 `/subagent` 应使用新的当前会话 / cwd。
   */
  setContext(context: { cwd: string; parentSessionId?: string; parentRunId?: string; projectId?: string }): void {
    this.opts = { ...this.opts, ...context }
  }

  /** 对外只暴露纯数据（不能把 PiRpc 实例推给渲染端） */
  private snapshot(run: Run): SubagentRun {
    return {
      id: run.id,
      task: run.task,
      cwd: run.cwd,
      parentSessionId: run.parentSessionId,
      parentRunId: run.parentRunId,
      projectId: run.projectId,
      isolation: run.isolation,
      resultPath: run.resultPath,
      model: run.model,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      latestActivity: run.latestActivity,
      transcript: run.transcript,
      diff: run.diff,
      review: run.review,
      error: run.error
    }
  }

  private emit(run: Run): void {
    this.opts.onChange(this.snapshot(run))
  }

  list(): SubagentRun[] {
    return [...this.runs.values()].map((r) => this.snapshot(r))
  }

  get(id: string): SubagentRun | undefined {
    const run = this.runs.get(id)
    return run ? this.snapshot(run) : undefined
  }

  get runningCount(): number {
    const live = [...this.runs.values()].filter((r) => r.status === 'running' || r.status === 'starting').length
    return live + this.preparing
  }

  /** 跑清掉**已结束**的记录（运行中的不动） */
  clearFinished(): void {
    for (const [id, run] of [...this.runs]) {
      if (run.status === 'running' || run.status === 'starting') continue
      /* 未审阅的 worktree 不能被“清除已结束”悄悄丢掉。 */
      if (run.review === 'pending' || run.review === 'conflict') continue
      this.runs.delete(id)
      this.opts.onRemove?.(id)
    }
  }

  async start(
    task: string,
    model?: string,
    isolation: 'worktree' | 'controlled-cwd' = 'worktree'
  ): Promise<{ ok: boolean; error?: string; run?: SubagentRun }> {
    const text = task.trim()
    if (!text) return { ok: false, error: '任务描述为空' }
    if (this.runningCount >= MAX_CONCURRENT) {
      return { ok: false, error: `同时最多 ${MAX_CONCURRENT} 个子代理，先等一个结束或停掉它` }
    }

    /*
     * 槽位必须在第一个 `await` 之前预占（D1）。准备 worktree 要跑几条
     * git 命令（几十毫秒起），期间别的 `start` 会看到"没人占位"，
     * 于是三个并发请求能一起越过上限。
     *
     * 上下文也在这里整体快照（D3）：`setContext` 可能在准备期间被调用
     * （用户切了父会话），逐字段读 `this.opts` 会让 cwd 与
     * parentSessionId 分属两代。
     */
    const ctx = this.opts
    this.preparing += 1
    try {
      return await this.launch(ctx, text, model, isolation)
    } finally {
      this.preparing -= 1
    }
  }

  private async launch(
    ctx: SubagentOptions,
    text: string,
    model: string | undefined,
    isolation: 'worktree' | 'controlled-cwd'
  ): Promise<{ ok: boolean; error?: string; run?: SubagentRun }> {
    const id = `sub-${randomBytes(4).toString('hex')}`
    let workspace: PreparedWorkspace
    try {
      const prepare = ctx.prepare ?? prepareWorkspace
      workspace = await prepare(ctx.cwd, id, isolation)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }

    const rpc = this.createRpc(ctx, workspace.cwd, model, isolation)

    const run: Run = {
      id,
      task: text,
      cwd: workspace.cwd,
      parentSessionId: ctx.parentSessionId,
      parentRunId: ctx.parentRunId,
      projectId: ctx.projectId,
      isolation: workspace.isolation,
      model,
      status: 'starting',
      startedAt: Date.now(),
      latestActivity: '启动中…',
      transcript: [],
      review: 'none',
      rpc,
      workspace,
      settled: false,
      msgSeq: 0,
      /* 占位，下面立刻覆盖 */
      timer: setTimeout(() => undefined, 0)
    }
    clearTimeout(run.timer)
    /*
     * 上限在**排定时就固定**（而不是等回调里再读 env）：
     * 否则测试提前清掉覆盖值时，提示会写成另一个数。
     */
    const timeoutMs = runTimeoutMs()
    run.timer = setTimeout(() => void this.fail(id, runTimeoutText(timeoutMs)), timeoutMs)

    rpc.on('event', (evt: Record<string, unknown>) => this.handleEvent(run, evt))
    rpc.on('exit', () => {
      /* 进程自己退了但没标结束 —— 也算结束，不留在“运行中” */
      if (run.status === 'running' || run.status === 'starting') {
        run.status = 'error'
        run.error = run.error ?? 'pi 子进程提前退出'
        run.endedAt = Date.now()
        this.emit(run)
        void this.finalize(run, false)
      }
    })

    this.runs.set(id, run)
    this.emit(run)

    try {
      rpc.spawn()
      /* 等 pi 起来（扩展加载 + RPC 就绪） */
      const ready = await this.waitReady(rpc, 20_000)
      if (!ready) {
        await this.fail(id, '子代理启动超时')
        return { ok: false, error: '子代理启动超时' }
      }
      run.status = 'running'
      run.latestActivity = '已启动'
      this.emit(run)

      const res = await rpc.command('prompt', { message: text })
      if (!res.success) {
        await this.fail(id, res.error ?? '启动任务失败')
        return { ok: false, error: res.error ?? '启动任务失败' }
      }
      return { ok: true, run: this.snapshot(run) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.fail(id, message)
      return { ok: false, error: message }
    }
  }

  /** 拼子进程参数并造客户端（默认 `PiRpc`，单测可注入假实现） */
  private createRpc(
    ctx: SubagentOptions,
    cwd: string,
    model: string | undefined,
    isolation: 'worktree' | 'controlled-cwd'
  ): SubagentRpc {
    const args = [
      ...(ctx.extensions?.flatMap((p) => ['--extension', p]) ?? []),
      ...(ctx.appendSystemPrompt ? ['--append-system-prompt', ctx.appendSystemPrompt] : []),
      /* 只读任务把工具白名单交给 pi 兜底（D4），不依赖上层自觉。 */
      ...(isolation === 'controlled-cwd' ? ['--tools', READONLY_TOOLS] : []),
      /*
       * 模型：优先用调用方指定的；否则跟随测试用的 YAN_TEST_MODEL
       * （与主 agent 同一套约定，让回归能跑在免费模型上）。
       */
      ...(model
        ? ['--model', model]
        : process.env.YAN_TEST_MODEL
          ? ['--model', process.env.YAN_TEST_MODEL]
          : [])
    ]
    if (ctx.createRpc) return ctx.createRpc({ cwd, piBin: ctx.piBin, args })
    return new PiRpc({ cwd, piBin: ctx.piBin, args })
  }

  /** 停止一个运行（方案 8.3：停止是明确动作，不是关掉预览） */
  async stop(id: string): Promise<{ ok: boolean; error?: string }> {
    const run = this.runs.get(id)
    if (!run) return { ok: false, error: '找不到这个子代理' }
    if (run.status !== 'running' && run.status !== 'starting') return { ok: true }
    await this.stopRun(run, false)
    return { ok: true }
  }

  private async stopRun(run: Run, cleanupReview: boolean): Promise<void> {
    try {
      await run.rpc.command('abort')
    } catch {
      /* abort 失败也要把进程收掉 */
    }
    clearTimeout(run.timer)
    await run.rpc.close()
    run.status = 'cancelled'
    run.endedAt = Date.now()
    run.latestActivity = '已停止'
    this.emit(run)
    await this.finalize(run, cleanupReview)
  }

  /**
   * 退出 / 重启时必须等待所有 pi 子进程和 worktree 收口。
   * 有未审阅修改的任务会先落一份补丁归档，再删除临时 worktree，避免
   * 退出留下孤儿进程或孤儿目录，同时保留可追溯结果。
   */
  async stopAll(): Promise<void> {
    const runs = [...this.runs.values()]
    for (const run of runs) {
      if (run.status === 'running' || run.status === 'starting') await this.stopRun(run, true)
      else await this.finalize(run, true)
    }
  }

  private async fail(id: string, message: string): Promise<void> {
    const run = this.runs.get(id)
    if (!run) return
    clearTimeout(run.timer)
    await run.rpc.close()
    run.status = run.status === 'cancelled' ? 'cancelled' : 'error'
    run.error = message
    run.endedAt = Date.now()
    run.latestActivity = message
    this.emit(run)
    await this.finalize(run, false)
  }

  /**
   * 结束后读取隔离 worktree 的摘要。普通结束保留 worktree 给用户审阅；
   * 退出/重启则把补丁保留在 YAN_DIR/subagents 后清掉 worktree。
   *
   * ⚠️ 已结束的任务在退出时还会被 `stopAll` 再调一次（`cleanupReview=true`），
   * 而此时 `run.finalizing` 已经缓存 —— 直接返回它就等于退出时永远不清理
   * 那些"跑完但没审阅"的临时 worktree（D2）。所以缓存之后要**补一次**
   * 退出归档。
   */
  private async finalize(run: Run, cleanupReview: boolean): Promise<void> {
    if (!run.finalizing) run.finalizing = this.finalizeOnce(run, cleanupReview)
    await run.finalizing
    if (cleanupReview) await this.archiveOnExit(run)
  }

  private async finalizeOnce(run: Run, cleanupReview: boolean): Promise<void> {
    try {
      const archiveDir = this.opts.archiveDir ?? join(YAN_DIR, 'subagents')
      const collected = await collectDiff(run.workspace, archiveDir, run.id)
      run.diff = collected.summary
      const changed = collected.summary.files > 0

      if (run.isolation === 'worktree' && changed) {
        if (cleanupReview) {
          run.review = 'archived'
          run.resultPath = collected.patchPath ?? run.workspace.worktreePath
          await cleanupWorkspace(run.workspace)
          run.worktreeDone = true
        } else {
          run.review = 'pending'
          run.resultPath = run.workspace.worktreePath
        }
      } else {
        run.review = 'none'
        run.resultPath = collected.patchPath
        await cleanupWorkspace(run.workspace)
        run.worktreeDone = true
      }

      await this.writeMetadata(run, collected.patchPath)
    } catch (error) {
      /* 差异读取失败时保留 worktree，不把用户改动当成“无改动”清掉。 */
      run.review = run.isolation === 'worktree' ? 'conflict' : 'none'
      run.error = run.error ?? `读取子代理差异失败：${error instanceof Error ? error.message : String(error)}`
      run.resultPath = run.workspace.worktreePath
      await this.writeMetadata(run)
    }
    this.emit(run)
  }

  /**
   * 退出收口：把仍留在磁盘上的未审阅 worktree 落成补丁再删除。
   * 已归档 / 已合并 / 已放弃 / 无隔离的任务是空操作。
   */
  private async archiveOnExit(run: Run): Promise<void> {
    if (run.worktreeDone) return
    run.worktreeDone = true

    if (run.isolation === 'worktree' && (run.review === 'pending' || run.review === 'conflict')) {
      try {
        const archiveDir = this.opts.archiveDir ?? join(YAN_DIR, 'subagents')
        const collected = await collectDiff(run.workspace, archiveDir, run.id)
        run.diff = collected.summary
        run.review = 'archived'
        run.resultPath = collected.patchPath ?? run.workspace.worktreePath
        await this.writeMetadata(run, collected.patchPath)
      } catch (error) {
        /*
         * 连差异都读不出来就**不删 worktree**：宁可退出后留一个临时目录，
         * 也不能把用户还没看过的改动清干净。
         */
        run.error = run.error ?? `退出归档失败，已保留工作区：${error instanceof Error ? error.message : String(error)}`
        this.emit(run)
        return
      }
    }

    await cleanupWorkspace(run.workspace)
    this.emit(run)
  }

  private async writeMetadata(run: Run, patchPath?: string): Promise<void> {
    try {
      const archiveDir = this.opts.archiveDir ?? join(YAN_DIR, 'subagents')
      await mkdir(archiveDir, { recursive: true })
      await writeFile(
        join(archiveDir, `${run.id}.json`),
        JSON.stringify(
          {
            id: run.id,
            task: run.task,
            parentSessionId: run.parentSessionId,
            parentRunId: run.parentRunId,
            projectId: run.projectId,
            rootCwd: run.workspace.rootCwd,
            isolation: run.isolation,
            status: run.status,
            review: run.review,
            startedAt: run.startedAt,
            endedAt: run.endedAt,
            diff: run.diff,
            patchPath: patchPath ?? run.diff?.patchPath,
            resultPath: run.resultPath
          },
          null,
          2
        ),
        'utf8'
      )
    } catch {
      /* 归档失败不能让已经完成的子代理变成未处理异常。 */
    }
  }

  async merge(id: string): Promise<{ ok: boolean; error?: string }> {
    const run = this.runs.get(id)
    if (!run) return { ok: false, error: '找不到这个子代理' }
    if (run.status === 'running' || run.status === 'starting') return { ok: false, error: '子代理仍在运行，结束后才能合并' }
    if (run.review === 'merged') return { ok: true }
    const patchPath = run.diff?.patchPath
    if (!patchPath || !run.diff?.files) {
      run.review = 'merged'
      await cleanupWorkspace(run.workspace)
      run.worktreeDone = true
      this.emit(run)
      return { ok: true }
    }

    const res = await applyPatch(run.workspace.rootCwd, patchPath)
    if (!res.ok) {
      run.review = 'conflict'
      run.error = res.error
      await this.writeMetadata(run, patchPath)
      this.emit(run)
      return res
    }

    run.review = 'merged'
    run.resultPath = patchPath
    run.error = undefined
    await cleanupWorkspace(run.workspace)
    /* 已清理过就别让退出流程再动一次同一个 worktree。 */
    run.worktreeDone = true
    await this.writeMetadata(run, patchPath)
    this.emit(run)
    return { ok: true }
  }

  async discard(id: string): Promise<{ ok: boolean; error?: string }> {
    const run = this.runs.get(id)
    if (!run) return { ok: false, error: '找不到这个子代理' }
    if (run.status === 'running' || run.status === 'starting') return { ok: false, error: '子代理仍在运行，先停止它' }
    run.review = 'discarded'
    /* 补丁归档保留，但隔离 worktree 明确删除；主工作树不受影响。 */
    run.resultPath = run.diff?.patchPath
    await cleanupWorkspace(run.workspace)
    run.worktreeDone = true
    await this.writeMetadata(run, run.diff?.patchPath)
    this.emit(run)
    return { ok: true }
  }

  private async waitReady(rpc: SubagentRpc, timeoutMs: number): Promise<boolean> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (!rpc.running) return false
      try {
        const res = await rpc.command('get_state', undefined, { timeoutMs: 2000 })
        if (res.success) return true
      } catch {
        /* 还没起来，继续等 */
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    return false
  }

  private handleEvent(run: Run, evt: Record<string, unknown>): void {
    const type = String(evt.type ?? '')
    /* 临时调试开关：看 pi 到底推了哪些事件（YAN_DEBUG_SUBAGENT=1）。
       Windows 上 Electron 是 GUI 子系统，console.log 不进 stdout，所以落临时文件。 */
    if (process.env.YAN_DEBUG_SUBAGENT) {
      try {
        appendFileSync(
          join(tmpdir(), 'yan-subagent-events.log'),
          `${run.id} ${type} ${JSON.stringify(evt).slice(0, 600)}\n`,
          'utf8'
        )
      } catch {
        /* 调试用，失败无所谓 */
      }
    }
    if (type === 'message_start' || type === 'message_update' || type === 'message_end') {
      const raw = evt.message as PiMessage | undefined
      if (!raw) return

      /*
       * 先记住这一轮的结束原因。
       *
       * pi 不会给「模型失败」发一个单独的 error 事件：回合照常走到
       * `agent_settled`，错误只体现在 assistant 消息的 `stopReason` 上。
       * 不记住它，settled 就无法分辨「真答完了」与「模型报错了」
       *（实测：坏模型名下子代理显示「已完成」、`error=null`）。
       */
      if (raw.role === 'assistant' && raw.stopReason) run.stopReason = raw.stopReason

      /*
       * `toolResult` 不是新消息，而是对已有工具调用的**回填**（也不占用序号）。
       * 主会话的历史回放（normalizeHistory）就是这么做的；子代理这边原先
       * 直接 push，于是同一个调用在详情面板里显示成两条（一条默认 ok、
       * 一条 error），真实结果反而看不出来 —— 实测：只读子代理的 write
       * 被白名单封死，面板上却有一个绿色的 write。
       */
      if (raw.role === 'toolResult') {
        const result = normalizeMessage(raw, run.msgSeq)?.toolCalls?.[0]
        const target = result
          ? run.transcript.find((m: UIMessage) => m.toolCalls?.some((c) => c.id === result.id))
          : undefined
        const call = target?.toolCalls?.find((c) => c.id === result?.id)
        if (result && call) {
          call.status = result.status
          call.output = result.output
          if (result.cancelled) call.cancelled = true
          run.latestActivity = `${call.name}${result.status === 'error' ? ' 失败' : ' 完成'}`
          this.emit(run)
          return
        }
      }

      /* 开一条新消息才递增序号；流式 update/end 复用同一个序号 */
      if (type === 'message_start' || run.streamingId === undefined) {
        run.msgSeq += 1
        run.streamingId = `m${run.msgSeq}`
      }
      const msg = normalizeMessage(raw, run.msgSeq)
      if (!msg) return

      const idx = run.transcript.findIndex((m: UIMessage) => m.id === msg.id)
      if (idx >= 0) run.transcript[idx] = msg
      else run.transcript.push(msg)
      if (type === 'message_end') run.streamingId = undefined
      if (run.transcript.length > MAX_TRANSCRIPT) {
        run.transcript.splice(0, run.transcript.length - MAX_TRANSCRIPT)
      }
      run.latestActivity = activityOf(msg)
      this.emit(run)
      return
    }

    if (type === 'tool_execution_start') {
      run.latestActivity = `运行 ${String(evt.toolName ?? '工具')}`
      this.emit(run)
      return
    }

    if (type === 'agent_settled' || type === 'agent_end') {
      if (run.settled) return
      run.settled = true
      clearTimeout(run.timer)
      /*
       * 模型自己失败也要如实落成 `error`（L03 尾巴）。
       *
       * 判据是 `stopReason === 'error'`，而不是「转录里有没有文本」：
       * 失败回合的 assistant 消息往往为空文本，拿空文本判会把空回复
       * 误判成失败；反过来只看 settled 则把失败当成功。
       */
      const modelFailed = run.status !== 'cancelled' && run.stopReason === 'error'
      run.status = run.status === 'cancelled' ? 'cancelled' : modelFailed ? 'error' : 'done'
      run.endedAt = Date.now()
      if (modelFailed) run.error = run.error ?? '模型返回错误（这一轮没有产出可用结果）'
      run.latestActivity = modelFailed ? '模型返回错误' : '已完成'
      this.emit(run)
      /*
       * 跑完的子代理进程必须收掉（D16）。
       *
       * pi 的 rpc 模式在 `agent_settled` 之后**不会自己退出**（还在等下一
       * 条命令）。原先这里只 finalize、不 close，后果有两个，都是实测到的：
       *   · 每跑完一个子任务就泄漏一个 pi 子进程，退出时 `stopAll` 又只对
       *     `running` 的调 `stopRun`，于是孤儿进程一直活到机器重启；
       *   · 进程的 cwd 就是隔离 worktree，Windows 上删不掉被用作工作目录
       *     的目录 —— `git worktree remove` 静默失败，临时目录残留。
       *
       * 但也不能一收到 settled 就 close：实测 settled 时 assistant 消息还是
       * 空的，模型的最终回复随后才到 —— 立即 close 会把尾巴一起切掉
       *（子代理场景的“转录里有回复文本”就是这么挂的）。所以先等转录安静。
       */
      void (async () => {
        await this.waitTranscriptQuiet(run)
        try {
          await run.rpc.close()
        } catch {
          /* 已经退了就算了 */
        }
        await this.finalize(run, false)
      })()
    }
  }

  /**
   * 等这一轮的尾部事件推完。
   *
   * 判据是“转录连续一段时间没有变化”（而不是固定 sleep）：pi 的
   * `agent_settled` 不等于消息已经推完，但推完到安静之间的间隔很短，
   * 而且不同模型/工具数差别很大。带上限，不会把退出卡住。
   */
  private async waitTranscriptQuiet(run: Run, quietMs = 600, maxMs = 5000): Promise<void> {
    const snapshot = (): string =>
      JSON.stringify(
        run.transcript.map((m) => [
          m.id,
          m.text.length,
          m.toolCalls?.map((c) => [c.name, c.status, c.output?.length ?? 0]) ?? []
        ])
      )
    let last = snapshot()
    let changedAt = Date.now()
    const started = Date.now()
    while (Date.now() - started < maxMs) {
      await new Promise((r) => setTimeout(r, 150))
      const now = snapshot()
      if (now !== last) {
        last = now
        changedAt = Date.now()
        continue
      }
      if (Date.now() - changedAt >= quietMs) return
    }
  }
}

/** 列表里显示的那一行活动 */
function activityOf(msg: UIMessage): string {
  if (msg.role === 'assistant') {
    const first = msg.text.split('\n').map((x) => x.trim()).find(Boolean)
    if (first) return first.slice(0, 80)
    if (msg.toolCalls?.length) return `调用 ${msg.toolCalls[msg.toolCalls.length - 1].name}`
    if (msg.thinking) return '推理中…'
    return '生成中…'
  }
  return msg.text.split('\n').find(Boolean)?.slice(0, 80) ?? '处理中…'
}
