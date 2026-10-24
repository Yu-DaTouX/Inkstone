import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { compareVersions, defaultFetchText, type FetchText } from './fabric-meta.ts'

export interface GradleRunOptions {
  javaPath: string
  initScripts?: string[]
  args?: string[]
  env?: NodeJS.ProcessEnv
  onLine?: (line: string) => void
  signal?: AbortSignal
  offline?: boolean
}

export interface GradleRunResult {
  ok: boolean
  code: number | null
  durationMs: number
  output: string
}

export interface LocalGradle {
  version: string
  home: string
}

export const WRAPPER_FILES = ['gradlew', 'gradlew.bat', 'gradle/wrapper/gradle-wrapper.jar', 'gradle/wrapper/gradle-wrapper.properties']
const OUTPUT_LIMIT = 400_000

export function gradleUserHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.GRADLE_USER_HOME || join(homedir(), '.gradle')
}

export function javaHomeOf(javaPath: string): string {
  return dirname(dirname(javaPath))
}

export async function findLocalGradles(userHome = gradleUserHome()): Promise<LocalGradle[]> {
  const dists = join(userHome, 'wrapper', 'dists')
  const found: LocalGradle[] = []
  let names: string[] = []
  try {
    names = await readdir(dists)
  } catch {
    return found
  }
  for (const name of names) {
    const match = name.match(/^gradle-(.+)-(bin|all)$/)
    if (!match) continue
    let hashes: string[] = []
    try {
      hashes = await readdir(join(dists, name))
    } catch {
      continue
    }
    for (const hash of hashes) {
      const home = join(dists, name, hash, `gradle-${match[1]}`)
      if (existsSync(join(home, 'lib')) && existsSync(join(dists, name, hash, `gradle-${match[1]}-${match[2]}.zip.ok`))) {
        found.push({ version: match[1], home })
        break
      }
    }
  }
  return found.sort((a, b) => compareVersions(b.version, a.version))
}

export function wrapperCommand(projectDir: string, javaPath: string, args: string[]): { command: string; args: string[] } {
  const jar = join(projectDir, 'gradle', 'wrapper', 'gradle-wrapper.jar')
  return {
    command: javaPath,
    args: ['-Xmx64m', '-Xms64m', '-Dorg.gradle.appname=gradlew', '-classpath', jar, 'org.gradle.wrapper.GradleWrapperMain', ...args]
  }
}

function runProcess(command: string, args: string[], cwd: string, options: { env?: NodeJS.ProcessEnv; onLine?: (line: string) => void; signal?: AbortSignal }): Promise<GradleRunResult> {
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: options.env ?? process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let pending = ''
    const take = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      output += text
      if (output.length > OUTPUT_LIMIT) output = output.slice(-OUTPUT_LIMIT)
      if (!options.onLine) return
      pending += text
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) options.onLine(line)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    const abort = () => child.kill()
    options.signal?.addEventListener('abort', abort, { once: true })
    child.on('error', (error) => {
      options.signal?.removeEventListener('abort', abort)
      resolve({ ok: false, code: null, durationMs: Date.now() - started, output: `${output}\n${error.message}` })
    })
    child.on('close', (code) => {
      options.signal?.removeEventListener('abort', abort)
      if (pending && options.onLine) options.onLine(pending)
      resolve({ ok: code === 0, code, durationMs: Date.now() - started, output })
    })
  })
}

export function gradleEnv(javaPath: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, JAVA_HOME: javaHomeOf(javaPath) }
  delete env.ELECTRON_RUN_AS_NODE
  delete env._JAVA_OPTIONS
  return env
}

export function runGradle(projectDir: string, tasks: string[], options: GradleRunOptions): Promise<GradleRunResult> {
  const args = ['--console=plain']
  for (const script of options.initScripts ?? []) args.push('--init-script', script)
  if (options.offline) args.push('--offline')
  args.push(...(options.args ?? []), ...tasks)
  const command = wrapperCommand(projectDir, options.javaPath, args)
  return runProcess(command.command, command.args, projectDir, { env: gradleEnv(options.javaPath, options.env), onLine: options.onLine, signal: options.signal })
}

export function cleanGradleOutput(output: string): string {
  return output
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => !/^WARNING: (A restricted method|java\.lang\.System::load|Use --enable-native-access|Restricted methods will be blocked)/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function parseGradleErrors(output: string): string[] {
  const errors: string[] = []
  const lines = output.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (/^\S.*\.(java|kt):\d+: (error|错误)/.test(line) || /^e: /.test(line)) {
      errors.push([line, lines[index + 1], lines[index + 2]].filter((part) => part !== undefined && part.trim() !== '').join('\n'))
    }
  }
  const failure = output.indexOf('FAILURE:')
  if (failure >= 0) {
    const tail = output.slice(failure).split(/\r?\n/)
    const end = tail.findIndex((line) => line.startsWith('* Try:') || line.startsWith('BUILD FAILED'))
    errors.push(tail.slice(0, end > 0 ? end : 20).join('\n').trim())
  }
  return errors
}

export async function writeWrapperFromLocal(projectDir: string, version: string, local: LocalGradle, javaPath: string): Promise<boolean> {
  const scratch = await mkdtemp(join(tmpdir(), 'inkstone-wrapper-'))
  try {
    await writeFile(join(scratch, 'settings.gradle'), "rootProject.name = 'wrapper'\n")
    const libs = await readdir(join(local.home, 'lib'))
    const cliMain = libs.find((name) => /^gradle-gradle-cli-main-.*\.jar$/.test(name))
    const legacy = libs.find((name) => /^gradle-launcher-.*\.jar$/.test(name))
    const entry = cliMain ? ['-jar', join(local.home, 'lib', cliMain)] : legacy ? ['-classpath', join(local.home, 'lib', legacy), 'org.gradle.launcher.GradleMain'] : null
    if (!entry) return false
    const result = await runProcess(javaPath, ['-Xmx128m', ...entry, '--console=plain', '--no-daemon', '-q', 'wrapper', '--gradle-version', version, '--distribution-type', 'bin'], scratch, { env: gradleEnv(javaPath) })
    if (!result.ok) return false
    for (const file of WRAPPER_FILES) {
      await mkdir(dirname(join(projectDir, file)), { recursive: true })
      await copyFile(join(scratch, file), join(projectDir, file))
    }
    return true
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function writeWrapperFromDownload(projectDir: string, version: string, fetchBytes: (url: string) => Promise<Buffer> = defaultFetchBytes, fetchText: FetchText = defaultFetchText): Promise<void> {
  const base = `https://raw.githubusercontent.com/gradle/gradle/v${version}`
  const [gradlew, gradlewBat, jar] = await Promise.all([fetchBytes(`${base}/gradlew`), fetchBytes(`${base}/gradlew.bat`), fetchBytes(`${base}/gradle/wrapper/gradle-wrapper.jar`)])
  const expected = (await fetchText(`https://services.gradle.org/distributions/gradle-${version}-wrapper.jar.sha256`)).trim()
  const actual = createHash('sha256').update(jar).digest('hex')
  if (expected !== actual) throw new Error(`gradle-wrapper.jar 校验失败（期望 ${expected}，实际 ${actual}）`)
  await mkdir(join(projectDir, 'gradle', 'wrapper'), { recursive: true })
  await writeFile(join(projectDir, 'gradlew'), gradlew, { mode: 0o755 })
  await writeFile(join(projectDir, 'gradlew.bat'), gradlewBat)
  await writeFile(join(projectDir, 'gradle', 'wrapper', 'gradle-wrapper.jar'), jar)
  await writeFile(join(projectDir, 'gradle', 'wrapper', 'gradle-wrapper.properties'), wrapperProperties(version))
}

export function wrapperProperties(version: string): string {
  return [
    'distributionBase=GRADLE_USER_HOME',
    'distributionPath=wrapper/dists',
    `distributionUrl=https\\://services.gradle.org/distributions/gradle-${version}-bin.zip`,
    'networkTimeout=10000',
    'validateDistributionUrl=true',
    'zipStoreBase=GRADLE_USER_HOME',
    'zipStorePath=wrapper/dists',
    ''
  ].join('\n')
}

async function defaultFetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { 'user-agent': 'inkstone-minecraft' } })
  if (!response.ok) throw new Error(`下载 ${url} 失败：HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

export async function ensureWrapper(projectDir: string, version: string, javaPath: string): Promise<'local-gradle' | 'download' | 'existing'> {
  if (WRAPPER_FILES.every((file) => existsSync(join(projectDir, file)))) return 'existing'
  for (const local of await findLocalGradles()) {
    if (await writeWrapperFromLocal(projectDir, version, local, javaPath)) {
      await writeFile(join(projectDir, 'gradle', 'wrapper', 'gradle-wrapper.properties'), wrapperProperties(version))
      return 'local-gradle'
    }
  }
  await writeWrapperFromDownload(projectDir, version)
  return 'download'
}
