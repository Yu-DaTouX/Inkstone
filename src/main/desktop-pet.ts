import { execFile, fork, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PiRpc } from './protocol'
import { PI_AGENT_DIR, YAN_DIR } from './paths'
import { findExecutableOnPath } from './executable-path'
import { getSettings } from './settings'
import { createPetEventTranslator } from './desktop-pet-events'
import {
  cancelDesktopPetEdgeFix,
  cancelDesktopPetEdgeFixSync,
  desktopPetEdgeStatus,
  startDesktopPetEdgeFix
} from './desktop-pet-edges'
import {
  DESKTOP_PET_PACKAGE,
  DESKTOP_PET_VERSION,
  type DesktopPetResult,
  type DesktopPetStatus
} from '../shared/desktop-pet'
import type { RunSnapshot } from '../shared/runs'

const ROOT = join(YAN_DIR, 'plugins', 'desktop-pet')
const HOME = join(ROOT, 'home')
const PACKAGE_DIR = join(ROOT, 'node_modules', DESKTOP_PET_PACKAGE)
const ENTRY = join(PACKAGE_DIR, 'lib', 'index.js')
const STATE_FILE = join(YAN_DIR, 'desktop-pet.json')
const LOG_LIMIT = 200
const START_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 6_000
const INSTALL_TIMEOUT_MS = 5 * 60_000
const REPLY_TIMEOUT_MS = 60_000

interface PetState {
  autoStart: boolean
  model: string | null
}

interface RunnerMessage {
  type?: string
  id?: number
  port?: number
  message?: string
  system?: string
  messages?: Array<{ role?: string; text?: string }>
}

export interface DesktopPetDeps {
  runnerPath(): string | undefined
  showMainWindow(): void
}

let deps: DesktopPetDeps | null = null
let runner: ChildProcess | null = null
let installing = false
const log: string[] = []
const translator = createPetEventTranslator()
const replies = new Map<number, PiRpc>()

export function configureDesktopPet(next: DesktopPetDeps): void {
  deps = next
}

function logLine(text: string): void {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimEnd()
    if (!trimmed) continue
    log.push(trimmed)
  }
  if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT)
}

async function readState(): Promise<PetState> {
  try {
    const raw = JSON.parse(await readFile(STATE_FILE, 'utf8')) as Partial<PetState>
    return {
      autoStart: raw.autoStart === true,
      model: typeof raw.model === 'string' && raw.model.includes('/') ? raw.model : null
    }
  } catch {
    return { autoStart: false, model: null }
  }
}

async function writeState(next: PetState): Promise<void> {
  await mkdir(YAN_DIR, { recursive: true })
  await writeFile(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
}

function installedVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
}

function alive(child: ChildProcess | null): child is ChildProcess {
  return !!child && child.exitCode === null && child.signalCode === null
}

function killTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return Promise.resolve()
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {
        if (alive(child)) {
          try {
            child.kill()
          } catch {
          }
        }
        resolve()
      })
    })
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    try {
      child.kill()
    } catch {
    }
  }
  return Promise.resolve()
}

const PET_ENV_KEYS = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'windir',
  'ComSpec',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'LANG',
  'LC_ALL'
] as const

export function desktopPetEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of PET_ENV_KEYS) {
    const value = source[key]
    if (typeof value === 'string' && value) env[key] = value
  }
  return env
}

export async function desktopPetStatus(): Promise<DesktopPetStatus> {
  const state = await readState()
  const version = installedVersion()
  return {
    installed: !!version && existsSync(ENTRY),
    version,
    running: alive(runner),
    autoStart: state.autoStart,
    model: state.model,
    installDir: ROOT,
    edges: desktopPetEdgeStatus(),
    log: log.slice(-40)
  }
}

async function result(ok: boolean, error?: string): Promise<DesktopPetResult> {
  return { ok, status: await desktopPetStatus(), ...(error ? { error } : {}) }
}

function transcript(messages: Array<{ role?: string; text?: string }>): string {
  const turns = messages.filter((message) => typeof message.text === 'string' && message.text.trim())
  const last = turns.pop()
  if (!last) return ''
  if (!turns.length) return String(last.text)
  const history = turns.map((message) => `${message.role === 'assistant' ? '你' : '主人'}：${message.text}`).join('\n')
  return `之前的对话：\n${history}\n\n主人现在说：\n${last.text}`
}

async function generateReply(id: number, model: string, system: string, prompt: string): Promise<string> {
  const settings = await getSettings()
  const rpc = new PiRpc({
    cwd: YAN_DIR,
    piBin: settings.piBin,
    args: [
      '--no-session',
      '--no-extensions',
      '--no-context-files',
      '--no-skills',
      '--no-prompt-templates',
      '--no-tools',
      '--model',
      model,
      ...(system ? ['--system-prompt', system] : [])
    ],
    env: { PI_CODING_AGENT_DIR: PI_AGENT_DIR, YAN_DATA_DIR: YAN_DIR }
  })
  replies.set(id, rpc)
  let text = ''
  let failure = ''
  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('桌宠回复超时')), REPLY_TIMEOUT_MS)
      const finish = (): void => {
        clearTimeout(timer)
        const reply = text.trim()
        if (reply) resolve(reply)
        else reject(new Error(failure || '模型未返回文本'))
      }
      rpc.on('event', (event: Record<string, unknown>) => {
        const type = String(event.type ?? '')
        if (type === 'message_update') {
          const update = event.assistantMessageEvent as Record<string, unknown> | undefined
          if (update?.type === 'text_delta') text += String(update.delta ?? '')
        } else if (type === 'message_end') {
          const message = event.message as { errorMessage?: unknown } | undefined
          if (typeof message?.errorMessage === 'string') failure = message.errorMessage
        } else if (type === 'agent_settled') {
          finish()
        }
      })
      rpc.on('exit', () => finish())
      rpc.spawn()
      void (async () => {
        for (let attempt = 0; attempt < 40; attempt++) {
          await new Promise((wait) => setTimeout(wait, 250))
          try {
            if ((await rpc.command('get_state')).success) break
          } catch {
          }
        }
        try {
          await rpc.command('set_thinking_level', { level: 'off' })
          await rpc.command('prompt', { message: prompt })
        } catch (error) {
          clearTimeout(timer)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })()
    })
  } finally {
    replies.delete(id)
    void rpc.close()
  }
}

async function answerReply(child: ChildProcess, message: RunnerMessage): Promise<void> {
  const id = Number(message.id)
  const send = (payload: { text?: string; error?: string }): void => {
    if (alive(child) && child.connected) child.send({ type: 'llm-result', id, ...payload })
  }
  const state = await readState()
  if (!state.model) {
    send({ error: '桌宠模型未在 Inkstone 中开启' })
    return
  }
  const prompt = transcript(Array.isArray(message.messages) ? message.messages : [])
  if (!prompt) {
    send({ error: '没有可发送的内容' })
    return
  }
  try {
    send({ text: await generateReply(id, state.model, String(message.system ?? ''), prompt) })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logLine(`[inkstone] 桌宠回复失败：${reason}`)
    send({ error: reason })
  }
}

function modelMessage(model: string | null): { type: 'model'; enabled: boolean; label: string } {
  return { type: 'model', enabled: !!model, label: model ?? '' }
}

async function launch(): Promise<DesktopPetResult> {
  if (alive(runner)) return result(true)
  if (!existsSync(ENTRY)) return result(false, '桌宠尚未安装')
  const runnerPath = deps?.runnerPath()
  if (!runnerPath) return result(false, '找不到桌宠宿主脚本（resources/desktop-pet/runner.mjs）')
  const state = await readState()
  await mkdir(HOME, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...desktopPetEnv(process.env),
    ELECTRON_RUN_AS_NODE: '1',
    YAN_PET_ENTRY: ENTRY,
    DSH_HOME: HOME,
    YAN_PET_MODEL: state.model ? '1' : '0',
    YAN_PET_MODEL_LABEL: state.model ?? ''
  }
  const child = fork(runnerPath, [], {
    execPath: process.execPath,
    cwd: YAN_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  runner = child
  translator.reset()
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => logLine(chunk))
  child.stderr?.on('data', (chunk: string) => logLine(chunk))
  child.on('message', (raw: unknown) => {
    const message = (raw && typeof raw === 'object' ? raw : {}) as RunnerMessage
    if (message.type === 'llm') {
      void answerReply(child, message).catch((error) => logLine(`[inkstone] 桌宠回复失败：${error instanceof Error ? error.message : String(error)}`))
    } else if (message.type === 'llm-cancel') {
      const rpc = replies.get(Number(message.id))
      if (rpc) void rpc.close()
    } else if (message.type === 'open-app') deps?.showMainWindow()
  })
  child.on('exit', (code) => {
    logLine(`[inkstone] 桌宠宿主已退出（code=${code ?? 'null'}）`)
    if (runner === child) runner = null
  })
  return new Promise<DesktopPetResult>((resolve) => {
    let settled = false
    const settle = (ok: boolean, error?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('message', onMessage)
      child.off('exit', onExit)
      if (!ok && alive(child)) void killTree(child)
      void result(ok, error).then(resolve)
    }
    const onMessage = (raw: unknown): void => {
      const message = (raw && typeof raw === 'object' ? raw : {}) as RunnerMessage
      if (message.type === 'ready') settle(true)
      else if (message.type === 'failed') settle(false, message.message || '桌宠启动失败')
    }
    const onExit = (code: number | null): void => settle(false, `桌宠宿主启动后立即退出（code=${code ?? 'null'}），详情见日志`)
    const timer = setTimeout(() => settle(false, '桌宠启动超时'), START_TIMEOUT_MS)
    child.on('message', onMessage)
    child.on('exit', onExit)
  })
}

function refineEdges(): void {
  const version = installedVersion()
  if (!version) return
  startDesktopPetEdgeFix({
    ffmpeg: findExecutableOnPath('ffmpeg'),
    version,
    sourceDir: join(PACKAGE_DIR, 'assets', 'webm'),
    targetDir: join(HOME, 'dsh-pet', 'main-animation', 'webm'),
    workDir: join(ROOT, 'edge-work'),
    log: logLine
  })
}

export async function startDesktopPet(): Promise<DesktopPetResult> {
  try {
    const started = await launch()
    if (started.ok) {
      refineEdges()
      return result(true)
    }
    return started
  } catch (error) {
    return result(false, error instanceof Error ? error.message : String(error))
  }
}

export async function stopDesktopPet(): Promise<DesktopPetResult> {
  const child = runner
  if (!alive(child)) return result(true)
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      void killTree(child).then(resolve)
    }, STOP_TIMEOUT_MS)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    try {
      child.send({ type: 'stop' })
    } catch {
      clearTimeout(timer)
      void killTree(child).then(resolve)
    }
  })
  runner = null
  return result(true)
}

export function stopDesktopPetSync(): void {
  cancelDesktopPetEdgeFixSync()
  const child = runner
  runner = null
  for (const rpc of replies.values()) void rpc.close()
  replies.clear()
  if (alive(child)) void killTree(child)
}

function runNpmInstall(npm: string): Promise<{ ok: boolean; output: string }> {
  const args = [
    'install',
    `${DESKTOP_PET_PACKAGE}@${DESKTOP_PET_VERSION}`,
    '--save-exact',
    '--legacy-peer-deps',
    '--ignore-scripts',
    '--omit=dev',
    '--no-audit',
    '--no-fund'
  ]
  const isCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(npm)
  return new Promise((resolve) => {
    let output = ''
    const keep = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf8')).slice(-8000)
    }
    let child: ChildProcess
    try {
      child = isCmd
        ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${npm}" ${args.join(' ')}"`], { cwd: ROOT, windowsHide: true, windowsVerbatimArguments: true })
        : spawn(npm, args, { cwd: ROOT, windowsHide: true })
    } catch (error) {
      resolve({ ok: false, output: error instanceof Error ? error.message : String(error) })
      return
    }
    const timer = setTimeout(() => {
      void killTree(child)
      output += '\n安装超时'
    }, INSTALL_TIMEOUT_MS)
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, output: `${output}\n${error.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, output })
    })
  })
}

export async function installDesktopPet(): Promise<DesktopPetResult> {
  if (installing) return result(false, '正在安装，请稍候')
  const npm = findExecutableOnPath('npm')
  if (!npm) return result(false, '没有找到 npm，需要先安装 Node.js 22.12 或更新版本')
  installing = true
  const wasRunning = alive(runner)
  try {
    if (wasRunning) await stopDesktopPet()
    await mkdir(ROOT, { recursive: true })
    const manifest = join(ROOT, 'package.json')
    if (!existsSync(manifest)) await writeFile(manifest, `${JSON.stringify({ private: true }, null, 2)}\n`, 'utf8')
    logLine(`[inkstone] npm install ${DESKTOP_PET_PACKAGE}@${DESKTOP_PET_VERSION}`)
    const installed = await runNpmInstall(npm)
    logLine(installed.output)
    if (!installed.ok || !existsSync(ENTRY)) return result(false, `安装失败：${installed.output.trim().split(/\r?\n/).slice(-3).join(' ') || 'npm 未完成'}`)
    refineEdges()
    if (wasRunning) return startDesktopPet()
    return result(true)
  } catch (error) {
    return result(false, error instanceof Error ? error.message : String(error))
  } finally {
    installing = false
  }
}

export async function uninstallDesktopPet(): Promise<DesktopPetResult> {
  await cancelDesktopPetEdgeFix()
  await stopDesktopPet()
  await rm(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  await rm(STATE_FILE, { force: true })
  log.length = 0
  return result(true)
}

export async function setDesktopPetAutoStart(enabled: boolean): Promise<DesktopPetResult> {
  const state = await readState()
  await writeState({ ...state, autoStart: enabled })
  return result(true)
}

export async function setDesktopPetModel(model: string | null): Promise<DesktopPetResult> {
  const next = typeof model === 'string' && model.includes('/') ? model : null
  const state = await readState()
  await writeState({ ...state, model: next })
  if (alive(runner) && runner.connected) runner.send(modelMessage(next))
  return result(true)
}

export function feedDesktopPetRuns(payload: { upsert: RunSnapshot[]; remove: string[] }): void {
  const child = runner
  if (!alive(child) || !child.connected) return
  for (const item of translator.translate(payload)) {
    try {
      child.send({ type: 'event', session: item.session, event: item.event })
    } catch {
      return
    }
  }
}

export async function autoStartDesktopPet(): Promise<void> {
  const state = await readState()
  if (!state.autoStart || !existsSync(ENTRY)) return
  const started = await startDesktopPet()
  if (!started.ok) logLine(`[inkstone] 桌宠自启失败：${started.error ?? ''}`)
}
