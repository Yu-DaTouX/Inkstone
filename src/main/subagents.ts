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
import type { SubagentRun, UIMessage } from '../shared/ipc'
import { normalizeMessage, type PiMessage } from './normalize'
import { PiRpc } from './protocol'

/** 同时最多跑几个（方案 8.4 建议首期 2 个） */
const MAX_CONCURRENT = 2
/** 单次运行上限：到点标记失败并杀进程，避免僵尸任务占着额度 */
const RUN_TIMEOUT_MS = 10 * 60 * 1000
/** 转录最多保留多少条 */
const MAX_TRANSCRIPT = 200

interface Run extends SubagentRun {
  rpc: PiRpc
  timer: NodeJS.Timeout
  /** 收到过 agent_settled / agent_end 就认为这一轮结束 */
  settled: boolean
}

export interface SubagentOptions {
  cwd: string
  piBin?: string
  /** 传给子进程的扩展（默认不传：子代理不需要浏览器/提问扩展） */
  extensions?: string[]
  /** 追加系统提示（例如「你是子代理，目标明确、少寒暄」） */
  appendSystemPrompt?: string
  /** 运行状态变化时回调（主进程转成 push） */
  onChange: (run: SubagentRun) => void
  onRemove?: (id: string) => void
}

export class SubagentController {
  private runs = new Map<string, Run>()
  private opts: SubagentOptions

  constructor(opts: SubagentOptions) {
    this.opts = opts
  }

  /** 对外只暴露纯数据（不能把 PiRpc 实例推给渲染端） */
  private snapshot(run: Run): SubagentRun {
    return {
      id: run.id,
      task: run.task,
      cwd: run.cwd,
      model: run.model,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      latestActivity: run.latestActivity,
      transcript: run.transcript,
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
    return [...this.runs.values()].filter((r) => r.status === 'running' || r.status === 'starting').length
  }

  /** 跑清掉**已结束**的记录（运行中的不动） */
  clearFinished(): void {
    for (const [id, run] of [...this.runs]) {
      if (run.status === 'running' || run.status === 'starting') continue
      this.runs.delete(id)
      this.opts.onRemove?.(id)
    }
  }

  async start(task: string, model?: string): Promise<{ ok: boolean; error?: string; run?: SubagentRun }> {
    const text = task.trim()
    if (!text) return { ok: false, error: '任务描述为空' }
    if (this.runningCount >= MAX_CONCURRENT) {
      return { ok: false, error: `同时最多 ${MAX_CONCURRENT} 个子代理，先等一个结束或停掉它` }
    }

    const id = `sub-${randomBytes(4).toString('hex')}`
    const rpc = new PiRpc({
      cwd: this.opts.cwd,
      piBin: this.opts.piBin,
      args: [
        ...this.opts.extensions?.flatMap((p) => ['--extension', p]) ?? [],
        ...(this.opts.appendSystemPrompt ? ['--append-system-prompt', this.opts.appendSystemPrompt] : []),
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
    })

    const run: Run = {
      id,
      task: text,
      cwd: this.opts.cwd,
      model,
      status: 'starting',
      startedAt: Date.now(),
      latestActivity: '启动中…',
      transcript: [],
      rpc,
      settled: false,
      /* 占位，下面立刻覆盖 */
      timer: setTimeout(() => undefined, 0)
    }
    clearTimeout(run.timer)
    run.timer = setTimeout(() => void this.fail(id, '运行超时（超过 10 分钟）'), RUN_TIMEOUT_MS)

    rpc.on('event', (evt: Record<string, unknown>) => this.handleEvent(run, evt))
    rpc.on('exit', () => {
      /* 进程自己退了但没标结束 —— 也算结束，不留在“运行中” */
      if (run.status === 'running' || run.status === 'starting') {
        run.status = 'error'
        run.error = run.error ?? 'pi 子进程提前退出'
        run.endedAt = Date.now()
        this.emit(run)
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

  /** 停止一个运行（方案 8.3：停止是明确动作，不是关掉预览） */
  async stop(id: string): Promise<{ ok: boolean; error?: string }> {
    const run = this.runs.get(id)
    if (!run) return { ok: false, error: '找不到这个子代理' }
    if (run.status !== 'running' && run.status !== 'starting') return { ok: true }
    try {
      await run.rpc.command('abort')
    } catch {
      /* abort 失败也要把进程收掉 */
    }
    clearTimeout(run.timer)
    void run.rpc.close()
    run.status = 'cancelled'
    run.endedAt = Date.now()
    run.latestActivity = '已停止'
    this.emit(run)
    return { ok: true }
  }

  stopAll(): void {
    for (const id of this.runs.keys()) void this.stop(id)
  }

  private async fail(id: string, message: string): Promise<void> {
    const run = this.runs.get(id)
    if (!run) return
    clearTimeout(run.timer)
    void run.rpc.close()
    run.status = run.status === 'cancelled' ? 'cancelled' : 'error'
    run.error = message
    run.endedAt = Date.now()
    run.latestActivity = message
    this.emit(run)
  }

  private async waitReady(rpc: PiRpc, timeoutMs: number): Promise<boolean> {
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
    if (type === 'message_start' || type === 'message_update' || type === 'message_end') {
      const raw = evt.message as PiMessage | undefined
      if (!raw) return
      const msg = normalizeMessage(raw, run.transcript.length)
      if (!msg) return
      const idx = run.transcript.findIndex((m: UIMessage) => m.id === msg.id)
      if (idx >= 0) run.transcript[idx] = msg
      else run.transcript.push(msg)
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
      run.status = run.status === 'cancelled' ? 'cancelled' : 'done'
      run.endedAt = Date.now()
      run.latestActivity = '已完成'
      this.emit(run)
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
