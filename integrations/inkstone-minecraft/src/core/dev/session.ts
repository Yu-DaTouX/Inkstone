import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

export interface SourceSetSpec {
  name: string
  classesDirs: string[]
  resourcesDir: string | null
  sourceDirs: string[]
  classesTask: string
  resourcesTask: string
}

export interface LaunchSpec {
  project: string
  projectDir: string
  mainClass: string
  classpath: string[]
  jvmArgs: string[]
  args: string[]
  workingDir: string
  environment: Record<string, string>
  javaLauncher: string | null
  minecraftVersion: string | null
  gradleVersion: string | null
  sourceSets: SourceSetSpec[]
}

export interface SessionFile {
  version: 1
  pid: number | null
  startedAt: number
  javaPath: string
  jbr: boolean
  enhanced: boolean
  mixinAgent?: boolean
  jdwpPort: number
  companionPort: number | null
  token: string | null
  world: string | null
  username?: string
  logFile: string
  minecraftVersion: string | null
  owner: number
  exitCode: number | null
  stoppedAt: number | null
  message: string | null
  jbrHint: string | null
}

export function stateDir(projectDir: string): string {
  return join(projectDir, '.inkstone', 'dev')
}

export function statePaths(projectDir: string) {
  const dir = stateDir(projectDir)
  return {
    dir,
    spec: join(dir, 'launch-spec.json'),
    session: join(dir, 'session.json'),
    classes: join(dir, 'class-manifest.json'),
    resources: join(dir, 'resource-manifest.json'),
    argFile: join(dir, 'client.args'),
    logs: join(dir, 'logs'),
    sources: join(dir, 'sources')
  }
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 2))
  await rename(temp, file)
}

export function pidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const child = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      child.on('close', () => resolve())
      child.on('error', () => resolve())
      return
    }
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
      }
    }
    resolve()
  })
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

export function quoteArgFileEntry(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

export async function writeLaunchArgFile(file: string, args: string[]): Promise<void> {
  const content = argFileText(args)
  await writeFile(file, content, 'utf8')
  if (process.platform !== 'win32' || !/[^\x00-\x7f]/.test(content)) return
  const script = fileURLToPath(new URL('../../../templates/java/write-argfile.ps1', import.meta.url))
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try {
    await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      windowsHide: true,
      timeout: 15_000,
      env: { ...process.env, INKSTONE_JAVA_ARGFILE: file }
    })
  } catch (error) {
    throw new Error(`无法用 Windows 本地编码写入 Java 参数文件；请检查项目路径是否含系统代码页无法表示的字符：${error instanceof Error ? error.message : String(error)}`)
  }
}

export function splitLaunchArgs(jvmArgs: string[]): { fileArgs: string[]; commandArgs: string[] } {
  const ascii = (arg: string): boolean => /^[\x00-\x7f]*$/.test(arg)
  return { fileArgs: jvmArgs.filter(ascii), commandArgs: jvmArgs.filter((arg) => !ascii(arg)) }
}

export function argFileText(args: string[]): string {
  return args.map(quoteArgFileEntry).join('\n') + '\n'
}

export function stablePlayerArgs(args: string[], username?: string): string[] {
  const value = (name: string) => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1)
  }
  const token = value('--accessToken')
  if (token && !/^(0|dummy|DummyAccessToken|none)$/i.test(token)) {
    if (username) throw new Error('已有登录凭证时不能覆盖玩家身份；固定开发名仅用于离线客户端')
    return [...args]
  }
  const existing = value('--username')
  const name = username ?? (existing && !/^Player\d+$/.test(existing) ? existing : 'InkstoneAgent')
  if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) throw new Error('开发玩家名必须是 1–16 位英文字母、数字或下划线')
  const hash = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest()
  hash[6] = (hash[6] & 0x0f) | 0x30
  hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = hash.toString('hex')
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  const out: string[] = []
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--username' || args[index] === '--uuid') index++
    else if (!args[index].startsWith('--username=') && !args[index].startsWith('--uuid=')) out.push(args[index])
  }
  return [...out, '--username', name, '--uuid', uuid]
}

export const DEV_OPTIONS: Record<string, string> = {
  pauseOnLostFocus: 'false',
  onboardAccessibility: 'false',
  tutorialStep: 'none',
  skipMultiplayerWarning: 'true',
  joinedFirstServer: 'true',
  narrator: '0'
}

export function optionsPath(workingDir: string): string {
  return join(workingDir, 'options.txt')
}

export function parseOptions(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    values[line.slice(0, index)] = line.slice(index + 1)
  }
  return values
}

export async function readOptions(workingDir: string): Promise<Record<string, string>> {
  const file = optionsPath(workingDir)
  return parseOptions(existsSync(file) ? await readFile(file, 'utf8') : '')
}

export async function writeOptions(workingDir: string, wanted: Record<string, string>): Promise<string> {
  await mkdir(workingDir, { recursive: true })
  const file = optionsPath(workingDir)
  const existing = existsSync(file) ? await readFile(file, 'utf8') : ''
  const next = mergeOptions(existing, wanted)
  if (next !== existing) await writeFile(file, next)
  return file
}

export function mergeOptions(existing: string, wanted: Record<string, string>): string {
  const lines = existing ? existing.split(/\r?\n/).filter((line) => line !== '') : []
  const seen = new Set<string>()
  const merged = lines.map((line) => {
    const key = line.slice(0, line.indexOf(':'))
    if (key in wanted) {
      seen.add(key)
      return `${key}:${wanted[key]}`
    }
    return line
  })
  for (const [key, value] of Object.entries(wanted)) if (!seen.has(key)) merged.push(`${key}:${value}`)
  return merged.join('\n') + '\n'
}

export async function prepareRunDir(workingDir: string, overrides: Record<string, string> = {}): Promise<void> {
  await mkdir(join(workingDir, 'mods'), { recursive: true })
  await writeOptions(workingDir, { ...DEV_OPTIONS, ...overrides })
}

export function worldExists(workingDir: string, world: string): boolean {
  return existsSync(join(workingDir, 'saves', world, 'level.dat'))
}

export const AGENT_WINDOW_WIDTH = 960
export const AGENT_WINDOW_HEIGHT = 540
export const AGENT_WINDOW_TITLE_PREFIX = 'Inkstone Agent'

export function agentWindowTitle(projectDir: string): string {
  return `${AGENT_WINDOW_TITLE_PREFIX} · ${basename(projectDir) || AGENT_WINDOW_TITLE_PREFIX}`
}

export function agentWindowJvmArgs(projectDir: string): string[] {
  return [`-Dinkstone.window.title=${agentWindowTitle(projectDir)}`, '-Dinkstone.window.placement=corner', '-Dinkstone.control=agent', '-Dinkstone.input=background']
}

export function withWindowSize(args: string[]): string[] {
  const kept: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--width' || arg === '--height') {
      if (args[index + 1] !== undefined && !args[index + 1].startsWith('--')) index += 1
      continue
    }
    if (arg.startsWith('--width=') || arg.startsWith('--height=')) continue
    kept.push(arg)
  }
  return [...kept, '--width', String(AGENT_WINDOW_WIDTH), '--height', String(AGENT_WINDOW_HEIGHT)]
}

export function stripJvmArgs(args: string[]): string[] {
  return args.filter((arg) => !arg.startsWith('-agentlib:jdwp') && !arg.startsWith('-Xmx') && !arg.startsWith('-Dinkstone.companion.') && !arg.startsWith('-Dinkstone.window.') && !arg.startsWith('-Dinkstone.control=') && arg !== '-XX:+AllowEnhancedClassRedefinition' && !(arg.startsWith('-javaagent:') && arg.includes('sponge-mixin')))
}

export function findMixinAgent(classpath: string[]): string | null {
  return classpath.find((entry) => /^sponge-mixin-.+.jar$/.test(basename(entry))) ?? null
}
