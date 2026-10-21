import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { resolvePi } from '../protocol'
import { nativeMcpTextFingerprint } from './native-import'
import type { NativeMcpImportVerifyInput, NativeMcpImportVerifyResult } from '../../shared/mcp-native-import'
import type { McpAppSwitchVerifyInput, McpAppSwitchVerifyResult } from '../../shared/mcp-app-switch'

export type NativeMcpPresence = 'present' | 'absent'

export interface NativeMcpVerifyOptions {
  piBin?: string
  runnerCwd: string
  isProjectTrusted?: (cwd: string) => Promise<boolean>
  timeoutMs?: number
}

interface ReadEntryResult {
  ok: boolean
  server?: Record<string, unknown>
  reason?: string
}

async function readServerEntry(
  targetPath: string,
  nativeName: string,
  expectedFingerprint: string,
  expect: NativeMcpPresence = 'present'
): Promise<ReadEntryResult> {
  if (typeof expectedFingerprint !== 'string' || !expectedFingerprint) {
    return { ok: false, reason: '缺少本次已确认写入内容的指纹，拒绝校验可能未被确认的条目' }
  }
  let text: string
  try {
    text = await readFile(targetPath, 'utf8')
  } catch (error) {
    return { ok: false, reason: `无法读取 pi 原生配置 ${targetPath}：${messageOf(error)}` }
  }
  if (nativeMcpTextFingerprint(text) !== expectedFingerprint) {
    return { ok: false, reason: '目标文件与本次已确认写入的内容不一致（可能被外部改动），拒绝执行未确认条目' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, reason: `pi 原生配置不是合法 JSON：${messageOf(error)}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'pi 原生配置顶层不是对象' }
  }
  const servers = (parsed as Record<string, unknown>).mcpServers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    return { ok: false, reason: 'pi 原生配置里的 mcpServers 不是对象' }
  }
  const entry = (servers as Record<string, unknown>)[nativeName]
  if (expect === 'absent') {
    if (Object.prototype.hasOwnProperty.call(servers, nativeName)) {
      return { ok: false, reason: `pi 原生配置里仍有服务「${nativeName}」，期望已被移出` }
    }
    return { ok: true }
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, reason: `pi 原生配置里找不到服务「${nativeName}」` }
  }
  return { ok: true, server: { ...(entry as Record<string, unknown>) } }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function killProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return
  if (process.platform === 'win32') {
    let killer: ChildProcess | undefined
    try {
      killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
      }
      return
    }
    killer.on('error', () => {
      try {
        child.kill('SIGKILL')
      } catch {
      }
    })
    killer.on('close', (code) => {
      if (code !== 0) {
        try {
          child.kill('SIGKILL')
        } catch {
        }
      }
    })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
    return
  } catch {
  }
  try {
    child.kill('SIGKILL')
  } catch {
  }
}

const PI_CHILD_ENV_KEYS = [
  'PATH',
  'Path',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'TEMP',
  'TMP',
  'TMPDIR',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'HOME',
  'LANG',
  'LC_ALL'
] as const

function piChildEnv(source: NodeJS.ProcessEnv, overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of PI_CHILD_ENV_KEYS) {
    const value = source[key]
    if (typeof value === 'string' && value) env[key] = value
  }
  return { ...env, ...overrides }
}

interface CliOutcome {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

const RUN_PI_LIST_TIMEOUT_GRACE_MS = 1500

function runPiList(opts: {
  cmd: string
  args: string[]
  cwd: string
  agentDir: string
  timeoutMs: number
}): Promise<CliOutcome> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(opts.cmd, [...opts.args, 'mcp', 'list', '--json'], {
        cwd: opts.cwd,
        windowsHide: true,
        ...(process.platform === 'win32' ? {} : { detached: true }),
        env: piChildEnv(process.env, {
          PI_CODING_AGENT_DIR: opts.agentDir,
          PI_OFFLINE: '1',
          ELECTRON_RUN_AS_NODE: '1'
        }),
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: messageOf(error), timedOut: false })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    const decoderOut = new StringDecoder('utf8')
    const decoderErr = new StringDecoder('utf8')
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = (stdout + decoderOut.write(chunk)).slice(-512 * 1024)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + decoderErr.write(chunk)).slice(-32 * 1024)
    })
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      stdout += decoderOut.end()
      stderr += decoderErr.end()
      resolve({ code, stdout, stderr, timedOut })
    }
    const timer = setTimeout(() => {
      timedOut = true
      try {
        killProcessTree(child)
      } catch {
      }
      child.stdout?.destroy()
      child.stderr?.destroy()
      graceTimer = setTimeout(() => finish(null), RUN_PI_LIST_TIMEOUT_GRACE_MS)
    }, opts.timeoutMs)
    child.on('error', (error) => {
      stderr = `${stderr}${messageOf(error)}`
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}

const stderrTail = (stderr: string): string => stderr.trim().split('\n').slice(-4).join(' ').slice(0, 400)

export function parseNativeMcpListOutput(
  outcome: CliOutcome,
  nativeName: string,
  expect: NativeMcpPresence = 'present'
): NativeMcpImportVerifyResult {
  if (outcome.timedOut) {
    return { ok: false, detail: `pi mcp list 超时（${nativeName} 未能在此时间内确认连接）` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(outcome.stdout)
  } catch {
    const tail = stderrTail(outcome.stderr)
    return { ok: false, detail: `pi mcp list 输出不是合法 JSON${tail ? `；stderr：${tail}` : ''}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, detail: 'pi mcp list 输出顶层不是对象' }
  }
  const root = parsed as Record<string, unknown>
  if (root.errors !== undefined && !Array.isArray(root.errors)) {
    return { ok: false, detail: 'pi mcp list 输出的 errors 不是数组' }
  }
  if (Array.isArray(root.errors) && root.errors.length > 0) {
    return {
      ok: false,
      connected: false,
      detail: `pi mcp list 报告了配置/加载错误：${root.errors.map((item) => String(item)).join('；').slice(0, 400)}`
    }
  }
  const servers = root.servers
  if (!Array.isArray(servers)) {
    return { ok: false, detail: 'pi mcp list 输出缺少 servers 数组' }
  }
  const entries = servers.filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)
  )
  if (entries.length !== servers.length) {
    return { ok: false, detail: 'pi mcp list 输出的 servers 含非对象条目，无法确认隔离结果' }
  }
  const matched = entries.filter((entry) => entry.name === nativeName)
  if (expect === 'absent') {
    if (matched.length > 0) {
      return { ok: false, detail: `pi mcp list 仍返回服务「${nativeName}」，期望已被移出` }
    }
    if (outcome.code !== 0) {
      const tail = stderrTail(outcome.stderr)
      return { ok: false, detail: `pi mcp list 退出码为 ${outcome.code ?? '未知'}，无法确认已移出${tail ? `；stderr：${tail}` : ''}` }
    }
    return { ok: true }
  }
  if (matched.length === 0) {
    return { ok: false, detail: `pi mcp list 未返回服务「${nativeName}」（配置可能未被加载）` }
  }
  if (matched.length > 1) {
    return { ok: false, detail: `pi mcp list 返回了重复的服务名「${nativeName}」，无法确认校验对象` }
  }
  if (entries.length !== 1) {
    const others = entries.filter((entry) => entry.name !== nativeName).map((entry) => String(entry.name))
    return { ok: false, detail: `pi mcp list 返回了本次导入之外的服务（${others.join('、') || '未命名'}），隔离校验不成立` }
  }
  const entry = matched[0]
  const state = typeof entry.state === 'string' ? entry.state : undefined
  if (!state) {
    return { ok: false, detail: `服务「${nativeName}」的 state 不是字符串，拒绝猜测` }
  }
  if (!Array.isArray(entry.tools) || entry.tools.some((tool) => typeof tool !== 'string')) {
    return { ok: false, connected: false, detail: `服务「${nativeName}」的 tools 不是字符串数组，拒绝按 0 工具通过` }
  }
  const tools = entry.tools as string[]
  const errorText = typeof entry.error === 'string' && entry.error.trim() ? entry.error.trim() : undefined
  if (state === 'needs-auth') {
    return {
      ok: false,
      connected: false,
      detail: `服务「${nativeName}」需要重新登录（import 不迁移 authRef 凭证），请在 pi 里执行 pi mcp login ${nativeName}`
    }
  }
  if (state !== 'connected') {
    return {
      ok: false,
      connected: false,
      detail: `服务「${nativeName}」状态为 ${state}${errorText ? `：${errorText}` : ''}`
    }
  }
  if (outcome.code !== 0) {
    const tail = stderrTail(outcome.stderr)
    return {
      ok: false,
      connected: true,
      toolCount: tools.length,
      detail: `pi mcp list 退出码为 ${outcome.code ?? '未知'}，即使显示 connected 也判为未通过${tail ? `；stderr：${tail}` : ''}`
    }
  }
  return { ok: true, connected: true, toolCount: tools.length }
}

export function createNativeMcpVerifier(
  options: NativeMcpVerifyOptions
): (input: NativeMcpImportVerifyInput) => Promise<NativeMcpImportVerifyResult> {
  return async (input: NativeMcpImportVerifyInput): Promise<NativeMcpImportVerifyResult> => {
    const entry = await readServerEntry(input.targetPath, input.nativeName, input.expectedFingerprint)
    if (!entry.ok || !entry.server) return { ok: false, detail: entry.reason ?? '无法读取原生服务条目' }

    const probe = resolvePi(options.piBin ? { override: options.piBin } : {})
    if (!probe.ok) return { ok: false, detail: probe.error ?? 'pi 可执行入口不可用' }
    const cliEntry = probe.args.at(-1)
    if (probe.source === 'shell' || !cliEntry) {
      return { ok: false, detail: '未找到可隔离运行的随包 pi 入口，无法校验（不回退 shell）' }
    }

    let root: string | undefined
    try {
      root = await mkdtemp(join(tmpdir(), 'yan-mcp-native-verify-'))
      const cwd = join(root, 'workspace')
      const agentDir = join(root, 'pi-agent')
      await Promise.all([
        mkdir(cwd, { recursive: true }),
        mkdir(agentDir, { recursive: true })
      ])
      const copy = { ...entry.server }
      const isStdio = typeof copy.command === 'string'
      if (isStdio && typeof copy.cwd !== 'string') {
        copy.cwd = input.scope === 'project' && input.projectCwd ? input.projectCwd : options.runnerCwd
      }
      await writeFile(
        join(agentDir, 'mcp.json'),
        `${JSON.stringify({ mcpServers: { [input.nativeName]: copy } }, null, 2)}\n`,
        'utf8'
      )
      const outcome = await runPiList({
        cmd: probe.cmd,
        args: probe.args,
        cwd,
        agentDir,
        timeoutMs: options.timeoutMs ?? 30_000
      })
      const result = parseNativeMcpListOutput(outcome, input.nativeName)
      if (!result.ok) return result

      if (input.scope === 'project') {
        const projectCwd = input.projectCwd?.trim()
        let trusted = false
        if (projectCwd && options.isProjectTrusted) trusted = await options.isProjectTrusted(projectCwd).catch(() => false)
        if (!trusted) {
          return {
            ok: false,
            connected: true,
            ...(result.toolCount !== undefined ? { toolCount: result.toolCount } : {}),
            detail: `服务「${input.nativeName}」可连接，但项目 ${projectCwd ?? '（未登记目录）'} 尚未被 pi 信任（既有 trustAPI 未确认），.pi/mcp.json 不会实际加载；旧条目未停用`
          }
        }
      }
      return result
    } catch (error) {
      return { ok: false, detail: `隔离校验失败：${messageOf(error)}` }
    } finally {
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

export function createNativeMcpPresenceVerifier(
  options: NativeMcpVerifyOptions
): (input: McpAppSwitchVerifyInput) => Promise<McpAppSwitchVerifyResult> {
  return async (input: McpAppSwitchVerifyInput): Promise<McpAppSwitchVerifyResult> => {
    const entry = await readServerEntry(input.targetPath, input.nativeName, input.expectedFingerprint, input.expect)
    if (!entry.ok) return { ok: false, detail: entry.reason ?? '无法确认原生条目状态' }
    if (input.expect === 'absent') {
      return { ok: true, detail: `目标文件已不含服务「${input.nativeName}」（按本次写入的指纹核对）` }
    }
    if (!entry.server) return { ok: false, detail: '无法读取原生服务条目' }

    const probe = resolvePi(options.piBin ? { override: options.piBin } : {})
    if (!probe.ok) return { ok: false, detail: probe.error ?? 'pi 可执行入口不可用' }
    const cliEntry = probe.args.at(-1)
    if (probe.source === 'shell' || !cliEntry) {
      return { ok: false, detail: '未找到可隔离运行的随包 pi 入口，无法校验（不回退 shell）' }
    }

    let root: string | undefined
    try {
      root = await mkdtemp(join(tmpdir(), 'yan-mcp-presence-verify-'))
      const cwd = join(root, 'workspace')
      const agentDir = join(root, 'pi-agent')
      await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true })])
      const copy = { ...entry.server }
      if (typeof copy.command === 'string' && typeof copy.cwd !== 'string') {
        copy.cwd = input.scope === 'project' && input.projectCwd ? input.projectCwd : options.runnerCwd
      }
      await writeFile(
        join(agentDir, 'mcp.json'),
        `${JSON.stringify({ mcpServers: { [input.nativeName]: copy } }, null, 2)}\n`,
        'utf8'
      )
      const outcome = await runPiList({
        cmd: probe.cmd,
        args: probe.args,
        cwd,
        agentDir,
        timeoutMs: options.timeoutMs ?? 30_000
      })
      const result = parseNativeMcpListOutput(outcome, input.nativeName, 'present')
      if (!result.ok) return result
      if (input.scope === 'project') {
        const projectCwd = input.projectCwd?.trim()
        let trusted = false
        if (projectCwd && options.isProjectTrusted) trusted = await options.isProjectTrusted(projectCwd).catch(() => false)
        if (!trusted) {
          return {
            ok: false,
            connected: true,
            ...(result.toolCount !== undefined ? { toolCount: result.toolCount } : {}),
            detail: `服务「${input.nativeName}」可连接，但项目 ${projectCwd ?? '（未登记目录）'} 尚未被 pi 信任（trustAPI 未确认），.pi/mcp.json 不会实际加载`
          }
        }
      }
      return result
    } catch (error) {
      return { ok: false, detail: `隔离校验失败：${messageOf(error)}` }
    } finally {
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
