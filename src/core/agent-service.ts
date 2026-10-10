import { randomUUID, createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { CreateServiceTask, ServiceApproval, ServiceCapability, ServiceReceipt, ServiceSnapshot, ServiceTask, TaskApplyResult } from '../shared/agent-service'
import { PiExecutor } from '../adapters/pi-executor'
import { RuntimeStore } from './runtime-store'
import { lockDataRoot } from './data-root-lock'
import { assertNarrower, taskBudget } from './task-authority'
import { applyOutputs, checkedPath, collectOutputs, copyInputs, inside, planApply, previewOutput } from './task-files'

export interface ServiceModelConfig {
  provider: string
  baseUrl: string
  api: string
  apiKey: string
  model: { id: string; name?: string; contextWindow: number; maxTokens: number; reasoning?: boolean; input?: string[]; cost?: { input: number; output: number; cacheRead: number; cacheWrite: number } }
}
export interface AgentServiceOptions {
  dataRoot: string
  runtime?: { executable: string; cli: string; kind: 'node' | 'electron' }
  guardExtension: string
  /** Explicit host configuration; never read global credentials automatically. */
  modelConfig?: ServiceModelConfig
  onChange?: (snapshot: ServiceSnapshot) => void
}
interface LiveExecution { executor: PiExecutor; token: string; startedAt: number; timer: ReturnType<typeof setTimeout>; stopping: boolean; network: Set<AbortController>; error?: string; finalizing?: Promise<void>; requestedStatus?: ServiceTask['status']; requestedError?: string }

function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
async function jsonBody(req: IncomingMessage, limit = 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []; let bytes = 0
  for await (const part of req) { const chunk = Buffer.from(part); bytes += chunk.length; if (bytes > limit) throw new Error('请求体超过上限'); chunks.push(chunk) }
  return Buffer.concat(chunks)
}
function respond(res: ServerResponse, code: number, data: unknown): void { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)) }

/** Local runtime. Native pi owns messages/context; this service owns task facts. */
export class AgentService {
  readonly store: RuntimeStore
  private release?: () => Promise<void>
  private server?: Server
  private url = ''
  private live = new Map<string, LiveExecution>()
  private mutations: Promise<unknown> = Promise.resolve()
  private operations = new Map<string, { digest: string; promise: Promise<unknown> }>()
  private uiReplies = new Map<string, (approved: boolean) => void>()
  constructor(readonly options: AgentServiceOptions) { this.store = new RuntimeStore(join(resolve(options.dataRoot), 'service')) }
  async start(): Promise<void> {
    if (this.release) throw new Error('运行服务已启动')
    if (!isAbsolute(this.options.dataRoot)) throw new Error('必须显式指定绝对数据目录')
    const config = this.options.modelConfig
    if (config) {
      const url = new URL(config.baseUrl)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !config.provider || !config.apiKey || !config.model?.id || !['openai-completions', 'openai-responses', 'anthropic-messages'].includes(config.api) || !Number.isSafeInteger(config.model.contextWindow) || config.model.contextWindow <= 0 || !Number.isSafeInteger(config.model.maxTokens) || config.model.maxTokens <= 0) throw new Error('模型配置无效或协议尚未接入')
    }
    try { await access(join(this.options.dataRoot, 'desktop.json')); throw new Error('独立运行服务不能使用桌面数据根；请选择单独数据目录') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    this.release = await lockDataRoot(this.options.dataRoot)
    try {
      await this.store.load()
      for (const task of this.store.document.tasks) if (task.status === 'waiting_approval' && !this.store.document.applyPlans[this.store.document.approvals.find(a => a.taskId === task.id && a.kind === 'apply' && a.status === 'pending')?.id ?? '']) {
        task.status = 'uncertain'; task.error = '审批等待所属执行进程已退出，请核实后重新运行'
      }
      for (const approval of this.store.document.approvals) if (approval.kind === 'tool' && approval.status === 'pending') approval.status = 'expired'
      await this.store.save()
      this.server = createServer((req, res) => { void this.handleHttp(req, res).catch(error => { if (!res.headersSent) respond(res, 400, { error: String(error) }); else res.destroy() }) })
      await new Promise<void>((resolveListen, reject) => { this.server!.once('error', reject); this.server!.listen(0, '127.0.0.1', resolveListen) })
      const address = this.server.address()
      if (!address || typeof address === 'string') throw new Error('本机服务监听失败')
      this.url = `http://127.0.0.1:${address.port}`
    } catch (error) { await this.release(); this.release = undefined; throw error }
  }
  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(() => { if (this.store.failure) throw new Error('运行记录无法持久化，已停止接受写操作；请修复存储后重启核实'); return fn() })
    this.mutations = next.catch(() => undefined)
    return next
  }
  private task(id: string): ServiceTask {
    const task = this.store.document.tasks.find(t => t.id === id)
    if (!task) throw new Error('任务不存在')
    return task
  }
  private ancestors(task: ServiceTask): ServiceTask[] {
    const result = [task]; let current = task
    while (current.parentId) { current = this.task(current.parentId); if (result.some(t => t.id === current.id)) throw new Error('任务父链循环'); result.push(current) }
    return result
  }
  private changed(): void { this.options.onChange?.(this.snapshot()) }
  capabilities(): ServiceCapability[] {
    const configured = !!this.options.modelConfig && !!this.options.runtime
    const available = configured && existsSync(this.options.runtime!.executable) && existsSync(this.options.runtime!.cli) && existsSync(this.options.guardExtension)
    return [
      { id: 'pi.execute', implemented: true, configured, available, authorized: configured, ...(!configured ? { reason: '需要显式配置 pi 运行时与模型；不自动使用个人凭证' } : !available ? { reason: 'pi 可执行文件、入口或授权扩展缺失' } : {}) },
      ...['task.files', 'task.preview', 'task.apply', 'task.cancel', 'task.budget', 'task.recovery'].map(id => ({ id, implemented: true, configured: true, available: true, authorized: true })),
      ...['shell', 'browser', 'computer', 'network.tools', 'external-cli'].map(id => ({ id, implemented: false, configured: false, available: false, authorized: false, reason: '独立入口未配置对应受约束适配器' }))
    ]
  }
  snapshot(): ServiceSnapshot { return structuredClone({ tasks: this.store.document.tasks, approvals: this.store.document.approvals, capabilities: this.capabilities() }) }
  async create(request: CreateServiceTask): Promise<ServiceTask> {
    return this.mutate(async () => {
      if (typeof request.title !== 'string' || !request.title.trim() || request.title.length > 500 || !Array.isArray(request.files) || request.files.some(file => typeof file !== 'string' || !isAbsolute(file))) throw new Error('无效任务输入')
      const parent = request.parentId ? this.task(request.parentId) : undefined
      if (parent && !parent.authority.subagents) throw new Error('父任务未授权子任务')
      if (parent && this.ancestors(parent).some(t => t.usage.elapsedMs >= t.budget.maxTimeMs || t.usage.modelCalls >= t.budget.maxModelCalls || t.usage.toolCalls >= t.budget.maxToolCalls)) throw new Error('父任务预算已耗尽，拒绝新增派活')
      if (parent && request.files.some(file => !parent.authority.readRoots.some(root => inside(root, resolve(file))))) throw new Error('子任务输入超出父任务文件授权')
      const id = randomUUID()
      const workspace = parent ? join(parent.workspace, 'outputs', '.children', id) : join(this.store.root, 'tasks', id)
      const inputs = await copyInputs(workspace, request.files)
      const authority = { readRoots: [join(workspace, 'inputs'), join(workspace, 'outputs')], writeRoots: [join(workspace, 'outputs')], network: this.options.modelConfig ? [new URL(this.options.modelConfig.baseUrl).origin] : [], programs: [], credentials: this.options.modelConfig ? [this.options.modelConfig.provider] : [], subagents: false }
      if (parent) assertNarrower(authority, parent.authority)
      const task: ServiceTask = { id, title: request.title.trim(), ...(parent ? { parentId: parent.id } : {}), status: 'ready', generation: 0, createdAt: Date.now(), updatedAt: Date.now(), workspace, inputs, outputs: [], authority, budget: taskBudget(request.budget, parent?.budget), usage: { elapsedMs: 0, modelCalls: 0, toolCalls: 0 } }
      this.store.document.tasks.push(task); await this.store.save(); this.changed(); return structuredClone(task)
    })
  }
  /** Host-authorized child dispatch; never callable from an unrestricted shell. */
  async authorizeChildren(taskId: string, allowed: boolean): Promise<void> {
    await this.mutate(async () => { const task = this.task(taskId); if (task.parentId && allowed && !this.task(task.parentId).authority.subagents) throw new Error('不能扩大父任务授权'); task.authority.subagents = allowed; await this.store.save() })
  }
  async outputs(id: string) { return this.mutate(async () => { const task = this.task(id); task.outputs = await collectOutputs(join(task.workspace, 'outputs')); await this.store.save(); return structuredClone(task.outputs) }) }
  async preview(id: string, name: string) { return previewOutput(join(this.task(id).workspace, 'outputs'), name) }
  async outputPath(id: string, name: string) { return checkedPath(join(this.task(id).workspace, 'outputs'), name) }
  async planApply(id: string, items: Array<{ output: string; destination: string }>) {
    return this.mutate(async () => {
      const task = this.task(id)
      if (this.live.has(id)) throw new Error('任务仍在执行，请先停止或等待完成')
      const plan = await planApply(join(task.workspace, 'outputs'), items)
      // Input originals must match the version captured before execution, not just the planning moment.
      for (const item of plan) {
        const input = task.inputs.find(file => resolve(file.source).toLowerCase() === resolve(item.destination).toLowerCase())
        if (input) item.expectedSha256 = input.sha256
      }
      const approval: ServiceApproval = { id: randomUUID(), taskId: id, generation: task.generation, kind: 'apply', status: 'pending', createdAt: Date.now(), detail: JSON.stringify(plan) }
      this.store.document.approvals.push(approval); this.store.document.applyPlans[approval.id] = plan
      await this.store.save(); this.changed(); return structuredClone({ approval, items: plan })
    })
  }
  async approve(id: string, generation: number, approved: boolean): Promise<void> {
    await this.mutate(async () => {
      const approval = this.store.document.approvals.find(a => a.id === id)
      if (!approval || approval.status !== 'pending' || approval.generation !== generation || this.task(approval.taskId).generation !== generation) throw new Error('审批已过期或不属于当前运行')
      approval.status = approved ? 'approved' : 'declined'; await this.store.save()
      this.uiReplies.get(id)?.(approved); this.uiReplies.delete(id); this.changed()
    })
  }
  /** Durable request keys bind payloads. Unknown results are returned for reconciliation, never replayed. */
  async once<T>(taskId: string, requestId: string, operation: string, payload: unknown, execute: () => Promise<T>): Promise<T> {
    if (!/^[a-zA-Z0-9._:-]{8,128}$/.test(requestId)) throw new Error('请求必须带 8–128 字符的幂等键')
    const key = `${taskId}:${requestId}`, expected = digest({ operation, payload })
    const pending = this.operations.get(key)
    if (pending) { if (pending.digest !== expected) throw new Error('同一幂等键不能用于不同请求'); return pending.promise as Promise<T> }
    const run = (async () => {
      let receipt!: ServiceReceipt
      const cached = await this.mutate(async () => {
        const old = this.store.document.receipts.find(r => r.taskId === taskId && r.requestId === requestId)
        if (old) {
          if (old.digest !== expected) throw new Error('同一幂等键不能用于不同请求')
          if (old.state !== 'completed') throw new Error('请求结果待核实，禁止盲目重试')
          return { found: true, result: old.result as T }
        }
        receipt = { id: randomUUID(), taskId, generation: taskId === 'service' ? 0 : this.task(taskId).generation, requestId, operation, digest: expected, state: 'started' }
        this.store.document.receipts.push(receipt); await this.store.save(); return { found: false }
      })
      if (cached.found) return cached.result as T
      try {
        const result = await execute()
        await this.mutate(async () => { receipt.state = 'completed'; receipt.result = result ?? null; await this.store.save() })
        return result
      } catch (error) { await this.mutate(async () => { receipt.state = 'uncertain'; receipt.result = { error: String(error) }; await this.store.save() }); throw error }
    })()
    this.operations.set(key, { digest: expected, promise: run })
    try { return await run } finally { this.operations.delete(key) }
  }
  async apply(id: string, approvalId: string, requestId: string): Promise<TaskApplyResult> {
    return this.once(id, requestId, 'apply', { approvalId }, () => this.mutate(async () => {
      const task = this.task(id), approval = this.store.document.approvals.find(a => a.id === approvalId)
      if (this.live.has(id) || !approval || approval.taskId !== id || approval.generation !== task.generation || approval.kind !== 'apply' || approval.status !== 'approved') throw new Error('缺少当前运行的成果应用批准')
      const plan = this.store.document.applyPlans[approvalId]
      if (!plan) throw new Error('应用计划不存在')
      task.applyResult = await applyOutputs(join(task.workspace, 'outputs'), plan)
      // One approval authorizes one application attempt, including partial completion.
      approval.status = 'expired'; await this.store.save(); this.changed(); return structuredClone(task.applyResult)
    }))
  }
  private async consume(task: ServiceTask, kind: 'modelCalls' | 'toolCalls'): Promise<void> {
    const limit = kind === 'modelCalls' ? 'maxModelCalls' : 'maxToolCalls'
    for (const ancestor of this.ancestors(task)) {
      const elapsed = ancestor.usage.elapsedMs + [...this.live].filter(([id]) => this.ancestors(this.task(id)).some(t => t.id === ancestor.id)).reduce((sum, [, live]) => sum + Date.now() - live.startedAt, 0)
      if (ancestor.usage[kind] >= ancestor.budget[limit] || elapsed >= ancestor.budget.maxTimeMs) throw new Error('任务或父任务预算已耗尽')
    }
    for (const ancestor of this.ancestors(task)) ancestor.usage[kind]++
    await this.store.save()
  }
  async run(id: string, prompt: string): Promise<ServiceTask> {
    return this.mutate(async () => {
      const task = this.task(id), config = this.options.modelConfig, runtime = this.options.runtime
      if (!config || !runtime) throw new Error('缺少模型或 pi 运行时配置；请显式配置独立入口')
      if (!this.capabilities()[0].available) throw new Error('pi 运行时或授权扩展文件不存在')
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 200_000) throw new Error('任务消息为空或过长')
      if (this.live.has(id) || this.ancestors(task).some(t => t.id !== id && this.live.has(t.id))) throw new Error('任务或父任务正在执行')
      if ([...this.live.keys()].some(liveId => this.ancestors(this.task(liveId)).some(t => t.id === id))) throw new Error('子任务仍在执行')
      if (task.status === 'uncertain') throw new Error('上次结果待核实；请先显式确认执行已结束')
      for (const ancestor of this.ancestors(task)) if (ancestor.usage.elapsedMs >= ancestor.budget.maxTimeMs || ancestor.usage.modelCalls >= ancestor.budget.maxModelCalls || ancestor.usage.toolCalls >= ancestor.budget.maxToolCalls) throw new Error('任务预算已耗尽')
      task.generation++; task.status = 'running'; task.error = undefined; task.updatedAt = Date.now()
      if (!task.parentId && task.generation === 1) { task.authority.network = [new URL(config.baseUrl).origin]; task.authority.credentials = [config.provider] }
      for (const approval of this.store.document.approvals) if (approval.taskId === id && approval.status === 'pending') approval.status = 'expired'
      const token = randomUUID(), privateDir = join(this.store.root, 'private', id)
      await mkdir(privateDir, { recursive: true })
      await writeFile(join(privateDir, 'models.json'), JSON.stringify({ providers: { [config.provider]: { baseUrl: `${this.url}/model/${token}`, api: config.api, apiKey: config.apiKey, models: [{ ...config.model, name: config.model.name ?? config.model.id, input: config.model.input ?? ['text'], cost: config.model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }))
      await writeFile(join(privateDir, 'settings.json'), JSON.stringify({ defaultTools: ['read', 'write', 'edit'], packages: [], compaction: { enabled: true } }))
      const executor = new PiExecutor(task, { runtime, piDir: privateDir, sessionDir: join(privateDir, 'sessions'), guardExtension: this.options.guardExtension, provider: config.provider, model: config.model.id, authorityUrl: `${this.url}/authority`, authorityToken: token })
      const remaining = Math.min(...this.ancestors(task).map(t => t.budget.maxTimeMs - t.usage.elapsedMs))
      const live: LiveExecution = { executor, token, startedAt: Date.now(), stopping: false, network: new Set(), timer: setTimeout(() => { void this.cancel(id, '任务时间预算已耗尽') }, remaining) }
      this.live.set(id, live)
      executor.rpc.on('stderr', line => { live.error = line.slice(0, 1000) })
      executor.rpc.on('ui', request => { void this.requestUi(task, live, request) })
      executor.rpc.on('event', event => {
        if (event.type === 'message_end' && (event.message as { stopReason?: string; errorMessage?: string } | undefined)?.stopReason === 'error') live.error = (event.message as { errorMessage?: string }).errorMessage ?? '模型执行失败'
        if (event.type === 'agent_settled') void this.finish(id, live, live.error ? 'failed' : 'completed')
      })
      executor.rpc.on('exit', () => { if (!live.stopping) void this.finish(id, live, 'uncertain', live.error ?? '执行进程意外退出，结果待核实') })
      await this.store.save(); this.changed()
      void executor.start().then(() => executor.prompt(prompt)).catch(error => this.finish(id, live, 'failed', String(error)))
      return structuredClone(task)
    })
  }
  private async requestUi(task: ServiceTask, live: LiveExecution, request: Record<string, unknown>): Promise<void> {
    if (!['confirm', 'select', 'input', 'editor'].includes(String(request.method))) return
    if (request.method !== 'confirm') { live.executor.rpc.respondUi({ id: request.id, cancelled: true }); live.error = '当前审批通道不支持执行器的结构化输入请求'; return }
    await this.mutate(async () => {
      if (this.live.get(task.id) !== live) return
      const approval: ServiceApproval = { id: randomUUID(), taskId: task.id, generation: task.generation, kind: 'tool', detail: String(request.title ?? request.message ?? '执行器请求确认'), status: 'pending', createdAt: Date.now() }
      this.store.document.approvals.push(approval); task.status = 'waiting_approval'
      this.uiReplies.set(approval.id, approved => { task.status = 'running'; live.executor.rpc.respondUi({ id: request.id, confirmed: approved, cancelled: !approved }); void this.store.save() })
      await this.store.save(); this.changed()
    })
  }
  private finish(id: string, live: LiveExecution, status: ServiceTask['status'], error?: string): Promise<void> {
    if (live.finalizing) return live.finalizing
    live.stopping = true
    live.finalizing = this.finishNow(id, live, status, error)
    return live.finalizing
  }
  private async finishNow(id: string, live: LiveExecution, status: ServiceTask['status'], error?: string): Promise<void> {
    clearTimeout(live.timer); for (const controller of live.network) controller.abort()
    let sessionFile: string | undefined
    try { const response = await live.executor.rpc.command<{ sessionFile?: string }>('get_state', {}, { timeoutMs: 2000 }); sessionFile = response.data?.sessionFile } catch { /* the durable session directory remains readable */ }
    await live.executor.rpc.close()
    await this.mutate(async () => {
      if (this.live.get(id) !== live) return
      const task = this.task(id)
      for (const ancestor of this.ancestors(task)) ancestor.usage.elapsedMs += Date.now() - live.startedAt
      this.live.delete(id); task.status = live.requestedStatus ?? status; task.error = live.requestedError ?? error ?? live.error; task.updatedAt = Date.now()
      if (sessionFile) task.sessionFile = sessionFile
      task.outputs = await collectOutputs(join(task.workspace, 'outputs')).catch(() => [])
      for (const approval of this.store.document.approvals) if (approval.taskId === id && approval.kind === 'tool' && approval.status === 'pending') { approval.status = 'expired'; this.uiReplies.delete(approval.id) }
      for (const receipt of this.store.document.receipts) if (receipt.taskId === id && receipt.state === 'started' && ['read', 'write', 'edit'].includes(receipt.operation)) {
        receipt.state = 'uncertain'
        if (receipt.operation !== 'read') { task.status = 'uncertain'; task.error = '文件工具执行缺少完成回执，结果待核实' }
      }
      await this.store.save(); this.changed()
    })
  }
  async cancel(id: string, reason?: string): Promise<void> {
    const live = this.live.get(id)
    if (live) { live.requestedStatus = reason ? 'failed' : 'cancelled'; live.requestedError = reason; await live.executor.rpc.command('abort', {}, { timeoutMs: 1000 }).catch(() => undefined); await this.finish(id, live, live.requestedStatus, reason) }
    else await this.mutate(async () => { const task = this.task(id); if (task.status !== 'uncertain') task.status = 'cancelled'; await this.store.save(); this.changed() })
  }
  async reconcile(id: string): Promise<void> {
    await this.mutate(async () => { const task = this.task(id); if (this.live.has(id)) throw new Error('执行仍活跃'); if (task.status !== 'uncertain') throw new Error('任务没有待核实结果'); task.status = 'ready'; task.error = '用户已确认上次执行结束；历史回执仍保留'; await this.store.save(); this.changed() })
  }
  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') return respond(res, 405, { error: 'method_not_allowed' })
    const path = new URL(req.url ?? '/', this.url).pathname
    const token = path.startsWith('/model/') ? path.split('/')[2] : req.headers.authorization?.replace(/^Bearer /, '')
    const entry = [...this.live].find(([, value]) => value.token === token && !value.stopping)
    if (!entry) return respond(res, 403, { error: '当前运行授权无效' })
    const [id, live] = entry, task = this.task(id)
    if (path.startsWith('/model/')) {
      const config = this.options.modelConfig!
      const origin = new URL(config.baseUrl).origin
      if (!task.authority.network.includes(origin) || !task.authority.credentials.includes(config.provider)) return respond(res, 403, { error: '模型网络或凭证未授权' })
      const body = await jsonBody(req, 32 * 1024 * 1024)
      try { await this.mutate(() => this.consume(task, 'modelCalls')) } catch (error) { return respond(res, 429, { error: String(error) }) }
      const suffix = path.slice(`/model/${token}`.length)
      if (!/^\/(chat\/completions|responses|messages|complete|generate|completions)$/.test(suffix)) return respond(res, 403, { error: '不支持的模型端点' })
      const controller = new AbortController(); live.network.add(controller)
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      for (const name of ['authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta']) if (typeof req.headers[name] === 'string') headers[name] = req.headers[name] as string
      try {
        const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}${suffix}`, { method: 'POST', headers, body: body.toString('utf8'), signal: controller.signal, redirect: 'error' })
        res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' })
        if (response.body) {
          const reader = response.body.getReader()
          try { while (true) { const { done, value } = await reader.read(); if (done) break; if (!res.write(value)) await new Promise<void>(resolveDrain => res.once('drain', resolveDrain)) } } finally { reader.releaseLock() }
        }
        res.end()
      } finally { live.network.delete(controller) }
      return
    }
    if (path !== '/authority') return respond(res, 404, { error: 'not_found' })
    const body = JSON.parse((await jsonBody(req)).toString('utf8')) as { action: string; taskId: string; generation: number; toolCallId: string; tool: string; input?: { path?: string }; isError?: boolean }
    if (body.taskId !== id || body.generation !== task.generation) return respond(res, 403, { allowed: false, reason: '运行身份已过期' })
    const result = await this.mutate(async () => {
      const requestId = `tool:${body.toolCallId}`
      if (body.action === 'receipt') {
        const receipt = this.store.document.receipts.find(r => r.taskId === id && r.generation === task.generation && r.requestId === requestId)
        if (!receipt) return { allowed: false, reason: '找不到执行回执' }
        receipt.state = body.isError ? 'failed' : 'completed'; await this.store.save(); return { allowed: true }
      }
      if (body.action !== 'tool' || !['read', 'write', 'edit'].includes(body.tool)) return { allowed: false, reason: '工具未授权；独立入口不提供无约束 shell 或网络工具' }
      if (typeof body.input?.path !== 'string') return { allowed: false, reason: '工具缺少文件路径' }
      const target = resolve(task.workspace, body.input.path), writing = body.tool !== 'read'
      if (relative(task.workspace, target).split(/[\\/]/).includes('.children')) return { allowed: false, reason: '不能访问其他任务的内部工作区' }
      const roots = writing ? task.authority.writeRoots : task.authority.readRoots
      const root = roots.find(value => inside(value, target))
      if (!root) return { allowed: false, reason: '文件路径超出任务授权' }
      try { await checkedPath(root, target, writing) } catch (error) { return { allowed: false, reason: String(error) } }
      const old = this.store.document.receipts.find(r => r.taskId === id && r.generation === task.generation && r.requestId === requestId)
      if (old) return { allowed: false, reason: '同一工具调用已执行或结果待核实，不重复副作用' }
      try { await this.consume(task, 'toolCalls') } catch (error) { return { allowed: false, reason: String(error) } }
      this.store.document.receipts.push({ id: randomUUID(), taskId: id, generation: task.generation, requestId, operation: body.tool, digest: digest(body.input), state: 'started' })
      await this.store.save(); return { allowed: true }
    })
    respond(res, 200, result)
  }
  async close(): Promise<void> {
    try {
      for (const id of [...this.live.keys()]) await this.cancel(id)
      await this.mutations
    } finally {
      for (const live of this.live.values()) { clearTimeout(live.timer); for (const controller of live.network) controller.abort(); await live.executor.rpc.close().catch(() => undefined) }
      this.live.clear()
      if (this.server) { this.server.closeAllConnections(); await new Promise<void>(resolveClose => this.server!.close(() => resolveClose())); this.server = undefined }
      if (this.release) { await this.release(); this.release = undefined }
    }
  }
}
