/**
 * 用随包 pi 的 `pi mcp list --json` 校验刚导入的一条原生 MCP 服务。
 *
 * 安全边界：pi 的 `mcp list` 没有按名字过滤的参数，会连接配置里的所有服务，所以校验
 * 必须在临时 `PI_CODING_AGENT_DIR` + 临时 cwd 里跑，只写本次这一条，不复制真实凭证、
 * 其它服务或扩展。从目标文件读到的内容必须先与 commit 给出的 SHA256 指纹一致，再在
 * 同一份文本里取这一条；不符就不 spawn。隔离运行不代表真实项目信任：项目范围服务还要
 * 经既有 trust API 确认，未确认即判未通过。
 *
 * 输出严格解析：只有 `{ servers: [...] }` 里恰好这一条、非空 errors 为空、名字一致、
 * `state === 'connected'`、tools 是字符串数组、退出码 0 才算通过；needs-auth 明确
 * 提示重新登录；其余状态、额外服务、重复名字、坏形状与超时都算未通过。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { resolvePi } from '../protocol'
import { nativeMcpTextFingerprint } from './native-import'
import type { NativeMcpImportVerifyInput, NativeMcpImportVerifyResult } from '../../shared/mcp-native-import'

export interface NativeMcpVerifyOptions {
  /** 与 runner 相同的 pi 覆盖（设置项 `piBin`）；缺省走 resolvePi 的默认解析。 */
  piBin?: string
  /** 受信的项目 / runner 工作目录：全局 stdio 服务相对命令的落点。 */
  runnerCwd: string
  /** 项目范围内的目标目录是否被 pi 信任（复用既有 trust API）。 */
  isProjectTrusted?: (cwd: string) => Promise<boolean>
  /** 单次 CLI 校验超时；超时杀本次子进程树。 */
  timeoutMs?: number
}

interface ReadEntryResult {
  ok: boolean
  server?: Record<string, unknown>
  reason?: string
}

/** 从刚写入的目标文件里读出这一条服务：一次读取、先核对指纹、再从同一文本取单条。 */
async function readServerEntry(
  targetPath: string,
  nativeName: string,
  expectedFingerprint: string
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
  /*
   * 先核对指纹：commit 写入后、校验前若文件被外部改过，这条内容就不是用户确认的那一条，
   * 绝不能拿它去 spawn。核对与后面的解析用的是**同一次读到的文本**。
   */
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
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, reason: `pi 原生配置里找不到服务「${nativeName}」` }
  }
  return { ok: true, server: { ...(entry as Record<string, unknown>) } }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 尽力杀掉本次子进程树。
 *
 * Windows 用 `taskkill /T /F`；它启动失败或退出码非零时再直接 `child.kill('SIGKILL')`，
 * 不把失败当成功。POSIX 目前只杀直接子进程，没有验证过整棵进程树，也不据此声称已跨平台验收。
 */
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
        /* 杀不掉不改变超时结果，超时由外层宽限兜底 */
      }
      return
    }
    killer.on('error', () => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 同上 */
      }
    })
    killer.on('close', (code) => {
      if (code !== 0) {
        try {
          child.kill('SIGKILL')
        } catch {
          /* 同上 */
        }
      }
    })
    return
  }
  try {
    child.kill('SIGKILL')
  } catch {
    /* 杀不掉不改变超时结果 */
  }
}

interface CliOutcome {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/**
 * 跑一次 `pi mcp list --json`：参数数组、不经 shell；超时尽力杀本次子进程树。
 * 环境用继承 + 覆盖 `PI_CODING_AGENT_DIR`，指向临时目录，避免读真实凭证与配置。
 *
 * 超时后不再无限等 `close`：杀树或子进程失败、孙进程攥着 stderr 不放都可能让 close
 * 永不到来，这里关掉自己这一端的读取并给有限宽限，到点就按超时结算（不声称清理已确认）。
 */
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
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: opts.agentDir,
          PI_OFFLINE: '1',
          ELECTRON_RUN_AS_NODE: '1'
        },
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
        /* 杀失败不吞掉超时结果 */
      }
      /* 关掉自己这一端的读取；即使对方还攥着写端，也不再无限等 close。 */
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

/** 严格解析 CLI 输出；任何不确定、额外服务、重复名字、坏形状都判未通过。 */
export function parseNativeMcpListOutput(
  outcome: CliOutcome,
  nativeName: string
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
  /* pi 的 list 会带 `errors`（加载配置的错误）；非空就说明这份隔离配置没能干净加载。 */
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
  if (matched.length === 0) {
    return { ok: false, detail: `pi mcp list 未返回服务「${nativeName}」（配置可能未被加载）` }
  }
  if (matched.length > 1) {
    return { ok: false, detail: `pi mcp list 返回了重复的服务名「${nativeName}」，无法确认校验对象` }
  }
  /*
   * 隔离运行只写了一条服务，正常应只返回这一条。出现别的名字说明加载了额外条目
   *（诱饵配置或扩展注册的服务），这条校验就不能代表只验证了本次导入，判未通过。
   */
  if (entries.length !== 1) {
    const others = entries.filter((entry) => entry.name !== nativeName).map((entry) => String(entry.name))
    return { ok: false, detail: `pi mcp list 返回了本次导入之外的服务（${others.join('、') || '未命名'}），隔离校验不成立` }
  }
  const entry = matched[0]
  const state = typeof entry.state === 'string' ? entry.state : undefined
  if (!state) {
    return { ok: false, detail: `服务「${nativeName}」的 state 不是字符串，拒绝猜测` }
  }
  /* tools 按真实 pi list 形状核对：必须是字符串数组，不能把坏形状当成 0 个工具。 */
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

/** 构造注入 `NativeMcpImportHost.verify` 的校验回调。 */
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
      /*
       * stdio 的相对命令必须相对真实项目 / runner 目录解析；隔离 cwd 只用于 CLI，
       * 不能把服务进程也拽进临时目录。HTTP 无凭证可补，原样校验。
       */
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

      /* 项目范围的目标要真正生效，还得 pi 信任该项目目录；隔离运行不能替代这一步。 */
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
