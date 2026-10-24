import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { McpSettingsMutation, McpSettingsResult, McpSettingsService, McpSettingsSnapshot } from '../../shared/mcp-settings'
import { atomicWrite, nativeMcpTextFingerprint } from './native-import'
import { mcpServersFile, parseMcpServersDocument } from './config'
import { serializedWrite } from './write-queue'
import { WINDOWS_MCP_SERVER_ID } from '../../shared/mcp-native-import'

type ObjectValue = Record<string, unknown>
type Document = { path: string; text: string | null; value: ObjectValue; servers: ObjectValue }

export interface McpSettingsHost {
  agentDir: string
  hostFile?: string
  context: string
  project: McpSettingsSnapshot['project']
  projectTrusted: boolean
  projects: readonly { id: string; cwd: string }[]
  busy: boolean
  isBusy?(): boolean
  nativeConfigChanged: boolean | null
  assertContext?(): void
}

function object(value: unknown): ObjectValue | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null
}

async function readText(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}

async function readNative(path: string): Promise<Document> {
  const text = await readText(path)
  const value = text === null ? {} : object(JSON.parse(text))
  if (!value || value.mcpServers !== undefined && !object(value.mcpServers)) throw new Error(`MCP 配置格式有误：${path}`)
  return { path, text, value, servers: object(value.mcpServers) ?? {} }
}

function override(value: unknown): boolean {
  const entry = object(value)
  return !!entry && Object.keys(entry).every((key) => ['enabled', 'exposure', 'toolExposure'].includes(key))
}

function endpoint(entry: ObjectValue): string {
  if (typeof entry.url !== 'string') return typeof entry.command === 'string' ? entry.command : ''
  try { return new URL(entry.url).origin } catch { return '' }
}

function nativeService(name: string, entry: ObjectValue, doc: Document, scope: 'global' | 'project'): McpSettingsService {
  return {
    key: `native:${scope}:${name}`, name, title: name, backend: 'native', owner: 'pi', scope,
    enabled: entry.enabled !== false, inherited: false, overridden: false,
    transport: typeof entry.url === 'string' ? 'http' : 'stdio', source: doc.path, connection: endpoint(entry)
  }
}

async function load(host: McpSettingsHost) {
  const global = await readNative(join(host.agentDir, 'mcp.json'))
  const project = host.project ? await readNative(join(host.project.cwd, '.pi', 'mcp.json')) : null
  const hostPath = host.hostFile ?? mcpServersFile()
  const hostText = await readText(hostPath)
  const loaded = parseMcpServersDocument(hostText ?? '[]', hostPath)
  if (loaded.error) throw new Error(loaded.error)
  const revision = nativeMcpTextFingerprint(JSON.stringify([global.text, project?.text ?? null, hostText]))
  return { global, project, hostPath, hostText, loaded, revision }
}

export async function listMcpServiceSettings(host: McpSettingsHost): Promise<McpSettingsSnapshot> {
  const data = await load(host)
  const global: McpSettingsService[] = []
  const projectServices: McpSettingsService[] = []
  const errors: string[] = []
  for (const [name, raw] of Object.entries(data.global.servers)) {
    const entry = object(raw)
    if (!entry) { errors.push(`服务 ${name} 的配置格式有误`); continue }
    const base = nativeService(name, entry, data.global, 'global')
    global.push(base)
    if (host.project) {
      const patch = object(data.project?.servers[name])
      if (!patch || override(patch)) {
        projectServices.push({ ...base, enabled: host.projectTrusted && patch?.enabled !== undefined ? patch.enabled !== false : base.enabled, inherited: true, overridden: typeof patch?.enabled === 'boolean' && host.projectTrusted })
      }
    }
  }
  if (data.project) for (const [name, raw] of Object.entries(data.project.servers)) {
    if (override(raw)) {
      if (!object(data.global.servers[name])) errors.push(`项目里的 ${name} 只有覆盖设置，缺少全局服务定义`)
      continue
    }
    const entry = object(raw)
    if (entry) projectServices.push(nativeService(name, entry, data.project, 'project'))
    else errors.push(`项目服务 ${name} 的配置格式有误`)
  }
  for (const config of data.loaded.servers) {
    if (config.projectScope && config.projectScope !== host.project?.id) continue
    const name = config.migratedToNative?.nativeName ?? config.id
    const nativeGlobal = global.find((item) => item.name === name)
    const nativeProject = projectServices.find((item) => item.name === name)
    if (config.migratedToNative && (nativeGlobal || nativeProject)) continue
    const service: McpSettingsService = {
      key: `host:${config.id}`, name: config.id, title: config.title ?? config.id, backend: 'host', owner: 'inkstone',
      scope: config.projectScope ? 'project' : 'global', enabled: config.enabled !== false,
      inherited: false, overridden: false, transport: config.transport, source: data.hostPath,
      connection: endpoint(config as unknown as ObjectValue), special: config.id === WINDOWS_MCP_SERVER_ID
    }
    const matching = config.projectScope ? nativeProject : nativeGlobal
    if (matching) {
      if (config.enabled !== false) { matching.conflict = true; errors.push(`服务 ${name} 存在两份连接配置，请在高级设置中处理归属`) }
      continue
    }
    if (!config.projectScope) global.push(service)
    if (host.project && (!config.projectScope || config.projectScope === host.project.id)) {
      const enabled = config.projectEnabled?.[host.project.id]
      projectServices.push({ ...service, enabled: typeof enabled === 'boolean' ? enabled : service.enabled, inherited: !config.projectScope, overridden: !config.projectScope && typeof enabled === 'boolean' })
    }
  }
  if (!global.some((service) => service.special)) {
    global.push({ key: 'host:windows-mcp', name: WINDOWS_MCP_SERVER_ID, title: 'windows-mcp', backend: 'host', owner: 'inkstone', scope: 'global', enabled: false, inherited: false, overridden: false, transport: 'stdio', source: data.hostPath, connection: '', special: true })
    if (host.project) projectServices.push({ ...global[global.length - 1], inherited: true })
  }
  if (host.project && !host.projectTrusted && Object.keys(data.project?.servers ?? {}).length) errors.push('项目尚未受信任，项目配置暂不生效')
  return { context: host.context, revision: data.revision, project: host.project, projectTrusted: host.projectTrusted, global, projectServices, errors, busy: host.busy, nativeConfigChanged: host.nativeConfigChanged }
}

function nativeText(doc: Document): string {
  return `${JSON.stringify({ ...doc.value, mcpServers: doc.servers }, null, 2)}\n`
}

async function writeDocuments(host: McpSettingsHost, docs: Document[]): Promise<void> {
  const written: { doc: Document; text: string }[] = []
  try {
    for (const doc of docs) {
      host.assertContext?.()
      const text = nativeText(doc)
      await atomicWrite(doc.path, text, nativeMcpTextFingerprint(doc.text))
      written.push({ doc, text })
    }
  } catch (error) {
    const failures: string[] = []
    for (const { doc, text } of written.reverse()) {
      try {
        if (doc.text !== null) await atomicWrite(doc.path, doc.text, nativeMcpTextFingerprint(text))
        else if (await readText(doc.path) === text) await unlink(doc.path)
        else throw new Error('文件已被其他操作修改')
      } catch { failures.push(doc.path) }
    }
    if (failures.length) throw new Error(`保存未完成，部分回退失败，请检查：${failures.join('、')}`)
    throw error
  }
}

async function ensureNoOtherOverrides(host: McpSettingsHost, name: string): Promise<void> {
  for (const project of host.projects) {
    if (project.id === host.project?.id) continue
    const doc = await readNative(join(project.cwd, '.pi', 'mcp.json'))
    if (doc.servers[name] && override(doc.servers[name])) throw new Error(`其他项目仍覆盖 ${name}，请先在对应项目恢复全局设置再修改范围或删除`)
  }
}

function validateConfig(raw: unknown): ObjectValue {
  const config = object(raw)
  if (!config || (!!config.command === !!config.url)) throw new Error('请填写启动命令或服务地址')
  if (config.url !== undefined) {
    if (typeof config.url !== 'string' || !/^https?:$/.test(new URL(config.url).protocol)) throw new Error('服务地址必须是 HTTP 或 HTTPS')
  } else if (typeof config.command !== 'string' || !config.command.trim()) throw new Error('启动命令不能为空')
  if (config.args !== undefined && (!Array.isArray(config.args) || !config.args.every((arg) => typeof arg === 'string'))) throw new Error('启动参数必须是字符串数组')
  if (config.env !== undefined && (!object(config.env) || !Object.values(object(config.env)!).every((value) => typeof value === 'string'))) throw new Error('环境变量必须是字符串键值')
  return { ...(config.url ? { url: config.url } : { command: config.command, ...(config.args ? { args: config.args } : {}) }), ...(config.env ? { env: config.env } : {}) }
}

export function changeMcpServiceSettings(host: McpSettingsHost, input: McpSettingsMutation): Promise<McpSettingsResult> {
  return serializedWrite(async () => {
    try {
      if (!object(input) || input.context !== host.context) throw new Error('当前会话或项目已切换，请重新读取服务列表')
      if (!['global', 'project'].includes(input.scope) || !['add', 'enable', 'disable', 'inherit', 'remove', 'move'].includes(input.action)) throw new Error('不支持的 MCP 设置操作')
      const data = await load(host)
      if (input.revision !== data.revision) throw new Error('服务配置已变化，请重新读取后再试')
      if (input.scope === 'project' && (!host.project || !data.project)) throw new Error('请先选择一个项目')
      if (input.scope === 'project' && !host.projectTrusted) throw new Error('请先信任当前项目，再修改项目 MCP 配置')
      if (input.action === 'add') {
        const name = typeof input.name === 'string' ? input.name.trim() : ''
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(name) || ['__proto__', 'constructor', 'prototype', WINDOWS_MCP_SERVER_ID].includes(name)) throw new Error('服务名称无效，只能包含字母、数字、下划线和连字符，电脑操作请在本机工具中配置')
        const target = input.scope === 'global' ? data.global : data.project!
        if (data.global.servers[name] || data.project?.servers[name] || data.loaded.servers.some((server) => server.id === name)) throw new Error('已有同名服务，请使用现有条目或更换名称')
        target.servers[name] = validateConfig(input.config)
        await writeDocuments(host, [target])
        return { ok: true, takesEffect: 'new-session' }
      }
      const snapshot = await listMcpServiceSettings(host)
      const service = [...snapshot.global, ...snapshot.projectServices].find((item) => item.key === input.key)
      if (!service || service.conflict || service.special) throw new Error('服务不可修改，请重新读取列表或前往本机工具配置')
      if (input.scope === 'global' && service.scope === 'project' && input.action !== 'move') throw new Error('项目服务只能从项目入口修改')
      if (service.backend === 'host') {
        if (host.isBusy?.() ?? host.busy) throw new Error('有任务正在运行，任务结束后可调整此服务')
        const document = data.loaded.document
        const list = Array.isArray(document) ? document : object(document)?.servers
        if (!Array.isArray(list)) throw new Error('旧服务配置格式有误')
        const entry = list.find((item) => object(item)?.id === service.name) as ObjectValue | undefined
        if (!entry || entry.migratedToNative) throw new Error('服务已迁移，请重新读取列表')
        if (input.action === 'move') {
          if (input.scope === 'project') entry.projectScope = host.project!.id
          else delete entry.projectScope
        } else if (input.scope === 'project' && !entry.projectScope) {
          if (input.action === 'remove') throw new Error('继承的服务请使用本项目关闭')
          const enabled = { ...(object(entry.projectEnabled) ?? {}) }
          if (input.action === 'inherit') delete enabled[host.project!.id]
          else enabled[host.project!.id] = input.action === 'enable'
          entry.projectEnabled = enabled
        } else if (input.action === 'remove') list.splice(list.indexOf(entry), 1)
        else if (input.action === 'enable' || input.action === 'disable') entry.enabled = input.action === 'enable'
        else throw new Error('此服务不支持该操作')
        host.assertContext?.()
        if (host.isBusy?.() ?? host.busy) throw new Error('有任务正在运行，任务结束后可调整此服务')
        await atomicWrite(data.hostPath, `${JSON.stringify(document, null, 2)}\n`, nativeMcpTextFingerprint(data.hostText))
        return { ok: true, takesEffect: 'next-call' }
      }
      const origin = service.scope === 'global' ? data.global : data.project!
      if (input.action === 'move') {
        if (!data.project || !host.project || !host.projectTrusted) throw new Error('请先选择并信任当前项目')
        const target = input.scope === 'global' ? data.global : data.project
        if (target.path === origin.path) throw new Error('服务已经在这个范围内')
        if (target.servers[service.name] && !override(target.servers[service.name])) throw new Error('目标范围已有同名服务，未覆盖')
        if (service.scope === 'global') await ensureNoOtherOverrides(host, service.name)
        target.servers[service.name] = { ...object(origin.servers[service.name]), ...(object(target.servers[service.name]) ?? {}) }
        delete origin.servers[service.name]
        await writeDocuments(host, [target, origin])
      } else {
        const target = input.scope === 'global' ? data.global : data.project!
        if (input.scope === 'global' && service.scope !== 'global') throw new Error('项目服务不能从全局入口修改')
        if (input.action === 'inherit') {
          if (service.scope !== 'global' || target === data.global || !override(target.servers[service.name])) throw new Error('没有可恢复的项目覆盖设置')
          const patch = { ...object(target.servers[service.name]) }
          delete patch.enabled
          if (Object.keys(patch).length) target.servers[service.name] = patch
          else delete target.servers[service.name]
        } else if (input.action === 'remove') {
          if (input.scope === 'project' && service.scope === 'global') throw new Error('继承的服务请使用本项目关闭')
          if (service.scope === 'global') {
            await ensureNoOtherOverrides(host, service.name)
            if (data.project?.servers[service.name] && override(data.project.servers[service.name])) {
              delete data.project.servers[service.name]
              delete target.servers[service.name]
              await writeDocuments(host, [target, data.project])
              return { ok: true, takesEffect: 'new-session' }
            }
          }
          delete target.servers[service.name]
        } else target.servers[service.name] = { ...(object(target.servers[service.name]) ?? {}), enabled: input.action === 'enable' }
        await writeDocuments(host, [target])
      }
      return { ok: true, takesEffect: 'new-session' }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
}
