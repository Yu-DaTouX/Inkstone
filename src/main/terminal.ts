/**
 * 交互终端（实施-11 H-11）。
 *
 * 为什么需要一层宿主服务：真正的交互终端要的是**伪终端**（PTY）——
 * 需要 TTY 语义（行编辑、Ctrl+C、进度输出、`resize` 通知）。一次性
 * `bash -c` 的输出流冒充不了它（H-11 禁区），Electron 自己也没有 PTY。
 * 所以这里用 `node-pty`（随包的原生依赖，N-API 预编译，无需 Electron 重编译）
 * 管理会话：开始 / 写入 / 缩放 / 关闭 / 退出，并给渲染端一个**可重连**的
 * 环形缓冲（面板重开或窗口刷新后还能看到之前的输出）。
 *
 * 三条边界：
 *   ① 原生依赖可能装不上（平台 / 架构不支持）—— 载荷失败时一律回落
 *      “不可用”，不让主进程 import 阶段就崩（`node-pty` 用惰性 require）。
 *   ② 工作目录由渲染端给，但**必须**在主进程校验成真实存在的目录，
 *      默认回落到会话工作目录 / 进程 cwd；不把任意字符串直接交给 spawn。
 *   ③ 输出是高频推送，但每个会话只保留**有界**的回滚缓冲
 *      （`BUFFER_LIMIT`），内存不随会话时长无界增长。
 */
import { createRequire } from 'node:module'
import { existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { IPty } from 'node-pty'

/**
 * 主进程是 ESM，而 `node-pty` 是原生 CJS 模块；用 `createRequire` 拿一个
 * 运行时 require。**只取类型用 `import type`**（编译后不留任何静态 import），
 * 真正的加载全部在 `ptyOrNull()` 里惰性发生 —— 装不上的平台上主进程照常启动。
 */
const requireNative = createRequire(import.meta.url)

/** 每个会话保留的滚动缓冲（字符数）：够重连后看清最近的内容，又有界 */
export const BUFFER_LIMIT = 200_000
/** 超过上限时裁到多少（留一点余量，避免每来一个字符就裁一次） */
const BUFFER_KEEP = 120_000

export interface TerminalSessionInfo {
  id: string
  /** 会话标题（壳名 · 目录名），标签上显示 */
  title: string
  shell: string
  cwd: string
  cols: number
  rows: number
  alive: boolean
  exitCode?: number | null
}

export interface TerminalSnapshot extends TerminalSessionInfo {
  /** 已有的输出尾部（重连时先灌回 xterm，再接实时流） */
  buffer: string
  /**
   * 这份 buffer 对应的输出序号。
   *
   * 为什么需要：实时数据与缓冲重放走的是**同一条推送通道**，
   * 重连瞬间两者会交叠。带一个单调序号，渲染端就可以“只收比快照更新的”，
   * 不靠时间窗猜（那在慢机器上必错）。
   */
  seq: number
}

export interface TerminalStartOptions {
  /** 期望的工作目录；不存在 / 不是目录时回落到 `fallbackCwd` */
  cwd?: string
  /** 主进程给的兜底目录（会话工作目录），同样会被校验 */
  fallbackCwd?: string
  cols?: number
  rows?: number
}

interface TerminalEntry {
  info: TerminalSessionInfo
  pty: IPty
  buffer: string
  /** 输出序号：每次 data 自增；重连时用来丢弃已包含在快照里的推送 */
  seq: number
}

/** 推送回调：`data` 是实时输出，`exit` 是进程退出（两者都带会话身份） */
export type TerminalSink = (event:
  | { kind: 'data'; id: string; data: string; seq: number }
  | { kind: 'exit'; id: string; exitCode: number | null }) => void

let loadError: string | null = null
let ptyModule: typeof import('node-pty') | null = null

/**
 * 惰性加载原生模块。**不要在模块顶层 require**：装不上的平台上，
 * 顶层 import 会让整个主进程起不来（终端只是可选能力，不是启动前提）。
 */
function ptyOrNull(): typeof import('node-pty') | null {
  if (ptyModule) return ptyModule
  if (loadError) return null
  try {
    ptyModule = requireNative('node-pty') as typeof import('node-pty')
    return ptyModule
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error)
    return null
  }
}

export function terminalAvailable(): boolean {
  return ptyOrNull() !== null
}

/** 加载失败原因（诊断 / 设置页展示；成功时为 null） */
export function terminalLoadError(): string | null {
  return loadError
}

const sessions = new Map<string, TerminalEntry>()
let sink: TerminalSink | null = null

export function setTerminalSink(next: TerminalSink | null): void {
  sink = next
}

/** 默认壳：Windows 用 ComSpec（cmd），类 Unix 用 SHELL（回退 sh） */
function defaultShell(): string {
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe'
  return process.env.SHELL || '/bin/sh'
}

/** 目录必须真实存在且是目录；否则返回 null（交给调用方回落） */
function validDir(candidate: string | undefined): string | null {
  if (!candidate) return null
  try {
    return existsSync(candidate) && statSync(candidate).isDirectory() ? candidate : null
  } catch {
    return null
  }
}

function clampDimension(value: number | undefined, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(2, Math.min(1000, Math.round(n)))
}

function titleOf(shell: string, cwd: string): string {
  const shellName = basename(shell.replace(/\.exe$/i, '')) || shell
  const dirName = basename(cwd) || cwd
  return `${shellName} · ${dirName}`
}

function snapshotOf(entry: TerminalEntry): TerminalSnapshot {
  return { ...entry.info, buffer: entry.buffer, seq: entry.seq }
}

/** 把一个会话的当前输出灌回监听方（重连用） */
function emitBuffered(id: string): void {
  const entry = sessions.get(id)
  if (!entry || !sink) return
  if (entry.buffer) sink({ kind: 'data', id, data: entry.buffer, seq: entry.seq })
  if (!entry.info.alive) sink({ kind: 'exit', id, exitCode: entry.info.exitCode ?? null })
}

export function startTerminal(options: TerminalStartOptions = {}): TerminalSnapshot | null {
  const pty = ptyOrNull()
  if (!pty) return null

  const cwd = validDir(options.cwd) ?? validDir(options.fallbackCwd) ?? process.cwd()
  const cols = clampDimension(options.cols, 80)
  const rows = clampDimension(options.rows, 24)
  const shell = defaultShell()
  const id = randomUUID()

  let child: IPty
  try {
    child = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' }
    })
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error)
    return null
  }

  const info: TerminalSessionInfo = {
    id,
    title: titleOf(shell, cwd),
    shell,
    cwd,
    cols,
    rows,
    alive: true,
    exitCode: null
  }
  const entry: TerminalEntry = { info, pty: child, buffer: '', seq: 0 }
  sessions.set(id, entry)

  child.onData((data) => {
    const current = sessions.get(id)
    if (!current) return
    current.buffer += data
    current.seq += 1
    if (current.buffer.length > BUFFER_LIMIT) {
      current.buffer = current.buffer.slice(current.buffer.length - BUFFER_KEEP)
    }
    sink?.({ kind: 'data', id, data, seq: current.seq })
  })
  child.onExit(({ exitCode }) => {
    const current = sessions.get(id)
    if (!current) return
    current.info = { ...current.info, alive: false, exitCode: exitCode ?? null }
    sink?.({ kind: 'exit', id, exitCode: exitCode ?? null })
  })

  return snapshotOf(entry)
}

/** 写入用户输入（含 Ctrl+C 等控制字符，原样交给 PTY） */
export function writeTerminal(id: string, data: string): boolean {
  const entry = sessions.get(id)
  if (!entry || !entry.info.alive) return false
  try {
    entry.pty.write(data)
    return true
  } catch {
    return false
  }
}

/** 缩放：先记住尺寸，再通知 PTY（供 curses 程序重排） */
export function resizeTerminal(id: string, cols: number, rows: number): boolean {
  const entry = sessions.get(id)
  if (!entry || !entry.info.alive) return false
  const nextCols = clampDimension(cols, entry.info.cols)
  const nextRows = clampDimension(rows, entry.info.rows)
  entry.info = { ...entry.info, cols: nextCols, rows: nextRows }
  try {
    entry.pty.resize(nextCols, nextRows)
    return true
  } catch {
    return false
  }
}

/** 关闭（用户点标签的关闭 / 会话销毁）：kill 之后从表里移除 */
export function killTerminal(id: string): boolean {
  const entry = sessions.get(id)
  if (!entry) return false
  try {
    entry.pty.kill()
  } catch {
    /* 已经退出的会话 kill 会抛，忽略即可 */
  }
  sessions.delete(id)
  return true
}

export function listTerminals(): TerminalSnapshot[] {
  return [...sessions.values()].map(snapshotOf)
}

export function readTerminal(id: string): TerminalSnapshot | null {
  const entry = sessions.get(id)
  return entry ? snapshotOf(entry) : null
}

/** 渲染端订阅时，把已存在会话的缓冲回放一遍（断线重连） */
export function attachTerminal(id: string): TerminalSnapshot | null {
  const entry = sessions.get(id)
  if (!entry) return null
  emitBuffered(id)
  return snapshotOf(entry)
}

/** 退出应用 / 关闭窗口时清干净，避免留下孤儿子进程 */
export function disposeTerminals(): void {
  for (const id of [...sessions.keys()]) killTerminal(id)
}
