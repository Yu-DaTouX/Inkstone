import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CompanionError } from '../src/core/dev/companion.ts'
import {
  isUserControlError,
  sendChat,
  sendHighlight,
  sendInput,
  sendPerf,
  sendScript,
  sendUi,
  sendWait,
  scriptTimeout,
  type BlockFace,
  type ChatReply,
  type ChatRequest,
  type CompanionItem,
  type CompanionSender,
  type HighlightReply,
  type HighlightRequest,
  type HitResult,
  type InputHand,
  type InputReply,
  type InputRequest,
  type InputTarget,
  type PerfReply,
  type ScriptReply,
  type ScriptStep,
  type UiReply,
  type UiRequest,
  type UiScreen,
  type UiSlot,
  type UiWidget,
  type WaitReply,
  type WaitRequest,
  type WaitUntil
} from '../src/core/dev/interact.ts'
import { statePaths } from '../src/core/dev/session.ts'
import type { DevProject } from '../src/core/dev/runner.ts'
import { failure, text, type ToolContent, type ToolDefinition, type ToolResult } from './protocol.ts'
import { USER_IN_CONTROL, type McpContext } from './tools.ts'
import { tickCommands } from './tools-tick.ts'

const PROJECT_PROPERTY = { type: 'string', description: 'Fabric mod 项目根目录（含 build.gradle）。省略时用 INKSTONE_MC_PROJECT 或当前目录' }

const MAX_IMAGES = 4
const MAX_TEXT = 400

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const value = typeof args[key] === 'string' ? Number(args[key]) : args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function triple(args: Record<string, unknown>, key: string): [number, number, number] | undefined {
  const value = args[key]
  if (!Array.isArray(value) || value.length !== 3) return undefined
  const parsed = value.map((item) => (typeof item === 'string' ? Number(item) : item))
  return parsed.every((item) => typeof item === 'number' && Number.isFinite(item)) ? (parsed as [number, number, number]) : undefined
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function shorten(value: string, limit = MAX_TEXT): string {
  return value.length > limit ? `${value.slice(0, limit)}…（共 ${value.length} 字，已截断）` : value
}

function point(value: [number, number, number]): string {
  return `(${value.map((item) => (Number.isInteger(item) ? String(item) : item.toFixed(2))).join(', ')})`
}

function sender(project: DevProject): CompanionSender {
  return (path, body, timeoutMs) => project.companion(path, body, timeoutMs)
}

function companionFailure(error: unknown): ToolResult {
  if (isUserControlError(error)) return failure(USER_IN_CONTROL)
  if (error instanceof CompanionError) {
    const detail = error.message.includes(`HTTP ${error.status}`) ? '' : `：${error.message}`
    const hint = error.status === 404 ? '（伴随 mod 可能还是旧版本，没有这个路由；先重新编译并重启开发客户端）' : error.status === 503 ? '（还没进入世界）' : ''
    return failure(`伴随 mod 返回 HTTP ${error.status}${detail}${hint}`)
  }
  const message = error instanceof Error ? error.message : String(error)
  return failure(`伴随 mod 请求失败：${message}${/fetch failed|ECONNREFUSED/i.test(message) ? '（开发客户端没在运行，或伴随 mod 未连接）' : ''}`)
}

function itemText(item: CompanionItem | null | undefined): string {
  if (!item) return '空'
  return item.count > 1 ? `${item.id} ×${item.count}` : item.id
}

function hitText(hit: HitResult): string {
  if (hit.type === 'miss') return '没命中（挥空）'
  if (hit.type === 'block') return `方块 ${hit.pos ? point(hit.pos) : '（未给坐标）'}`
  return `实体 ${hit.entity ?? '（未给实体）'}`
}

function faceText(target: InputTarget | undefined): string {
  if (!target) return ''
  if ('block' in target) return ` ${point(target.block)}${target.face ? ` 的 ${target.face} 面` : ''}`
  return ` ${target.entity}`
}

function inputRequest(args: Record<string, unknown>): InputRequest {
  const action = str(args, 'action')
  if (!action) throw new Error('action 不能为空：attack、use、look、move、hotbar、key 之一')
  if (!['attack', 'use', 'look', 'move', 'hotbar', 'key'].includes(action)) throw new Error(`未知 action ${action}：attack、use、look、move、hotbar、key 之一`)
  const block = triple(args, 'target_block')
  const entity = str(args, 'target_entity')
  if (block && entity) throw new Error('target_block 与 target_entity 只能选一个')
  const face = str(args, 'target_face')
  if (face && !block) throw new Error('target_face 只在给了 target_block 时可用')
  if (face && !['up', 'down', 'north', 'south', 'east', 'west'].includes(face)) throw new Error(`未知 target_face ${face}：up、down、north、south、east、west 之一`)
  const hand = str(args, 'hand')
  if (hand && hand !== 'main' && hand !== 'off') throw new Error(`未知 hand ${hand}：main 或 off`)
  const request: InputRequest = { action: action as InputRequest['action'] }

  if (action === 'attack' || action === 'use') {
    if (block) request.target = face ? { block, face: face as BlockFace } : { block }
    if (entity) request.target = { entity }
    if (hand) request.hand = hand as InputHand
    const holdTicks = num(args, 'hold_ticks')
    if (holdTicks !== undefined) {
      if (action !== 'use') throw new Error('hold_ticks 只在 action=use 时可用')
      request.holdTicks = clamp(Math.round(holdTicks), 1, 400)
    }
    return request
  }

  if (action === 'look') {
    const at = triple(args, 'at')
    const yaw = num(args, 'yaw')
    const pitch = num(args, 'pitch')
    if (at) {
      request.at = at
      return request
    }
    if (yaw === undefined || pitch === undefined) throw new Error('look 需要 yaw 与 pitch，或 at 坐标')
    request.yaw = yaw
    request.pitch = clamp(pitch, -90, 90)
    return request
  }

  if (action === 'move') {
    const forward = num(args, 'forward') ?? 0
    const strafe = num(args, 'strafe') ?? 0
    const jump = args.jump === true
    const sneak = args.sneak === true
    const sprint = args.sprint === true
    if (forward === 0 && strafe === 0 && !jump && !sneak && !sprint) throw new Error('move 需要 forward、strafe，或 jump/sneak/sprint 之一')
    request.forward = clamp(forward, -1, 1)
    request.strafe = clamp(strafe, -1, 1)
    if (jump) request.jump = true
    if (sneak) request.sneak = true
    if (sprint) request.sprint = true
    request.ticks = clamp(Math.round(num(args, 'ticks') ?? 1), 1, 1200)
    return request
  }

  if (action === 'hotbar') {
    const slot = num(args, 'slot')
    if (slot === undefined) throw new Error('hotbar 需要 slot（0–8）')
    if (!Number.isInteger(slot) || slot < 0 || slot > 8) throw new Error(`slot 必须是 0–8 的整数，收到 ${slot}`)
    request.slot = slot
    return request
  }

  const key = str(args, 'key')
  if (!key) throw new Error('key 需要 GLFW 键名，例如 e、escape、f3、left_shift')
  request.key = key
  const holdTicks = num(args, 'hold_ticks')
  if (holdTicks !== undefined) request.holdTicks = clamp(Math.round(holdTicks), 1, 400)
  return request
}

function inputConclusion(request: InputRequest): string {
  if (request.action === 'attack') return `已攻击${faceText(request.target)}`
  if (request.action === 'use') return `已使用物品${faceText(request.target)}${request.holdTicks ? `（按住 ${request.holdTicks} tick）` : ''}`
  if (request.action === 'look') return request.at ? `视角已对准 ${point(request.at)}` : `视角已设为 yaw=${request.yaw}、pitch=${request.pitch}`
  if (request.action === 'move') {
    const flags = [request.jump ? '跳' : '', request.sneak ? '潜行' : '', request.sprint ? '冲刺' : ''].filter(Boolean)
    return `已移动 ${request.ticks} tick（forward=${request.forward}、strafe=${request.strafe}${flags.length ? `、${flags.join('、')}` : ''}）`
  }
  if (request.action === 'hotbar') return `已切到快捷栏槽 ${request.slot}（0–8）`
  return `已按键 ${request.key}${request.holdTicks ? `（按住 ${request.holdTicks} tick）` : ''}`
}

function formatInput(request: InputRequest, reply: InputReply): string {
  const lines = [inputConclusion(request)]
  if (reply.hit) lines.push(`命中：${hitText(reply.hit)}`)
  if (request.action === 'attack' || request.action === 'use') {
    if (!request.target) lines.push('目标：没指定 target，按准星当前指向执行')
  }
  lines.push(reply.screen ? `界面：${reply.screen}` : '界面：无（仍在游戏内）')
  return lines.join('\n')
}

function uiRequest(args: Record<string, unknown>): UiRequest {
  const action = str(args, 'action') ?? 'read'
  if (action === 'read') return { action: 'read' }
  if (action === 'close') return { action: 'close' }
  if (action === 'click') {
    const slot = num(args, 'slot')
    const widget = num(args, 'widget')
    const x = num(args, 'x')
    const y = num(args, 'y')
    const button = str(args, 'button')
    if (button && !['left', 'right', 'middle'].includes(button)) throw new Error(`未知 button ${button}：left、right、middle 之一`)
    if (slot !== undefined && widget !== undefined) throw new Error('slot 与 widget 只能选一个')
    if ((x !== undefined) !== (y !== undefined)) throw new Error('x 与 y 要同时给（GUI 坐标）')
    if (slot === undefined && widget === undefined && x === undefined) throw new Error('click 需要 slot、widget 或 x+y')
    const request: UiRequest = { action: 'click' }
    if (slot !== undefined) request.slot = Math.round(slot)
    if (widget !== undefined) request.widget = Math.round(widget)
    if (x !== undefined && y !== undefined) {
      request.x = x
      request.y = y
    }
    if (button) request.button = button as 'left' | 'right' | 'middle'
    if (args.shift === true) request.shift = true
    return request
  }
  if (action === 'hover') {
    const slot = num(args, 'slot')
    const x = num(args, 'x')
    const y = num(args, 'y')
    if ((x !== undefined) !== (y !== undefined)) throw new Error('x 与 y 要同时给（GUI 坐标）')
    if (slot !== undefined && x !== undefined) throw new Error('slot 与 x+y 只能选一个')
    if (slot !== undefined) return { action: 'hover', slot: Math.round(slot) }
    if (x !== undefined && y !== undefined) return { action: 'hover', x, y }
    throw new Error('hover 需要 slot 或 x+y')
  }
  if (action === 'type') {
    const value = typeof args.text === 'string' ? args.text : undefined
    if (value === undefined) throw new Error('type 需要 text')
    const request: UiRequest = { action: 'type', text: value }
    const widget = num(args, 'widget')
    if (widget !== undefined) request.widget = Math.round(widget)
    if (args.replace === true) request.replace = true
    if (args.submit === true) request.submit = true
    return request
  }
  if (action === 'key') {
    const key = str(args, 'key')
    if (!key) throw new Error('key 需要键名，例如 enter、tab、escape')
    return { action: 'key', key }
  }
  if (action === 'open') {
    const screen = str(args, 'screen')
    if (screen !== 'inventory' && screen !== 'chat') throw new Error(`未知 screen ${screen ?? ''}：inventory 或 chat`)
    const request: UiRequest = { action: 'open', screen }
    const value = typeof args.text === 'string' ? args.text : undefined
    if (value !== undefined) request.text = value
    return request
  }
  throw new Error(`未知 action ${action}：read、click、hover、type、key、close、open 之一`)
}

const KIND_TEXT: Record<UiScreen['kind'], string> = {
  container: '容器',
  chat: '聊天',
  sign: '告示牌',
  book: '书',
  anvil: '铁砧',
  creative: '创造模式物品',
  other: '其他'
}

function formatWidget(widget: UiWidget): string {
  const flags = [widget.focused ? '焦点' : '', widget.active ? '' : '禁用', widget.value ? `值「${shorten(widget.value, 80)}」` : ''].filter(Boolean)
  return `  ${widget.id} ${widget.type}「${shorten(widget.label, 80)}」@${widget.x},${widget.y} ${widget.w}×${widget.h}${flags.length ? `（${flags.join('，')}）` : ''}`
}

function formatSlot(slot: UiSlot): string {
  const center = slot.cx !== undefined && slot.cy !== undefined ? ` 中心${slot.cx},${slot.cy}` : ''
  return `  ${slot.index} ${slot.container === 'player' ? '背包' : '菜单'}@${slot.x},${slot.y}${center}：${itemText(slot.item)}`
}

function formatScreen(screen: UiScreen | null, slotLimit = 60, widgetLimit = 40): string {
  if (!screen) return '界面：无（玩家在游戏内）'
  const head = `界面：${screen.class}「${screen.title}」（${KIND_TEXT[screen.kind]}${screen.menu ? `，menu ${screen.menu}` : ''}）`
  const scale = screen.guiScale ? `；GUI 缩放 ${screen.guiScale}，截图像素 = GUI 坐标 × ${screen.guiScale}` : ''
  const lines = [head, `槽位 ${screen.slots.length} 个、控件 ${screen.widgets.length} 个${scale}`]
  if (screen.hover) lines.push(`悬停：GUI 坐标 (${screen.hover.x}, ${screen.hover.y})，下一帧按这里绘制悬停与 tooltip，直到再操作界面或真实鼠标移动`)
  lines.push(...screen.slots.slice(0, slotLimit).map(formatSlot))
  if (screen.slots.length > slotLimit) lines.push(`  …还有 ${screen.slots.length - slotLimit} 个槽位没列出`)
  lines.push(...screen.widgets.slice(0, widgetLimit).map(formatWidget))
  if (screen.widgets.length > widgetLimit) lines.push(`  …还有 ${screen.widgets.length - widgetLimit} 个控件没列出`)
  if (screen.carried !== undefined) lines.push(`手中（carried）：${itemText(screen.carried)}`)
  return lines.join('\n')
}

function uiConclusion(request: UiRequest): string {
  if (request.action === 'read') return ''
  if (request.action === 'click') {
    const button = request.button ?? 'left'
    const what = request.slot !== undefined ? `槽位 ${request.slot}` : request.widget !== undefined ? `控件 ${request.widget}` : `坐标 (${request.x}, ${request.y})`
    return `已点击${what}（${button === 'left' ? '左键' : button === 'right' ? '右键' : '中键'}${request.shift ? ' + shift' : ''}）`
  }
  if (request.action === 'hover') return `已悬停在${request.slot !== undefined ? `槽位 ${request.slot}` : `坐标 (${request.x}, ${request.y})`}`
  if (request.action === 'type') {
    const flags = [request.replace ? '已替换原内容' : '', request.submit ? '并提交' : ''].filter(Boolean)
    return `已输入 ${request.text.length} 个字符${request.widget !== undefined ? `到控件 ${request.widget}` : ''}${flags.length ? `（${flags.join('，')}）` : ''}`
  }
  if (request.action === 'key') return `已在界面内按 ${request.key}`
  if (request.action === 'close') return '已关闭当前界面'
  return `已打开${request.screen === 'chat' ? '聊天栏' : '背包'}${request.text ? `，预填「${shorten(request.text, 80)}」` : ''}`
}

function formatUi(request: UiRequest, reply: UiReply): string {
  const head = uiConclusion(request)
  const tooltip = reply.tooltip?.length ? `\n\n物品提示（tooltip）：\n${reply.tooltip.map((line) => `  ${line}`).join('\n')}` : request.action === 'hover' && request.slot !== undefined ? '\n\n物品提示：槽位为空' : ''
  const body = formatScreen(reply.screen) + tooltip
  return head ? `${head}\n\n${body}` : body
}

function clockText(time: number): string {
  if (!Number.isFinite(time) || time <= 0) return '--:--:--'
  const date = new Date(time)
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((value) => String(value).padStart(2, '0')).join(':')
}

function formatChat(request: ChatRequest, reply: ChatReply): string {
  const count = reply.messages.length
  const head = count
    ? request.since !== undefined
      ? `自 seq=${request.since} 之后 ${count} 条新消息（最新 seq=${reply.latest}）`
      : `最近 ${count} 条消息（最新 seq=${reply.latest}）`
    : request.since !== undefined
      ? `没有新消息（最新 seq=${reply.latest}）`
      : '没有消息'
  const lines = reply.messages.map((message) => `#${message.seq} ${clockText(message.time)} [${message.kind}] ${shorten(message.text)}`)
  return [head, ...lines].join('\n')
}

function shotStamp(): string {
  const now = new Date()
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`
}

interface SavedShot {
  index: number
  op: string
  path: string
}

function shotDir(projectDir: string): string {
  return join(statePaths(projectDir).dir, 'shots')
}

async function saveShots(projectDir: string, reply: ScriptReply): Promise<SavedShot[]> {
  const withImage = reply.results.filter((result) => result.image)
  if (!withImage.length) return []
  const dir = shotDir(projectDir)
  await mkdir(dir, { recursive: true })
  const stamp = shotStamp()
  const saved: SavedShot[] = []
  for (const result of withImage) {
    const op = (result.op || 'step').replace(/[^\w-]/g, '_')
    const file = join(dir, `${stamp}-${String(result.index).padStart(2, '0')}-${op}.png`)
    await writeFile(file, result.image as Buffer)
    saved.push({ index: result.index, op: result.op, path: file })
  }
  return saved
}

function stepSummary(value: unknown): string {
  if (value === undefined || value === null) return ''
  const body = typeof value === 'string' ? value : JSON.stringify(value)
  return shorten(body, 320)
}

function formatScript(reply: ScriptReply, saved: SavedShot[]): { body: string; failed: boolean } {
  const total = reply.results.length
  const failedSteps = reply.results.filter((result) => !result.ok)
  const durationMs = reply.results.reduce((sum, result) => sum + result.timeMs, 0)
  const lastTick = reply.results.length ? reply.results[reply.results.length - 1].tick : 0
  const head = failedSteps.length
    ? `脚本 ${total} 步中 ${failedSteps.length} 步失败：第 ${failedSteps[0].index} 步（${failedSteps[0].op}）${failedSteps[0].error ?? '未知原因'}`
    : total
      ? `脚本 ${total} 步全部成功（累计 ${durationMs}ms，最后 tick=${lastTick}）`
      : '脚本没有返回任何步骤结果'
  const lines = [head]
  for (const result of reply.results) {
    const status = result.ok ? '成功' : `失败：${result.error ?? '未知原因'}`
    lines.push(`#${result.index} ${result.op} ${status} tick=${result.tick} ${result.timeMs}ms`)
    const summary = stepSummary(result.result)
    if (summary) lines.push(`  结果：${summary}`)
  }
  if (saved.length) lines.push(...saved.map((shot) => `截图 #${shot.index}（${shot.op}）：${shot.path}`))
  return { body: lines.join('\n'), failed: failedSteps.length > 0 }
}

function perfLines(perf: PerfReply): string {
  const percent = perf.memory.max > 0 ? Math.round((perf.memory.used / perf.memory.max) * 100) : 0
  return [
    `FPS ${perf.fps}，MSPT ${perf.mspt.toFixed(1)}ms，TPS ${perf.tps.toFixed(1)}`,
    `实体 ${perf.entities}，区块 ${perf.chunks}，内存 ${Math.round(perf.memory.used)}/${Math.round(perf.memory.max)} MB（${percent}%）`
  ].join('\n')
}

const HIGHLIGHT_COLOR = /^#?([0-9a-fA-F]{6})$/
const HIGHLIGHT_SECONDS_DEFAULT = 30
const HIGHLIGHT_SECONDS_MAX = 600

function colorValue(args: Record<string, unknown>): string | undefined {
  const value = str(args, 'color')
  if (!value) return undefined
  const match = HIGHLIGHT_COLOR.exec(value)
  if (!match) throw new Error(`color 要写成 #rrggbb，收到 ${value}`)
  return `#${match[1].toLowerCase()}`
}

function secondsValue(args: Record<string, unknown>): number | undefined {
  const seconds = num(args, 'seconds')
  return seconds === undefined ? undefined : clamp(Math.round(seconds), 1, HIGHLIGHT_SECONDS_MAX)
}

function highlightRequest(args: Record<string, unknown>): HighlightRequest {
  const action = str(args, 'action')
  if (!action) throw new Error('action 不能为空：entity、block、clear 之一')
  if (action === 'clear') return { action: 'clear' }
  const color = colorValue(args)
  const seconds = secondsValue(args)
  if (action === 'entity') {
    const selector = str(args, 'selector')
    const uuid = str(args, 'uuid')
    if (selector && uuid) throw new Error('selector 与 uuid 只能选一个')
    if (!selector && !uuid) throw new Error('entity 需要 selector 或 uuid')
    const request: HighlightRequest = { action: 'entity' }
    if (selector) request.selector = selector
    if (uuid) request.uuid = uuid
    if (color) request.color = color
    if (seconds !== undefined) request.seconds = seconds
    return request
  }
  if (action === 'block') {
    const pos = triple(args, 'pos')
    if (!pos) throw new Error('block 需要 pos：[x, y, z] 方块坐标')
    const request: HighlightRequest = { action: 'block', pos }
    if (color) request.color = color
    if (seconds !== undefined) request.seconds = seconds
    return request
  }
  throw new Error(`未知 action ${action}：entity、block、clear 之一`)
}

function formatHighlight(request: HighlightRequest, reply: HighlightReply): string {
  if (request.action === 'clear') return reply.cleared === undefined ? '已清除全部高亮' : `已清除全部高亮（${reply.cleared} 个）`
  const what = request.action === 'entity' ? `实体 ${request.selector ?? request.uuid}` : `方块 ${point(request.pos)}`
  const seconds = request.seconds ?? HIGHLIGHT_SECONDS_DEFAULT
  const lines = [`已高亮${what}（${request.color ?? '默认色'}，${seconds} 秒，截图里直接可见）`]
  lines.push(`id=${reply.id ?? '（未给）'}，到期 ${reply.until ? clockText(reply.until) : '（未给）'}；提前结束用 action=clear`)
  return lines.join('\n')
}

const WAIT_UNTIL = ['in_world', 'screen', 'no_screen', 'chat', 'ticks', 'entity', 'player']

function waitRequest(args: Record<string, unknown>): WaitRequest {
  const until = str(args, 'until')
  if (!until) throw new Error(`until 不能为空：${WAIT_UNTIL.join('、')} 之一`)
  if (!WAIT_UNTIL.includes(until)) throw new Error(`未知 until ${until}：${WAIT_UNTIL.join('、')} 之一`)
  const request: WaitRequest = { until: until as WaitUntil }
  if (until === 'screen') {
    const screen = typeof args.screen === 'string' ? args.screen.trim() : undefined
    if (screen) request.screen = screen
  }
  if (until === 'chat') {
    const match = str(args, 'match')
    if (!match) throw new Error('chat 需要 match：要等的聊天文本片段')
    request.match = match
    const since = num(args, 'since')
    if (since !== undefined) request.since = Math.max(0, Math.round(since))
  }
  if (until === 'ticks') {
    const ticks = num(args, 'ticks')
    if (ticks === undefined) throw new Error('ticks 需要 ticks：要等的 tick 数')
    request.ticks = clamp(Math.round(ticks), 1, 24_000)
  }
  if (until === 'entity') {
    const selector = str(args, 'selector')
    if (!selector) throw new Error('entity 需要 selector')
    request.selector = selector
  }
  if (until === 'player') {
    const field = str(args, 'field')
    if (!field) throw new Error('player 需要 field：玩家字段，例如 health、food、xp_level')
    request.field = field
    const equals = args.equals
    const lt = num(args, 'lt')
    const gt = num(args, 'gt')
    const hasEquals = typeof equals === 'number' || typeof equals === 'string' || typeof equals === 'boolean'
    if (!hasEquals && lt === undefined && gt === undefined) throw new Error('player 需要 equals、lt 或 gt 之一')
    if (hasEquals) request.equals = equals as number | string | boolean
    if (lt !== undefined) request.lt = lt
    if (gt !== undefined) request.gt = gt
  }
  const timeoutMs = num(args, 'timeout_ms')
  if (timeoutMs !== undefined) request.timeoutMs = clamp(Math.round(timeoutMs), 100, 600_000)
  const pollTicks = num(args, 'poll_ticks')
  if (pollTicks !== undefined) request.pollTicks = clamp(Math.round(pollTicks), 1, 200)
  return request
}

function waitGoal(request: WaitRequest): string {
  if (request.until === 'in_world') return '进入世界且可操作'
  if (request.until === 'screen') return request.screen ? `界面类名或标题包含「${request.screen}」` : '任意界面打开'
  if (request.until === 'no_screen') return '界面关闭'
  if (request.until === 'chat') return `聊天出现「${request.match}」`
  if (request.until === 'ticks') return `${request.ticks} tick`
  if (request.until === 'entity') return `选择器 ${request.selector} 有匹配`
  const compare = request.equals !== undefined ? `等于 ${String(request.equals)}` : request.lt !== undefined ? `小于 ${request.lt}` : `大于 ${request.gt}`
  return `玩家 ${request.field} ${compare}`
}

function formatWait(request: WaitRequest, reply: WaitReply): { body: string; failed: boolean } {
  const goal = waitGoal(request)
  const timeoutMs = request.timeoutMs ?? 30_000
  if (reply.ok) {
    const lines = [`已等到：${goal}（等了 ${reply.waitedMs}ms，tick=${reply.tick}）`]
    if (reply.detail) lines.push(`当时：${reply.detail}`)
    return { body: lines.join('\n'), failed: false }
  }
  const reason = reply.reason === 'timeout' ? `${timeoutMs}ms 内没等到` : (reply.reason ?? '没等到')
  const lines = [`等待超时：${goal}（${reason}，tick=${reply.tick}，已等 ${reply.waitedMs}ms）`]
  if (reply.detail) lines.push(`当时：${reply.detail}`)
  lines.push('先查现场（mc_ui read / mc_inspect what=player / mc_chat），别直接加大 timeout 重试')
  return { body: lines.join('\n'), failed: true }
}

function scriptSteps(args: Record<string, unknown>): ScriptStep[] {
  const raw = args.steps
  if (!Array.isArray(raw) || !raw.length) throw new Error('steps 需要非空数组，每步形如 {"op":"command","command":"/time set day"}')
  return raw.flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`第 ${index} 步不是对象`)
    const step = entry as Record<string, unknown>
    const op = step.op
    if (typeof op !== 'string' || !op.trim()) throw new Error(`第 ${index} 步缺少 op`)
    if (op.trim() === 'tick') {
      try {
        return tickCommands(step).map((command) => ({ op: 'command' as const, command }))
      } catch (error) {
        throw new Error(`第 ${index} 步 tick：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (!['command', 'input', 'ui', 'wait', 'screenshot', 'player', 'chat', 'perf'].includes(op.trim())) throw new Error(`第 ${index} 步 op=${op} 不支持：command、input、ui、wait、screenshot、player、chat、perf、tick 之一`)
    return [step as ScriptStep]
  })
}

export function createInteractTools(context: McpContext): ToolDefinition[] {
  return [
    {
      name: 'mc_input',
      title: '操作游戏内输入',
      description:
        '像玩家一样操作开发客户端，返回是否命中、打开的界面。action=attack/use 可带 target_block（先对准方块再打/用，可指定面）或 target_entity（选择器或 UUID），use 的 hold_ticks 用于拉弓、进食；look 用 yaw/pitch 或 at 坐标；move 走 forward/strafe（-1..1，负值后退/左移）若干 ticks，可加 jump/sneak/sprint；hotbar 切 0–8 快捷栏槽；key 按 GLFW 键名（e 开背包、escape 关界面、f3 调试）。用户接管开发客户端时会被拒绝。',
      inputSchema: {
        type: 'object',
        properties: {
          project: PROJECT_PROPERTY,
          action: { type: 'string', enum: ['attack', 'use', 'look', 'move', 'hotbar', 'key'], description: 'attack 左键、use 右键、look 转视角、move 移动、hotbar 切槽位、key 按键' },
          target_block: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'attack/use 的目标方块世界坐标 [x,y,z]，会先把视角对准它' },
          target_face: { type: 'string', enum: ['up', 'down', 'north', 'south', 'east', 'west'], description: 'target_block 的命中面，默认 up（顶面）' },
          target_entity: { type: 'string', description: 'attack/use 的目标实体：选择器（@e[type=minecraft:zombie,limit=1,sort=nearest]）或 UUID，二者与 target_block 只能选一个' },
          hand: { type: 'string', enum: ['main', 'off'], description: 'attack/use 用手，默认 main' },
          hold_ticks: { type: 'number', description: 'use 持续按住的 tick 数（拉弓、进食）；key 也可用，按住时长。1 秒 = 20 tick' },
          yaw: { type: 'number', description: 'look：水平角，0 为南，90 为西' },
          pitch: { type: 'number', description: 'look：俯仰角，-90..90，负值向上' },
          at: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'look：看向的世界坐标 [x,y,z]，与 yaw/pitch 二选一（按眼睛位置自动算角度）' },
          forward: { type: 'number', description: 'move：前进量 -1..1，负值后退，默认 0' },
          strafe: { type: 'number', description: 'move：平移量 -1..1，正值向右，默认 0' },
          jump: { type: 'boolean', description: 'move：同时按住跳跃' },
          sneak: { type: 'boolean', description: 'move：同时潜行' },
          sprint: { type: 'boolean', description: 'move：同时冲刺' },
          ticks: { type: 'number', description: 'move：持续 tick 数，默认 1（20 tick = 1 秒），上限 1200' },
          slot: { type: 'number', description: 'hotbar：快捷栏槽位 0–8' },
          key: { type: 'string', description: 'key：GLFW 键名，例如 e、escape、f3、left_shift、space' }
        },
        required: ['action']
      },
      annotations: { title: '操作游戏内输入', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      run: async (args) => {
        const project = context.project(args)
        let request: InputRequest
        try {
          request = inputRequest(args)
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error))
        }
        try {
          return text(formatInput(request, await sendInput(sender(project), request)))
        } catch (error) {
          return companionFailure(error)
        }
      }
    },
    {
      name: 'mc_ui',
      title: '读界面并操作界面',
      description:
        '读开发客户端当前界面并操作它：action=read 返回界面类名、标题、GUI 缩放、槽位（菜单/背包、左上角与中心坐标、物品）和控件（按钮、输入框、复选框、滑块，含 id、标签、值、焦点、位置）；click 点槽位（可右键、shift）、控件 id 或 GUI 坐标（按下并松开，手上物品可放下）；hover 把鼠标停在槽位或 GUI 坐标上，返回该槽物品的 tooltip 文本，之后 mc_view 截图能看到悬停提示框；type 往输入框写文本（replace 先清空、submit 回车提交）；key 在界面内按键；close 关界面；open 打开 inventory 或 chat（chat 可预填 text 以读补全）。每个操作都返回执行后的界面。用户接管时只有 read 可用。',
      inputSchema: {
        type: 'object',
        properties: {
          project: PROJECT_PROPERTY,
          action: { type: 'string', enum: ['read', 'click', 'hover', 'type', 'key', 'close', 'open'], description: 'read 读界面（默认）、click 点击、hover 悬停、type 输入、key 按键、close 关闭、open 打开' },
          slot: { type: 'number', description: 'click/hover：槽位序号（来自 read 的 slots[].index）' },
          widget: { type: 'number', description: 'click/type：控件 id（来自 read 的 widgets[].id，同一界面内稳定）' },
          x: { type: 'number', description: 'click/hover：界面 GUI 坐标 x，需要和 y 一起给；点槽位用 slots[].cx' },
          y: { type: 'number', description: 'click/hover：界面 GUI 坐标 y；点槽位用 slots[].cy' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'click：鼠标键，默认 left' },
          shift: { type: 'boolean', description: 'click：按住 shift（快速移动整叠）' },
          text: { type: 'string', description: 'type：要写入的文本；open 且 screen=chat 时可预填聊天栏文本' },
          replace: { type: 'boolean', description: 'type：先清空输入框原有内容' },
          submit: { type: 'boolean', description: 'type：输入后按回车提交（聊天发送、搜索框执行）' },
          key: { type: 'string', description: 'key：界面内按键，例如 enter、tab、escape' },
          screen: { type: 'string', enum: ['inventory', 'chat'], description: 'open：要打开的界面' }
        },
        required: ['action']
      },
      annotations: { title: '读界面并操作界面', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      run: async (args) => {
        const project = context.project(args)
        let request: UiRequest
        try {
          request = uiRequest(args)
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error))
        }
        try {
          return text(formatUi(request, await sendUi(sender(project), request)))
        } catch (error) {
          return companionFailure(error)
        }
      }
    },
    {
      name: 'mc_chat',
      title: '读聊天与系统消息',
      description:
        '读开发客户端聊天记录（伴随 mod 启动起缓存最近 500 条）：聊天、系统消息、actionbar、title/subtitle。since 只取该序号之后的新消息（配合上次的 latest 做增量轮询），limit 限制条数（默认 50）。发送聊天或执行客户端命令用 mc_command via=chat。',
      inputSchema: {
        type: 'object',
        properties: {
          project: PROJECT_PROPERTY,
          since: { type: 'number', description: '只要序号大于它的消息；不填返回最新的 limit 条' },
          limit: { type: 'number', description: '最多返回多少条，默认 50，上限 500' }
        }
      },
      annotations: { title: '读聊天与系统消息', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      run: async (args) => {
        const project = context.project(args)
        const request: ChatRequest = {}
        const since = num(args, 'since')
        if (since !== undefined) request.since = Math.max(0, Math.round(since))
        const limit = num(args, 'limit')
        request.limit = clamp(Math.round(limit ?? 50), 1, 500)
        try {
          return text(formatChat(request, await sendChat(sender(project), request)))
        } catch (error) {
          return companionFailure(error)
        }
      }
    },
    {
      name: 'mc_script',
      title: '按 tick 跑一串步骤',
      description:
        '在客户端 tick 上按顺序执行一串步骤并一次性返回每步结果与截图，适合精确到 tick 的复现：steps 每步用 op 指定动作——command（command、check、via）、input（与 mc_input 参数相同）、ui（与 mc_ui 参数相同）、wait（ticks）、screenshot（hideHud、crop、grid）、player、chat（since、limit）、perf、tick（参数同 mc_tick，本地转成 /tick 命令步，reset 展开成 unfreeze + rate 20 两步）。截图要照坐标点界面时给 screenshot 步加 grid:true（或 grid:{step:25}）在图上叠坐标网格与刻度。返回每步的 tick、耗时、结果或错误；截图自动存到项目 .inkstone/dev/shots 并一起返回图片。任一步失败时整体算失败，第一行就是失败原因。用户接管时会被拒绝。',
      inputSchema: {
        type: 'object',
        properties: {
          project: PROJECT_PROPERTY,
          steps: {
            type: 'array',
            description: '按顺序执行的步骤数组，至少一步',
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: ['command', 'input', 'ui', 'wait', 'screenshot', 'player', 'chat', 'perf', 'tick'], description: '步骤类型；tick 步用 mc_tick 的参数，本地展开成 /tick command 步' },
                command: { type: 'string', description: 'op=command：命令文本' },
                check: { type: 'boolean', description: 'op=command：只解析不执行' },
                via: { type: 'string', enum: ['server', 'chat'], description: 'op=command：server 走服务端命令源（默认），chat 走客户端聊天发送' },
                action: { type: 'string', description: 'op=input/ui：动作名，与 mc_input / mc_ui 的 action 相同' },
                ticks: { type: 'number', description: 'op=wait：等待的 tick 数' },
                text: { type: 'string', description: 'op=ui：要输入的文本' },
                key: { type: 'string', description: 'op=input/ui：键名' },
                hideHud: { type: 'boolean', description: 'op=screenshot：隐藏界面与 HUD' },
                crop: { type: 'array', items: { type: 'number' }, description: 'op=screenshot：裁剪区域 [x,y,w,h]' },
                grid: { description: 'op=screenshot：在返回的图上叠坐标网格与刻度（GUI 坐标，与 mc_ui click 的 x/y 同一套），true 默认步长 50，也可写 {"step":25}', type: ['boolean', 'object'] }
              },
              required: ['op'],
              additionalProperties: true
            }
          },
          timeout_ticks: { type: 'number', description: '整串步骤的总超时 tick 数，默认 200' },
          save_screenshots: { type: 'boolean', description: '把返回的截图存到项目 .inkstone/dev/shots，默认 true' }
        },
        required: ['steps']
      },
      annotations: { title: '按 tick 跑一串步骤', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      run: async (args) => {
        const project = context.project(args)
        let steps: ScriptStep[]
        try {
          steps = scriptSteps(args)
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error))
        }
        const timeoutTicks = num(args, 'timeout_ticks')
        const request = timeoutTicks === undefined ? { steps } : { steps, timeoutTicks: clamp(Math.round(timeoutTicks), 1, 24000) }
        let reply: ScriptReply
        try {
          reply = await sendScript(sender(project), request, scriptTimeout(request))
        } catch (error) {
          return companionFailure(error)
        }
        let saved: SavedShot[] = []
        let saveNote = ''
        if (args.save_screenshots !== false && reply.results.some((result) => result.image)) {
          try {
            saved = await saveShots(project.projectDir, reply)
          } catch (error) {
            saveNote = `\n截图保存失败：${error instanceof Error ? error.message : String(error)}`
          }
        }
        const formatted = formatScript(reply, saved)
        const body = `${formatted.body}${saveNote}`
        const content: ToolContent[] = [{ type: 'text', text: body }]
        for (const shot of saved.slice(0, MAX_IMAGES)) {
          const png = reply.results.find((result) => result.index === shot.index)?.image
          if (png) content.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' })
        }
        if (saved.length > MAX_IMAGES) content[0].text += `\n（截图共 ${saved.length} 张，只内联前 ${MAX_IMAGES} 张；其余见上面的路径）`
        return { content, isError: formatted.failed || undefined }
      }
    },
    {
      name: 'mc_perf',
      title: '看性能',
      description: '读开发客户端性能：FPS、MSPT（每 tick 毫秒）、TPS、堆内存已用/上限、加载的实体数与区块数。排查卡顿、验证优化前后差异时用。',
      inputSchema: {
        type: 'object',
        properties: { project: PROJECT_PROPERTY }
      },
      annotations: { title: '看性能', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      run: async (args) => {
        const project = context.project(args)
        try {
          return text(perfLines(await sendPerf(sender(project))))
        } catch (error) {
          return companionFailure(error)
        }
      }
    },
    {
      name: 'mc_highlight',
      title: '高亮测试对象',
      description:
        '给要测的东西加看得见的高亮，自己截图时、用户看画面时都能直接找到：action=entity 用 selector（@e[type=minecraft:zombie,limit=1,sort=nearest]）或 uuid 圈出实体轮廓；action=block 用 pos=[x,y,z] 给方块描框；action=clear 清掉全部。color 写 #rrggbb，seconds 默认 30、上限 600，到期自动消失。返回高亮 id 与到期时间。只影响渲染，不改实体与方块的存档数据。用户接管时会被拒绝。',
      inputSchema: {
        type: 'object',
        properties: {
          project: PROJECT_PROPERTY,
          action: { type: 'string', enum: ['entity', 'block', 'clear'], description: 'entity 高亮实体、block 高亮方块、clear 清除全部高亮' },
          selector: { type: 'string', description: 'entity：选择器，例如 @e[type=minecraft:zombie,limit=1,sort=nearest]，与 uuid 只能选一个' },
          uuid: { type: 'string', description: 'entity：实体 UUID，适合操作后要盯住同一个实体' },
          pos: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'block：方块世界坐标 [x, y, z]' },
          color: { type: 'string', description: '高亮颜色 #rrggbb，例如 #ffcc00；不填用默认色' },
          seconds: { type: 'number', description: '高亮持续秒数，默认 30，上限 600' }
        },
        required: ['action']
      },
      annotations: { title: '高亮测试对象', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      run: async (args) => {
        const project = context.project(args)
        let request: HighlightRequest
        try {
          request = highlightRequest(args)
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error))
        }
        try {
          return text(formatHighlight(request, await sendHighlight(sender(project), request)))
        } catch (error) {
          return companionFailure(error)
        }
      }
    },
    {
      name: 'mc_wait',
      title: '等游戏里的事发生',
      description:
        '等一件事发生，等到立刻返回，超时也返回结论，用它代替反复截图/读界面轮询。until 取：in_world（已进入世界且玩家可操作）、screen（界面类名或标题包含 screen，不给 screen 表示任意界面已打开）、no_screen（界面已关闭）、chat（自 since 之后聊天或系统消息包含 match）、ticks（等 ticks 个 tick）、entity（selector 有匹配）、player（玩家字段满足条件，配 equals、lt 或 gt，例如 field=health lt=10）。timeout_ms 默认 30000，poll_ticks 默认 2。等到时第一行是「已等到」，超时时第一行是「等待超时」与原因。等待期间用户按 F8 接管会立即返回拒绝。',
      inputSchema: {
        type: 'object',
        properties: {
          project: PROJECT_PROPERTY,
          until: { type: 'string', enum: ['in_world', 'screen', 'no_screen', 'chat', 'ticks', 'entity', 'player'], description: '要等的事：in_world、screen、no_screen、chat、ticks、entity、player' },
          screen: { type: 'string', description: 'until=screen：界面类名或标题要包含的字符串，例如 InventoryScreen、Crafting；不填表示任意界面打开' },
          match: { type: 'string', description: 'until=chat：要等的聊天或系统消息文本片段' },
          since: { type: 'number', description: 'until=chat：只看序号大于它的消息（来自 mc_chat 的 latest），避免拿到旧消息' },
          ticks: { type: 'number', description: 'until=ticks：要等的 tick 数，20 tick = 1 秒' },
          selector: { type: 'string', description: 'until=entity：选择器，例如 @e[type=minecraft:zombie]' },
          field: { type: 'string', description: 'until=player：玩家字段，例如 health、food、xp_level、onGround' },
          equals: { description: 'until=player：字段等于这个值（数字、字符串或布尔）' },
          lt: { type: 'number', description: 'until=player：字段小于这个值' },
          gt: { type: 'number', description: 'until=player：字段大于这个值' },
          timeout_ms: { type: 'number', description: '最多等多少毫秒，默认 30000，上限 600000' },
          poll_ticks: { type: 'number', description: '每多少 tick 检查一次，默认 2' }
        },
        required: ['until']
      },
      annotations: { title: '等游戏里的事发生', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      run: async (args) => {
        const project = context.project(args)
        let request: WaitRequest
        try {
          request = waitRequest(args)
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error))
        }
        let reply: WaitReply
        try {
          reply = await sendWait(sender(project), request)
        } catch (error) {
          return companionFailure(error)
        }
        const formatted = formatWait(request, reply)
        return { content: [{ type: 'text', text: formatted.body }], isError: formatted.failed || undefined }
      }
    }
  ]
}

export const INTERACT_TOOL_NAMES = ['mc_input', 'mc_ui', 'mc_chat', 'mc_script', 'mc_perf', 'mc_highlight', 'mc_wait']
