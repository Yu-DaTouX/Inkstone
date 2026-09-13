/**
 * pi RPC 协议客户端 —— **手写**，不 import 包内部的 rpc-client.js。
 *
 * 理由（HANDOFF §9 原则 2）：`dist/modes/rpc/rpc-client.js` 不在 package.json 的
 * `exports` 里，`pi update` 一次就可能改名/搬家。协议适配集中在本文件，
 * 上游变了我只改这里。
 *
 * 协议要点（docs/rpc.md）：
 *   · JSONL，**只用 LF 分帧** —— 不能用 readline（它还会切 U+2028/U+2029，
 *     而这两个字符在 JSON 字符串里是合法的）
 *   · 命令带 `id`，响应回同一个 `id`
 *   · 事件无 id，直接流式推来
 *   · extension_ui_request 里 select/confirm/input/editor 需要回
 *     extension_ui_response，其余（notify/setStatus/...）不需要
 */
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, delimiter, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PiInfo, PiSource, PiProbe, RpcResponse } from '../shared/ipc'

const PKG = '@earendil-works/pi-coding-agent'
/** cli 在包里的相对路径（package.json 的 bin 字段） */
const CLI_REL = join('dist', 'bundle', 'cli.js')

const __dirname_ = fileURLToPath(new URL('.', import.meta.url))

/**
 * 随应用分发的内置 pi 运行时（由 `npm run vendor:pi` 生成，见 scripts/vendor-pi.mjs）。
 *
 * 为什么内置：不内置的话用户得先 `npm i -g @earendil-works/pi-coding-agent`
 * 才能用这个应用 —— 这是分发时最大的门槛。内置后开箱即用。
 *
 * 放在**全局安装之前**优先使用：版本确定，不受用户环境里 pi 升级/降级影响。
 * 想换回全局 pi 或指定别的版本，用设置项 `piBin` 或 `YAN_PI_BIN` 覆盖。
 */
function bundledRoots(): string[] {
  const out: string[] = []
  // 打包后：electron-builder 把 resources/pi-runtime 放进 process.resourcesPath
  if (process.resourcesPath) out.push(join(process.resourcesPath, 'pi-runtime'))
  // 开发期：out/main/protocol.js → ../../resources/pi-runtime
  out.push(join(__dirname_, '..', '..', 'resources', 'pi-runtime'))
  // 兜底：以 cwd 为项目根时
  out.push(join(process.cwd(), 'resources', 'pi-runtime'))
  return out
}

/* 定位 pi 可执行入口 */

/** 内置运行时目录是否可用（clili.js 存在） */
export function bundledAvailable(): boolean {
  return bundledRoots().some((root) => existsSync(join(root, CLI_REL)))
}

/**
 * 从 CLI 入口往上找 pi 包根目录（含 package.json 的那层）。
 *
 * 仅用于界面显示「包在哪」，找不到就返回 undefined —— 不能因为
 * 一个诊断字段让定位流程失败。最多上溯 6 层，防止在异常路径上死循环。
 */
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

/** 达到一个候选时统一组装返回，补上来源与包目录 */
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

/** 候选的包安装根目录 */
function packageRoots(): string[] {
  const roots: string[] = []
  const home = homedir()

  // Windows: %APPDATA%\npm\node_modules
  if (process.env.APPDATA) roots.push(join(process.env.APPDATA, 'npm', 'node_modules'))
  // npm 全局默认的前缀（类 Unix）
  roots.push(join(home, '.npm-global', 'lib', 'node_modules'))
  roots.push('/usr/local/lib/node_modules')
  roots.push('/usr/lib/node_modules')
  // nvm / volta
  if (process.env.NVM_BIN) roots.push(join(process.env.NVM_BIN, '..', 'lib', 'node_modules'))
  if (process.env.VOLTA_HOME) roots.push(join(process.env.VOLTA_HOME, 'tools', 'image', 'node_modules'))

  return roots
}

/**
 * 在 PATH 里找 `pi.cmd` / `pi`，从其所在目录反推 node_modules。
 * 全局 npm bin 目录通常就是 `<prefix>/node_modules/.bin` 的上一层。
 */
function pathCandidates(): string[] {
  const out: string[] = []
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : ['']
  for (const dir of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const shim = join(dir, `pi${ext}`)
      if (existsSync(shim)) {
        // 同级或上一级的 node_modules
        out.push(join(dir, 'node_modules', PKG, CLI_REL))
        out.push(join(dir, '..', 'lib', 'node_modules', PKG, CLI_REL))
      }
    }
  }
  return out
}

/**
 * 解析出「怎么启动 pi」。
 *
 * 关键决策：用 **Electron 自带的 Node**（`process.execPath` + ELECTRON_RUN_AS_NODE=1）
 * 而不是 shell 里那个 `pi.cmd`。
 * 原因：spawn 一个 .cmd 必须 `shell:true`，而 shell 会做引号解析 ——
 * 提示词里带引号、反斜杠、中文时很容易被吃掉或注入。走 execPath 则是纯参数数组，
 * 不经过任何 shell。
 */
export function resolvePi(opts: { override?: string } = {}): PiProbe {
  const tried: string[] = []

  // 1. 用户显式指定
  if (opts.override) {
    tried.push(`设置项 piBin: ${opts.override}`)
    if (existsSync(opts.override)) {
      return hit('override', [opts.override], tried)
    }
  }

  // 2. 环境变量
  const fromEnv = process.env.YAN_PI_BIN
  if (fromEnv) {
    tried.push(`env YAN_PI_BIN: ${fromEnv}`)
    if (existsSync(fromEnv)) {
      return hit('env', [fromEnv], tried)
    }
  }

  // 3. 随应用分发的内置运行时（正常分发路径，开箱即用）
  for (const root of bundledRoots()) {
    const cli = join(root, CLI_REL)
    tried.push(`内置运行时: ${cli}`)
    if (existsSync(cli)) return hit('bundled', [cli], tried)
  }

  // 4. 常规安装位置（用户自己全局装过 pi）
  for (const root of packageRoots()) {
    const cli = join(root, PKG, CLI_REL)
    tried.push(cli)
    if (existsSync(cli)) return hit('global', [cli], tried)
  }

  // 5. 从 PATH 上的 shim 反推
  for (const cli of pathCandidates()) {
    tried.push(cli)
    if (existsSync(cli)) return hit('path', [cli], tried)
  }

  // 6. 最后兜底：直接用 PATH 上的 pi（需要 shell，量力而行）
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

/**
 * 探测本机 pi 的入口与版本号（右栏「环境」分区用）。
 *
 * 为什么要版本号：pi 的 RPC 协议在演进（会话格式已经到 version: 3），
 * 出问题时第一件事就是问「你是哪个版本」—— 界面上直接看得到就省一轮对话。
 * 探测失败一律静默降级（不显示版本号），绝不能影响启动。
 */
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

/**
 * 清掉版本缓存。
 *
 * `redetectPi` 用它强制重跑 `--version` —— 否则用户装完/升完 pi
 * 点「重新检测」，界面还是显示旧版本。
 */
export function resetPiVersionCache(): void {
  versionCache = null
  versionPending = null
}

/** 版本号缓存（进程生命周期内不会变，pi 升级要重启应用） */
let versionCache: string | undefined | null = null
/** 正在探测中的 Promise —— 防止并发重复起进程 */
let versionPending: Promise<string | undefined> | null = null

/**
 * 异步读版本号。
 *
 * ⚠️ 这里**曾经用 `execFileSync`，是个错误的决定**：
 *   同步子进程会阻塞主进程的事件循环 —— 实测 183ms 内所有其它 IPC 全部排队
 *   （`bootstrap()` 并发下发 11 个请求，它们都要等这个 `--version` 跑完）。
 *   而且冷启动时 pi 自己要加载模块，可能到几秒。
 *
 * 现在：异步 + 结果缓存 + 重入保护，不再堵塞任何东西。
 */
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
      /*
       * 用 execFile（不走 shell） + ELECTRON_RUN_AS_NODE：
       * 与 protocol.ts 启动 pi 的方式一致 —— 避免依赖用户系统上的 node 版本，
       * 也不需要 shell 解析（路径含空格/中文时 shell 很容易出错）。
       */
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
            // 探测失败**不**缓存 —— 下次换个时机可能就成功了
            done(undefined)
            return
          }
          const m = String(stdout).match(/\d+\.\d+\.\d+[\w.-]*/)
          done(m ? m[0] : String(stdout).trim().split('\n')[0] || undefined)
        }
      )
      // 别让子进程句柄拴住主进程退出
      child.unref?.()
    } catch {
      done(undefined)
    }
  })

  return versionPending
}

/* RPC 客户端 */
export interface PiRpcOptions {
  cwd: string
  /** 追加的 CLI 参数，例如 --no-session */
  args?: string[]
  /** 显式指定 pi JS 入口 */
  piBin?: string
  /** 给扩展注入的额外环境变量（例如内置浏览器桥接 token） */
  env?: NodeJS.ProcessEnv
}

type Pending = {
  resolve: (r: RpcResponse) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface PiRpcEvents {
  /** pi 的原始事件（agent_start / message_update / ... ） */
  event: (evt: Record<string, unknown>) => void
  /** 扩展要求弹窗（select/confirm/input/editor）或不需应答的通知 */
  ui: (req: Record<string, unknown>) => void
  /** 进程退出 */
  exit: (code: number | null, signal: string | null) => void
  /** stderr 一行 */
  stderr: (line: string) => void
}

const REQUEST_TIMEOUT = 30_000

export class PiRpc extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private buf = ''
  private pending = new Map<string, Pending>()
  private seq = 0
  private closed = false

  readonly probe: PiProbe

  constructor(private opts: PiRpcOptions) {
    super()
    this.probe = resolvePi({ override: opts.piBin })
  }

  get running(): boolean {
    return this.child !== null && !this.closed
  }

  spawn(): void {
    if (this.child) return

    const rpcArgs = [...this.probe.args, '--mode', 'rpc', ...(this.opts.args ?? [])]

    // ELECTRON_RUN_AS_NODE：让 Electron 二进制当纯 Node 跑，
    // 这样不依赖用户系统里装了哪个版本的 node。
    const env: NodeJS.ProcessEnv = { ...process.env, ...(this.opts.env ?? {}), ELECTRON_RUN_AS_NODE: '1' }
    // 去掉可能干扰子进程的 Electron 变量
    delete env.ELECTRON_NO_ATTACH_CONSOLE
    delete env.ELECTRON_FORCE_IS_PACKAGED

    // 不显式传 stdio：默认就是 pipe，这样 TS 能推出 ChildProcessWithoutNullStreams
    const child: ChildProcessWithoutNullStreams = spawn(this.probe.cmd, rpcArgs, {
      cwd: this.opts.cwd,
      env,
      windowsHide: true
    })

    this.child = child

    // ---- stdout：严格按 LF 分帧 ----
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.feed(chunk))
    child.stdout.on('error', () => {})

    // ---- stderr：逐行转出去，不当协议内容 ----
    child.stderr.setEncoding('utf8')
    let errBuf = ''
    child.stderr.on('data', (chunk: string) => {
      errBuf += chunk
      let i: number
      while ((i = errBuf.indexOf('\n')) >= 0) {
        const line = errBuf.slice(0, i).replace(/\r$/, '')
        errBuf = errBuf.slice(i + 1)
        if (line.trim()) this.emit('stderr', line)
      }
    })
    child.stderr.on('error', () => {})

    child.on('error', (err: Error) => {
      this.failAll(new Error(`无法启动 pi：${err.message}`))
      this.emit('exit', null, null)
    })

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.closed = true
      this.child = null
      this.failAll(new Error(`pi 进程已退出（code=${code ?? 'null'}）`))
      this.emit('exit', code, signal)
    })

    // stdin 出错不要让整个进程崩
    child.stdin.on('error', () => {})
  }

  /** 累积 stdout 并按 LF 切记录 */
  private feed(chunk: string): void {
    this.buf += chunk

    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      // 只按 \n 切；容忍 CRLF
      const line = this.buf.slice(0, nl).replace(/\r$/, '')
      this.buf = this.buf.slice(nl + 1)
      if (!line.trim()) continue
      this.handleLine(line)
    }

    // 防御：万一上游吐了没有换行的巨量内容，别把内存吃干净
    if (this.buf.length > 64 * 1024 * 1024) {
      this.buf = ''
      this.emit('stderr', '[yan] 单条记录超过 64MB，已丢弃（协议异常？）')
    }
  }

  private handleLine(line: string): void {
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      // 不是 JSON 的行（第三方扩展 print 之类）—— 记下来，不要崩
      this.emit('stderr', `[非 JSON 输出] ${line.slice(0, 500)}`)
      return
    }

    // 1. 响应：带 id 的关联回去
    if (obj.type === 'response') {
      const res = obj as unknown as RpcResponse
      const id = res.id
      if (id && this.pending.has(id)) {
        const p = this.pending.get(id)!
        clearTimeout(p.timer)
        this.pending.delete(id)
        p.resolve(res)
      } else {
        // 没有 id 的响应（我们没带 id 发的，或者上游漏了）—— 当事件抛出去，别丢
        this.emit('event', obj)
      }
      return
    }

    // 2. 扩展 UI
    if (obj.type === 'extension_ui_request') {
      this.emit('ui', obj)
      return
    }

    // 3. 其余都是事件
    this.emit('event', obj)
  }

  /**
   * 发命令。返回响应（不抛错 —— 用 `success` 判断）。
   * 超时或进程已死才 reject。
   *
   * `opts.id` 可以自己指定请求 id。为什么需要：
   * `bash_execution_update` 事件带的 `id` 就是发起命令的 id，
   * 而 bash 是流式输出的，我们必须**在发命令前就知道 id** 才能把流接上。
   */
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

  /** 回扩展的弹窗应答（不需要响应） */
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

  /** 优雅关闭：先关 stdin（pi 会自己收尾），1.5s 后强杀 */
  close(): Promise<void> {
    const child = this.child
    if (!child) return Promise.resolve()

    this.closed = true
    this.child = null

    return new Promise((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        resolve()
      }

      child.once('exit', finish)
      try {
        child.stdin.end()
      } catch {
        /* 已关 */
      }

      setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* 已死 */
        }
        finish()
      }, 1500)
    })
  }
}

/* ---- 类型安全的 on 重载 ---- */
export interface PiRpc {
  on<K extends keyof PiRpcEvents>(event: K, listener: PiRpcEvents[K]): this
  emit<K extends keyof PiRpcEvents>(event: K, ...args: Parameters<PiRpcEvents[K]>): boolean
}
