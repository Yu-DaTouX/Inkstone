import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import type { ApplyResult, BuildResult, DevSessionInfo } from '../src/shared/dev-api.ts'
import { CompanionError } from '../src/core/dev/companion.ts'
import { createFabricProject } from '../src/core/dev/create-project.ts'
import { formatMapping, loadMappingTable, lookupMapping } from '../src/core/dev/mappings.ts'
import { decodePng, encodePng, scaleDown } from '../src/core/dev/png.ts'
import { DevProject, LAUNCH_ENV_KEYS, type LaunchEnv } from '../src/core/dev/runner.ts'
import { readJson, statePaths, type SessionFile } from '../src/core/dev/session.ts'
import { readSource, searchSources, sourceRoots, type SourceScope } from '../src/core/dev/sources.ts'
import { loadTexture, texturePathFromId, textureWriteDir } from '../src/core/dev/texture-lookup.ts'
import { imageFromGrid, renderTextureView } from '../src/core/dev/texture.ts'
import { gridRequest } from '../src/core/dev/interact.ts'
import { potentialJavaPaths } from '../src/core/dev/java.ts'
import { failure, image, text, type ToolContent, type ToolDefinition, type ToolResult } from './protocol.ts'
import { tickResetReminder, tickStatusLine } from './tools-tick.ts'
import { withOperations } from './operations.ts'

export interface McpContextOptions {
  runtimesDir: string
  javaPaths: string[]
  maxMemoryMb: number
  log: (line: string) => void
}

export const USER_IN_CONTROL = '用户正在操作开发客户端（通过接管入口交还 Agent 后再试）'

async function userInControl(project: DevProject): Promise<boolean> {
  try {
    return (await project.control())?.owner === 'user'
  } catch {
    return false
  }
}

const PROJECT_PROPERTY = { type: 'string', description: 'Fabric mod 项目根目录（含 build.gradle）。省略时用 INKSTONE_MC_PROJECT 或当前目录' }

export class McpContext {
  private readonly projects = new Map<string, DevProject>()
  readonly options: McpContextOptions

  constructor(options: McpContextOptions) {
    this.options = options
  }

  projectDir(args: Record<string, unknown>): string {
    const raw = typeof args.project === 'string' && args.project.trim() ? args.project.trim() : process.env.INKSTONE_MC_PROJECT || process.cwd()
    const dir = resolve(raw)
    if (!existsSync(join(dir, 'build.gradle')) && !existsSync(join(dir, 'build.gradle.kts'))) throw new Error(`${dir} 不是 Gradle 项目；用 project 参数指向 Fabric mod 项目根目录`)
    return dir
  }

  project(args: Record<string, unknown>): DevProject {
    const dir = this.projectDir(args)
    let project = this.projects.get(dir.toLowerCase())
    if (!project) {
      project = new DevProject(dir, { runtimesDir: this.options.runtimesDir, javaPaths: this.options.javaPaths, onLog: (line) => this.options.log(line) })
      this.projects.set(dir.toLowerCase(), project)
    }
    return project
  }

  async minecraft(project: DevProject): Promise<string | null> {
    const spec = await project.readSpec()
    if (spec?.minecraftVersion) return spec.minecraftVersion
    try {
      return (await readFile(join(project.projectDir, 'gradle.properties'), 'utf8')).match(/^minecraft_version\s*=\s*(\S+)/m)?.[1] ?? null
    } catch {
      return null
    }
  }

  async resourceDirs(project: DevProject): Promise<string[]> {
    const spec = await project.readSpec()
    const fromSpec = spec ? spec.sourceSets.flatMap((set) => set.sourceDirs.filter((dir) => /resources$/.test(dir))) : []
    return fromSpec.length ? fromSpec : [join(project.projectDir, 'src', 'main', 'resources'), join(project.projectDir, 'src', 'client', 'resources')]
  }

  async sourceDirs(project: DevProject): Promise<string[]> {
    const spec = await project.readSpec()
    const fromSpec = spec ? spec.sourceSets.flatMap((set) => set.sourceDirs.filter((dir) => /(java|kotlin)$/.test(dir))) : []
    return fromSpec.length ? fromSpec : [join(project.projectDir, 'src', 'main', 'java'), join(project.projectDir, 'src', 'client', 'java')]
  }
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const value = typeof args[key] === 'string' ? Number(args[key]) : args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function formatBuild(build: BuildResult): string {
  if (build.ok) return `编译成功（${(build.durationMs / 1000).toFixed(1)}s，${build.tasks.join(' ')}）`
  return [`编译失败（${(build.durationMs / 1000).toFixed(1)}s）：`, ...(build.errors.length ? build.errors : [build.output.slice(-3000)])].join('\n')
}

export function formatApply(result: ApplyResult, side?: (path: string) => string | null): string {
  const label = (path: string) => {
    const found = side?.(path)
    return found ? `${path}（${found}）` : path
  }
  const lines = [formatBuild(result.build)]
  if (!result.build.ok) return [...lines, ...result.notes].join('\n')
  const swap = result.hotswap
  if (swap) {
    if (swap.swapped.length) lines.push(`已热替换：${swap.swapped.map(label).join('、')}`)
    if (swap.added.length) lines.push(`新类（首次用到时加载）：${swap.added.map(label).join('、')}`)
    if (swap.skippedNotLoaded.length) lines.push(`还没加载过、下次用到时直接读新版：${swap.skippedNotLoaded.map(label).join('、')}`)
    if (swap.removed.length) lines.push(`删除的类：${swap.removed.map(label).join('、')}`)
  }
  if (result.changedAssets.length) lines.push(`资源${result.resourcesReloaded ? '已重载' : '有改动'}：${result.changedAssets.slice(0, 20).join('、')}${result.changedAssets.length > 20 ? ' …' : ''}`)
  if (result.changedData.length) lines.push(`数据${result.dataReloaded ? '已 /reload' : '有改动'}：${result.changedData.slice(0, 20).join('、')}${result.changedData.length > 20 ? ' …' : ''}`)
  if (!swap?.swapped.length && !result.changedAssets.length && !result.changedData.length && !swap?.added.length) lines.push('没有检测到需要同步的改动')
  if (result.restartNeeded) {
    lines.push(result.restarted ? '已自动重启并回到测试世界：' : '需要重启才能生效：')
    for (const reason of swap?.restartReasons ?? []) lines.push(`  - ${reason.detail}`)
    if (!result.restarted) lines.push('调用 mc_run action=restart（约十几秒，自动回到测试世界）')
  }
  lines.push(...result.notes)
  return lines.join('\n')
}

export interface SessionExtras {
  live?: Record<string, unknown> | null
  perf?: Record<string, unknown> | null
  jbrHint?: string | null
}

export function formatSession(session: DevSessionInfo, extras: SessionExtras = {}): string {
  const live = extras.live ?? null
  const takeover = record(live?.takeover)
  const lines = [
    `状态：${session.state}${session.pid ? `（pid ${session.pid}）` : ''}`,
    session.minecraftVersion ? `Minecraft：${session.minecraftVersion}` : '',
    session.javaPath ? `Java：${session.javaPath}${session.enhancedRedefinition ? '（JBR，增强热替换）' : session.jbr ? '（JBR）' : '（普通 JDK，只能热替换方法体）'}${session.mixinHotswap ? '，Mixin 方法体可热替换' : ''}` : '',
    session.state === 'running' ? `伴随 mod：${session.companionReady ? '已连接' : '未连接'}${session.world ? `，世界 ${session.world}` : ''}` : '',
    session.control ? `控制方：${session.control.owner === 'user' ? '用户（已接管，写操作会被拒绝；通过游戏窗口顶栏或 F8 交还 Agent 后恢复）' : 'Agent'}` : '',
    takeover?.created === true ? `接管入口：游戏窗口原生标题栏，点击「${session.control?.owner === 'user' ? '交还 Agent' : '接管'}」切换${takeover.visible === true ? '' : `（当前未显示：${String(takeover.reason ?? '窗口未就绪')}）`}` : takeover ? `接管按钮未就绪：${String(takeover.reason ?? '本平台不支持原生标题栏按钮')}；仍可用 F8` : '',
    formatEnv(live?.env),
    extras.perf ? formatPerf(extras.perf) : '',
    extras.jbrHint ? `JBR：${extras.jbrHint}` : '',
    session.crashReport ? `崩溃报告：${session.crashReport}（用 mc_logs crash=true 查看）` : '',
    session.logFile ? `日志：${session.logFile}` : '',
    session.message ?? ''
  ]
  return lines.filter(Boolean).join('\n')
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 1)
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

async function saveViewShot(projectDir: string, png: Buffer, label: string, at: number): Promise<string> {
  const dir = join(statePaths(projectDir).dir, 'shots')
  await mkdir(dir, { recursive: true })
  const date = new Date(at)
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const time = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`
  const file = join(dir, `${time}-view-${label.replace(/[^\w-]/g, '_')}.png`)
  await writeFile(file, png)
  return file
}

function stamp(at: number): string {
  const date = new Date(at)
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function formatEnv(value: unknown): string {
  const env = record(value)
  if (!env) return ''
  const pos = Array.isArray(env.pos) ? env.pos.map((item) => Math.round(Number(item))).join(', ') : null
  const rot = Array.isArray(env.rot) ? env.rot.map((item) => Number(item).toFixed(1)).join(', ') : null
  const parts = [
    env.world ? `世界 ${String(env.world)}` : '',
    env.version ? `版本 ${String(env.version)}` : '',
    env.dimension ? `维度 ${String(env.dimension)}` : '',
    env.gamemode ? `模式 ${String(env.gamemode)}` : '',
    env.difficulty ? `难度 ${String(env.difficulty)}` : '',
    env.lang ? `语言 ${String(env.lang)}` : '',
    pos ? `坐标 ${pos}${rot ? `（朝向 ${rot}）` : ''}` : '',
    env.paused === true ? '已暂停（开着暂停界面）' : ''
  ].filter(Boolean)
  return parts.length ? `环境：${parts.join(' / ')}` : ''
}

function formatPerf(value: unknown): string {
  const perf = record(value)
  if (!perf) return ''
  const memory = record(perf.memory)
  const round = (input: unknown, digits = 0) => (typeof input === 'number' && Number.isFinite(input) ? input.toFixed(digits) : null)
  const parts = [
    round(perf.tps, 1) ? `TPS ${round(perf.tps, 1)}` : '',
    round(perf.mspt, 1) ? `MSPT ${round(perf.mspt, 1)}` : '',
    round(perf.fps) ? `FPS ${round(perf.fps)}` : '',
    memory && round(memory.used) ? `内存 ${round(memory.used)}/${round(memory.max)}MB` : '',
    round(perf.entities) ? `实体 ${round(perf.entities)}` : '',
    round(perf.chunks) ? `区块 ${round(perf.chunks)}` : ''
  ].filter(Boolean)
  return parts.length ? `性能：${parts.join(' / ')}` : ''
}

async function companionMaybe(project: DevProject, path: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> {
  try {
    return record(await project.companion(path, body))
  } catch {
    return null
  }
}

async function companionCall(project: DevProject, path: string, body: Record<string, unknown> = {}, timeoutMs?: number): Promise<Record<string, unknown>> {
  try {
    const reply = record(await project.companion(path, body, timeoutMs))
    if (!reply) throw new Error(`伴随 mod 对 ${path} 没有返回内容`)
    return reply
  } catch (error) {
    if (error instanceof CompanionError && error.status === 423) throw new Error(USER_IN_CONTROL)
    throw error instanceof CompanionError ? new Error(`伴随 mod 拒绝了 ${path}（HTTP ${error.status}）：${error.message}`) : error
  }
}

async function screenshotScreen(project: DevProject, body: Record<string, unknown>): Promise<{ png: Buffer; note: string | null }> {
  try {
    return { png: await project.image('/screenshot', body), note: null }
  } catch (error) {
    const status = error instanceof CompanionError ? error.status : 0
    if (!Object.keys(body).length || (status !== 400 && status !== 404 && status !== 405)) throw error
    return { png: await project.image('/screenshot', {}), note: `伴随 mod 还没有支持 ${Object.keys(body).join('、')}（HTTP ${status}），这张是完整画面` }
  }
}

const chatCursors = new Map<string, number>()

const commandQueues = new Map<string, Promise<unknown>>()

function serializedCommand<T>(project: DevProject, run: () => Promise<T>): Promise<T> {
  const key = project.projectDir.toLowerCase()
  const next = (commandQueues.get(key) ?? Promise.resolve()).then(run)
  const settled = next.catch(() => undefined)
  commandQueues.set(key, settled)
  void settled.then(() => {
    if (commandQueues.get(key) === settled) commandQueues.delete(key)
  })
  return next
}

async function chatLatest(project: DevProject): Promise<number | undefined> {
  try {
    const reply = record(await project.companion('/chat', { limit: 1 }))
    return typeof reply?.latest === 'number' && Number.isFinite(reply.latest) ? reply.latest : undefined
  } catch {
    return undefined
  }
}

async function chatAfter(project: DevProject, since: number): Promise<string[]> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await sleep(300)
    try {
      const reply = record(await project.companion('/chat', { limit: 50, since }))
      const messages = Array.isArray(reply?.messages) ? (reply.messages as Array<Record<string, unknown>>) : []
      if (messages.length) return formatChat(messages).split('\n')
    } catch {
      return []
    }
  }
  return []
}

async function readChatSince(project: DevProject): Promise<{ messages: Array<Record<string, unknown>>; latest: number }> {
  const key = project.projectDir.toLowerCase()
  const since = chatCursors.get(key)
  let messages: Array<Record<string, unknown>> = []
  let latest = since ?? 0
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await sleep(attempt === 1 ? 400 : 900)
    const reply = record(await project.companion('/chat', { limit: 50, ...(since !== undefined ? { since } : {}) }))
    messages = Array.isArray(reply?.messages) ? (reply.messages as Array<Record<string, unknown>>) : []
    if (typeof reply?.latest === 'number' && Number.isFinite(reply.latest)) latest = reply.latest
    if (messages.length) break
  }
  chatCursors.set(key, latest)
  return { messages, latest }
}

function formatChat(messages: Array<Record<string, unknown>>): string {
  return messages
    .map((message) => {
      const kind = typeof message.kind === 'string' ? message.kind : 'chat'
      const time = typeof message.time === 'number' ? stamp(message.time) : ''
      return `${time ? `[${time.slice(11)}] ` : ''}${kind}: ${String(message.text ?? '')}`
    })
    .join('\n')
}

function describeItem(value: unknown): string {
  const item = record(value)
  if (!item) return String(value)
  const count = typeof item.count === 'number' ? item.count : 1
  return `${String(item.id ?? '?')}×${count}`
}

function formatPlayer(reply: Record<string, unknown>): string {
  const pos = Array.isArray(reply.pos) ? reply.pos.map((item) => Math.round(Number(item))).join(', ') : '?'
  const rot = Array.isArray(reply.rot) ? reply.rot.map((item) => Number(item).toFixed(1)).join(', ') : '?'
  const xp = record(reply.xp)
  const effects = Array.isArray(reply.effects) ? (reply.effects as Array<Record<string, unknown>>) : []
  const inventory = Array.isArray(reply.inventory) ? (reply.inventory as Array<Record<string, unknown>>) : []
  const items = inventory.filter((entry) => entry.item).map((entry) => `${String(entry.slot)}: ${describeItem(entry.item)}`)
  const health = `${typeof reply.health === 'number' ? reply.health.toFixed(1) : '?'}/${String(reply.maxHealth ?? '?')}${typeof reply.absorption === 'number' && reply.absorption > 0 ? `+${reply.absorption.toFixed(1)} 吸收` : ''}`
  const food = `${String(reply.food ?? '?')}/20（饱和 ${String(reply.saturation ?? '?')}）`
  const level = typeof xp?.level === 'number' ? xp.level : 0
  const progress = typeof xp?.progress === 'number' ? Math.round(xp.progress * 100) : 0
  const slot = typeof reply.selectedSlot === 'number' ? reply.selectedSlot + 1 : '?'
  return [
    `${String(reply.name ?? '?')}（${String(reply.gamemode ?? '?')}${reply.invulnerable === true ? '，无敌' : ''}${reply.onGround === true ? '' : '，离地'}）`,
    `位置：${pos}（${String(reply.dimension ?? '?')}），朝向 yaw ${rot}`,
    `生命 ${health}，饥饿 ${food}`,
    `经验 等级 ${level}（${progress}%），快捷栏第 ${slot} 格`,
    effects.length ? `效果：${effects.map((effect) => `${String(effect.id ?? '?')} ${Number(effect.amplifier ?? 0) + 1} 级 ${Math.round(Number(effect.duration ?? 0) / 20)}s`).join('、')}` : '效果：无',
    reply.lookingAt ? `视线：${json(reply.lookingAt)}` : '',
    items.length ? `背包：${items.slice(0, 24).join('、')}${items.length > 24 ? ` …（共 ${items.length} 格）` : ''}` : '背包：空',
    '说明：命令用玩家实体本身执行，不临时改游戏模式、不加无敌；这里的值就是命令作用时看到的真实状态'
  ]
    .filter(Boolean)
    .join('\n')
}

async function classSides(project: DevProject): Promise<(path: string) => string | null> {
  const spec = await Promise.resolve()
    .then(() => project.readSpec())
    .catch(() => null)
  if (!spec) return () => null
  const sets = spec.sourceSets
  return (path: string) => sets.find((set) => set.classesDirs.some((dir) => existsSync(join(dir, `${path}.class`))))?.name ?? null
}

const shownJbrHints = new Set<string>()

function launchEnv(args: Record<string, unknown>): LaunchEnv | null {
  const env: LaunchEnv = {}
  for (const key of LAUNCH_ENV_KEYS) {
    const value = str(args, key)
    if (value) env[key] = value
  }
  return Object.keys(env).length ? env : null
}

async function statusText(project: DevProject): Promise<string> {
  const session = await project.status()
  const live = session.state === 'running' && session.companionReady ? await companionMaybe(project, '/status') : null
  const perf = session.state === 'running' && session.companionReady ? await companionMaybe(project, '/perf') : null
  const tick = session.state === 'running' && session.companionReady ? await tickStatusLine(project) : null
  const hint = jbrHintOnce(project.projectDir, await sessionHint(project.projectDir), true)
  const missing = session.state === 'running' && session.companionReady && (!formatEnv(live?.env) || !formatPerf(perf)) ? '\n（伴随 mod 还没提供 env 或 /perf 路由：升级伴随 mod 后这里会出现环境与性能）' : ''
  return `${formatSession(session, { live, perf, jbrHint: hint })}${tick ? `\n${tick}` : ''}${missing}`
}

function jbrHintOnce(projectDir: string, hint: string | null, always: boolean): string | null {
  if (!hint) return null
  const key = `${projectDir.toLowerCase()}\n${hint}`
  if (!always && shownJbrHints.has(key)) return null
  shownJbrHints.add(key)
  return hint
}

async function sessionHint(projectDir: string): Promise<string | null> {
  const file = await readJson<SessionFile>(statePaths(projectDir).session)
  return file?.jbrHint ?? null
}

export function createTools(context: McpContext): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: 'mc_build',
      title: '编译 mod',
      description: '用 Gradle 增量编译项目（classes + processResources），返回编译错误。只想确认代码能编译时用；要让游戏里生效用 mc_apply。',
      inputSchema: { type: 'object', properties: { project: PROJECT_PROPERTY } },
      run: async (args) => {
        const result = await context.project(args).build()
        return result.ok ? text(formatBuild(result)) : failure(formatBuild(result))
      }
    },
    {
      name: 'mc_apply',
      title: '同步改动到游戏',
      description:
        '把代码和资源改动同步进正在运行的开发客户端：增量编译 → 改过的类经 JDWP 热替换 → assets 改动触发资源重载 → data 改动执行 /reload。Mixin 注入方法的方法体也能热替换；结构改动（新增方法/字段、Mixin 新增注入、fabric.mod.json、注册新内容）会报告需要重启；restart_if_needed=true 时自动快速重启并回到测试世界。split source sets 项目里每个类名后面会标出它属于哪一侧（main / client）。',
      inputSchema: { type: 'object', properties: { project: PROJECT_PROPERTY, restart_if_needed: { type: 'boolean', description: '需要重启时自动重启（默认 false）' } } },
      run: async (args) => {
        const project = context.project(args)
        const taken = await userInControl(project)
        const side = await classSides(project)
        const result = await project.apply({ autoRestart: args.restart_if_needed === true && !taken })
        if (taken && result.build.ok && result.restartNeeded) result.notes.push('用户正在操作开发客户端，没有自动重启（按 F8 或在开发页点「交还 Agent」后再试）')
        return result.build.ok ? text(formatApply(result, side)) : failure(formatApply(result, side))
      }
    },
    {
      name: 'mc_run',
      title: '启动/停止开发客户端',
      description:
        '管理 Loom runClient 开发客户端（砚直接拉起 JVM：优先 JetBrains Runtime + 增强热替换，带 JDWP 和伴随 mod）。start/restart 默认进入测试世界 inkstone-test（不存在时自动建平坦创造世界，默认和平难度、创造模式、en_us），返回时已在世界里，并按 gamemode/difficulty/lang/time/weather 参数调好环境（lang 启动前写 options.txt，其余进世界后用命令设）。status 查看状态、控制方、当前环境（世界/版本/模式/难度/语言/坐标）、性能与 tick 状态。mc_tick 冻结或调低过 tick 时，stop/restart 前会提醒先 mc_tick action=reset 恢复，别把冻结状态带进下一轮。用户在游戏里按 F8 接管后，stop/restart 会被拒绕；action=take_control 把控制方切回 agent，只在用户明确同意时用，不要擅自收回控制权。',
      inputSchema: {
        type: 'object',
        properties: {
          project: PROJECT_PROPERTY,
          action: { type: 'string', enum: ['start', 'stop', 'restart', 'status', 'take_control'] },
          world: { type: 'string', description: '要进入的存档名，默认 inkstone-test；传空字符串则停在标题界面' },
          username: { type: 'string', description: '固定离线玩家名，1–16 位字母数字下划线；默认把 Loom 随机 Player 名替换成 InkstoneAgent，并使用稳定离线 UUID。已有实名登录参数会保留。' },
          gamemode: { type: 'string', enum: ['survival', 'creative', 'adventure', 'spectator'], description: 'start/restart 时进世界后用 /gamemode 设置；不传则保持世界原有模式' },
          difficulty: { type: 'string', enum: ['peaceful', 'easy', 'normal', 'hard'], description: 'start/restart 时用 /difficulty 设置；和平难度不能召唤怪物' },
          lang: { type: 'string', description: '客户端语言（zh_cn、en_us 等），start/restart 启动前写进 run/options.txt；运行时改语言要用 mc_options' },
          time: { type: 'string', description: 'start/restart 时用 /time set 设置：day、noon、night、midnight 或数字 tick' },
          weather: { type: 'string', enum: ['clear', 'rain', 'thunder'], description: 'start/restart 时用 /weather 设置' }
        },
        required: ['action']
      },
      run: async (args) => {
        const project = context.project(args)
        const action = str(args, 'action') ?? 'status'
        if (action === 'take_control') return text(`已收回控制权\n${formatSession(await project.setControl('agent'))}`)
        if (['start', 'stop', 'restart'].includes(action) && (await userInControl(project))) return failure(USER_IN_CONTROL)
        if (action === 'status') return text(await statusText(project))
        const world = typeof args.world === 'string' ? (args.world.trim() ? args.world.trim() : null) : undefined
        const env = launchEnv(args)
        const options = { projectDir: project.projectDir, world, username: str(args, 'username'), maxMemoryMb: context.options.maxMemoryMb, ...(env ? { env } : {}) }
        const tickNote = action === 'start' ? null : await tickResetReminder(project)
        const session = action === 'start' ? await project.launch(options) : action === 'stop' ? await project.stop() : await project.restart(options)
        const live = session.companionReady ? await companionMaybe(project, '/status') : null
        return text([formatSession(session, { live, jbrHint: jbrHintOnce(project.projectDir, await sessionHint(project.projectDir), false) }), tickNote].filter(Boolean).join('\n'))
      }
    },
    {
      name: 'mc_command',
      title: '执行游戏命令',
      description:
        '在开发客户端的单人世界里执行命令，例如 give、setblock、summon、tp、/reload、/data get。命令用玩家实体本身执行（不临时改游戏模式、不加无敌），玩家是权限 4，实际生效模式与无敌状态用 mc_inspect what=player 看。check=true 只解析不执行，返回能不能解析、错在哪里、补全建议；via=chat 走客户端聊天发送路径（客户端命令、真实玩家权限、聊天事件都会触发），返回结果从 /chat 读。需要已进入世界。',
      inputSchema: {
        type: 'object',
        properties: {
          project: PROJECT_PROPERTY,
          command: { type: 'string', description: '命令，可带或不带开头的 /' },
          check: { type: 'boolean', description: '只解析不执行（默认 false），返回 valid/error/cursor/suggestions' },
          via: { type: 'string', enum: ['server', 'chat'], description: 'server（默认）在服务端直接执行；chat 从客户端聊天框发送，会触发客户端命令与聊天事件，结果从 /chat 读' }
        },
        required: ['command']
      },
      run: async (args) => {
        const command = str(args, 'command')
        if (!command) return failure('command 不能为空')
        const project = context.project(args)
        const clean = command.replace(/^\//, '')
        if (args.check === true) {
          const reply = await companionCall(project, '/command', { command: clean, check: true })
          const suggestions = Array.isArray(reply.suggestions) ? reply.suggestions.map(String) : []
          const valid = reply.valid === true
          const lines = [valid ? `命令可解析：/${clean}` : `命令无法解析：/${clean}`]
          if (typeof reply.error === 'string' && reply.error) lines.push(`错误：${reply.error}${typeof reply.cursor === 'number' ? `（第 ${reply.cursor} 个字符处）` : ''}`)
          if (suggestions.length) lines.push(`补全建议：${suggestions.slice(0, 24).join('、')}${suggestions.length > 24 ? ' …' : ''}`)
          return valid ? text(lines.join('\n')) : failure(lines.join('\n'))
        }
        if (await userInControl(project)) return failure(USER_IN_CONTROL)
        if (str(args, 'via') === 'chat') {
          const { sent, messages } = await serializedCommand(project, async () => {
            const sent = await companionCall(project, '/command', { command: clean, via: 'chat' })
            const { messages } = await readChatSince(project)
            return { sent, messages }
          })
          const body = [`已从聊天发送：/${clean}${sent.sent === true ? '' : '（伴随 mod 没确认已发送）'}`, messages.length ? formatChat(messages) : '聊天里没有新消息（命令可能没产生输出；聊天历史用 mc_chat 读）']
          return text(body.join('\n'))
        }
        const { result, echoed } = await serializedCommand(project, async () => {
          const before = await chatLatest(project)
          const result = await project.command(command)
          const echoed = result.output.length || before === undefined ? [] : await chatAfter(project, before)
          return { result, echoed }
        })
        const output = result.output.length ? result.output : echoed.length ? ['（命令来源没有回显，下面是执行期间新增的聊天/系统消息）', ...echoed] : ['（没有输出，执行期间也没有新的聊天/系统消息；命令若会打开界面，用 mc_ui read 查看）']
        const body = [`/${result.command.replace(/^\//, '')}`, ...output]
        if (result.error) body.push(`错误：${result.error}`)
        return result.ok ? text(body.join('\n')) : failure(body.join('\n'))
      }
    },
    {
      name: 'mc_logs',
      title: '读日志和崩溃报告',
      description: '读开发客户端日志（可按级别和正则过滤，异常堆栈会整段保留），或 crash=true 读最近的崩溃报告摘要（Description、异常、可疑的非原版栈帧和报告开头）。',
      inputSchema: {
        type: 'object',
        properties: {
          project: PROJECT_PROPERTY,
          lines: { type: 'number', description: '先按 level/filter 筛选，再取匹配结果的末尾 N 行，默认 120；读取范围为日志末尾 512 KiB' },
          level: { type: 'string', enum: ['error', 'warn', 'all'], description: '默认 all' },
          filter: { type: 'string', description: '正则或关键字（不区分大小写）' },
          crash: { type: 'boolean' }
        }
      },
      annotations: { readOnlyHint: true },
      run: async (args) => {
        const project = context.project(args)
        if (args.crash === true) {
          const crashes = await project.crashes(3)
          if (!crashes.length) {
            const session = await project.status()
            if (session.state !== 'crashed' && !(session.exitCode !== null && session.exitCode !== 0)) return text('没有崩溃报告')
            const tail = await project.logs({ lines: num(args, 'lines') ?? 120 })
            return text(`客户端异常退出（exitCode=${session.exitCode ?? '未知'}），没有生成崩溃报告。以下为启动日志末尾：${session.logFile ?? '无日志路径'}\n${tail.join('\n') || '（没有可读日志）'}`)
          }
          const [latest, ...older] = crashes
          return text(
            [
              `最近的崩溃：${latest.file}（${new Date(latest.at).toLocaleString()}）`,
              `描述：${latest.description ?? '?'}`,
              `异常：${latest.exception ?? '?'}`,
              latest.suspectFrames.length ? `非原版栈帧（优先怀疑）：${latest.suspectFrames.join('、')}` : '',
              '——报告开头——',
              latest.head,
              older.length ? `更早的报告：${older.map((item) => item.file).join('、')}` : ''
            ]
              .filter(Boolean)
              .join('\n')
          )
        }
        const level = str(args, 'level')
        const result = await project.logDetails({ lines: num(args, 'lines') ?? 120, filter: str(args, 'filter'), levels: level === 'error' ? ['ERROR'] : level === 'warn' ? ['ERROR', 'WARN'] : undefined })
        return text(`日志末尾 512 KiB 内匹配 ${result.matchedLines} 行，返回最后 ${result.lines.length} 行\n${result.lines.join('\n') || '（没有匹配的日志）'}`)
      }
    },
    {
      name: 'mc_view',
      title: '看游戏画面或渲染物品',
      description:
        'target=screen 截取开发客户端当前画面（可连拍）：count 张、间隔 intervalMs，每张都带截图时间戳与间隔，适合倒计时、粒子、动画这类“必须看变化”的验证；hideHud=true 截图时隐藏 HUD，crop=[x,y,w,h] 只取屏幕区域，grid=true 在返回的图上叠半透明坐标网格与刻度（GUI 坐标，与 mc_ui click 的 x/y 同一套，默认步长 50，也可写 {step:25}），照坐标点自定义界面时先开 grid。target=item 或 block 把指定物品/方块单独渲染成透明背景 PNG（黑白两遍背景还原透明度，游戏内的真实模型和贴图，包含刚重载的资源）。',
      inputSchema: {
        type: 'object',
        properties: {
          project: PROJECT_PROPERTY,
          target: { type: 'string', enum: ['screen', 'item', 'block'] },
          id: { type: 'string', description: '物品或方块 id，例如 minecraft:diamond_sword、mymod:ruby_block' },
          size: { type: 'number', description: '渲染边长像素，默认 256' },
          count: { type: 'number', description: 'screen 连拍张数，默认 1，最多 20（每张都是独立图片，按顺序给出）' },
          intervalMs: { type: 'number', description: 'screen 连拍的间隔毫秒，默认 500；间隔为 0 时尽快连拍' },
          hideHud: { type: 'boolean', description: 'screen 截图时隐藏 HUD（要看得见的世界画面）' },
          crop: { type: 'array', items: { type: 'number' }, description: 'screen 只截一块区域：[x, y, 宽, 高]（屏幕像素，左上角为原点）' },
          grid: {
            type: ['boolean', 'object'],
            properties: { step: { type: 'number', description: '网格与刻度步长（GUI 像素），默认 50，范围 4–400' } },
            description: 'screen 截图时在返回的图上叠半透明坐标网格与坐标刻度（不画进游戏画面），坐标是 GUI 缩放后的屏幕坐标，与 mc_ui click 的 x/y 同一套；默认步长 50，也可直接给数字'
          }
        },
        required: ['target']
      },
      annotations: { readOnlyHint: true },
      run: async (args) => {
        const project = context.project(args)
        const target = str(args, 'target') ?? 'screen'
        if (target === 'screen') {
          const count = Math.max(1, Math.min(20, Math.round(num(args, 'count') ?? 1)))
          const intervalMs = Math.max(0, Math.min(60_000, Math.round(num(args, 'intervalMs') ?? 500)))
          const body: Record<string, unknown> = {}
          if (args.hideHud === true) body.hideHud = true
          const grid = gridRequest(args.grid)
          if (grid !== undefined) body.grid = grid
          const crop = Array.isArray(args.crop) ? args.crop.map((item) => Math.round(Number(item))) : null
          if (crop && crop.length === 4 && crop.every((item) => Number.isFinite(item))) body.crop = crop
          const content: ToolContent[] = []
          const notes: string[] = []
          const startedAt = Date.now()
          const saved: string[] = []
          for (let index = 0; index < count; index += 1) {
            if (index > 0 && intervalMs) await sleep(intervalMs)
            const shot = await screenshotScreen(project, body)
            if (shot.note && !notes.includes(shot.note)) notes.push(shot.note)
            const decoded = decodePng(shot.png)
            const scaled = scaleDown(decoded, 1280)
            const at = Date.now()
            saved.push(await saveViewShot(project.projectDir, shot.png, count > 1 ? `screen-${index + 1}` : 'screen', at))
            content.push({ type: 'image', data: (scaled === decoded ? shot.png : encodePng(scaled)).toString('base64'), mimeType: 'image/png' })
            content.push({
              type: 'text',
              text: `#${index + 1}/${count} ${stamp(at)}（第 ${((at - startedAt) / 1000).toFixed(1)}s）${decoded.width}×${decoded.height}${scaled === decoded ? '' : ` → ${scaled.width}×${scaled.height}`}`
            })
          }
          notes.push(saved.length === 1 ? `已存原图：${saved[0]}` : `已存原图：\n${saved.join('\n')}`)
          if (count > 1) notes.push(`连拍 ${count} 张，间隔 ${intervalMs}ms`)
          if (await userInControl(project)) notes.push('用户正在操作，画面可能已被改变')
          if (notes.length) content.push({ type: 'text', text: notes.join('\n') })
          return { content }
        }
        const id = str(args, 'id')
        if (!id) return failure('渲染物品或方块需要 id')
        const png = await project.image('/render', { id, kind: target, size: num(args, 'size') ?? 256 })
        const file = await saveViewShot(project.projectDir, png, `${target}-${id}`, Date.now())
        return image(png, `${target === 'block' ? '方块' : '物品'} ${id} 的游戏内渲染（透明背景）\n已存：${file}`)
      }
    },
    {
      name: 'mc_texture',
      title: '查看或绘制贴图',
      description:
        'action=view（默认）：把贴图按最近邻放大并加坐标网格（每 8 格红线）返回图片，同时给出调色板（每种颜色的键、十六进制、像素数）和逐像素字符图，方便精确描述和修改 16×16 贴图。texture 可以是 png 路径，或资源 id（mymod:item/ruby、minecraft:block/stone），先找项目资源再找原版客户端。action=write：用同样的格式（palette 键→#rrggbb[aa]，grid 每行一个字符串，. 为透明）写出 PNG 到项目资源里，再返回放大视图；写完用 mc_apply 重载资源。',
      inputSchema: {
        type: 'object',
        properties: {
          project: PROJECT_PROPERTY,
          action: { type: 'string', enum: ['view', 'write'] },
          texture: { type: 'string', description: '资源 id 或 png 路径；write 时只能写到项目目录内' },
          max_size: { type: 'number', description: '放大后最长边像素，默认 512' },
          palette: { type: 'object', additionalProperties: { type: 'string' }, description: 'write 用：{"A":"#3c2a1e","B":"#ffffff80"}' },
          grid: { type: 'array', items: { type: 'string' }, description: 'write 用：每行一个字符串，行数为高、长度为宽' }
        },
        required: ['texture']
      },
      run: async (args) => {
        const project = context.project(args)
        const ref = str(args, 'texture')
        if (!ref) return failure('需要 texture')
        if (str(args, 'action') === 'write') {
          const unknown = Object.keys(args).filter((key) => !['project', 'action', 'texture', 'max_size', 'palette', 'grid'].includes(key))
          if (unknown.length) return failure(`未知参数：${unknown.join('、')}。${unknown.includes('rows') ? '像素行请使用 grid，而不是 rows。' : '可用参数：project、action、texture、max_size、palette、grid。'}`)
          if (!Array.isArray(args.grid) || !args.grid.length || !args.grid.every((row) => typeof row === 'string')) return failure('write 需要非空的 grid 字符串数组，每行一个像素字符串（不是 rows）')
          const palette = (args.palette && typeof args.palette === 'object' ? args.palette : {}) as Record<string, string>
          const grid = Array.isArray(args.grid) ? args.grid.map(String) : []
          const resourcePath = texturePathFromId(ref)
          const target = resourcePath ? join(textureWriteDir(await context.resourceDirs(project), resourcePath.split('/')[1]), ...resourcePath.split('/')) : resolve(project.projectDir, ref)
          const inside = relative(project.projectDir, target)
          if (!inside || inside.startsWith('..') || isAbsolute(inside) || !target.toLowerCase().endsWith('.png')) return failure(`只能写项目目录内的 png：${target}`)
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, encodePng(imageFromGrid(grid, palette)))
          const view = renderTextureView(decodePng(await readFile(target)), { maxSize: num(args, 'max_size') ?? 512 })
          return image(view.png, `已写入 ${target}\n${view.text}\n运行中的客户端要用 mc_apply 重载资源才能看到`)
        }
        const found = await loadTexture(ref, { projectDir: project.projectDir, resourceDirs: await context.resourceDirs(project), minecraft: await context.minecraft(project) })
        const view = renderTextureView(decodePng(found.bytes), { maxSize: num(args, 'max_size') ?? 512 })
        const info = [`来源：${found.source}`, found.mcmeta ? `动画/元数据（.mcmeta）：${found.mcmeta.trim()}` : '', view.text].filter(Boolean).join('\n')
        const result: ToolResult = image(view.png, info)
        return result
      }
    },
    {
      name: 'mc_inspect',
      title: '查询游戏状态',
      description:
        'what=status 客户端与伴随 mod 状态（玩家位置、当前界面）；player 玩家完整状态（位置与朝向、生命与吸收、饥饿、经验、游戏模式、无敌、脚是否落地、药水效果、快捷栏、背包与盔甲、看着的方块/实体），判断“为什么打不动/命令为什么失败”时先看它；registry 列注册表（不填 registry 列出全部注册表名，filter 过滤 id）；block 查坐标处方块状态和方块实体 NBT；entities 查附近实体（默认玩家周围 8 格）及其 NBT。',
      inputSchema: {
        type: 'object',
        properties: {
          project: PROJECT_PROPERTY,
          what: { type: 'string', enum: ['status', 'player', 'registry', 'block', 'entities'], description: '默认 status' },
          target: { type: 'string', description: 'what 的别名，写 target=player 也可以' },
          registry: { type: 'string', description: '例如 minecraft:item、minecraft:block、minecraft:worldgen/biome' },
          filter: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
          radius: { type: 'number' },
          uuid: { type: 'string' },
          type: { type: 'string', description: '实体类型 id 过滤，例如 minecraft:zombie' },
          dimension: { type: 'string' },
          limit: { type: 'number' }
        }
      },
      annotations: { readOnlyHint: true },
      run: async (args) => {
        const project = context.project(args)
        const what = str(args, 'what') ?? str(args, 'target') ?? 'status'
        if (what === 'status') {
          const session = await project.status()
          const live = session.companionReady ? await project.companion('/status') : null
          return text(`${formatSession(session)}${live ? `\n${json(live)}` : ''}`)
        }
        if (what === 'player') return text(formatPlayer(await companionCall(project, '/player')))
        if (what === 'registry') return text(json(await project.companion('/registry', { registry: str(args, 'registry') ?? '', filter: str(args, 'filter') ?? '', limit: num(args, 'limit') ?? 300 })))
        if (what === 'block') {
          if (num(args, 'x') === undefined || num(args, 'y') === undefined || num(args, 'z') === undefined) return failure('block 需要 x、y、z')
          return text(json(await project.companion('/block', { x: num(args, 'x'), y: num(args, 'y'), z: num(args, 'z'), dimension: str(args, 'dimension') ?? '' })))
        }
        return text(
          json(
            await project.companion('/entities', {
              ...(num(args, 'x') !== undefined ? { x: num(args, 'x'), y: num(args, 'y'), z: num(args, 'z') } : {}),
              radius: num(args, 'radius') ?? 8,
              uuid: str(args, 'uuid') ?? '',
              type: str(args, 'type') ?? '',
              dimension: str(args, 'dimension') ?? '',
              limit: num(args, 'limit') ?? 10
            })
          )
        )
      }
    },
    {
      name: 'mc_options',
      title: '读写客户端选项',
      description:
        '读或改开发客户端的客户端选项（options.txt 里的键，例如 lang、guiScale、renderDistance、fov、gamma、hideGui、pauseOnLostFocus、soundCategory_master、fancyGraphics）。游戏在运行时经伴随 mod 的 /options 当场生效，返回实际生效的项和需要重启的项；游戏没在运行时直接改 run/options.txt，下次启动生效。get 传要读的键（不传则不读），set 传要改的键值；两者都没有会报错。改 lang 要重载资源，启动前改语言用 mc_run start 的 lang 参数更省事。',
      inputSchema: {
        type: 'object',
        properties: {
          project: PROJECT_PROPERTY,
          get: { type: 'array', items: { type: 'string' }, description: '要读的键名，例如 ["lang","guiScale","hideGui"]' },
          set: { type: 'object', additionalProperties: { type: 'string' }, description: '要改的键值（值会转成文本），例如 {"lang":"zh_cn","hideGui":"true"}' }
        }
      },
      run: async (args) => {
        const project = context.project(args)
        const get = Array.isArray(args.get) ? args.get.map(String).filter(Boolean) : []
        const wanted = record(args.set)
        const set = wanted ? Object.fromEntries(Object.entries(wanted).map(([key, value]) => [key, String(value)])) : {}
        const keys = Object.keys(set)
        if (!get.length && !keys.length) return failure('需要 get（要读的键名）或 set（要改的键值）')
        if (keys.length && (await userInControl(project))) return failure(USER_IN_CONTROL)
        const session = await project.status()
        let fallback: string | null = null
        if (session.state === 'running' && session.companionReady) {
          const body: Record<string, unknown> = {}
          if (get.length) body.get = get
          if (keys.length) body.set = set
          try {
            const reply = await companionCall(project, '/options', body, keys.includes('lang') ? 225_000 : undefined)
            const values = record(reply.values) ?? {}
            const applied = Array.isArray(reply.applied) ? reply.applied.map(String) : []
            const needsRestart = Array.isArray(reply.needsRestart) ? reply.needsRestart.map(String) : []
            const lines = ['游戏选项（运行时经伴随 mod 修改）']
            for (const key of keys.length ? keys : get) lines.push(`${key} = ${values[key] ?? '（未知）'}`)
            for (const key of Object.keys(values).filter((key) => !(keys.length ? keys : get).includes(key))) lines.push(`${key} = ${values[key]}`)
            if (keys.length) lines.push(applied.length ? `已当场生效：${applied.join('、')}` : '没有项能当场生效')
            if (applied.includes('lang')) lines.push('语言资源重载已完成，加载遮罩已结束')
            if (needsRestart.length) lines.push(`需要重启才生效：${needsRestart.join('、')}`)
            return text(lines.join('\n'))
          } catch (error) {
            if (!(error instanceof CompanionError) || (error.status !== 404 && error.status !== 405)) throw error
            fallback = '伴随 mod 没有 /options 路由（旧版），改的是 run/options.txt，重启后生效'
          }
        }
        if (keys.length) {
          const written = await project.saveClientOptions(set)
          const lines = [fallback ?? `游戏没在运行：已写入 ${written.file}，下次启动生效`]
          for (const key of keys) lines.push(`${key} = ${written.values[key] ?? '（未知）'}`)
          return text(lines.join('\n'))
        }
        const current = await project.clientOptions()
        const lines = [fallback ?? `游戏没在运行，直接读 ${current.file}`]
        for (const key of get) lines.push(`${key} = ${current.values[key] ?? '（文件里没有这个键）'}`)
        return text(lines.join('\n'))
      }
    },
    {
      name: 'mc_source',
      title: '搜索反编译源码',
      description:
        '在反编译的 Minecraft 源码（项目当前映射：yarn 或 mojmap）、项目自己的源码、以及依赖（Fabric API 等，scope 含 deps 时）里搜索或读取。action=search 按关键字/正则搜，path_filter 支持包路径或完整 Java 文件路径；action=read 读一个类（全名或简单类名）的指定行段；action=gen_sources 先生成 Minecraft 反编译源码（首次约 1 分钟，客户端运行时拒绝生成，已有源码可直接读）。deps 没有源码包时按当前启动 classpath 用 JDK javap 读取公共 API 签名，结果会明确标记不是源码；每次最多检查 25 个字节码类，请用 path_filter 限定包或类。',
      inputSchema: {
        type: 'object',
        properties: {
          project: PROJECT_PROPERTY,
          action: { type: 'string', enum: ['search', 'read', 'gen_sources'] },
          query: { type: 'string' },
          regex: { type: 'boolean' },
          path_filter: { type: 'string', description: '例如 net/minecraft/client/render 或 net.minecraft.item' },
          scope: { type: 'array', items: { type: 'string', enum: ['minecraft', 'project', 'deps'] }, description: '默认 minecraft + project' },
          target: { type: 'string', description: 'read 的类名，例如 net.minecraft.item.Item 或 ItemRenderer' },
          start: { type: 'number' },
          lines: { type: 'number' },
          limit: { type: 'number' }
        },
        required: ['action']
      },
      annotations: { readOnlyHint: true },
      run: async (args) => {
        const project = context.project(args)
        const action = str(args, 'action') ?? 'search'
        if (action === 'gen_sources') {
          const session = await project.status()
          if (['starting', 'building'].includes(session.state) || (session.pid && session.state === 'running')) return failure('开发客户端正在运行或启动/构建中，gen_sources 可能被其锁住 Minecraft jar。已有源码可直接用 search/read；确需重新生成时，请先明确授权停止客户端并调用 mc_run action=stop，再重试。')
          const result = await project.gradle(['genSources'])
          return result.ok ? text(`已生成反编译源码（${(result.durationMs / 1000).toFixed(0)}s）`) : failure(result.output.slice(-3000))
        }
        const scopes = (Array.isArray(args.scope) && args.scope.length ? args.scope : ['minecraft', 'project']) as SourceScope[]
        const spec = await project.readSpec()
        const session = await readJson<SessionFile>(statePaths(project.projectDir).session)
        const javaPaths = [spec?.javaLauncher, session?.javaPath, ...context.options.javaPaths]
        const hasJavap = (file: string | null | undefined): file is string => !!file && existsSync(join(dirname(file), process.platform === 'win32' ? 'javap.exe' : 'javap'))
        if (scopes.includes('deps') && !javaPaths.some(hasJavap)) javaPaths.push(...await potentialJavaPaths())
        const roots = await sourceRoots(project.projectDir, statePaths(project.projectDir).sources, await context.minecraft(project), await context.sourceDirs(project), scopes, { classpath: spec?.classpath ?? [], javaPath: javaPaths.find(hasJavap) ?? null })
        const missing = [
          scopes.includes('minecraft') && !roots.some((root) => root.scope === 'minecraft') ? '还没有当前 Minecraft 版本的反编译源码：先调用 mc_source action=gen_sources' : '',
          scopes.includes('deps') && !roots.some((root) => root.scope === 'deps') ? '依赖没有可用的 sources.jar，不能从“扫描 0 个文件”推断依赖不存在这个类或方法；需要为当前项目的依赖版本取得源码' : ''
        ].filter(Boolean).map((line) => `\n（${line}）`).join('')
        if (action === 'read') {
          const target = str(args, 'target') ?? str(args, 'query')
          if (!target) return failure('read 需要 target')
          const found = await readSource(roots, target, { start: num(args, 'start'), lines: num(args, 'lines') })
          if (!found) return failure(`没找到 ${target}${missing}`)
          return text(`${found.scope}:${found.file}（第 ${found.start}–${found.end} 行，共 ${found.total} 行）\n${found.text}`)
        }
        const query = str(args, 'query')
        if (!query) return failure('search 需要 query')
        const result = await searchSources(roots, query, { regex: args.regex === true, pathFilter: str(args, 'path_filter'), limit: num(args, 'limit') ?? 60 })
        const body = result.matches.map((match) => `${match.scope}:${match.file}:${match.line}: ${match.text}`)
        return text(`${body.length ? body.join('\n') : '没有匹配'}${result.truncated ? '\n（结果已截断，缩小 path_filter 或换更具体的关键字）' : ''}\n扫描文件 ${result.filesScanned} 个${missing}`)
      }
    },
    {
      name: 'mc_mapping',
      title: '转换映射名',
      description:
        '在 official（混淆名）、intermediary（class_/method_/field_）、yarn、mojmap 之间转换类、方法、字段名。name 可以是任一命名空间的类名（全名或简单名）、成员名，或 类名#成员名。首次用 mojmap 会从 Mojang 下载约 9MB 的 client.txt 映射（校验 sha1，缓存在项目 .inkstone/dev/mappings）。',
      inputSchema: {
        type: 'object',
        properties: { project: PROJECT_PROPERTY, name: { type: 'string' }, minecraft: { type: 'string', description: '默认取项目的 Minecraft 版本' }, limit: { type: 'number' } },
        required: ['name']
      },
      annotations: { readOnlyHint: true },
      run: async (args) => {
        const name = str(args, 'name')
        if (!name) return failure('需要 name')
        let minecraft = str(args, 'minecraft') ?? null
        let cacheDir: string | null = null
        try {
          const project = context.project(args)
          minecraft ??= await context.minecraft(project)
          cacheDir = join(statePaths(project.projectDir).dir, 'mappings')
        } catch (error) {
          if (!minecraft) throw error
        }
        if (!minecraft) return failure('无法确定 Minecraft 版本，传 minecraft 参数')
        if (/^26\./.test(minecraft)) return text(`Minecraft ${minecraft} 不再混淆，开发源码使用官方类名，本工具不提供旧 intermediary/yarn 名到此版本的跨版本转换。请用 mc_source 搜索或读取对应的官方类名；无需为此重新构建项目。`)
        const table = await loadMappingTable(minecraft, cacheDir ?? join(context.options.runtimesDir, '..', 'mappings'))
        return text(`Minecraft ${minecraft}\n${formatMapping(lookupMapping(table, name, num(args, 'limit') ?? 20), table)}`)
      }
    },
    {
      name: 'mc_new_project',
      title: '新建 Fabric mod 项目',
      description: '用 Fabric 官方元数据接口查 loader、yarn、Fabric API、Loom 和 Gradle 版本，生成可构建的 Fabric 项目（1.21–1.21.1 附带示例物品和贴图）。目标目录必须为空或不存在。',
      inputSchema: {
        type: 'object',
        properties: {
          minecraft_version: { type: 'string', description: '例如 1.21.1' },
          mod_id: { type: 'string', description: '小写字母开头，只含 a-z 0-9 _ -' },
          package_name: { type: 'string', description: '例如 com.example.mymod' },
          target_dir: { type: 'string' },
          mod_name: { type: 'string' },
          mappings: { type: 'string', enum: ['yarn', 'mojmap'] }
        },
        required: ['minecraft_version', 'mod_id', 'package_name', 'target_dir']
      },
      run: async (args) => {
        const result = await createFabricProject(
          {
            minecraftVersion: str(args, 'minecraft_version') ?? '',
            modId: str(args, 'mod_id') ?? '',
            packageName: str(args, 'package_name') ?? '',
            targetDir: str(args, 'target_dir') ?? '',
            modName: str(args, 'mod_name'),
            mappings: str(args, 'mappings') === 'mojmap' ? 'mojmap' : 'yarn'
          },
          { javaPaths: context.options.javaPaths }
        )
        return text(
          [
            `已创建 ${result.projectDir}`,
            `Minecraft ${result.versions.minecraft}，loader ${result.versions.loader}，${result.mappings === 'yarn' ? `yarn ${result.versions.yarn}` : 'mojmap'}，Fabric API ${result.versions.fabricApi}，Loom ${result.versions.loom}，Gradle ${result.versions.gradle}，Java ${result.versions.javaRelease}`,
            `文件：${result.files.join('、')}`,
            '下一步：mc_run action=start project=<目录>（首次会下载 Minecraft 与依赖，几分钟）'
          ].join('\n')
        )
      }
    }
  ]
  return tools.map((tool) => ({ ...tool, annotations: { title: tool.title, ...TOOL_HINTS[tool.name] } }))
}

const TOOL_HINTS: Record<string, Record<string, boolean>> = {
  mc_build: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  mc_apply: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  mc_run: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  mc_command: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  mc_logs: { readOnlyHint: true, openWorldHint: false },
  mc_view: { readOnlyHint: true, openWorldHint: false },
  mc_texture: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  mc_inspect: { readOnlyHint: true, openWorldHint: false },
  mc_options: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  mc_source: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  mc_mapping: { readOnlyHint: true, openWorldHint: true },
  mc_new_project: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
}

const EXTRA_MODULES: Array<{ file: string; factory: string }> = [
  { file: 'tools-test.ts', factory: 'createTestTools' },
  { file: 'tools-world.ts', factory: 'createWorldTools' },
  { file: 'tools-interact.ts', factory: 'createInteractTools' },
  { file: 'tools-tick.ts', factory: 'createTickTools' }
]

export async function loadExtraTools(context: McpContext, dir = dirname(fileURLToPath(import.meta.url))): Promise<ToolDefinition[]> {
  const extras: ToolDefinition[] = []
  for (const module of EXTRA_MODULES) {
    const file = join(dir, module.file)
    if (!existsSync(file)) {
      context.options.log?.(`[inkstone] 没有 ${module.file}，跳过 ${module.factory} 的工具`)
      continue
    }
    try {
      const loaded = (await import(pathToFileURL(file).href)) as Record<string, unknown>
      const create = loaded[module.factory]
      if (typeof create !== 'function') {
        context.options.log?.(`[inkstone] ${module.file} 没有导出 ${module.factory}`)
        continue
      }
      extras.push(...((create as (context: McpContext) => ToolDefinition[])(context) ?? []))
    } catch (error) {
      context.options.log?.(`[inkstone] 加载 ${module.file} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return extras
}

export async function createToolsWithExtras(context: McpContext): Promise<ToolDefinition[]> {
  return withOperations([...createTools(context), ...(await loadExtraTools(context))], (args) => context.project(args).projectDir.toLowerCase())
}
