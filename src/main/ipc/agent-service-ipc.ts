import { app, dialog, shell } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
import type { IpcRegistrar } from './registrar'
import { AgentService, type ServiceModelConfig } from '../../core/agent-service'
import type { CreateServiceTask } from '../../shared/agent-service'
import { resolvePi } from '../protocol'
import { YAN_DIR } from '../paths'
import { PI_AGENT_DIR } from '../paths'
import { resolveProviderSecret } from '../credentials'
import type { AgentController } from '../agent'

let service: AgentService | null = null
let starting: Promise<AgentService> | null = null
async function getService(): Promise<AgentService> {
  if (service) return service
  if (starting) return starting
  starting = (async () => {
    const probe = resolvePi()
    let modelConfig: ServiceModelConfig | undefined
    try { modelConfig = JSON.parse(await readFile(join(YAN_DIR, 'file-task-model.json'), 'utf8')) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const runtime = probe.source !== 'shell' && probe.args.length ? { executable: probe.cmd, cli: probe.args[probe.args.length - 1], kind: 'electron' as const } : undefined
    const guardExtension = [join(process.resourcesPath, 'yan-thin', 'service-authority.js'), join(app.getAppPath(), 'resources', 'pi-extensions', 'service-authority.js'), join(process.cwd(), 'resources', 'pi-extensions', 'service-authority.js')].find(path => existsSync(path)) ?? ''
    const next = new AgentService({ dataRoot: join(YAN_DIR, 'file-task-service'), runtime, modelConfig, guardExtension })
    await next.start(); service = next; return next
  })()
  try { return await starting } finally { starting = null }
}
export async function closeAgentService(): Promise<void> { if (starting) await starting.catch(() => undefined); await service?.close(); service = null }

export function registerAgentServiceIpc(ipc: IpcRegistrar, deps: { currentAgent(): AgentController | null }): void {
  ipc.handle('yan:service:snapshot', async () => (await getService()).snapshot())
  ipc.handle('yan:service:create', async (request: CreateServiceTask) => (await getService()).create(request))
  ipc.handle('yan:service:run', async (id: string, prompt: string) => (await getService()).run(String(id), String(prompt)))
  ipc.handle('yan:service:cancel', async (id: string) => (await getService()).cancel(String(id)))
  ipc.handle('yan:service:reconcile', async (id: string) => (await getService()).reconcile(String(id)))
  ipc.handle('yan:service:outputs', async (id: string) => (await getService()).outputs(String(id)))
  ipc.handle('yan:service:preview', async (id: string, name: string) => (await getService()).preview(String(id), String(name)))
  ipc.handle('yan:service:plan', async (id: string, items: Array<{ output: string; destination: string }>) => (await getService()).planApply(String(id), items))
  ipc.handle('yan:service:approve', async (id: string, generation: number, approved: boolean) => (await getService()).approve(String(id), Number(generation), approved === true))
  ipc.handle('yan:service:apply', async (id: string, approval: string, request: string) => (await getService()).apply(String(id), String(approval), String(request)))
  ipc.handle('yan:service:inputs', async () => (await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })).filePaths)
  ipc.handle('yan:service:destination', async (name: string) => (await dialog.showSaveDialog({ defaultPath: basename(String(name)) })).filePath ?? null)
  ipc.handle('yan:service:open', async (id: string, name: string) => { shell.showItemInFolder(await (await getService()).outputPath(String(id), String(name))) })
  ipc.handle('yan:service:configure', async () => {
    const current = await getService()
    if (current.snapshot().tasks.some(t => t.status === 'running' || t.status === 'waiting_approval')) throw new Error('任务仍在执行，不能切换模型配置')
    const model = await deps.currentAgent()?.serviceModelDetails()
    if (!model || typeof model.provider !== 'string' || typeof model.id !== 'string' || typeof model.api !== 'string' || typeof model.baseUrl !== 'string') throw new Error('请先在当前会话中选择已配置的模型')
    if (!['openai-completions', 'openai-responses', 'anthropic-messages'].includes(model.api)) throw new Error('当前模型协议尚未接入受预算约束的独立入口，请选择 OpenAI 或 Anthropic API 模型')
    try {
      const auth = JSON.parse(await readFile(join(PI_AGENT_DIR, 'auth.json'), 'utf8')) as Record<string, { type?: string }>
      if (auth[model.provider]?.type === 'oauth') throw new Error('订阅登录的刷新与专用请求头尚未接入独立入口，请选择 API Key 模型')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    let apiKey = await resolveProviderSecret(model.provider)
    if (!apiKey) {
      try {
        const raw = JSON.parse(await readFile(join(PI_AGENT_DIR, 'models.json'), 'utf8')) as { providers?: Record<string, { apiKey?: string }> }
        const key = raw.providers?.[model.provider]?.apiKey
        if (key && !key.startsWith('!')) apiKey = process.env[key] ?? key
      } catch { /* existing configuration remains untouched */ }
    }
    if (!apiKey) throw new Error('当前模型没有可复用的凭证，请先在设置中登录或配置 API Key')
    const cost = model.cost as ServiceModelConfig['model']['cost']
    const config: ServiceModelConfig = { provider: model.provider, baseUrl: model.baseUrl, api: model.api, apiKey, model: { id: model.id, name: String(model.name ?? model.id), contextWindow: Number(model.contextWindow) || 32000, maxTokens: Number(model.maxTokens) || 4096, reasoning: model.reasoning === true, input: Array.isArray(model.input) ? model.input as string[] : ['text'], ...(cost && [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0) ? { cost } : {}) } }
    await writeFile(join(YAN_DIR, 'file-task-model.json'), JSON.stringify(config, null, 2), { mode: 0o600 })
    await closeAgentService(); await getService()
    return true
  })
}

