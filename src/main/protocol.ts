import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, delimiter, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PiInfo, PiSource, PiProbe, RpcResponse } from '../shared/ipc'
import { selectedPiRuntime } from './pi-runtime-location'
import { killPidTree } from './git-service'
import { ignoresElectronRunAsNode, runtimeProbe, type PiRpcRuntime } from './pi-runtime-launch'

export type { PiRpcRuntime }

const PKG = '@earendil-works/pi-coding-agent'
const CLI_REL = join('dist', 'bundle', 'cli.js')

const __dirname_ = fileURLToPath(new URL('.', import.meta.url))

const MAX_STDERR_BUF_CHARS = 16 * 1024
const STDERR_LINE_TOO_LONG = `[yan] stderr 单行过长，已截断（整行省略，丢弃到下一个换行）`
const EXIT_DRAIN_MS = 300

function bundledRoots(): string[] {
  const out: string[] = []
  if (process.resourcesPath) out.push(join(process.resourcesPath, 'pi-runtime'))
  out.push(join(__dirname_, '..', '..', 'resources', 'pi-runtime'))
  out.push(join(process.cwd(), 'resources', 'pi-runtime'))
  return out.map(selectedPiRuntime)
}

export function bundledAvailable(): boolean {
  return bundledRoots().some((root) => existsSync(join(root, CLI_REL)))
}

function findPackageHome(cliPath: string): string | undefined {
  let dir = dirname(cliPath)
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

function hit(source: PiSource, args: string[], tried: string[]): PiProbe {
  const cli = args[args.length - 1]
  return {
    ok: true,
    source,
    cmd: process.execPath,
    args,
    home: cli ? findPackageHome(cli) : undefined,
    tried
  }
}

function packageRoots(): string[] {
  const roots: string[] = []
  const home = homedir()

  if (process.env.APPDATA) roots.push(join(process.env.APPDATA, 'npm', 'node_modules'))
  roots.push(join(home, '.npm-global', 'lib', 'node_modules'))
  roots.push('/usr/local/lib/node_modules')
  roots.push('/usr/lib/node_modules')
  if (process.env.NVM_BIN) roots.push(join(process.env.NVM_BIN, '..', 'lib', 'node_modules'))
  if (process.env.VOLTA_HOME) roots.push(join(process.env.VOLTA_HOME, 'tools', 'image', 'node_modules'))

  return roots
}

function pathCandidates(): string[] {
  const out: string[] = []
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : ['']
  for (const dir of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const shim = join(dir, `pi${ext}`)
      if (existsSync(shim)) {
        out.push(join(dir, 'node_modules', PKG, CLI_REL))
        out.push(join(dir, '..', 'lib', 'node_modules', PKG, CLI_REL))
      }
    }
  }
  return out
}

export function resolvePi(opts: { override?: string } = {}): PiProbe {
  const tried: string[] = []

  if (opts.override) {
    tried.push(`设置项 piBin: ${opts.override}`)
    if (existsSync(opts.override)) {
      return hit('override', [opts.override], tried)
    }
  }

  const fromEnv = process.env.YAN_PI_BIN
  if (fromEnv) {
    tried.push(`env YAN_PI_BIN: ${fromEnv}`)
    if (existsSync(fromEnv)) {
      return hit('env', [fromEnv], tried)
    }
  }

  for (const root of bundledRoots()) {
    const cli = join(root, CLI_REL)
    tried.push(`内置运行时: ${cli}`)
    if (existsSync(cli)) return hit('bundled', [cli], tried)
  }

  for (const root of packageRoots()) {
    const cli = join(root, PKG, CLI_REL)
    tried.push(cli)
    if (existsSync(cli)) return hit('global', [cli], tried)
  }

  for (const cli of pathCandidates()) {
    tried.push(cli)
    if (existsSync(cli)) return hit('path', [cli], tried)
  }

  tried.push('PATH 上的 pi（shell 兜底）')
  return {
    ok: true,
    source: 'shell',
    cmd: 'pi',
    args: [],
    tried,
    error: '未找到 pi 的 JS 入口，退回 shell 调用（提示词含特殊字符时可能出问题）'
  }
}

export async function piInfo(override?: string, opts: { fresh?: boolean } = {}): Promise<PiInfo> {
  const probe = resolvePi({ override })
  const bin = probe.args[probe.args.length - 1] ?? probe.cmd
  const version = probe.ok ? await readPiVersion(probe, !!opts.fresh) : undefined

  return {
    bin,
    home: probe.home,
    version,
    source: probe.source,
    bundled: probe.source === 'bundled',
    bundledAvailable: bundledAvailable(),
    error: probe.error
  }
}

export function resetPiVersionCache(): void {
  versionCache = null
  versionPending = null
}

let versionCache: string | undefined | null = null
let versionPending: Promise<string | undefined> | null = null

function readPiVersion(probe: PiProbe, fresh = false): Promise<string | undefined> {
  if (fresh) versionCache = null
  if (versionCache !== null) return Promise.resolve(versionCache)
  if (versionPending) return versionPending

  versionPending = new Promise<string | undefined>((resolve) => {
    const done = (v: string | undefined): void => {
      versionPending = null
      if (v !== undefined) versionCache = v
      resolve(v)
    }

    try {
      const child = execFile(
        probe.cmd,
        [...probe.args, '--version'],
        {
          timeout: 8000,
          windowsHide: true,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          encoding: 'utf8',
          maxBuffer: 1024 * 1024
        },
        (err, stdout) => {
          if (err) {
            done(undefined)
            return
          }
          const m = String(stdout).match(/\d+\.\d+\.\d+[\w.-]*/)
          done(m ? m[0] : String(stdout).trim().split('\n')[0] || undefined)
        }
      )
      child.unref?.()
    } catch {
      done(undefined)
    }
  })

  return versionPending
}

export interface PiRpcOptions {
  cwd: string
  args?: string[]
  piBin?: string
  env?: NodeJS.ProcessEnv
  inheritEnv?: boolean
  runtime?: PiRpcRuntime
}

type Pending = {
  resolve: (r: RpcResponse) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface PiRpcEvents {
  event: (evt: Record<string, unknown>) => void
  ui: (req: Record<string, unknown>) => void
  exit: (code: number | null, signal: string | null) => void
  stderr: (line: string) => void
  'spawn-error': (err: Error) => void
}

const REQUEST_TIMEOUT = 30_000

export class PiRpc extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private parts: string[] = []
  private partsLen = 0
  private pending = new Map<string, Pending>()
  private seq = 0
  private closed = false
  private errBuf = ''
  private errDropping = false
  private spawnError: Error | null = null
  private finished = false
  private sawExit = false
  private exitDrainTimer: NodeJS.Timeout | null = null

  readonly probe: PiProbe

  constructor(private opts: PiRpcOptions) {
    super()
    this.probe = opts.runtime ? runtimeProbe(opts.runtime) : resolvePi({ override: opts.piBin })
  }

  get launchOptions(): Readonly<PiRpcOptions> {
    return this.opts
  }

  get running(): boolean {
    return this.child !== null && !this.closed
  }

  spawn(): void {
    if (this.child) return
    this.closed = false
    this.finished = false
    this.sawExit = false
    this.spawnError = null
    if (this.exitDrainTimer) {
      clearTimeout(this.exitDrainTimer)
      this.exitDrainTimer = null
    }

    const rpcArgs = [...this.probe.args, '--mode', 'rpc', ...(this.opts.args ?? [])]

    const env: NodeJS.ProcessEnv = {
      ...(this.opts.inheritEnv === false ? {} : process.env),
      ...(this.opts.env ?? {})
    }
    if (ignoresElectronRunAsNode(this.opts.runtime)) delete env.ELECTRON_RUN_AS_NODE
    else env.ELECTRON_RUN_AS_NODE = '1'
    delete env.ELECTRON_NO_ATTACH_CONSOLE
    delete env.ELECTRON_FORCE_IS_PACKAGED
    delete env.YAN_REMOTE_TOKEN

    const child: ChildProcessWithoutNullStreams = spawn(this.probe.cmd, rpcArgs, {
      cwd: this.opts.cwd,
      env,
      windowsHide: true
    })

    this.child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.feed(chunk))
    child.stdout.on('error', () => {})

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.feedStderr(chunk))
    child.stderr.on('end', () => this.flushStderr())
    child.stderr.on('error', () => {})

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.finished) return
      this.sawExit = true
      this.closed = true
      this.failAll(new Error(`pi 进程已退出（code=${code ?? 'null'}）`))
      this.exitDrainTimer = setTimeout(() => this.finishExit(code, signal), EXIT_DRAIN_MS)
      this.exitDrainTimer.unref?.()
    })

    child.on('error', (err: Error) => {
      this.spawnError = err
      this.failAll(new Error(`无法启动 pi：${err.message}`))
    })

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => this.finishExit(code, signal))

    child.stdin.on('error', () => {})
  }

  private feedStderr(chunk: string): void {
    if (this.finished) return
    let rest = chunk
    while (rest.length > 0) {
      if (this.errDropping) {
        const drop = rest.indexOf('\n')
        if (drop < 0) return
        rest = rest.slice(drop + 1)
        this.errDropping = false
        continue
      }
      const nl = rest.indexOf('\n')
      if (nl < 0) {
        this.errBuf += rest
        if (this.errBuf.length > MAX_STDERR_BUF_CHARS) {
          this.errBuf = ''
          this.errDropping = true
          this.emit('stderr', STDERR_LINE_TOO_LONG)
        }
        return
      }
      const line = this.errBuf + rest.slice(0, nl)
      rest = rest.slice(nl + 1)
      this.errBuf = ''
      if (line.length > MAX_STDERR_BUF_CHARS) {
        this.emit('stderr', STDERR_LINE_TOO_LONG)
        continue
      }
      const cleaned = line.replace(/\r$/, '')
      if (cleaned.trim()) this.emit('stderr', cleaned)
    }
  }

  private flushStderr(): void {
    if (this.errDropping) {
      this.errDropping = false
      return
    }
    if (!this.errBuf) return
    const line = this.errBuf.replace(/\r$/, '')
    this.errBuf = ''
    if (line.trim()) this.emit('stderr', line)
  }

  private finishExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.finished) return
    this.finished = true
    if (this.exitDrainTimer) {
      clearTimeout(this.exitDrainTimer)
      this.exitDrainTimer = null
    }
    this.closed = true
    this.child = null
    this.flushStderr()
    this.failAll(new Error(`pi 进程已退出（code=${code ?? 'null'}）`))
    if (this.spawnError) this.emit('spawn-error', this.spawnError)
    this.emit('exit', code, signal)
  }

  private feed(chunk: string): void {
    if (this.finished) return
    let start = 0
    let nl: number
    while ((nl = chunk.indexOf('\n', start)) >= 0) {
      const piece = chunk.slice(start, nl)
      start = nl + 1
      let line = this.partsLen > 0 ? this.parts.join('') + piece : piece
      this.parts = []
      this.partsLen = 0
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (!line.trim()) continue
      this.handleLine(line)
    }
    if (start < chunk.length) {
      const rest = start === 0 ? chunk : chunk.slice(start)
      this.parts.push(rest)
      this.partsLen += rest.length
    }

    if (this.partsLen > 64 * 1024 * 1024) {
      this.parts = []
      this.partsLen = 0
      this.emit('stderr', '[yan] 单条记录超过 64MB，已丢弃（协议异常？）')
    }
  }

  private handleLine(line: string): void {
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      this.emit('stderr', `[非 JSON 输出] ${line.slice(0, 500)}`)
      return
    }
    if (line.length > 4 * 1024 * 1024) {
      const kind = [obj.type, obj.command, (obj as { event?: { type?: unknown } }).event?.type].filter((v) => typeof v === 'string').join('/')
      this.emit('stderr', `[yan] 大 RPC 记录 ${kind || '?'}：${(line.length / 1024 / 1024).toFixed(1)}MB`)
    }

    if (obj.type === 'response') {
      const res = obj as unknown as RpcResponse
      const id = res.id
      if (id && this.pending.has(id)) {
        const p = this.pending.get(id)!
        clearTimeout(p.timer)
        this.pending.delete(id)
        p.resolve(res)
      } else {
        this.emit('event', obj)
      }
      return
    }

    if (obj.type === 'extension_ui_request') {
      this.emit('ui', obj)
      return
    }

    this.emit('event', obj)
  }

  command<T = unknown>(
    type: string,
    payload: Record<string, unknown> = {},
    opts: { id?: string; timeoutMs?: number } = {}
  ): Promise<RpcResponse & { data?: T }> {
    if (!this.child || this.closed) {
      return Promise.reject(new Error('pi 未运行'))
    }

    const id = opts.id ?? `yan-${++this.seq}`
    const limit = opts.timeoutMs ?? REQUEST_TIMEOUT

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`命令 ${type} 超时（${limit}ms）`))
      }, limit)

      this.pending.set(id, { resolve: resolve as Pending['resolve'], reject, timer })

      const line = JSON.stringify({ id, type, ...payload }) + '\n'
      this.child!.stdin.write(line, 'utf8', (err) => {
        if (!err) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`写入 stdin 失败：${err.message}`))
      })
    })
  }

  respondUi(res: Record<string, unknown>): void {
    if (!this.child || this.closed) return
    this.child.stdin.write(JSON.stringify({ type: 'extension_ui_response', ...res }) + '\n')
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  close(): Promise<void> {
    const child = this.child
    if (!child) return Promise.resolve()

    this.closed = true
    this.child = null

    if (this.sawExit) return Promise.resolve()

    return new Promise((resolve) => {
      let done = false
      let timer: NodeJS.Timeout | null = null
      const finish = (): void => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        child.off('exit', finish)
        resolve()
      }

      child.once('exit', finish)
      try {
        child.stdin.end()
      } catch {
      }

      timer = setTimeout(() => {
        killPidTree(child.pid, () => {
          try {
            child.kill()
          } catch {
          }
        })
        finish()
      }, 1500)
      timer.unref?.()
    })
  }
}

export interface PiRpc {
  on<K extends keyof PiRpcEvents>(event: K, listener: PiRpcEvents[K]): this
  emit<K extends keyof PiRpcEvents>(event: K, ...args: Parameters<PiRpcEvents[K]>): boolean
}
