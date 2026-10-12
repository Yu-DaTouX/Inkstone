import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { YAN_DIR, PI_AGENT_DIR } from './paths'
import { resolveProviderSecret, readAuthEntry } from './credentials'
import type { ServiceModelConfig } from '../core/agent-service'

type ModelReference = Omit<ServiceModelConfig, 'apiKey'>
const file = join(YAN_DIR, 'file-task-model.json')
let tail: Promise<unknown> = Promise.resolve()
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const next = tail.then(job, job)
  tail = next.catch(() => undefined)
  return next
}
function reference(raw: unknown): ModelReference {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('文件任务模型配置无效')
  const value = raw as ServiceModelConfig
  if (typeof value.provider !== 'string' || !value.provider || typeof value.baseUrl !== 'string' || typeof value.api !== 'string' || !value.model || typeof value.model.id !== 'string') throw new Error('文件任务模型配置无效')
  // 只复制非秘密字段，兼容旧配置但从不复用它的 apiKey 副本。
  return { provider: value.provider, baseUrl: value.baseUrl, api: value.api, model: value.model }
}
async function write(value: ModelReference): Promise<void> {
  await mkdir(YAN_DIR, { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(temp, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(value, null, 2), 'utf8'); await handle.sync() } finally { await handle.close() }
    await rename(temp, file)
  } catch (error) { await unlink(temp).catch(() => undefined); throw error }
}
export function saveFileTaskModel(config: ServiceModelConfig): Promise<void> {
  return enqueue(() => write(reference(config)))
}
export function clearFileTaskModel(provider: string): Promise<void> {
  return enqueue(async () => {
    let raw: unknown
    try { raw = JSON.parse(await readFile(file, 'utf8')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      // 用户明确清除凭证时，坏的旧凭证副本也不能留下；其他 I/O 错误仍传播。
      if (error instanceof SyntaxError) { await unlink(file); return }
      throw error
    }
    if (!raw || typeof raw !== 'object' || (raw as { provider?: unknown }).provider === provider) await unlink(file)
  })
}
export function loadFileTaskModel(): Promise<ServiceModelConfig | undefined> {
  return enqueue(async () => {
    let raw: unknown
    try { raw = JSON.parse(await readFile(file, 'utf8')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const config = reference(raw)
    if (Object.hasOwn(raw as object, 'apiKey')) await write(config)
    const auth = await readAuthEntry(config.provider)
    if (auth && typeof auth === 'object' && (auth as { type?: unknown }).type === 'oauth') throw new Error('文件任务入口不支持订阅 OAuth，请选择 API Key 模型')
    // 自定义供应商的当前端点必须仍与保存时一致，不能向旧端点发送更新后的 key。
    let models: { providers?: Record<string, { baseUrl?: string; apiKey?: string }> }
    try { models = JSON.parse(await readFile(join(PI_AGENT_DIR, 'models.json'), 'utf8')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      models = {}
    }
    const provider = models.providers?.[config.provider]
    const configuredKey = typeof provider?.apiKey === 'string' && !provider.apiKey.startsWith('!') ? (process.env[provider.apiKey] ?? provider.apiKey) : undefined
    const apiKey = await resolveProviderSecret(config.provider) || configuredKey
    if (!apiKey) throw new Error('文件任务模型凭证已失效，请在设置中重新配置')
    const currentBase = provider?.baseUrl
    if (currentBase && currentBase.replace(/\/+$/, '') !== config.baseUrl.replace(/\/+$/, '')) throw new Error('文件任务模型端点已变更，请重新配置')
    return { ...config, apiKey }
  })
}
