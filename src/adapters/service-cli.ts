import { readFile, readdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { resolve, join } from 'node:path'
import { AgentService, type AgentServiceOptions } from '../core/agent-service'

const path = process.argv[2]
if (!path) throw new Error('用法：node scripts/agent-service.mjs <绝对配置文件路径>；通过 stdin/stdout JSONL 控制，不公开监听')
const config = JSON.parse(await readFile(resolve(path), 'utf8')) as AgentServiceOptions
const service = new AgentService(config)
await service.start()
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
let closing = false
async function close() { if (closing) return; closing = true; lines.close(); await service.close() }
process.once('SIGINT', () => { void close() }); process.once('SIGTERM', () => { void close() })
process.stdout.write(JSON.stringify({ type: 'ready', capabilities: service.capabilities() }) + '\n')
for await (const line of lines) {
  if (!line.trim()) continue
  let request: { id: string; action: string; taskId?: string; payload?: Record<string, unknown> }
  try {
    if (line.length > 512 * 1024) throw new Error('命令超过上限')
    request = JSON.parse(line)
    const { id, action, taskId, payload = {} } = request
    let result: unknown
    if (action === 'snapshot') result = service.snapshot()
    else if (action === 'outputs') result = await service.outputs(String(taskId))
    else if (action === 'preview') result = await service.preview(String(taskId), String(payload.name))
    else if (action === 'history') {
      const task = service.snapshot().tasks.find(t => t.id === taskId)
      if (!task) throw new Error('任务不存在')
      const files = await readdir(join(service.store.root, 'private', task.id, 'sessions')).catch(() => [])
      result = { sessionFile: task.sessionFile, files }
    } else if (action === 'close') { await close(); result = { closed: true } }
    else result = await service.once(taskId ?? 'service', id, action, payload, async () => {
      if (action === 'create') return service.create(payload as unknown as Parameters<AgentService['create']>[0])
      if (action === 'run') return service.run(String(taskId), String(payload.prompt ?? ''))
      if (action === 'cancel') { await service.cancel(String(taskId)); return { cancelled: true } }
      if (action === 'plan-apply') return service.planApply(String(taskId), payload.items as Parameters<AgentService['planApply']>[1])
      if (action === 'approve') { await service.approve(String(payload.approvalId), Number(payload.generation), payload.approved === true); return { recorded: true } }
      if (action === 'apply') return service.apply(String(taskId), String(payload.approvalId), `${id}:apply`)
      if (action === 'reconcile') { await service.reconcile(String(taskId)); return { reconciled: true } }
      if (action === 'authorize-children') { await service.authorizeChildren(String(taskId), payload.allowed === true); return { recorded: true } }
      throw new Error('不支持的操作')
    })
    process.stdout.write(JSON.stringify({ id, ok: true, result }) + '\n')
    if (closing) break
  } catch (error) { process.stdout.write(JSON.stringify({ id: request!?.id ?? null, ok: false, error: error instanceof Error ? error.message : String(error) }) + '\n') }
}
await close()
