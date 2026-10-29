import { fork, execFile, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { cp, mkdir, readFile, rename, rm, writeFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BundledPluginResult } from '../shared/bundled-plugins'

interface PluginManifest {
  id: string
  version: string
  process?: string
  extension?: string
  setup?: string
  beforeRemove?: string
  capabilities?: string[]
  commands?: Record<string, string>
  environment?: string[]
  publicActions?: string[]
  skills?: string[]
}
interface Options {
  sources: string[]
  dataDir: string
  runtime: string
  complete(model: string, system: string, prompt: string, signal: AbortSignal): Promise<string>
  showWindow(): void
  confirm?(plugin: string, title: string, detail: string, signal: AbortSignal): Promise<boolean>
}
interface Connection {
  child: ChildProcess
  capabilities: Set<string>
  ready: Promise<void>
  pending: Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>
  completions: Map<number, AbortController>
}
const MARKER = '.installed-by-inkstone'
const SAFE_ENV = ['PATH', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'LANG', 'LC_ALL']
const SAFE_FILE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

export function pluginEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(SAFE_ENV.flatMap(key => source[key] ? [[key, source[key]]] : []))
}

export function pluginConfiguredEnvironment(names: string[] | undefined, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries((names ?? []).filter(name =>
    /^[A-Z][A-Z0-9_]{0,99}$/.test(name) && !/TOKEN|SECRET|KEY|PASSWORD|COOKIE|AUTH|NODE_OPTIONS|NODE_PATH|ELECTRON/i.test(name) && source[name]
  ).map(name => [name, source[name]]))
}

export function pluginRunEvent(payload: unknown): unknown {
  const raw = payload as { upsert?: Array<Record<string, unknown>>; remove?: unknown[] }
  return {
    upsert: (raw.upsert ?? []).map(run => {
      const phase = run.phase as { kind: string; activity?: string; tool?: { callId: string; name: string }; request?: { id: string } }
      return {
        runId: run.runId, sessionId: run.sessionId, kind: run.kind,
        phase: {
          kind: phase.kind,
          ...(phase.kind === 'running' ? { activity: phase.activity, ...(phase.tool ? { tool: { callId: phase.tool.callId, name: phase.tool.name } } : {}) } : {}),
          ...(phase.kind === 'needs-you' ? { request: { id: phase.request?.id, summary: '等待用户处理' } } : {})
        }
      }
    }),
    remove: raw.remove ?? []
  }
}

export class BundledPlugins {
  private connections = new Map<string, Connection>()
  private queues = new Map<string, Promise<unknown>>()
  private sequence = 0
  private closed = false
  constructor(private options: Options) {}

  private root(id: string): string { return join(this.options.dataDir, 'plugins', id, 'plugin') }

  private async manifest(id: string): Promise<{ manifest: PluginManifest; source: string }> {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('无效插件标识')
    for (const parent of this.options.sources) {
      const source = join(parent, id)
      let raw: string
      try { raw = await readFile(join(source, 'inkstone-plugin.json'), 'utf8') }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
      const manifest = JSON.parse(raw) as PluginManifest
      if (manifest.id !== id || [manifest.process, manifest.extension, ...(manifest.skills ?? [])].some(file => file !== undefined && !SAFE_FILE.test(file))) throw new Error('无效插件清单')
      return { manifest, source }
    }
    throw new Error('随包插件不存在')
  }

  extensionPaths(): string[] {
    const paths: string[] = []
    for (const parent of this.options.sources) {
      if (!existsSync(parent)) continue
      for (const id of readdirSync(parent, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name)) {
        try {
          const manifest = JSON.parse(readFileSync(join(parent, id, 'inkstone-plugin.json'), 'utf8')) as PluginManifest
          if (manifest.id !== id || !manifest.extension || !SAFE_FILE.test(manifest.extension)) continue
          const path = join(this.root(id), manifest.extension)
          if (existsSync(join(this.root(id), MARKER)) && existsSync(path) && !paths.includes(path)) paths.push(path)
        } catch {}
      }
    }
    return paths
  }

  skillPaths(): string[] {
    return this.extensionPaths().flatMap(path => {
      const root = join(path, '..')
      try {
        const manifest = JSON.parse(readFileSync(join(root, 'inkstone-plugin.json'), 'utf8')) as PluginManifest
        return (manifest.skills ?? []).filter(name => SAFE_FILE.test(name)).map(name => join(root, 'skills', name, 'SKILL.md')).filter(existsSync)
      } catch { return [] }
    })
  }

  async startInstalled(): Promise<void> {
    for (const parent of this.options.sources) {
      const entries = await import('node:fs/promises').then(fs => fs.readdir(parent, { withFileTypes: true })).catch(() => [])
      for (const entry of entries) {
        if (!entry.isDirectory() || !existsSync(join(this.root(entry.name), MARKER))) continue
        try {
          const { manifest } = await this.manifest(entry.name)
          if (manifest.process) await this.connect(manifest)
        } catch (error) { console.warn('[plugins]', entry.name, error) }
      }
    }
  }

  action(id: string, action: string): Promise<BundledPluginResult> {
    const task = async (): Promise<BundledPluginResult> => {
      try {
        if (this.closed) throw new Error('插件宿主已关闭')
        const { manifest, source } = await this.manifest(id)
        const target = this.root(id)
        const installed = existsSync(join(target, MARKER))
        if (action === 'status') return { ok: true, installed, ...(installed && manifest.process ? { status: await this.invoke(id, 'status') } : {}) }
        if (action === 'remove') {
          if (installed && manifest.beforeRemove && manifest.process) await this.invoke(id, manifest.beforeRemove)
          await this.disconnect(id)
          if (installed) await rm(target, { recursive: true, force: true })
          return { ok: true, installed: false }
        }
        if (action !== 'install') throw new Error('未知插件操作')
        if (existsSync(target) && !installed) throw new Error('目标已有非砚安装的文件，未改动')
        if (installed) await this.disconnect(id)
        const staging = `${target}.${randomUUID()}.new`
        const previous = `${target}.${randomUUID()}.old`
        try {
          await cp(source, staging, { recursive: true, filter: async path => {
            if ((await lstat(path)).isSymbolicLink()) throw new Error('插件包不能包含符号链接')
            return !path.split(/[\\/]/).some(part => ['node_modules', '.git', '.tmp'].includes(part))
          } })
          await writeFile(join(staging, MARKER), manifest.id, 'utf8')
          await mkdir(join(target, '..'), { recursive: true })
          if (installed) await rename(target, previous)
          try { await rename(staging, target) }
          catch (error) { if (installed) await rename(previous, target); throw error }
          if (installed) await rm(previous, { recursive: true, force: true })
        } finally { await rm(staging, { recursive: true, force: true }).catch(() => undefined) }
        if (manifest.setup && manifest.process) {
          const value = await this.invoke(id, manifest.setup) as { ok?: boolean; error?: string; status?: unknown }
          if (value?.ok === false) return { ok: false, installed: true, error: value.error, status: value.status }
        }
        return { ok: true, installed: true, ...(manifest.process ? { status: await this.invoke(id, 'status') } : {}) }
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
    }
    const next = (this.queues.get(id) ?? Promise.resolve()).then(task, task)
    this.queues.set(id, next)
    void next.finally(() => { if (this.queues.get(id) === next) this.queues.delete(id) })
    return next
  }

  async command(command: string, params: Record<string, unknown>, context: { cwd: string }, signal?: AbortSignal): Promise<{ data?: unknown; summary: Record<string, unknown> }> {
    let id = command === 'plugin.invoke' && typeof params.plugin === 'string' ? params.plugin : ''
    let action = command === 'plugin.invoke' && typeof params.action === 'string' ? params.action : ''
    if (command !== 'plugin.invoke') {
      for (const parent of this.options.sources) {
        if (!existsSync(parent)) continue
        for (const entry of readdirSync(parent, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          try {
            const { manifest } = await this.manifest(entry.name)
            if (Object.hasOwn(manifest.commands ?? {}, command)) { id = manifest.id; action = manifest.commands![command]; break }
          } catch {}
        }
        if (id) break
      }
    }
    if (!id || !action) throw new Error('此命令需要安装对应插件')
    const { manifest } = await this.manifest(id)
    if (!manifest.publicActions?.includes(action)) throw new Error('插件没有公开此操作')
    const value = await this.invoke(id, action, { input: command === 'plugin.invoke' ? params.input : params, context }, signal)
    const summary = value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).slice(0, 32).flatMap(([key, field]) =>
        typeof field === 'boolean' || typeof field === 'number' || (typeof field === 'string' && field.length <= 300) ? [[key, field]] : Array.isArray(field) ? [[key, field.length]] : []
      ))
      : {}
    return { data: value, summary: { ...summary, plugin: id, action } }
  }

  async invoke(id: string, action: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new Error('已取消')
    if (this.closed) throw new Error('插件宿主已关闭')
    if (!/^[a-zA-Z][a-zA-Z0-9.-]{0,63}$/.test(action) || JSON.stringify(params ?? null).length > 64_000) throw new Error('插件请求无效')
    const { manifest } = await this.manifest(id)
    if (!existsSync(join(this.root(id), MARKER))) throw new Error('插件尚未安装')
    const connection = await this.connect(manifest)
    const requestId = ++this.sequence
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
        connection.pending.delete(requestId)
      }
      const cancel = (): void => {
        cleanup()
        if (connection.child.connected) connection.child.send({ type: 'cancel-request', id: requestId }, () => undefined)
        reject(new Error('已取消'))
      }
      const timer = setTimeout(() => {
        cleanup()
        if (connection.child.connected) connection.child.send({ type: 'cancel-request', id: requestId }, () => undefined)
        reject(new Error('插件操作超时'))
      }, 16 * 60_000)
      connection.pending.set(requestId, {
        resolve: value => { cleanup(); resolve(value) },
        reject: error => { cleanup(); reject(error) }, timer
      })
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) { cancel(); return }
      connection.child.send({ type: 'request', id: requestId, action, params }, error => {
        if (!error) return
        cleanup(); reject(error)
      })
    })
  }

  private async connect(manifest: PluginManifest): Promise<Connection> {
    const existing = this.connections.get(manifest.id)
    if (existing) { await existing.ready; return existing }
    if (!manifest.process) throw new Error('此插件不提供进程接口')
    const child = fork(join(this.root(manifest.id), manifest.process), [], {
      execPath: this.options.runtime, execArgv: [], cwd: this.options.dataDir,
      env: { ...pluginEnvironment(process.env), ...pluginConfiguredEnvironment(manifest.environment, process.env), ELECTRON_RUN_AS_NODE: '1', INKSTONE_DATA_ROOT: this.options.dataDir, INKSTONE_PLUGIN_DATA: join(this.options.dataDir, 'plugins', manifest.id) },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    let readyResolve!: () => void
    let readyReject!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
    const connection: Connection = { child, capabilities: new Set(manifest.capabilities), ready, pending: new Map(), completions: new Map() }
    const timer = setTimeout(() => { readyReject(new Error('插件启动超时')); void this.disconnect(manifest.id) }, 60_000)
    this.connections.set(manifest.id, connection)
    child.stderr?.on('data', () => undefined)
    child.on('message', raw => {
      const message = raw as { type?: string; id: number; error?: string; code?: string; value?: unknown; capability?: string; params?: unknown }
      if (message.type === 'ready') { clearTimeout(timer); readyResolve() }
      if (message.type === 'response') {
        const pending = connection.pending.get(message.id)
        if (pending) { clearTimeout(pending.timer); connection.pending.delete(message.id); if (message.error) pending.reject(Object.assign(new Error(message.error), { code: message.code })); else pending.resolve(message.value) }
      }
      if (message.type === 'cancel') connection.completions.get(message.id)?.abort()
      if (message.type === 'capability') void this.capability(manifest, connection, message)
    })
    const finish = (): void => {
      clearTimeout(timer); readyReject(new Error('插件进程已退出'))
      for (const item of connection.pending.values()) { clearTimeout(item.timer); item.reject(new Error('插件进程已退出')) }
      connection.pending.clear()
      for (const controller of connection.completions.values()) controller.abort()
      if (this.connections.get(manifest.id) === connection) this.connections.delete(manifest.id)
    }
    child.once('exit', finish)
    child.once('error', finish)
    await ready
    return connection
  }

  private async capability(manifest: PluginManifest, connection: Connection, message: { id: number; capability?: string; params?: unknown }): Promise<void> {
    const reply = (value?: unknown, error?: string): void => {
      if (connection.child.connected) connection.child.send({ type: 'capability-result', id: message.id, value, error }, () => undefined)
    }
    try {
      if (!Number.isSafeInteger(message.id) || connection.completions.has(message.id) || !manifest.capabilities?.includes(message.capability ?? '')) throw new Error('插件能力未授权')
      if (message.capability === 'window.show') { this.options.showWindow(); reply(true); return }
      if (message.capability === 'user.confirm') {
        const params = message.params as { title?: unknown; detail?: unknown }
        if (typeof params?.title !== 'string' || params.title.length > 200 || typeof params.detail !== 'string' || params.detail.length > 20000 || connection.completions.size >= 4) throw new Error('确认参数无效')
        const controller = new AbortController()
        connection.completions.set(message.id, controller)
        try { reply(await this.options.confirm?.(manifest.id, params.title, params.detail, controller.signal) ?? false) }
        finally { connection.completions.delete(message.id) }
        return
      }
      if (message.capability !== 'text.complete') throw new Error('未知插件能力')
      const params = message.params as { model?: unknown; system?: unknown; prompt?: unknown }
      if (typeof params?.model !== 'string' || !params.model.includes('/') || params.model.length > 300 || typeof params.prompt !== 'string' || !params.prompt.trim() || params.prompt.length > 20000 || typeof params.system !== 'string' || params.system.length > 20000) throw new Error('文本补全参数无效')
      if (connection.completions.size >= 2 || connection.completions.has(message.id)) throw new Error('插件补全请求过多')
      const controller = new AbortController()
      connection.completions.set(message.id, controller)
      try { reply(await this.options.complete(params.model, params.system, params.prompt, controller.signal)) }
      finally { connection.completions.delete(message.id) }
    } catch (error) { reply(undefined, error instanceof Error ? error.message : String(error)) }
  }

  publishRuns(payload: unknown): void {
    const event = pluginRunEvent(payload)
    for (const connection of this.connections.values()) {
      if (connection.capabilities.has('runs') && connection.child.connected) connection.child.send({ type: 'event', channel: 'runs', payload: event }, () => undefined)
    }
  }

  private async disconnect(id: string): Promise<void> {
    const connection = this.connections.get(id)
    if (!connection) return
    for (const controller of connection.completions.values()) controller.abort()
    const child = connection.child
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        if (child.pid && process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => { child.kill(); resolve() })
        else { child.kill(); resolve() }
      }, 6000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      if (child.connected) child.disconnect()
      else { clearTimeout(timer); child.kill(); resolve() }
    })
    this.connections.delete(id)
  }

  close(): void {
    this.closed = true
    for (const id of this.connections.keys()) void this.disconnect(id)
  }
}
