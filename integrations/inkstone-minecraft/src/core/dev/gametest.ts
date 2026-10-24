import { existsSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { JavaEntry } from '../../shared/dev-api.ts'
import { detectJava, pickJava } from './java.ts'
import { javaReleaseFor } from './fabric-meta.ts'
import { cleanGradleOutput, runGradle } from './gradle.ts'

export type GameTestSide = 'server' | 'client'

export interface GameTestRunConfig {
  name: string
  task: string
  side: GameTestSide
  filterProperty: string | null
  filterKey: string | null
  filterKind: 'wildcard' | 'substring' | 'unknown'
  reportFile: string | null
  runDir: string | null
}

export interface JunitCase {
  name: string
  classname: string | null
  timeMs: number | null
  status: 'passed' | 'failed' | 'error' | 'skipped'
  message: string | null
}

export interface JunitReport {
  total: number
  passed: number
  failed: number
  errors: number
  skipped: number
  cases: JunitCase[]
}

export interface GradleTaskRecord {
  ok: boolean
  code: number | null
  durationMs: number
  output: string
}

export type GradleRunner = (projectDir: string, tasks: string[], args: string[]) => Promise<GradleTaskRecord>

export interface TestJava {
  required: number
  path: string
  majorVersion: number
  available: number[]
}

export interface GameTestOutcome {
  name: string
  task: string
  side: GameTestSide
  ok: boolean
  code: number | null
  durationMs: number
  filterArg: string | null
  filterKind: GameTestRunConfig['filterKind']
  report: string | null
  reportFresh: boolean
  tests: number
  passed: number
  failed: number
  errors: number
  skipped: number
  failures: Array<{ name: string; message: string | null }>
  summary: string[]
  outputTail: string
}

export interface GameTestResult {
  ok: boolean
  refused: boolean
  projectDir: string
  filter: string | null
  javaPath: string
  javaMajor: number
  requiredJava: number
  stoppedClient: boolean
  restartedClient: boolean
  notes: string[]
  outcomes: GameTestOutcome[]
  totals: { tests: number; passed: number; failed: number; errors: number; skipped: number }
  reports: string[]
  durationMs: number
}

export interface GameTestPlan {
  projectDir: string
  requiredJava: number
  javaPath: string | null
  javaMajor: number | null
  javaError: string | null
  runs: GameTestRunConfig[]
}

export interface GameTestOptions {
  projectDir: string
  filter?: string | null
  side?: GameTestSide | 'both'
  task?: string | null
  javaPaths?: string[]
  timeoutMs?: number
  onLog?: (line: string) => void
  runner?: GradleRunner
  client?: { running: boolean; owner: 'agent' | 'user' | null } | null
  stopClient?: () => Promise<void>
  restartClient?: () => Promise<void>
  restartAfter?: boolean
}

export const GAMETEST_TIMEOUT_MS = 900_000
export const CLIENT_BUSY_FOR_TEST = '用户正在操作开发客户端，GameTest 要先停掉它（按 F8 或开发页点「交还 Agent」后再试）'
const OUTPUT_TAIL_LINES = 40
const SKIP_DIRS = new Set(['classes', 'generated', 'tmp', 'loom-cache', 'libs', 'sources', 'resources', 'reports'])

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function parseAttrs(text: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const match of text.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attrs[match[1]] = decodeEntities(match[2])
  for (const match of text.matchAll(/([\w:.-]+)\s*=\s*'([^']*)'/g)) attrs[match[1]] ??= decodeEntities(match[2])
  return attrs
}

function tagDetail(inner: string, tag: string): string | null {
  const open = inner.match(new RegExp(`<${tag}\\b([^>]*)>`))
  if (!open) return null
  const attrs = parseAttrs(open[1])
  const body = inner.match(new RegExp(`<${tag}\\b[^>]*(?<!/)>([\\s\\S]*?)</${tag}>`))
  const text = body ? decodeEntities(body[1]).replace(/\r/g, '').trim() : ''
  const message = attrs.message !== undefined && attrs.message.trim() ? attrs.message.replace(/\r/g, '').split('\n')[0].trim() : text ? text.split('\n')[0].trim() : null
  return message
}

export function parseJunit(xml: string): JunitReport {
  const cases: JunitCase[] = []
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = parseAttrs(match[1])
    const inner = match[2] ?? ''
    const status: JunitCase['status'] = /<error\b/.test(inner) ? 'error' : /<failure\b/.test(inner) ? 'failed' : /<skipped\b/.test(inner) ? 'skipped' : 'passed'
    const time = attrs.time === undefined ? null : Number(attrs.time)
    cases.push({
      name: attrs.name ?? '',
      classname: attrs.classname ?? null,
      timeMs: time !== null && Number.isFinite(time) ? Math.round(time * 1000) : null,
      status,
      message: status === 'passed' ? null : tagDetail(inner, status === 'error' ? 'error' : status === 'skipped' ? 'skipped' : 'failure')
    })
  }
  const passed = cases.filter((item) => item.status === 'passed').length
  const failed = cases.filter((item) => item.status === 'failed').length
  const errors = cases.filter((item) => item.status === 'error').length
  const skipped = cases.filter((item) => item.status === 'skipped').length
  return { total: cases.length, passed, failed, errors, skipped, cases }
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function matchBrace(text: string, openIndex: number): number {
  let depth = 0
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function runsBody(text: string): string | null {
  const match = text.match(/\bruns\s*\{/)
  if (!match || match.index === undefined) return null
  const open = text.indexOf('{', match.index)
  const close = matchBrace(text, open)
  return open >= 0 && close > open ? text.slice(open + 1, close) : null
}

function childBlocks(body: string): Array<{ name: string; body: string }> {
  const blocks: Array<{ name: string; body: string }> = []
  let index = 0
  while (index < body.length) {
    if (body[index] !== '{') {
      index += 1
      continue
    }
    const close = matchBrace(body, index)
    if (close < 0) break
    const head = body.slice(Math.max(0, index - 200), index)
    const named = head.match(/(?:(?:register|create)\s*\(\s*["']([\w.-]+)["']\s*\)|([A-Za-z_]\w*))\s*$/)
    const name = named ? named[1] ?? named[2] : null
    if (name) blocks.push({ name, body: body.slice(index + 1, close) })
    index = close + 1
  }
  return blocks
}

function resolveBuildPath(projectDir: string, expression: string): string {
  const cleaned = expression.trim().replace(/^["']|["']$/g, '')
  const replaced = cleaned
    .replace(/\$\{[^}]*[Bb]uildDirectory[^}]*\}/g, 'build')
    .replace(/\$\{[^}]*buildDir[^}]*\}/g, 'build')
    .replace(/\$buildDir\b/g, 'build')
    .replace(/\$\{?projectDir\}?/g, '')
  return isAbsolute(replaced) ? replaced : resolve(projectDir, replaced)
}

function propertyNear(body: string, targetIndex: number | null): string | null {
  const all = [...body.matchAll(/(?:hasProperty|findProperty|property|getProperty)\s*\(\s*["']([\w.-]+)["']\s*\)/g)]
  const near = targetIndex === null ? all : all.filter((match) => (match.index ?? 0) > targetIndex - 1200 && (match.index ?? 0) < targetIndex + 400)
  const name = near[0]?.[1]
  return name && !/^(minecraft_version|loader_version|loom_version|fabric_api_version|mod_version)$/.test(name) ? name : null
}

function filterKindOf(raw: string, key: string | null): GameTestRunConfig['filterKind'] {
  if (!key) return 'unknown'
  if (/^fabric-api\.gametest\.filter$/.test(key)) return 'wildcard'
  const index = raw.indexOf(key)
  if (index < 0) return 'unknown'
  const window = raw.slice(Math.max(0, index - 600), index + 200)
  if (/子串|substring|忽略大小写|case-insensitive/i.test(window)) return 'substring'
  if (/通配符|wildcard/i.test(window)) return 'wildcard'
  return 'unknown'
}

function configFromBlock(name: string, block: string, raw: string, projectDir: string): GameTestRunConfig {
  const side: GameTestSide = /\bclient\s*\(\s*\)/.test(block) ? 'client' : 'server'
  const filterMatch = block.match(/-D([A-Za-z0-9_.-]*gametest\.filter)/)
  const filterKey = filterMatch ? filterMatch[1] : null
  const reportMatch = block.match(/-D[A-Za-z0-9_.-]*gametest\.report-file=([^\s"']+)/)
  const runDirMatch = block.match(/\brunDir\s*\(?\s*["']([^"']+)["']/)
  return {
    name,
    task: `run${name[0].toUpperCase()}${name.slice(1)}`,
    side,
    filterProperty: propertyNear(block, filterMatch && filterMatch.index !== undefined ? filterMatch.index : null),
    filterKey,
    filterKind: filterKindOf(raw, filterKey),
    reportFile: reportMatch ? resolveBuildPath(projectDir, reportMatch[1]) : null,
    runDir: runDirMatch ? resolveBuildPath(projectDir, runDirMatch[1]) : null
  }
}

export function parseGradleRuns(text: string, projectDir: string): GameTestRunConfig[] {
  const stripped = stripComments(text)
  const body = runsBody(stripped)
  if (!body) return []
  const configs: GameTestRunConfig[] = []
  for (const child of childBlocks(body)) {
    if (!/gametest/i.test(child.name) && !/gametest/i.test(child.body)) continue
    configs.push(configFromBlock(child.name, child.body, text, projectDir))
  }
  return configs
}

async function projectScripts(projectDir: string): Promise<string[]> {
  const texts: string[] = []
  for (const name of ['build.gradle', 'build.gradle.kts']) {
    try {
      texts.push(await readFile(join(projectDir, name), 'utf8'))
    } catch {
      continue
    }
  }
  return texts
}

export async function detectGameTestRuns(projectDir: string): Promise<GameTestRunConfig[]> {
  const found: GameTestRunConfig[] = []
  for (const text of await projectScripts(projectDir)) {
    for (const config of parseGradleRuns(text, projectDir)) if (!found.some((item) => item.task === config.task)) found.push(config)
  }
  return found
}

async function minecraftVersionOf(projectDir: string): Promise<string | null> {
  try {
    return (await readFile(join(projectDir, 'gradle.properties'), 'utf8')).match(/^minecraft_version\s*=\s*(\S+)/m)?.[1] ?? null
  } catch {
    return null
  }
}

function javaMajorOf(text: string): number {
  return text.startsWith('1.') ? Number(text.split('.')[1]) : Number(text)
}

export async function requiredJavaFor(projectDir: string): Promise<number> {
  const versions: number[] = []
  for (const text of await projectScripts(projectDir)) {
    for (const match of text.matchAll(/options\.release\s*=\s*(\d+)/g)) versions.push(Number(match[1]))
    for (const match of text.matchAll(/JavaVersion\.VERSION_(\d+)(?:_(\d+))?/g)) versions.push(Number(match[1]) === 1 ? Number(match[2] ?? 8) : Number(match[1]))
    for (const match of text.matchAll(/JavaLanguageVersion\.of\(\s*(\d+)\s*\)/g)) versions.push(Number(match[1]))
    for (const match of text.matchAll(/(?:targetCompatibility|sourceCompatibility)\s*=\s*(?:JavaVersion\.)?["']?(\d+(?:\.\d+)?)["']?/g)) versions.push(javaMajorOf(match[1]))
  }
  const known = versions.filter((value) => Number.isFinite(value) && value >= 8)
  if (known.length) return Math.max(...known)
  const minecraft = await minecraftVersionOf(projectDir)
  return minecraft ? javaReleaseFor(minecraft) : 21
}

export async function resolveTestJava(projectDir: string, javaPaths: string[] = []): Promise<TestJava> {
  const required = await requiredJavaFor(projectDir)
  const list: JavaEntry[] = await detectJava(javaPaths)
  const hit = pickJava(list, required)
  if (!hit) {
    const majors = list.map((java) => java.majorVersion).join('/') || '无'
    throw new Error(`没有找到 Java ${required}（项目需要 JDK ${required}，本机可用的只有 ${majors}）`)
  }
  return { required, path: hit.path, majorVersion: hit.majorVersion, available: list.map((java) => java.majorVersion) }
}

export async function planGameTests(projectDir: string, javaPaths: string[] = []): Promise<GameTestPlan> {
  const runs = await detectGameTestRuns(projectDir)
  let required = 21
  try {
    required = await requiredJavaFor(projectDir)
  } catch {
    required = 21
  }
  try {
    const java = await resolveTestJava(projectDir, javaPaths)
    return { projectDir, requiredJava: java.required, javaPath: java.path, javaMajor: java.majorVersion, javaError: null, runs }
  } catch (error) {
    return { projectDir, requiredJava: required, javaPath: null, javaMajor: null, javaError: error instanceof Error ? error.message : String(error), runs }
  }
}

async function collectJunit(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth < 0) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await collectJunit(full, depth - 1, out)
    } else if (/^junit.*\.xml$/i.test(entry.name)) {
      out.push(full)
    }
  }
}

async function reportsFor(projectDir: string, config: GameTestRunConfig, since: number): Promise<Array<{ file: string; fresh: boolean }>> {
  const seen: string[] = []
  const push = (file: string | null) => {
    if (file && existsSync(file) && !seen.includes(file)) seen.push(file)
  }
  push(config.reportFile)
  for (const root of [join(projectDir, 'build'), config.runDir, join(projectDir, 'run')]) {
    if (!root) continue
    const found: string[] = []
    await collectJunit(root, 3, found)
    for (const file of found) push(file)
  }
  const timed = await Promise.all(
    seen.map(async (file) => {
      const info = await stat(file).catch(() => null)
      return { file, at: info?.mtimeMs ?? 0 }
    })
  )
  const fresh = timed.filter((item) => item.at >= since - 2000).sort((a, b) => b.at - a.at)
  const stale = timed.filter((item) => item.at < since - 2000).sort((a, b) => b.at - a.at)
  return [...fresh, ...stale].map((item) => ({ file: item.file, fresh: item.at >= since - 2000 }))
}

function countsFromOutput(output: string): { tests: number; passed: number } | null {
  const passed = output.match(/All (\d+) required tests? passed/)
  if (passed) return { tests: Number(passed[1]), passed: Number(passed[1]) }
  const complete = output.match(/^(\d+) GAME TESTS? COMPLETE$/m)
  if (complete) return { tests: Number(complete[1]), passed: Number(complete[1]) }
  return null
}

function summaryLines(output: string): string[] {
  return cleanGradleOutput(output)
    .split('\n')
    .filter((line) => /GAME TESTS?\b|required tests? passed|Required tests? that failed|^BUILD (SUCCESSFUL|FAILED)/.test(line))
    .slice(-12)
}

function tail(text: string, lines = OUTPUT_TAIL_LINES): string {
  const parts = cleanGradleOutput(text).split('\n')
  return parts.slice(-lines).join('\n')
}

interface ExecutedRun {
  record: GradleTaskRecord
  javaPath: string
  aborted: boolean
}

function runGradleTask(projectDir: string, task: string, args: string[], javaPath: string, timeoutMs: number, onLog?: (line: string) => void): Promise<{ record: GradleTaskRecord; aborted: boolean }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return runGradle(projectDir, [task], { javaPath, args, onLine: onLog, signal: controller.signal })
    .then((result) => ({ record: { ok: result.ok, code: result.code, durationMs: result.durationMs, output: result.output }, aborted: controller.signal.aborted }))
    .finally(() => clearTimeout(timer))
}

export async function runGameTests(options: GameTestOptions): Promise<GameTestResult> {
  const started = Date.now()
  const notes: string[] = []
  const projectDir = options.projectDir
  const filter = options.filter && options.filter.trim() ? options.filter.trim() : null
  const timeoutMs = options.timeoutMs ?? GAMETEST_TIMEOUT_MS
  const result: GameTestResult = {
    ok: false,
    refused: false,
    projectDir,
    filter,
    javaPath: '',
    javaMajor: 0,
    requiredJava: 0,
    stoppedClient: false,
    restartedClient: false,
    notes,
    outcomes: [],
    totals: { tests: 0, passed: 0, failed: 0, errors: 0, skipped: 0 },
    reports: [],
    durationMs: 0
  }
  const finish = (): GameTestResult => {
    result.durationMs = Date.now() - started
    result.ok = !result.refused && result.outcomes.length > 0 && result.outcomes.every((item) => item.ok) && result.totals.tests > 0
    return result
  }

  if (options.client?.running) {
    if (options.client.owner === 'user') {
      result.refused = true
      notes.push(CLIENT_BUSY_FOR_TEST)
      return finish()
    }
    if (options.stopClient) {
      await options.stopClient()
      result.stoppedClient = true
      notes.push('开发客户端原来在运行，已先停止（GameTest 要独占 run 目录和内存）')
    }
  }

  const finishWithClient = async (value: GameTestResult): Promise<GameTestResult> => {
    if (value.stoppedClient) {
      if (options.restartAfter && options.restartClient) {
        await options.restartClient()
        value.restartedClient = true
        notes.push('测试结束，开发客户端已重新启动')
      } else {
        notes.push('测试结束，没有自动重启开发客户端；需要时用 mc_run action=start')
      }
    }
    return value
  }

  let java: TestJava
  try {
    java = await resolveTestJava(projectDir, options.javaPaths ?? [])
  } catch (error) {
    notes.push(error instanceof Error ? error.message : String(error))
    return finishWithClient(finish())
  }
  result.requiredJava = java.required
  result.javaPath = java.path
  result.javaMajor = java.majorVersion

  const all = await detectGameTestRuns(projectDir)
  const side = options.side ?? 'server'
  let runs = options.task
    ? all.filter((config) => config.task === options.task)
    : all.filter((config) => side === 'both' || config.side === side)
  if (options.task && !runs.length) {
    const guessed: GameTestSide = side === 'client' ? 'client' : 'server'
    runs = [{ name: options.task, task: options.task, side: guessed, filterProperty: null, filterKey: guessed === 'client' ? 'fabric.client.gametest.filter' : 'fabric-api.gametest.filter', filterKind: 'unknown', reportFile: null, runDir: null }]
  }
  if (!runs.length) {
    notes.push(
      all.length
        ? `项目里只有 ${all.map((config) => `${config.side === 'client' ? '客户端' : '服务端'} ${config.task}`).join('、')}，没有 side=${side} 的 GameTest；换 side 或传 task`
        : '项目没有 GameTest 运行配置（loom 里要有 runs { gametest { server() ... vmArg "-Dfabric-api.gametest" } }，客户端测试用 client() 加 -Dfabric.client.gametest）'
    )
    return finishWithClient(finish())
  }

  let javaPath = java.path
  const execute = async (task: string, args: string[]): Promise<ExecutedRun> => {
    if (options.runner) return { record: await options.runner(projectDir, [task], args), javaPath, aborted: false }
    let last: { record: GradleTaskRecord; aborted: boolean } | null = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      last = await runGradleTask(projectDir, task, args, javaPath, timeoutMs, options.onLog)
      const needed = last.record.output.match(/requires at least JVM runtime version (\d+)/)
      if (needed) {
        const better = pickJava(await detectJava(options.javaPaths ?? []), Number(needed[1]))
        if (better && better.path !== javaPath) {
          javaPath = better.path
          result.javaPath = better.path
          result.javaMajor = better.majorVersion
          continue
        }
      }
      break
    }
    return { record: last!.record, javaPath, aborted: last!.aborted }
  }

  for (const config of runs) {
    const nativeKey = config.side === 'client' ? 'fabric.client.gametest.filter' : 'fabric-api.gametest.filter'
    const filterKey = config.filterKey ?? nativeKey
    const filterArg = filter ? (config.filterProperty ? `-P${config.filterProperty}=${filter}` : `-D${filterKey}=${filter}`) : null
    if (filter && !config.filterProperty) {
      notes.push(`${config.task} 用的是 Fabric 原生 -D${filterKey}${config.filterKey ? '' : '（项目没写这行 vmArg，按原生默认键）'}，只有 build.gradle 自己转发给游戏 JVM 才生效`)
    }
    const args = ['--no-configuration-cache', ...(filterArg ? [filterArg] : [])]
    const since = Date.now()
    const executed = await execute(config.task, args)
    const output = executed.record.output
    const outcome: GameTestOutcome = {
      name: config.name,
      task: config.task,
      side: config.side,
      ok: false,
      code: executed.record.code,
      durationMs: executed.record.durationMs,
      filterArg,
      filterKind: config.filterKind,
      report: null,
      reportFresh: false,
      tests: 0,
      passed: 0,
      failed: 0,
      errors: 0,
      skipped: 0,
      failures: [],
      summary: summaryLines(output),
      outputTail: tail(output)
    }
    const reports = await reportsFor(projectDir, config, since)
    const report = reports[0] ?? null
    if (report) {
      outcome.report = report.file
      outcome.reportFresh = report.fresh
      if (!report.fresh) notes.push(`${config.task} 的报告没有在本次运行后更新，是上一次的，没有计入本次结果：${report.file}`)
    }
    if (report?.fresh) {
      try {
        const parsed = parseJunit(await readFile(report.file, 'utf8'))
        outcome.tests = parsed.total
        outcome.passed = parsed.passed
        outcome.failed = parsed.failed
        outcome.errors = parsed.errors
        outcome.skipped = parsed.skipped
        outcome.failures = parsed.cases.filter((item) => item.status === 'failed' || item.status === 'error').map((item) => ({ name: item.name, message: item.message }))
        result.reports.push(report.file)
      } catch (error) {
        notes.push(`读报告失败：${report.file}（${error instanceof Error ? error.message : String(error)}）`)
      }
    } else {
      const counts = countsFromOutput(output)
      if (counts) {
        outcome.tests = counts.tests
        outcome.passed = counts.passed
        notes.push(`${config.task} 没有找到 junit 报告，通过数取自 Gradle 输出`)
      }
    }
    if (executed.aborted) notes.push(`${config.task} 超过 ${Math.round(timeoutMs / 1000)} 秒被中止，可能残留 java 进程（先确认不是用户自己的游戏再结束）`)
    if ((executed.record.ok || /found no tests|No tests found/i.test(output)) && outcome.tests === 0 && !outcome.failed && !outcome.errors) notes.unshift(`${config.task} 一项测试都没跑：过滤器可能没匹配到（通配符要带命名空间）${snakeHint(options.filter)}`)
    outcome.ok = executed.record.ok && outcome.failed === 0 && outcome.errors === 0 && outcome.tests > 0
    result.outcomes.push(outcome)
    result.totals.tests += outcome.tests
    result.totals.passed += outcome.passed
    result.totals.failed += outcome.failed
    result.totals.errors += outcome.errors
    result.totals.skipped += outcome.skipped
  }

  return finishWithClient(finish())
}

function snakeHint(filter: string | null | undefined): string {
  if (!filter || !/[a-z][A-Z]/.test(filter)) return ''
  const snake = filter.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
  return `；测试名一般是 snake_case（方法 coinPouchUse 注册成 coin_pouch_use），可以试 ${snake}`
}

export function summarizeGameTests(result: GameTestResult): string {
  const totals = result.totals
  const lines: string[] = []
  if (result.refused) lines.push(`没有跑 GameTest：${result.notes[0] ?? CLIENT_BUSY_FOR_TEST}`)
  else if (result.ok) lines.push(`GameTest 通过：${totals.passed}/${totals.tests}`)
  else if (totals.tests > 0) lines.push(`GameTest 失败：${totals.failed + totals.errors} 项失败，通过 ${totals.passed}/${totals.tests}`)
  else lines.push(`GameTest 没有跑起来：${result.notes[0] ?? '没有执行任何测试'}`)
  if (result.requiredJava) lines.push(`JDK：${result.javaPath || '?'}（${result.javaMajor}，项目需要 ${result.requiredJava}）`)
  if (result.filter) lines.push(`过滤：${result.filter}`)
  for (const outcome of result.outcomes) {
    const side = outcome.side === 'client' ? '客户端' : '服务端'
    const verdict = outcome.ok ? '通过' : outcome.failed + outcome.errors ? '有失败' : '未通过'
    lines.push(`${side} ${outcome.task}：${outcome.passed}/${outcome.tests} ${verdict}（${(outcome.durationMs / 1000).toFixed(1)}s）${outcome.filterArg ? ` ${outcome.filterArg}` : ''}`)
    if (outcome.report) lines.push(`  报告：${outcome.report}${outcome.reportFresh ? '' : '（本次没有更新）'}`)
    for (const item of outcome.summary) lines.push(`  ${item}`)
    for (const failed of outcome.failures) lines.push(`  失败：${failed.name}${failed.message ? `：${failed.message}` : ''}`)
  }
  for (const note of result.notes) lines.push(note)
  const last = result.outcomes.at(-1)
  if (!result.ok && last?.outputTail) {
    lines.push('——Gradle 输出尾部——')
    lines.push(last.outputTail)
  }
  return lines.join('\n')
}

export function summarizeGameTestPlan(plan: GameTestPlan, client?: { running: boolean; owner: 'agent' | 'user' | null } | null): string {
  const lines = [`${plan.runs.length ? `检测到 ${plan.runs.length} 个 GameTest 运行配置` : '没有检测到 GameTest 运行配置'}`]
  for (const run of plan.runs) {
    const filter = run.filterProperty ? `-P${run.filterProperty}=…` : run.filterKey ? `-D${run.filterKey}=…` : '无过滤参数'
    const kind = run.filterKind === 'wildcard' ? '通配符' : run.filterKind === 'substring' ? '子串' : '未注明'
    lines.push(`  ${run.side === 'client' ? '客户端' : '服务端'} ${run.task}：${filter}（${kind}）${run.reportFile ? `，报告 ${run.reportFile}` : ''}`)
  }
  lines.push(plan.javaError ? `JDK：${plan.javaError}` : `JDK：${plan.javaPath}（${plan.javaMajor}，项目需要 ${plan.requiredJava}）`)
  if (client) lines.push(`开发客户端：${client.running ? `在运行（控制方 ${client.owner === 'user' ? '用户' : 'agent'}）` : '没有运行'}`)
  return lines.join('\n')
}
