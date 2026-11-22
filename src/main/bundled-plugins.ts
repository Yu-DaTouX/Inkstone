import { pick } from '../shared/ui-lang'
import { fork, execFile, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rename, rm, writeFile, lstat } from 'node:fs/promises'
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
  proxyEnvironment?(): Promise<NodeJS.ProcessEnv>
  platform?: NodeJS.Platform
  listProcesses?(): Promise<ProcessRow[]>
  killTree?(pid: number): Promise<void>
  remove?(path: string, options: typeof REMOVE_RETRY): Promise<void>
}
export interface ProcessRow { pid: number; ppid: number; created: string }
interface Connection {
  child: ChildProcess
  capabilities: Set<string>
  ready: Promise<void>
  pending: Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>
  completions: Map<number, AbortController>
  stderr: string
}
const STDERR_TAIL_CHARS = 4000
const MARKER = '.installed-by-inkstone'
const SAFE_ENV = ['PATH', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'LANG', 'LC_ALL']
const SAFE_FILE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

function parseManifest(id: string, raw: string): PluginManifest {
  const manifest = JSON.parse(raw) as PluginManifest
  if (!manifest || manifest.id !== id || (manifest.skills !== undefined && !Array.isArray(manifest.skills)) ||
    [manifest.process, manifest.extension, ...(manifest.skills ?? [])].some(file => file !== undefined && (typeof file !== 'string' || !SAFE_FILE.test(file)))) {
    throw new Error(pick('无效插件清单', 'Invalid plugin manifest'))
  }
  return manifest
}

function withStderrTail(message: string, tail: string): string {
  const text = tail.trim()
  return text ? `${message}\n${pick('插件输出（stderr）：', 'Plugin output (stderr):')}\n${text}` : message
}

const REMOVE_RETRY = { recursive: true, force: true, maxRetries: 8, retryDelay: 250 } as const
const LEFTOVER = /^plugin\.[0-9a-f-]{36}\.(old|new)$/
const UNINSTALLED = '.uninstalled'
const PROCESS_SCAN_TIMEOUT_MS = 8000

function listWindowsProcesses(): Promise<ProcessRow[]> {
  const script = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }) }"
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: PROCESS_SCAN_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) { resolve([]); return }
      resolve(String(stdout).split(/\r?\n/).flatMap(line => {
        const match = /^(\d+) (\d+) (\d+)$/.exec(line.trim())
        return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), created: match[3] }] : []
      }))
    })
  })
}

function createdAt(row: ProcessRow | undefined): bigint | undefined {
  if (!row || !/^\d+$/.test(row.created) || row.created === '0') return undefined
  return BigInt(row.created)
}

function descendantsOf(rows: ProcessRow[], root: number): ProcessRow[] {
  const found: ProcessRow[] = []
  const seen = new Set<number>([root])
  const born = new Map<number, bigint | undefined>([[root, createdAt(rows.find(row => row.pid === root))]])
  let frontier = [root]
  while (frontier.length) {
    const next: number[] = []
    for (const row of rows) {
      if (seen.has(row.pid) || !frontier.includes(row.ppid)) continue
      const parentBorn = born.get(row.ppid)
      const childBorn = createdAt(row)
      if (parentBorn === undefined || childBorn === undefined || childBorn < parentBorn) continue
      born.set(row.pid, childBorn)
      seen.add(row.pid)
      found.push(row)
      next.push(row.pid)
    }
    frontier = next
  }
  return found
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

function taskkillTree(pid: number): Promise<void> {
  return new Promise(resolve => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()))
}

function killProcessTree(child: ChildProcess, done: () => void): void {
  if (child.exitCode !== null || child.signalCode !== null) { done(); return }
  if (child.pid && process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => { child.kill(); done() })
  else { child.kill(); done() }
}

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
  private connecting = new Map<string, Promise<Connection>>()
  private queues = new Map<string, Promise<unknown>>()
  private sequence = 0
  private closed = false
  private closing?: Promise<void>
  constructor(private options: Options) {}

  private root(id: string): string { return join(this.options.dataDir, 'plugins', id, 'plugin') }

  installed(id: string): boolean { return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) && existsSync(join(this.root(id), MARKER)) }

  inbox(id: string): string { return join(this.options.dataDir, 'plugins', id, 'inbox') }

  private async manifest(id: string): Promise<{ manifest: PluginManifest; source: string }> {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error(pick('无效插件标识', 'Invalid plugin id'))
    for (const parent of this.options.sources) {
      const source = join(parent, id)
      let raw: string
      try { raw = await readFile(join(source, 'inkstone-plugin.json'), 'utf8') }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
      return { manifest: parseManifest(id, raw), source }
    }
    throw new Error(pick('随包插件不存在', 'Bundled plugin not found'))
  }

  extensionPaths(): string[] {
    const paths: string[] = []
    for (const parent of this.options.sources) {
      if (!existsSync(parent)) continue
      for (const id of readdirSync(parent, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name)) {
        try {
          if (!this.installed(id)) continue
          const bundled = parseManifest(id, readFileSync(join(parent, id, 'inkstone-plugin.json'), 'utf8'))
          if (!bundled.extension) continue
          const root = this.root(id)
          const installed = parseManifest(id, readFileSync(join(root, 'inkstone-plugin.json'), 'utf8'))
          if (!installed.extension) continue
          const path = join(root, installed.extension)
          if (existsSync(path) && !paths.includes(path)) paths.push(path)
        } catch {}
      }
    }
    return paths
  }

  skillPaths(extensionPaths = this.extensionPaths()): string[] {
    return extensionPaths.flatMap(path => {
      const root = join(path, '..')
      try {
        const manifest = JSON.parse(readFileSync(join(root, 'inkstone-plugin.json'), 'utf8')) as PluginManifest
        return (manifest.skills ?? []).filter(name => SAFE_FILE.test(name)).map(name => join(root, 'skills', name, 'SKILL.md')).filter(existsSync)
      } catch { return [] }
    })
  }

  async startInstalled(): Promise<void> {
    await this.sweepLeftovers()
    for (const parent of this.options.sources) {
      if (this.closed) return
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

  private removeDir(path: string): Promise<void> { return (this.options.remove ?? rm)(path, REMOVE_RETRY) }

  private enqueue<T>(id: string, task: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(id) ?? Promise.resolve()).then(task, task)
    this.queues.set(id, next)
    void next.finally(() => { if (this.queues.get(id) === next) this.queues.delete(id) }).catch(() => undefined)
    return next
  }

  private async sweepLeftovers(): Promise<void> {
    const pluginsDir = join(this.options.dataDir, 'plugins')
    const ids = await readdir(pluginsDir, { withFileTypes: true }).then(items => items.filter(item => item.isDirectory()).map(item => item.name), () => [] as string[])
    for (const id of ids) {
      if (this.closed) return
      await this.enqueue(id, async () => {
        if (this.closed) return
        const dir = join(pluginsDir, id)
        const names = await this.leftovers(id)
        const target = this.root(id)
        const restorable = names.filter(name => name.endsWith('.old'))
          .map(name => ({ name, mtime: statSync(join(dir, name), { throwIfNoEntry: false })?.mtimeMs ?? 0 }))
          .sort((a, b) => b.mtime - a.mtime)[0]?.name
        if (restorable && !existsSync(target) && !existsSync(join(dir, UNINSTALLED))) {
          await rename(join(dir, restorable), target)
          names.splice(names.indexOf(restorable), 1)
        }
        await this.removeLeftovers(id, names)
      }).catch(error => console.warn('[plugins]', id, error))
    }
  }

  private leftovers(id: string): Promise<string[]> {
    return readdir(join(this.options.dataDir, 'plugins', id)).then(items => items.filter(name => LEFTOVER.test(name)), () => [] as string[])
  }

  private async removeLeftovers(id: string, names?: string[]): Promise<void> {
    for (const name of names ?? await this.leftovers(id)) await this.removeDir(join(this.options.dataDir, 'plugins', id, name)).catch(error => console.warn('[plugins]', id, error))
  }

  action(id: string, action: string): Promise<BundledPluginResult> {
    const task = async (): Promise<BundledPluginResult> => {
      try {
        if (this.closed) throw new Error(pick('插件宿主已关闭', 'Plugin host is closed'))
        const { manifest, source } = await this.manifest(id)
        const target = this.root(id)
        const installed = existsSync(join(target, MARKER))
        if (action === 'status') return { ok: true, installed, ...(installed && manifest.process ? { status: await this.invoke(id, 'status') } : {}) }
        if (action === 'remove') {
          if (installed && manifest.beforeRemove && manifest.process) await this.invoke(id, manifest.beforeRemove)
          await this.disconnect(id)
          await writeFile(join(this.options.dataDir, 'plugins', id, UNINSTALLED), '', 'utf8').catch(() => undefined)
          if (installed) await this.removeDir(target)
          await this.removeLeftovers(id)
          return { ok: true, installed: false }
        }
        if (action !== 'install') throw new Error(pick('未知插件操作', 'Unknown plugin action'))
        if (existsSync(target) && !installed) throw new Error(pick('目标已有非砚安装的文件，未改动', 'Target has files not installed by Inkstone; left unchanged'))
        await rm(join(this.options.dataDir, 'plugins', id, UNINSTALLED), { force: true })
        const wasConnected = installed && (this.connections.has(id) || this.connecting.has(id))
        if (installed) await this.disconnect(id)
        const staging = `${target}.${randomUUID()}.new`
        const previous = `${target}.${randomUUID()}.old`
        let swapped = false
        const revive = async (): Promise<void> => {
          if (!wasConnected) return
          if (manifest.process) await this.connect(manifest).catch(() => undefined)
        }
        const rollback = async (): Promise<void> => {
          if (!swapped) { await revive(); return }
          await this.disconnect(id)
          await this.removeDir(target)
          await rename(previous, target)
          swapped = false
          await revive()
        }
        let status: unknown
        let failure: { error?: string; status?: unknown } | undefined
        try {
          try {
            await cp(source, staging, { recursive: true, filter: async path => {
              if ((await lstat(path)).isSymbolicLink()) throw new Error(pick('插件包不能包含符号链接', 'Plugin package cannot contain symbolic links'))
              return !path.split(/[\\/]/).some(part => ['node_modules', '.git', '.tmp'].includes(part))
            } })
            await writeFile(join(staging, MARKER), manifest.id, 'utf8')
            await mkdir(join(target, '..'), { recursive: true })
            if (installed) { await rename(target, previous); swapped = true }
            try { await rename(staging, target) }
            catch (error) { if (swapped) { await rename(previous, target); swapped = false }; throw error }
          } finally { await this.removeDir(staging).catch(() => undefined) }
          if (manifest.setup && manifest.process) {
            const value = await this.invoke(id, manifest.setup) as { ok?: boolean; error?: string; status?: unknown }
            if (value?.ok === false) failure = { error: value.error, status: value.status }
          }
          if (!failure && manifest.process) status = await this.invoke(id, 'status')
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          try { await rollback() } catch (restoreError) {
            throw new Error(`${message}\n${pick('恢复旧版本失败：', 'Restoring the previous version failed: ')}${restoreError instanceof Error ? restoreError.message : String(restoreError)}`)
          }
          throw installed ? new Error(`${pick('升级失败，已保留旧版本：', 'Upgrade failed; the previous version is kept: ')}${message}`) : error
        }
        if (failure) {
          if (!swapped) return { ok: false, installed: true, error: failure.error, status: failure.status }
          try { await rollback() } catch (restoreError) {
            return { ok: false, installed: true, error: `${failure.error ?? ''}\n${pick('恢复旧版本失败：', 'Restoring the previous version failed: ')}${restoreError instanceof Error ? restoreError.message : String(restoreError)}`.trim(), status: failure.status }
          }
          return { ok: false, installed: true, error: `${pick('升级失败，已保留旧版本：', 'Upgrade failed; the previous version is kept: ')}${failure.error ?? ''}`.trim(), status: failure.status }
        }
        if (swapped) await this.removeDir(previous).catch(error => console.warn('[plugins]', id, pick('旧版本目录清理失败，下次启动时重试', 'Cleaning the previous version directory failed; will retry at next start'), error))
        return { ok: true, installed: true, ...(manifest.process ? { status } : {}) }
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
    }
    return this.enqueue(id, task)
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
    if (!id || !action) throw new Error(pick('此命令需要安装对应插件', 'This command needs the plugin installed'))
    const { manifest } = await this.manifest(id)
    if (!manifest.publicActions?.includes(action)) throw new Error(pick('插件没有公开此操作', 'The plugin does not expose this action'))
    const value = await this.invoke(id, action, { input: command === 'plugin.invoke' ? params.input : params, context }, signal)
    const summary = value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).slice(0, 32).flatMap(([key, field]) =>
        typeof field === 'boolean' || typeof field === 'number' || (typeof field === 'string' && field.length <= 300) ? [[key, field]] : Array.isArray(field) ? [[key, field.length]] : []
      ))
      : {}
    return { data: value, summary: { ...summary, plugin: id, action } }
  }

  async invoke(id: string, action: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new Error(pick('已取消', 'Cancelled'))
    if (this.closed) throw new Error(pick('插件宿主已关闭', 'Plugin host is closed'))
    if (!/^[a-zA-Z][a-zA-Z0-9.-]{0,63}$/.test(action) || JSON.stringify(params ?? null).length > 64_000) throw new Error(pick('插件请求无效', 'Invalid plugin request'))
    const { manifest } = await this.manifest(id)
    if (!existsSync(join(this.root(id), MARKER))) throw new Error(pick('插件尚未安装', 'Plugin is not installed'))
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
        reject(new Error(pick('已取消', 'Cancelled')))
      }
      const timer = setTimeout(() => {
        cleanup()
        if (connection.child.connected) connection.child.send({ type: 'cancel-request', id: requestId }, () => undefined)
        reject(new Error(pick('插件操作超时', 'Plugin operation timed out')))
      }, 45 * 60_000)
      connection.pending.set(requestId, {
        resolve: value => { cleanup(); resolve(value) },
        reject: error => { cleanup(); reject(error) }, timer
      })
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) { cancel(); return }
      try {
        connection.child.send({ type: 'request', id: requestId, action, params }, error => {
          if (!error) return
          cleanup(); reject(error)
        })
      } catch (error) {
        cleanup(); reject(error)
      }
    })
  }

  private async connect(manifest: PluginManifest): Promise<Connection> {
    const existing = this.connections.get(manifest.id)
    if (existing) { await existing.ready; return existing }
    const pending = this.connecting.get(manifest.id)
    if (pending) return pending
    const task = this.spawn(manifest)
    this.connecting.set(manifest.id, task)
    try { return await task } finally { this.connecting.delete(manifest.id) }
  }

  private async spawn(manifest: PluginManifest): Promise<Connection> {
    const root = this.root(manifest.id)
    const installed = parseManifest(manifest.id, await readFile(join(root, 'inkstone-plugin.json'), 'utf8'))
    if (!manifest.process || !installed.process) throw new Error(pick('此插件不提供进程接口', 'This plugin has no process interface'))
    const proxy = manifest.capabilities?.includes('system.proxy') ? await this.options.proxyEnvironment?.().catch(() => ({})) : undefined
    if (this.closed) throw new Error(pick('插件宿主已关闭', 'Plugin host is closed'))
    const child = fork(join(root, installed.process), [], {
      execPath: this.options.runtime, execArgv: [], cwd: this.options.dataDir,
      env: { ...pluginEnvironment(process.env), ...pluginConfiguredEnvironment(manifest.environment, process.env), ...proxy, ELECTRON_RUN_AS_NODE: '1', INKSTONE_DATA_ROOT: this.options.dataDir, INKSTONE_PLUGIN_DATA: join(this.options.dataDir, 'plugins', manifest.id) },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    let readyResolve!: () => void
    let readyReject!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
    const connection: Connection = { child, capabilities: new Set(manifest.capabilities), ready, pending: new Map(), completions: new Map(), stderr: '' }
    const timer = setTimeout(() => { readyReject(new Error(withStderrTail(pick('插件启动超时', 'Plugin start timed out'), connection.stderr))); void this.disconnect(manifest.id) }, 60_000)
    this.connections.set(manifest.id, connection)
    child.stderr?.on('data', (chunk: Buffer) => { connection.stderr = (connection.stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS) })
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
      clearTimeout(timer)
      const exited = (): Error => new Error(withStderrTail(pick('插件进程已退出', 'Plugin process exited'), connection.stderr))
      readyReject(exited())
      for (const item of connection.pending.values()) { clearTimeout(item.timer); item.reject(exited()) }
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
    const tracked = await this.trackDescendants(child)
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => killProcessTree(child, resolve), 6000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      if (child.connected) child.disconnect()
      else { clearTimeout(timer); killProcessTree(child, resolve) }
    })
    await this.killSurvivors(tracked)
    if (this.connections.get(id) === connection) this.connections.delete(id)
  }

  private async trackDescendants(child: ChildProcess): Promise<ProcessRow[]> {
    if ((this.options.platform ?? process.platform) !== 'win32' || !child.pid || child.exitCode !== null || child.signalCode !== null) return []
    const rows = await (this.options.listProcesses ?? listWindowsProcesses)().catch(() => [] as ProcessRow[])
    return descendantsOf(rows, child.pid)
  }

  private async killSurvivors(tracked: ProcessRow[]): Promise<void> {
    if (tracked.length === 0) return
    const alive = tracked.filter(row => pidAlive(row.pid))
    if (alive.length === 0) return
    const rows = await (this.options.listProcesses ?? listWindowsProcesses)().catch(() => [] as ProcessRow[])
    const same = alive.filter(row => rows.some(item => item.pid === row.pid && item.created === row.created))
    const pids = new Set(same.map(row => row.pid))
    const tops = same.filter(row => !pids.has(row.ppid))
    await Promise.all(tops.map(row => (this.options.killTree ?? taskkillTree)(row.pid).catch(() => undefined)))
  }

  close(): Promise<void> {
    this.closed = true
    return this.closing ??= Promise.resolve().then(() => this.finishClose())
  }

  private async finishClose(): Promise<void> {
    const pending = [...this.connecting.values(), ...this.queues.values()]
    await Promise.all([...this.connections.keys()].map(id => this.disconnect(id).catch(() => undefined)))
    await Promise.allSettled(pending)
    await Promise.all([...this.connections.keys()].map(id => this.disconnect(id).catch(() => undefined)))
  }
}
