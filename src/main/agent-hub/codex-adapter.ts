import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { stopHubChild } from './stop-child'

type Message = { id?: string | number; method?: string; params?: Record<string, any>; result?: any; error?: { message?: string } }
export interface CodexEvents {
  event(method: string, params: Record<string, any>): void
  request(id: string | number, method: string, params: Record<string, any>): void
  exit(error?: string): void
}

/** JSONL 双向协议；只认正式 turn 状态，不从静默或子进程退出猜任务成功。 */
export class CodexAdapter {
  private child: ChildProcessWithoutNullStreams | null = null
  private sequence = 0
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private buffer = ''
  private stderr = ''
  constructor(private readonly executable: string, private readonly events: CodexEvents, private readonly executableArgs: string[] = []) {}

  async start(cwd: string, config: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<void> {
    this.child = spawn(this.executable, [...this.executableArgs, 'app-server', '--stdio'], { cwd, env: this.executableArgs.length ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env, windowsHide: true, stdio: 'pipe' })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', (data: string) => {
      this.buffer += data
      if (this.buffer.length > 8 * 1024 * 1024) { this.fail('Codex 协议帧超过上限'); return }
      let end: number
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end)
        this.buffer = this.buffer.slice(end + 1)
        if (!line.trim()) continue
        try { this.receive(JSON.parse(line) as Message) } catch { this.fail('Codex 返回无效 JSONL'); return }
      }
    })
    this.child.stderr.on('data', (data: string) => { this.stderr = (this.stderr + data).slice(-4000) })
    this.child.once('error', (error) => this.fail(error.message))
    this.child.once('exit', (code) => {
      this.rejectPending('Codex app-server 已退出')
      this.child = null
      this.events.exit(code === 0 ? undefined : `Codex 退出 ${code ?? '未知'}：${this.stderr}`)
    })
    await this.call('initialize', { clientInfo: { name: 'inkstone', title: 'Inkstone', version: '0.5.1' } })
    this.send({ method: 'initialized', params: {} })
    // 每次 thread/start/resume 传会话级配置；不改用户的 CODEX_HOME 与登录。
    this.config = config
  }
  private config: Record<string, unknown> = {}

  async thread(cwd: string, model?: string, threadId?: string): Promise<string> {
    const params = { cwd, ...(model ? { model } : {}), approvalPolicy: 'on-request', sandbox: 'workspace-write', config: this.config }
    const result = await this.call(threadId ? 'thread/resume' : 'thread/start', { ...params, ...(threadId ? { threadId } : {}) })
    return String(result.thread.id)
  }
  async models(): Promise<Array<{ model: string; displayName: string; supportedReasoningEfforts: Array<{ reasoningEffort: string }> }>> {
    const result = await this.call('model/list', { includeHidden: true })
    return result.data
  }
  async turn(threadId: string, text: string, effort?: 'low' | 'medium' | 'high'): Promise<string> {
    const result = await this.call('turn/start', { threadId, input: [{ type: 'text', text }], ...(effort ? { effort } : {}) })
    return String(result.turn.id)
  }
  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.call('turn/interrupt', { threadId, turnId })
  }
  reply(id: string | number, result: unknown): void { this.send({ id, result }) }
  reject(id: string | number): void { this.send({ id, error: { message: 'Inkstone 尚未支持此交互请求，已拒绝。', code: -32601 } }) }
  close(): Promise<boolean> { return stopHubChild(this.child) }
  private send(value: unknown): void {
    if (!this.child?.stdin.writable) throw new Error('Codex 控制通道已关闭')
    this.child.stdin.write(`${JSON.stringify(value)}\n`)
  }
  private call(method: string, params: unknown): Promise<any> {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} 响应超时，结果待核实`)) }, 15_000)
      this.pending.set(id, { resolve, reject, timer })
      try { this.send({ id, method, params }) } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }
  private receive(message: Message): void {
    if (message.method && message.id !== undefined) {
      this.events.request(message.id, message.method, message.params ?? {})
    } else if (message.method) {
      this.events.event(message.method, message.params ?? {})
    } else if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message ?? 'Codex 请求失败'))
      else pending.resolve(message.result)
    }
  }
  private rejectPending(message: string): void {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error(message)) }
    this.pending.clear()
  }
  private fail(message: string): void {
    this.rejectPending(message)
    this.events.exit(message)
    void this.close()
  }
}
