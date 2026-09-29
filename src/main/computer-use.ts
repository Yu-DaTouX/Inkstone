/**
 * 电脑操作（Computer use）：让模型通过 Windows 的界面自动化接口看窗口、点按钮、打字。
 *
 * ── 为什么不内置 ──
 * 实现用开源的 Windows-MCP（MIT，https://github.com/cursortouch/windows-mcp），它是 Python 包。
 * 砚只带 Node，不为它打包一套 Python：用户在设置页点「安装 uv」后，由 uv 按需下载
 * Python 3.13 与 windows-mcp（`uvx`），装在用户自己的 uv 缓存里，砚不分发这些文件。
 *
 * ── 只开放界面操作 ──
 * Windows-MCP 还带 PowerShell、注册表、文件、进程等工具，和 pi 自带的命令行/文件工具重复，
 * 且会绕开砚的确认流程。这里用它自带的 `--tools` 白名单只开放看屏幕与操作界面的工具。
 *
 * ── 登记方式 ──
 * 写进宿主的 MCP 配置（`mcp-servers.json`，模型不能改），命令用 uvx 的绝对路径，
 * 这样刚装完 uv、本进程 PATH 还没刷新时也能启动。关闭 = 删掉这一条。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { mcpServersFile } from './mcp/config'

export const COMPUTER_USE_SERVER_ID = 'windows-mcp'

/** 只开放「看」与「操作界面」的工具（大小写与 Windows-MCP 一致） */
export const COMPUTER_USE_TOOLS = [
  'Snapshot',
  'Screenshot',
  'DisplayInventory',
  'Click',
  'Type',
  'Scroll',
  'Move',
  'Shortcut',
  'Wait',
  'WaitFor',
  'App',
  'MultiSelect',
  'MultiEdit'
] as const

export interface ComputerUseStatus {
  /** 只有 Windows 能用 */
  supported: boolean
  /** uvx 的位置；null = 还没装 uv */
  uvx: string | null
  enabled: boolean
  /** 能用 winget 一键安装 uv */
  canInstallUv: boolean
}

export interface ComputerUseResult {
  ok: boolean
  error?: string
  /** 失败时命令输出的尾部 */
  log?: string
  /** 没有 winget：界面给出 uv 官方安装说明的链接 */
  needsManual?: boolean
}

function findOnPath(name: string, extraDirs: string[] = []): string | null {
  const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...extraDirs]
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`] : [name]
  for (const dir of dirs) {
    for (const candidate of names) {
      const p = join(dir, candidate)
      if (existsSync(p)) return p
    }
  }
  return null
}

/** uv 的常见安装位置：刚装完时本进程的 PATH 还是旧的，所以显式补上 */
function uvDirs(): string[] {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  return [join(local, 'Microsoft', 'WinGet', 'Links'), join(homedir(), '.local', 'bin'), join(homedir(), '.cargo', 'bin')]
}

export function findUvx(): string | null {
  return findOnPath('uvx', uvDirs())
}

async function readRawServers(): Promise<{ shape: 'array' | 'object'; list: unknown[]; raw: unknown }> {
  const file = mcpServersFile()
  if (!existsSync(file)) return { shape: 'array', list: [], raw: [] }
  const raw = JSON.parse(await readFile(file, 'utf8')) as unknown
  if (Array.isArray(raw)) return { shape: 'array', list: raw, raw }
  if (raw && typeof raw === 'object' && Array.isArray((raw as { servers?: unknown }).servers)) {
    return { shape: 'object', list: (raw as { servers: unknown[] }).servers, raw }
  }
  throw new Error(`MCP 配置不是数组或 { servers: [...] }：${file}`)
}

async function writeServers(shape: 'array' | 'object', raw: unknown, list: unknown[]): Promise<void> {
  const file = mcpServersFile()
  const next = shape === 'array' ? list : { ...(raw as object), servers: list }
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8')
  await rename(tmp, file)
}

const isOurs = (item: unknown): boolean => !!item && typeof item === 'object' && (item as { id?: unknown }).id === COMPUTER_USE_SERVER_ID

export async function computerUseStatus(): Promise<ComputerUseStatus> {
  const supported = process.platform === 'win32'
  let enabled = false
  try {
    enabled = (await readRawServers()).list.some((item) => isOurs(item) && (item as { enabled?: unknown }).enabled !== false)
  } catch {
    /* 配置坏了由能力页的配置警告来说，这里当作未启用 */
  }
  return { supported, uvx: supported ? findUvx() : null, enabled, canInstallUv: supported && !!findOnPath('winget') }
}

function run(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; log: string }> {
  return new Promise((resolve) => {
    let log = ''
    const keep = (c: Buffer): void => {
      log = (log + c.toString('utf8')).slice(-8000)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { windowsHide: true, env: { ...process.env, ANONYMIZED_TELEMETRY: 'false' } })
    } catch (e) {
      resolve({ code: null, log: e instanceof Error ? e.message : String(e) })
      return
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: null, log: `${log}\n${e.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, log })
    })
  })
}

const tail = (log: string): string => log.trim().split('\n').slice(-12).join('\n')

/** 用户点了「安装 uv」：走 winget（系统自带的包管理器），不下载执行远程脚本 */
export async function installUv(): Promise<ComputerUseResult> {
  const winget = findOnPath('winget')
  if (!winget) return { ok: false, needsManual: true, error: '没有找到 winget，请按 uv 官方说明安装后回来刷新' }
  const r = await run(winget, ['install', '--id', 'astral-sh.uv', '--exact', '--silent', '--accept-source-agreements', '--accept-package-agreements'], 5 * 60_000)
  if (findUvx()) return { ok: true, log: tail(r.log) }
  return { ok: false, error: `winget 没有装好 uv（退出码 ${r.code ?? '?'}）`, log: tail(r.log) }
}

function serverEntry(uvx: string): Record<string, unknown> {
  return {
    id: COMPUTER_USE_SERVER_ID,
    title: '电脑操作（Windows-MCP）',
    transport: 'stdio',
    command: uvx,
    args: ['--python', '3.13', 'windows-mcp', 'serve', '--tools', COMPUTER_USE_TOOLS.join(',')],
    env: { ANONYMIZED_TELEMETRY: 'false' },
    effect: 'external-action'
  }
}

/**
 * 开启：先让 uvx 把 Python 与 windows-mcp 下载好（首次可能要一两分钟，
 * 放在这里做，免得模型第一次调用时撞上 MCP 的 20 秒握手超时），再登记配置。
 */
export async function enableComputerUse(): Promise<ComputerUseResult> {
  if (process.platform !== 'win32') return { ok: false, error: '电脑操作目前只支持 Windows' }
  const uvx = findUvx()
  if (!uvx) return { ok: false, error: '还没有安装 uv' }
  const warm = await run(uvx, ['--python', '3.13', 'windows-mcp', '--help'], 10 * 60_000)
  if (warm.code !== 0) return { ok: false, error: `下载或启动 windows-mcp 失败（退出码 ${warm.code ?? '?'}）`, log: tail(warm.log) }
  try {
    const { shape, list, raw } = await readRawServers()
    await writeServers(shape, raw, [...list.filter((item) => !isOurs(item)), serverEntry(uvx)])
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function disableComputerUse(): Promise<ComputerUseResult> {
  try {
    const { shape, list, raw } = await readRawServers()
    await writeServers(shape, raw, list.filter((item) => !isOurs(item)))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
