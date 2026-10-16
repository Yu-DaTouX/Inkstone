import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { mcpServersFile } from './mcp/config'

export const COMPUTER_USE_SERVER_ID = 'windows-mcp'

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
  supported: boolean
  uvx: string | null
  enabled: boolean
  canInstallUv: boolean
}

export interface ComputerUseResult {
  ok: boolean
  error?: string
  log?: string
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

let serverWriteQueue: Promise<unknown> = Promise.resolve()
function serializeServerWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = serverWriteQueue.then(operation, operation)
  serverWriteQueue = result.then(() => undefined, () => undefined)
  return result
}

const isOurs = (item: unknown): boolean => !!item && typeof item === 'object' && (item as { id?: unknown }).id === COMPUTER_USE_SERVER_ID

export async function computerUseStatus(): Promise<ComputerUseStatus> {
  const supported = process.platform === 'win32'
  let enabled = false
  try {
    enabled = (await readRawServers()).list.some((item) => isOurs(item) && (item as { enabled?: unknown }).enabled !== false)
  } catch {
  }
  return { supported, uvx: supported ? findUvx() : null, enabled, canInstallUv: supported && !!findOnPath('winget') }
}

function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    killer.on('error', () => child.kill('SIGKILL'))
    return
  }
  child.kill('SIGKILL')
}

function run(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; log: string }> {
  return new Promise((resolve) => {
    let log = ''
    const decoder = new StringDecoder('utf8')
    const keep = (c: Buffer): void => {
      log = (log + decoder.write(c)).slice(-8000)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { windowsHide: true, env: { ...process.env, ANONYMIZED_TELEMETRY: 'false' } })
    } catch (e) {
      resolve({ code: null, log: e instanceof Error ? e.message : String(e) })
      return
    }
    const timer = setTimeout(() => killProcessTree(child), timeoutMs)
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: null, log: `${log}\n${e.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      log = (log + decoder.end()).slice(-8000)
      resolve({ code, log })
    })
  })
}

const tail = (log: string): string => log.trim().split('\n').slice(-12).join('\n')

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

export async function enableComputerUse(): Promise<ComputerUseResult> {
  if (process.platform !== 'win32') return { ok: false, error: '电脑操作目前只支持 Windows' }
  const uvx = findUvx()
  if (!uvx) return { ok: false, error: '还没有安装 uv' }
  const warm = await run(uvx, ['--python', '3.13', 'windows-mcp', '--help'], 10 * 60_000)
  if (warm.code !== 0) return { ok: false, error: `下载或启动 windows-mcp 失败（退出码 ${warm.code ?? '?'}）`, log: tail(warm.log) }
  try {
    await serializeServerWrite(async () => {
      const { shape, list, raw } = await readRawServers()
      await writeServers(shape, raw, [...list.filter((item) => !isOurs(item)), serverEntry(uvx)])
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function disableComputerUse(): Promise<ComputerUseResult> {
  try {
    await serializeServerWrite(async () => {
      const { shape, list, raw } = await readRawServers()
      await writeServers(shape, raw, list.filter((item) => !isOurs(item)))
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
