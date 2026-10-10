/**
 * 每个子任务使用独立 pi RPC 进程，复用事件规范化与有界转录。
 * 默认当前文件夹；只读工具和 Git worktree 均显式选择。
 * 子进程只有自己的危险审批通道，不继承父会话的宿主能力令牌。
 * 并发、超时、取消与用量按子运行记录，结果通过父会话身份回传。
 */
import { randomBytes } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PI_AGENT_DIR, YAN_DIR } from './paths'
import type { SubagentEndReason, SubagentRun, UIMessage } from '../shared/ipc'
import { normalizeMessage, toUsage, type PiMessage } from './normalize'
import { accumulateUsage, ingestUsageSnapshot, type UsageSnapshots } from '../shared/subagent-usage'
import {
  briefPrompt,
  parseSubagentBrief,
  summarizeSubagentRun,
  type SubagentBrief
} from '../shared/subagent-brief'
import { PiRpc, resolvePi } from './protocol'
import { CapabilityServer } from './capability-server'
import { nativePiToolsSupported } from '../shared/agent-context'
import { modelErrorNotice } from '../shared/model-errors'
import { subagentModelError, subagentPiArgs } from '../shared/subagent-pi-launch'
import {
  applyPatch,
  cleanupWorkspace,
  collectDiff,
  prepareWorkspace,
  type PreparedWorkspace
} from './subagent-isolation'

/** 同时最多跑几个（方案 8.4 建议首期 2 个） */
const MAX_CONCURRENT = 2
/**
 * 时间限制有三层，避免「干了很多活却在整点被一刀杀掉、成果全丢」：
 *   · 无进展提醒：这么久没有事件只提醒等待，不据此判定卡死；
 *   · 总上限：不管有没有进展，最长跑这么久（任务输入里可给 `timeoutMinutes`，仍封顶）；
 *   · 收尾宽限：到点先让它交出目前的结论，宽限内仍不结束才硬停。
 */
const IDLE_WARNING_MS = 5 * 60 * 1000
const TOTAL_TIMEOUT_MS = 30 * 60 * 1000
const GRACE_MS = 75 * 1000

/**
 * 无进展提醒、总时长与收尾宽限的实际取值。
 *
 * `YAN_SUBAGENT_TIMEOUT_MS` / `YAN_SUBAGENT_IDLE_MS` / `YAN_SUBAGENT_GRACE_MS` 只为测试能真跑
 * 超时分支，避免回归测试等待完整任务时限。
 */
function envMs(name: string): number | undefined {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : undefined
}
function limitsFor(brief: SubagentBrief): { totalMs: number; idleMs: number; graceMs: number } {
  const total = envMs('YAN_SUBAGENT_TIMEOUT_MS') ?? (brief.timeoutMinutes ? brief.timeoutMinutes * 60_000 : TOTAL_TIMEOUT_MS)
  return { totalMs: total, idleMs: envMs('YAN_SUBAGENT_IDLE_MS') ?? IDLE_WARNING_MS, graceMs: envMs('YAN_SUBAGENT_GRACE_MS') ?? GRACE_MS }
}

/** 时长的可读写法：报**实际上限**，测试把它压到几百毫秒时不能还写「10 分钟」 */
function spanText(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} 分钟`
  if (ms >= 1_000) return `${Math.round(ms / 1000)} 秒`
  return `${ms} 毫秒`
}
const totalTimeoutText = (ms: number): string => `运行超时（超过 ${spanText(ms)}）`
const idleWarningText = (ms: number): string => `超过 ${spanText(ms)} 未收到进展，可能仍在执行工具或等待模型；任务继续运行`

/** 到点后发给子代理的收尾指令 */
function wrapUpMessage(reason: 'timeout' | 'budget'): string {
  return (
    (reason === 'budget' ? '【宿主提示】工具调用次数已用完。' : '【宿主提示】时间到了。') +
    '不要再调用任何工具，立刻用已有的资料交出结论：先说已确认的结论，再说明哪些部分没来得及核实。'
  )
}
/** 转录最多保留多少条 */
const MAX_TRANSCRIPT = 200
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
  /** 当前排定的看门计时器（到点检查空闲 / 总上限，或收尾宽限） */
  timer: NodeJS.Timeout
  /** 最近一次收到 pi 事件的时刻：无进展提醒从这里算 */
  lastProgressAt: number
  totalMs: number
  idleMs: number
  graceMs: number
  /** 收到过 agent_settled / agent_end 就认为这一轮结束 */
  settled: boolean
  workspace: PreparedWorkspace
  finalizing?: Promise<void>
  /** worktree 已经归档或确认无需保留（退出清理据此避免重复 git 操作） */
  worktreeDone?: boolean
  /** 已经回调过 onFinished（每个运行只通知一次） */
  notified?: boolean
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
  /** H-10b：按消息 id 保存最后一份 usage 快照，重放/流式增量不会重复相加 */
  usageSnapshots: UsageSnapshots
  /**
   * 派活时写清的输入（T15-1）。
   *
   * 存在 run 上而不是只拼进 prompt，是因为「结果对不对」要拿它来判断：
   * 主 agent 汇总时得知道当初要的交付物是什么。
   */
  brief: SubagentBrief
}

export interface SubagentApprovalOrigin { sessionId?: string; runId?: string; subagentId?: string }

export interface SubagentOptions {
  /** 父会话当前工作目录；默认在此执行，worktree 模式才建立独立目录。 */
  cwd: string
  piBin?: string
  parentSessionId?: string
  parentRunId?: string
  parentMessageId?: string
  projectId?: string
  /** 退出 / 重启时的可恢复补丁目录。 */
  archiveDir?: string
  confirmDanger?(params: Record<string, unknown>, cwd: string, origin?: SubagentApprovalOrigin): Promise<boolean>
  /** 传给子进程的扩展（默认不传：子代理不需要浏览器/提问扩展） */
  extensions?: string[]
  /** 追加系统提示（例如「你是子代理，目标明确、少寒暄」） */
  appendSystemPrompt?: string
  /** 运行状态变化时回调（主进程转成 push） */
  onChange: (run: SubagentRun) => void
  onRemove?: (id: string) => void
  /** 一次运行收口（差异与审阅状态已定）后回调一次；用来通知父会话 */
  onFinished?: (run: SubagentRun) => void
  /** 造 pi 客户端（默认真的 PiRpc；单测注入假实现） */
  createRpc?: (opts: { cwd: string; piBin?: string; args: string[] }) => SubagentRpc
  /** 按所选方式准备工作目录；单测可注入准备过程。 */
  prepare?: (rootCwd: string, id: string, isolation: 'worktree' | 'controlled-cwd' | 'shared-cwd') => Promise<PreparedWorkspace>
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
  setContext(context: { cwd: string; parentSessionId?: string; parentRunId?: string; parentMessageId?: string; projectId?: string }): void {
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
      parentMessageId: run.parentMessageId,
      projectId: run.projectId,
      isolation: run.isolation,
      resultPath: run.resultPath,
      model: run.model,
      thinkingLevel: run.thinkingLevel,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      endReason: run.endReason,
      toolCalls: run.toolCalls,
      wrapUp: run.wrapUp,
      latestActivity: run.latestActivity,
      progressWarning: run.progressWarning,
      transcript: run.transcript,
      diff: run.diff,
      review: run.review,
      error: run.error,
      usage: run.usage,
      brief: run.brief,
      /*
       * 汇总每次都重算：它与转录必须同时前进（转录是有界的，开销可忽）。
       * `at` 用结束时刻而不是当前时间，免得每次推送的 result 都变。
       */
      result: summarizeSubagentRun(
        {
          transcript: run.transcript,
          diffPaths: run.diff?.paths,
          resultPath: run.resultPath,
          error: run.error,
          status: run.status
        },
        run.endedAt ?? run.startedAt
      )
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
    isolation: 'worktree' | 'controlled-cwd' | 'shared-cwd' = 'shared-cwd',
    briefInput?: unknown
  ): Promise<{ ok: boolean; error?: string; run?: SubagentRun }> {
    const text = task.trim()
    if (!text) return { ok: false, error: '任务描述为空' }
    const modelError = subagentModelError(model ?? process.env.YAN_TEST_MODEL, isolation === 'controlled-cwd')
    if (modelError) return { ok: false, error: modelError }
    if (this.runningCount >= MAX_CONCURRENT) {
      return { ok: false, error: `同时最多 ${MAX_CONCURRENT} 个子代理，先等一个结束或停掉它` }
    }
    /*
     * 输入先成形再占槽：一份读不通的 brief 不应该占掉一个并发位，
     * 也不应该让子代理带着半截说明跑起来。
     */
    const parsed = parseSubagentBrief(briefInput, text)
    if (!parsed.ok) return { ok: false, error: parsed.error }

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
      return await this.launch(ctx, text, model, isolation, parsed.brief)
    } finally {
      this.preparing -= 1
    }
  }

  private async launch(
    ctx: SubagentOptions,
    text: string,
    model: string | undefined,
    isolation: 'worktree' | 'controlled-cwd' | 'shared-cwd',
    brief: SubagentBrief
  ): Promise<{ ok: boolean; error?: string; run?: SubagentRun }> {
    const id = `sub-${randomBytes(4).toString('hex')}`
    let workspace: PreparedWorkspace
    try {
      const prepare = ctx.prepare ?? prepareWorkspace
      workspace = await prepare(ctx.cwd, id, isolation)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }

    let rpc: SubagentRpc
    try {
      rpc = await this.createRpc(ctx, workspace.cwd, model, isolation, id)
    } catch (error) {
      await cleanupWorkspace(workspace)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }

    const run: Run = {
      id,
      task: text,
      cwd: workspace.cwd,
      parentSessionId: ctx.parentSessionId,
      parentRunId: ctx.parentRunId,
      parentMessageId: ctx.parentMessageId,
      projectId: ctx.projectId,
      isolation: workspace.isolation,
      model,
      status: 'starting',
      startedAt: Date.now(),
      latestActivity: '启动中…',
      transcript: [],
      review: 'none',
      usageSnapshots: {},
      brief,
      rpc,
      workspace,
      settled: false,
      msgSeq: 0,
      toolCalls: 0,
      lastProgressAt: Date.now(),
      /* 上限在**创建时就固定**（而不是等回调里再读 env）：测试提前清掉覆盖值时，提示会写成另一个数。 */
      ...limitsFor(brief),
      /* 占位，下面立刻排定 */
      timer: setTimeout(() => undefined, 0)
    }
    clearTimeout(run.timer)
    this.armWatch(run)

    rpc.on('event', (evt: Record<string, unknown>) => this.handleEvent(run, evt))
    rpc.on('exit', () => {
      /* 进程自己退了但没标结束 —— 也算结束，不留在“运行中” */
      if (run.status === 'running' || run.status === 'starting') {
        clearTimeout(run.timer)
        run.status = 'error'
        run.endReason = 'exited'
        run.wrapUp = undefined
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
      /* 等待期间用户可能已经停掉它：不能再把 cancelled 覆盖回 running，更不能继续派活。 */
      if (run.status !== 'starting') return { ok: false, error: '子代理在启动期间已停止' }
      if (!ready.ok) {
        await this.fail(id, '子代理启动超时', 'startup')
        return { ok: false, error: '子代理启动超时' }
      }
      /* 未显式指定模型时记下 pi 实际选用的那个，界面才能如实显示。 */
      if (ready.model) run.model = ready.model
      if (ready.thinkingLevel) run.thinkingLevel = ready.thinkingLevel
      run.status = 'running'
      run.latestActivity = '已启动'
      this.emit(run)

      const res = await rpc.command('prompt', { message: briefPrompt(brief, text) })
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
  private async createRpc(
    ctx: SubagentOptions,
    cwd: string,
    model: string | undefined,
    isolation: 'worktree' | 'controlled-cwd' | 'shared-cwd',
    id: string
  ): Promise<SubagentRpc> {
    let version: string | undefined
    try { const probe = resolvePi({ override: ctx.piBin }); if (probe.home) version = JSON.parse(readFileSync(join(probe.home, 'package.json'), 'utf8')).version } catch { /* 未知版本保留兼容边界。 */ }
    const args = subagentPiArgs({ sessionDir: join(ctx.archiveDir ?? join(YAN_DIR, 'subagents'), 'sessions', id), native: nativePiToolsSupported(version), readOnly: isolation === 'controlled-cwd', model: model ?? process.env.YAN_TEST_MODEL, systemPrompt: ctx.appendSystemPrompt, extensions: ctx.extensions })
    if (ctx.createRpc) return ctx.createRpc({ cwd, piBin: ctx.piBin, args })
    /*
     * 子代理必须和主 agent 用同一个 pi 私有目录。主 agent 显式传了
     * `PI_CODING_AGENT_DIR`（见 agent.ts），子代理漏了这一步，pi 就会回退到
     * `~/.pi/agent`：便携版 / `YAN_PI_DIR` 隔离时凭证、models.json、会话目录
     * 全都错位（测试会读真实凭证而不是隔离副本）。这里补齐同一份目录。
     */
    // 子运行只有独立的危险审批端点，不继承父会话的完整能力令牌。
    const approval = new CapabilityServer({
      opsDir: join(ctx.archiveDir ?? join(YAN_DIR, 'subagents'), 'approvals', id),
      onlyCommands: ['danger.confirm'],
      handlers: { run: async (_command, params) => ({ summary: {
        kind: 'danger-confirm', allowed: await ctx.confirmDanger?.(params, cwd, { sessionId: ctx.parentSessionId, runId: ctx.parentRunId, subagentId: id }) ?? false
      } }) }
    })
    try {
      const endpoint = await approval.start({ sessionId: id, projectId: ctx.projectId ?? id })
      const rpc = new PiRpc({
        cwd, piBin: ctx.piBin, args,
        env: { PI_CODING_AGENT_DIR: PI_AGENT_DIR, YAN_DATA_DIR: YAN_DIR,
          YAN_CLI_URL: endpoint.url, YAN_CLI_TOKEN: endpoint.token,
          YAN_SESSION_ID: id, YAN_PROJECT_ID: ctx.projectId ?? id }
      })
      rpc.on('exit', () => approval.stop())
      const close = rpc.close.bind(rpc)
      rpc.close = async () => { approval.stop(); await close() }
      return rpc
    } catch (error) {
      approval.stop()
      throw error
    }
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
    run.endReason = 'stopped'
    run.wrapUp = undefined
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

  private async fail(id: string, message: string, reason: SubagentEndReason = 'failed'): Promise<void> {
    const run = this.runs.get(id)
    if (!run) return
    clearTimeout(run.timer)
    await run.rpc.close()
    run.status = run.status === 'cancelled' ? 'cancelled' : 'error'
    run.endReason = run.status === 'cancelled' ? 'stopped' : reason
    run.wrapUp = undefined
    run.progressWarning = undefined
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
    if (!run.notified) {
      run.notified = true
      try {
        this.opts.onFinished?.(this.snapshot(run))
      } catch {
        /* 通知失败不能拖垮收口 */
      }
    }
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
            parentMessageId: run.parentMessageId,
            projectId: run.projectId,
            rootCwd: run.workspace.rootCwd,
            isolation: run.isolation,
            status: run.status,
            endReason: run.endReason,
            error: run.error,
            brief: run.brief,
            limits: { totalMs: run.totalMs, idleWarningMs: run.idleMs, graceMs: run.graceMs },
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

  /** 无进展只提醒一次；总时长独立计时，不被事件续期。 */
  private armWatch(run: Run): void {
    clearTimeout(run.timer)
    if (run.status !== 'running' && run.status !== 'starting') return
    const at = run.progressWarning
      ? run.startedAt + run.totalMs
      : Math.min(run.startedAt + run.totalMs, run.lastProgressAt + run.idleMs)
    run.timer = setTimeout(() => this.onWatch(run), Math.max(10, at - Date.now()))
  }

  private onWatch(run: Run): void {
    if (run.status !== 'running' && run.status !== 'starting') return
    const now = Date.now()
    if (now >= run.startedAt + run.totalMs) void this.wrapUp(run, 'timeout', totalTimeoutText(run.totalMs))
    else {
      if (!run.progressWarning && now >= run.lastProgressAt + run.idleMs) {
        run.progressWarning = idleWarningText(run.idleMs)
        this.emit(run)
      }
      this.armWatch(run)
    }
  }

  /**
   * 到点（时间或调用预算）：先让它收尾交结论，宽限内仍没结束才硬停。
   *
   * 硬停时已经产出的助手文本仍会进摘要（见 `summarizeSubagentRun`），不会因为超时丢掉。
   * 启动阶段没有可收尾的东西，直接判失败。
   */
  private async wrapUp(run: Run, reason: 'timeout' | 'budget', text: string): Promise<void> {
    if (run.wrapUp || run.settled) return
    if (run.status !== 'running') {
      await this.fail(run.id, text, reason)
      return
    }
    run.wrapUp = { reason, since: Date.now() }
    run.progressWarning = undefined
    run.latestActivity = reason === 'budget' ? '调用次数用完，正在收尾…' : '时间到，正在收尾…'
    this.emit(run)
    clearTimeout(run.timer)
    run.timer = setTimeout(() => void this.fail(run.id, text, reason), run.graceMs)
    try {
      const res = await run.rpc.command('steer', { message: wrapUpMessage(reason) }, { timeoutMs: 5000 })
      if (!res.success) await this.fail(run.id, text, reason)
    } catch {
      await this.fail(run.id, text, reason)
    }
  }

  private async waitReady(
    rpc: SubagentRpc,
    timeoutMs: number
  ): Promise<{ ok: boolean; model?: string; thinkingLevel?: string }> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (!rpc.running) return { ok: false }
      try {
        const res = await rpc.command('get_state', undefined, { timeoutMs: 2000 })
        if (res.success) {
          const data = res.data as { model?: unknown; thinkingLevel?: unknown } | undefined
          return {
            ok: true,
            model: modelLabel(data?.model),
            thinkingLevel: typeof data?.thinkingLevel === 'string' && data.thinkingLevel ? data.thinkingLevel : undefined
          }
        }
      } catch {
        /* 还没起来，继续等 */
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    return { ok: false }
  }

  private handleEvent(run: Run, evt: Record<string, unknown>): void {
    const type = String(evt.type ?? '')
    run.lastProgressAt = Date.now()
    if (run.progressWarning && !run.wrapUp && (run.status === 'running' || run.status === 'starting')) {
      run.progressWarning = undefined
      this.armWatch(run)
      this.emit(run)
    }
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
      if (raw.role === 'assistant' && raw.stopReason) {
        run.stopReason = raw.stopReason
        if (raw.stopReason === 'error') run.error = modelErrorNotice(raw.errorMessage)
      }

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
      /* H-10b：按消息 id 收 usage 快照；同一 id 只留最后一份（流式→final 不重复） */
      const usage = toUsage(raw.usage)
      if (usage) {
        run.usageSnapshots = ingestUsageSnapshot(run.usageSnapshots, msg.id, usage)
        run.usage = accumulateUsage(run.usageSnapshots)
      }
      if (type === 'message_end') run.streamingId = undefined
      if (run.transcript.length > MAX_TRANSCRIPT) {
        run.transcript.splice(0, run.transcript.length - MAX_TRANSCRIPT)
      }
      run.latestActivity = activityOf(msg)
      this.emit(run)
      return
    }

    if (type === 'tool_execution_start') {
      run.toolCalls = (run.toolCalls ?? 0) + 1
      const budget = run.brief?.maxToolCalls
      if (budget && run.toolCalls >= budget && !run.wrapUp && run.status === 'running') {
        void this.wrapUp(run, 'budget', `工具调用次数用完（${budget} 次）`)
        return
      }
      if (!run.wrapUp) run.latestActivity = `运行 ${String(evt.toolName ?? '工具')}`
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
      const wrapped = run.status !== 'cancelled' && !modelFailed ? run.wrapUp : undefined
      run.status = run.status === 'cancelled' ? 'cancelled' : modelFailed ? 'error' : 'done'
      run.endReason = run.status === 'cancelled' ? 'stopped' : modelFailed ? 'model-error' : (wrapped?.reason ?? 'completed')
      run.wrapUp = undefined
      run.progressWarning = undefined
      run.endedAt = Date.now()
      if (modelFailed) run.error = run.error ?? modelErrorNotice(undefined)
      run.latestActivity = modelFailed
        ? '模型返回错误'
        : wrapped
          ? wrapped.reason === 'budget'
            ? '调用次数用完，已收尾'
            : '超时，已收尾'
          : '已完成'
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

/** pi `get_state` 里的 model 对象 → `provider/id`（与 `--model` 的写法一致） */
function modelLabel(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { provider, id } = raw as { provider?: unknown; id?: unknown }
  if (typeof id !== 'string' || !id) return undefined
  return typeof provider === 'string' && provider ? `${provider}/${id}` : id
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
