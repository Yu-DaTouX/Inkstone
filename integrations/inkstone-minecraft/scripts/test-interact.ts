import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { companionRequest } from '../src/core/dev/companion.ts'
import { gridRequest } from '../src/core/dev/interact.ts'
import { createImage, encodePng } from '../src/core/dev/png.ts'
import type { DevProject } from '../src/core/dev/runner.ts'
import { agentWindowJvmArgs } from '../src/core/dev/session.ts'
import type { ToolResult } from '../mcp/protocol.ts'
import { createInteractTools, INTERACT_TOOL_NAMES } from '../mcp/tools-interact.ts'
import { createTools, type McpContext } from '../mcp/tools.ts'
import { USER_IN_CONTROL } from '../mcp/tools.ts'

let passed = 0
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run()
    passed += 1
  } catch (error) {
    console.error(`✗ ${name}`)
    throw error
  }
}

const root = mkdtempSync(join(tmpdir(), 'inkstone-interact-test-'))
const shotPng = encodePng(createImage(6, 6, [30, 120, 200, 255]))
const TOKEN = 'secret-token'

type ScreenName = 'none' | 'inventory' | 'chat'

const state = {
  owner: 'agent' as 'agent' | 'user',
  screen: 'none' as ScreenName,
  chat: '',
  requests: [] as Array<{ path: string; body: Record<string, unknown> }>,
  images: [] as Array<{ path: string; body: Record<string, unknown> }>
}

const HEALTH = 20
const CHAT_MESSAGES = [
  { seq: 1, time: 1700000001000, kind: 'system', text: '已加入世界' },
  { seq: 2, time: 1700000002000, kind: 'chat', text: '<Dev> hello' },
  { seq: 3, time: 1700000003000, kind: 'actionbar', text: '你现在不能睡觉' }
]

function screenLabel(): string {
  if (state.screen === 'inventory') return 'InventoryScreen Crafting'
  if (state.screen === 'chat') return 'ChatScreen 聊天'
  return ''
}

function waitReply(body: Record<string, unknown>): unknown {
  const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : 30_000
  const tick = 200
  const miss = { ok: false, reason: 'timeout', waitedMs: timeoutMs, tick: tick + Math.round(timeoutMs / 50) }
  if (body.until === 'in_world') return { ok: true, waitedMs: 0, tick, detail: 'inkstone-test，creative，可操作' }
  if (body.until === 'screen') {
    const wanted = typeof body.screen === 'string' ? body.screen : ''
    const label = screenLabel()
    if (!label || (wanted && !label.includes(wanted))) return { ...miss, detail: state.screen === 'none' ? '当前没有界面' : `${label} 不包含「${wanted}」` }
    return { ok: true, waitedMs: 0, tick, detail: label }
  }
  if (body.until === 'no_screen') return state.screen === 'none' ? { ok: true, waitedMs: 200, tick: tick + 4 } : { ...miss, detail: `${screenLabel()} 还开着` }
  if (body.until === 'chat') {
    const since = typeof body.since === 'number' ? body.since : 0
    const match = typeof body.match === 'string' ? body.match : ''
    const found = CHAT_MESSAGES.find((message) => message.seq > since && message.text.includes(match))
    return found ? { ok: true, waitedMs: 400, tick: tick + 8, detail: `#${found.seq} ${found.text}` } : { ...miss, detail: `自 seq=${since} 后没有包含「${match}」的消息` }
  }
  if (body.until === 'ticks') {
    const ticks = typeof body.ticks === 'number' ? body.ticks : 0
    return { ok: true, waitedMs: ticks * 50, tick: tick + ticks }
  }
  if (body.until === 'entity') return { ok: true, waitedMs: 100, tick: tick + 2, detail: 'minecraft:zombie u-1' }
  if (body.until === 'player') {
    const value = body.field === 'health' ? HEALTH : 0
    const equals = body.equals
    const hit = equals !== undefined ? value === equals : typeof body.lt === 'number' ? value < body.lt : typeof body.gt === 'number' ? value > body.gt : false
    return hit ? { ok: true, waitedMs: 300, tick: tick + 6, detail: `${String(body.field)}=${value}` } : { ...miss, detail: `${String(body.field)}=${value}` }
  }
  return { ok: false, reason: 'unknown', waitedMs: 0, tick }
}

function screenPayload(): unknown {
  if (state.screen === 'none') return null
  if (state.screen === 'inventory')
    return {
      class: 'InventoryScreen',
      title: 'Crafting',
      kind: 'container',
      menu: 'minecraft:inventory',
      slots: [
        { index: 0, x: 8, y: 8, container: 'menu', item: { id: 'minecraft:stone', count: 3, components: '{}' } },
        { index: 1, x: 26, y: 8, container: 'menu', item: null },
        { index: 36, x: 8, y: 84, container: 'player', role: 'hotbar', item: { id: 'minecraft:oak_log', count: 1 } }
      ],
      widgets: [
        { id: 0, type: 'edit', label: '搜索', value: state.chat, focused: true, active: true, x: 80, y: 4, w: 80, h: 12 },
        { id: 1, type: 'button', label: '开始游戏', active: true, x: 4, y: 4, w: 60, h: 20 }
      ],
      carried: { id: 'minecraft:dirt', count: 2 }
    }
  return {
    class: 'ChatScreen',
    title: '聊天',
    kind: 'chat',
    slots: [],
    widgets: [{ id: 0, type: 'edit', label: '聊天', value: state.chat, focused: true, active: true, x: 0, y: 0, w: 320, h: 12 }]
  }
}

function inputReply(body: Record<string, unknown>): unknown {
  const target = body.target && typeof body.target === 'object' ? (body.target as Record<string, unknown>) : null
  const key = typeof body.key === 'string' ? body.key : ''
  if (body.action === 'key' && key === 'e') {
    state.screen = 'inventory'
    return { ok: true, screen: 'InventoryScreen' }
  }
  if (body.action === 'attack' || body.action === 'use') {
    if (target && Array.isArray(target.block)) return { ok: true, hit: { type: 'block', pos: target.block }, screen: null }
    if (target && typeof target.entity === 'string')
      return { ok: true, hit: { type: 'entity', entity: { uuid: 'u-1', type: 'minecraft:zombie', name: 'Zombie' } }, screen: null }
    return { ok: true, hit: { type: 'miss' }, screen: null }
  }
  return { ok: true, screen: null }
}

function scriptReply(body: Record<string, unknown>): unknown {
  const steps = Array.isArray(body.steps) ? body.steps : []
  return {
    results: steps.map((entry, index) => {
      const step = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
      const op = typeof step.op === 'string' ? step.op : ''
      const tick = 100 + index
      if (op === 'command' && step.command === '/fail') return { index, op, tick, timeMs: 4, ok: false, error: '命令不存在' }
      if (op === 'screenshot') return { index, op, tick, timeMs: 12, ok: true, result: { file: 'shot.png' }, image: shotPng.toString('base64') }
      if (op === 'wait') return { index, op, tick: tick + Number(step.ticks ?? 0), timeMs: 30, ok: true }
      if (['command', 'input', 'ui', 'player', 'chat', 'perf'].includes(op)) return { index, op, tick, timeMs: 2, ok: true, result: { path: `/echo ${op}` } }
      return { index, op, tick, timeMs: 1, ok: false, error: `不支持的 op ${op}` }
    })
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((done) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += String(chunk)
    })
    request.on('end', () => {
      try {
        done(raw ? (JSON.parse(raw) as Record<string, unknown>) : {})
      } catch {
        done({})
      }
    })
  })
}

async function fakeCompanion(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readBody(request)
  const path = (request.url ?? '').split('?')[0]
  if (request.headers.authorization !== `Bearer ${TOKEN}`) return json(response, 401, { error: 'unauthorized' })
  state.requests.push({ path, body })
  const writes = path === '/input' || path === '/script' || path === '/highlight' || path === '/wait' || (path === '/ui' && body.action !== 'read')
  if (writes && state.owner === 'user') return json(response, 423, { error: 'user_control' })
  if (path === '/control') {
    if (body.owner === 'agent' || body.owner === 'user') state.owner = body.owner
    return json(response, 200, { owner: state.owner, changedAt: 1700000000000, changedBy: 'agent' })
  }
  if (path === '/status')
    return json(response, 200, {
      playing: state.screen !== 'none',
      env: { world: 'inkstone-test', version: '1.21.1', difficulty: 'peaceful', gamemode: 'creative', lang: 'en_us', pos: [0, 64, 0], dimension: 'minecraft:overworld', paused: false }
    })
  if (path === '/input') return json(response, 200, inputReply(body))
  if (path === '/ui') {
    if (body.action === 'open') {
      state.screen = body.screen === 'chat' ? 'chat' : 'inventory'
      if (typeof body.text === 'string') state.chat = body.text
      return json(response, 200, { screen: screenPayload() })
    }
    if (body.action === 'close') {
      state.screen = 'none'
      state.chat = ''
      return json(response, 200, { screen: null })
    }
    if (body.action === 'type') {
      state.chat = typeof body.text === 'string' ? body.text : ''
      return json(response, 200, { screen: screenPayload() })
    }
    if (body.action === 'key') {
      if (body.key === 'enter') state.screen = 'none'
      return json(response, 200, { screen: screenPayload() })
    }
    if (body.action === 'read' || body.action === 'click') return json(response, 200, { screen: screenPayload() })
    return json(response, 400, { error: 'unknown ui action' })
  }
  if (path === '/chat') {
    const since = typeof body.since === 'number' ? body.since : -1
    const limit = typeof body.limit === 'number' ? body.limit : 50
    return json(response, 200, { latest: 3, messages: CHAT_MESSAGES.filter((message) => message.seq > since).slice(-limit) })
  }
  if (path === '/highlight') {
    if (body.action === 'clear') return json(response, 200, { cleared: 2 })
    return json(response, 200, { id: 'hl-1', until: 1700000030000 })
  }
  if (path === '/wait') return json(response, 200, waitReply(body))
  if (path === '/script') return json(response, 200, scriptReply(body))
  if (path === '/perf') return json(response, 200, { fps: 60, mspt: 5.24, tps: 20, memory: { used: 512.4, max: 2048 }, entities: 42, chunks: 81 })
  if (path === '/screenshot') {
    state.images.push({ path, body })
    response.writeHead(200, { 'content-type': 'image/png' })
    response.end(shotPng)
    return
  }
  json(response, 404, { error: 'unknown route' })
}

function listen(server: ReturnType<typeof createHttpServer>): Promise<number> {
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      done(typeof address === 'object' && address ? address.port : 0)
    })
  })
}

const server = createHttpServer((request, response) => {
  void fakeCompanion(request, response)
})
const port = await listen(server)
const endpoint = { port, token: TOKEN }

function toolsFor(target: { port: number; token: string }): ReturnType<typeof createInteractTools> {
  const project = {
    projectDir: root,
    companion: (path: string, body: Record<string, unknown> = {}, timeoutMs?: number) => companionRequest(target, path, body, timeoutMs),
    image: async (path: string, body: Record<string, unknown> = {}) => {
      state.images.push({ path, body })
      return shotPng
    },
    control: async () => ({ owner: state.owner })
  } as unknown as DevProject
  const context = { project: () => project } as unknown as McpContext
  return createInteractTools(context)
}

const tools = toolsFor(endpoint)
const toolOf = (name: string, list: ReturnType<typeof createInteractTools> = tools) => {
  const found = list.find((tool) => tool.name === name)
  assert.ok(found, `找不到工具 ${name}`)
  return found
}
const bodyOf = (result: ToolResult): string => result.content.map((item) => item.text ?? '').filter(Boolean).join('\n')
const firstLine = (result: ToolResult): string => bodyOf(result).split('\n')[0] ?? ''
const lastBody = (): Record<string, unknown> => state.requests[state.requests.length - 1].body

try {
  await test('工具清单：七个交互工具与只读标注', () => {
    assert.deepEqual(
      tools.map((tool) => tool.name),
      INTERACT_TOOL_NAMES
    )
    assert.equal(toolOf('mc_chat').annotations?.readOnlyHint, true)
    assert.equal(toolOf('mc_perf').annotations?.readOnlyHint, true)
    assert.equal(toolOf('mc_wait').annotations?.readOnlyHint, true)
    assert.equal(toolOf('mc_input').annotations?.destructiveHint, true)
    assert.equal(toolOf('mc_highlight').annotations?.destructiveHint, false)
    for (const tool of tools) {
      assert.ok(tool.title.length > 0)
      const properties = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>
      assert.ok(Object.keys(properties).length > 0, `${tool.name} 没有参数`)
      for (const [key, value] of Object.entries(properties)) assert.ok((value.description ?? '').length > 8, `${tool.name}.${key} 缺参数描述`)
    }
  })

  await test('输入：对准方块攻击，返回命中与界面', async () => {
    state.screen = 'none'
    const result = await toolOf('mc_input').run({ action: 'attack', target_block: [10, 64, -3], target_face: 'up' })
    assert.equal(result.isError, undefined)
    assert.equal(firstLine(result), '已攻击 (10, 64, -3) 的 up 面')
    assert.match(bodyOf(result), /命中：方块 \(10, 64, -3\)/)
    assert.match(bodyOf(result), /界面：无（仍在游戏内）/)
    assert.deepEqual(lastBody(), { action: 'attack', target: { block: [10, 64, -3], face: 'up' } })
    assert.equal(state.requests[state.requests.length - 1].path, '/input')
  })

  await test('输入：实体目标、手、按住 tick 与挥空', async () => {
    const entity = await toolOf('mc_input').run({ action: 'use', target_entity: '@e[type=minecraft:zombie,limit=1]', hand: 'off', hold_ticks: 32 })
    assert.equal(entity.isError, undefined)
    assert.equal(firstLine(entity), '已使用物品 @e[type=minecraft:zombie,limit=1]（按住 32 tick）')
    assert.match(bodyOf(entity), /命中：实体 minecraft:zombie Zombie u-1/)
    assert.deepEqual(lastBody(), { action: 'use', target: { entity: '@e[type=minecraft:zombie,limit=1]' }, hand: 'off', holdTicks: 32 })
    const miss = await toolOf('mc_input').run({ action: 'attack' })
    assert.match(firstLine(miss), /已攻击$/)
    assert.match(bodyOf(miss), /命中：没命中（挥空）/)
    assert.match(bodyOf(miss), /没指定 target/)
  })

  await test('输入：视角、移动、快捷栏与按键', async () => {
    const looked = await toolOf('mc_input').run({ action: 'look', at: [1, 2, 3] })
    assert.equal(firstLine(looked), '视角已对准 (1, 2, 3)')
    assert.deepEqual(lastBody(), { action: 'look', at: [1, 2, 3] })
    const turned = await toolOf('mc_input').run({ action: 'look', yaw: 90, pitch: 120 })
    assert.equal(firstLine(turned), '视角已设为 yaw=90、pitch=90')
    const moved = await toolOf('mc_input').run({ action: 'move', forward: 1, strafe: -0.5, sprint: true, ticks: 40 })
    assert.equal(firstLine(moved), '已移动 40 tick（forward=1、strafe=-0.5、冲刺）')
    assert.deepEqual(lastBody(), { action: 'move', forward: 1, strafe: -0.5, sprint: true, ticks: 40 })
    const slot = await toolOf('mc_input').run({ action: 'hotbar', slot: 4 })
    assert.equal(firstLine(slot), '已切到快捷栏槽 4（0–8）')
    const key = await toolOf('mc_input').run({ action: 'key', key: 'e' })
    assert.equal(firstLine(key), '已按键 e')
    assert.match(bodyOf(key), /界面：InventoryScreen/)
    assert.equal(state.screen, 'inventory')
  })

  await test('输入：参数校验先于请求', async () => {
    const before = state.requests.length
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{}, /action 不能为空/],
      [{ action: 'jump' }, /未知 action jump/],
      [{ action: 'look' }, /look 需要 yaw 与 pitch/],
      [{ action: 'attack', target_block: [1, 2, 3], target_entity: '@e' }, /只能选一个/],
      [{ action: 'attack', target_face: 'up' }, /target_face 只在/],
      [{ action: 'attack', target_block: [1, 2, 3], hold_ticks: 5 }, /hold_ticks 只在 action=use/],
      [{ action: 'move' }, /move 需要 forward/],
      [{ action: 'hotbar', slot: 9 }, /0–8/],
      [{ action: 'key' }, /key 需要 GLFW 键名/],
      [{ action: 'use', hand: 'both' }, /未知 hand/],
      [{ action: 'look', yaw: 0, pitch: 0, at: [0, 0, 0] }, /^$/]
    ]
    for (const [args, pattern] of cases) {
      const result = await toolOf('mc_input').run(args)
      if (pattern.source === '^$') {
        assert.equal(result.isError, undefined, JSON.stringify(args))
        continue
      }
      assert.equal(result.isError, true, `${JSON.stringify(args)} 应该被拒绝`)
      assert.match(firstLine(result), pattern, JSON.stringify(args))
    }
    assert.equal(state.requests.length, before + 1)
  })

  await test('界面：读背包的槽位、控件与手中物品', async () => {
    state.screen = 'inventory'
    const result = await toolOf('mc_ui').run({ action: 'read' })
    assert.equal(result.isError, undefined)
    const body = bodyOf(result)
    assert.equal(body.split('\n')[0], '界面：InventoryScreen「Crafting」（容器，menu minecraft:inventory）')
    assert.match(body, /槽位 3 个、控件 2 个/)
    assert.match(body, /0 菜单@8,8：minecraft:stone ×3/)
    assert.match(body, /空槽 1 个（序号与中心坐标）：\n {4}1$/m)
    assert.match(body, /36 快捷栏@8,84：minecraft:oak_log/)
    assert.match(body, /0 edit「搜索」@80,4 80×12（焦点）/)
    assert.match(body, /1 button「开始游戏」@4,4 60×20/)
    assert.match(body, /手中（carried）：minecraft:dirt ×2/)
    assert.deepEqual(lastBody(), { action: 'read' })
  })

  await test('界面：点击、输入、按键与打开聊天预填', async () => {
    const clicked = await toolOf('mc_ui').run({ action: 'click', slot: 3, button: 'right', shift: true })
    assert.equal(firstLine(clicked), '已点击槽位 3（右键 + shift）')
    assert.deepEqual(lastBody(), { action: 'click', slot: 3, button: 'right', shift: true })
    const widgetClick = await toolOf('mc_ui').run({ action: 'click', widget: 1 })
    assert.equal(firstLine(widgetClick), '已点击控件 1（左键）')
    const coord = await toolOf('mc_ui').run({ action: 'click', x: 12.5, y: 30 })
    assert.equal(firstLine(coord), '已点击坐标 (12.5, 30)（左键）')
    assert.deepEqual(lastBody(), { action: 'click', x: 12.5, y: 30 })
    const typed = await toolOf('mc_ui').run({ action: 'type', widget: 0, text: 'hello', replace: true, submit: true })
    assert.equal(firstLine(typed), '已输入 5 个字符到控件 0（已替换原内容，并提交）')
    assert.match(bodyOf(typed), /值「hello」/)
    assert.deepEqual(lastBody(), { action: 'type', text: 'hello', widget: 0, replace: true, submit: true })
    const opened = await toolOf('mc_ui').run({ action: 'open', screen: 'chat', text: '/give @s stone' })
    assert.equal(firstLine(opened), '已打开聊天栏，预填「/give @s stone」')
    const body = bodyOf(opened)
    assert.match(body, /界面：ChatScreen「聊天」（聊天）/)
    assert.match(body, /值「\/give @s stone」/)
    assert.deepEqual(lastBody(), { action: 'open', screen: 'chat', text: '/give @s stone' })
    const submitted = await toolOf('mc_ui').run({ action: 'key', key: 'enter' })
    assert.equal(firstLine(submitted), '已在界面内按 enter')
    assert.match(bodyOf(submitted), /界面：无（玩家在游戏内）/)
    const closed = await toolOf('mc_ui').run({ action: 'close' })
    assert.equal(firstLine(closed), '已关闭当前界面')
    assert.equal(state.screen, 'none')
  })

  await test('界面：参数校验', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ action: 'click' }, /click 需要 slot、widget 或 x\+y/],
      [{ action: 'click', x: 3 }, /x 与 y 要同时给/],
      [{ action: 'click', slot: 1, widget: 2 }, /slot 与 widget 只能选一个/],
      [{ action: 'click', slot: 1, button: 'back' }, /未知 button/],
      [{ action: 'type' }, /type 需要 text/],
      [{ action: 'key' }, /key 需要键名/],
      [{ action: 'open', screen: 'anvil' }, /未知 screen/],
      [{ action: 'drag' }, /未知 action drag/]
    ]
    for (const [args, pattern] of cases) {
      const result = await toolOf('mc_ui').run(args)
      assert.equal(result.isError, true, JSON.stringify(args))
      assert.match(firstLine(result), pattern)
    }
    assert.deepEqual(await toolOf('mc_ui').run({}).then(bodyOf).then((body) => body.split('\n')[0]), '界面：无（玩家在游戏内）')
  })

  await test('聊天：全量与增量', async () => {
    state.screen = 'none'
    const all = await toolOf('mc_chat').run({})
    assert.equal(firstLine(all), '最近 3 条消息（最新 seq=3）')
    assert.match(bodyOf(all), /#1 \d\d:\d\d:\d\d \[system\] 已加入世界/)
    assert.match(bodyOf(all), /#2 \d\d:\d\d:\d\d \[chat\] <Dev> hello/)
    assert.deepEqual(lastBody(), { limit: 50 })
    const incremental = await toolOf('mc_chat').run({ since: 2 })
    assert.equal(firstLine(incremental), '自 seq=2 之后 1 条新消息（最新 seq=3）')
    assert.match(bodyOf(incremental), /\[actionbar\] 你现在不能睡觉/)
    assert.deepEqual(lastBody(), { since: 2, limit: 50 })
    const none = await toolOf('mc_chat').run({ since: 3 })
    assert.equal(firstLine(none), '没有新消息（最新 seq=3）')
    const limited = await toolOf('mc_chat').run({ limit: 999 })
    assert.deepEqual(lastBody(), { limit: 500 })
    assert.match(bodyOf(limited), /最近 3 条消息/)
  })

  await test('脚本：按 tick 顺序执行、截图存进项目并内联图片', async () => {
    state.screen = 'none'
    const result = await toolOf('mc_script').run({
      steps: [
        { op: 'command', command: '/time set day' },
        { op: 'wait', ticks: 20 },
        { op: 'screenshot', hideHud: true }
      ]
    })
    assert.equal(result.isError, undefined)
    const body = bodyOf(result)
    assert.equal(firstLine(result), '脚本 3 步全部成功（累计 44ms，最后 tick=102）')
    assert.match(body, /#0 command 成功 tick=100 2ms/)
    assert.match(body, /结果：\{"path":"\/echo command"\}/)
    assert.match(body, /#1 wait 成功 tick=121 30ms/)
    assert.match(body, /#2 screenshot 成功 tick=102 12ms/)
    const saved = body.match(/截图 #2（screenshot）：(.+\.png)/)
    assert.ok(saved, body)
    assert.equal(saved[1].startsWith(join(root, '.inkstone', 'dev', 'shots')), true, saved[1])
    assert.equal(existsSync(saved[1]), true)
    assert.deepEqual(await readFile(saved[1]), shotPng)
    const images = result.content.filter((item) => item.type === 'image')
    assert.equal(images.length, 1)
    assert.equal(images[0].mimeType, 'image/png')
    assert.equal(images[0].data, shotPng.toString('base64'))
    const sent = lastBody()
    assert.equal(Array.isArray(sent.steps), true)
    assert.equal((sent.steps as unknown[]).length, 3)
    assert.equal(sent.timeoutTicks, undefined)
  })

  await test('脚本：可以关掉截图保存并限制内联张数', async () => {
    const many = await toolOf('mc_script').run({
      steps: [
        { op: 'screenshot' },
        { op: 'screenshot' },
        { op: 'screenshot' },
        { op: 'screenshot' },
        { op: 'screenshot' },
        { op: 'screenshot' }
      ]
    })
    assert.equal(many.content.filter((item) => item.type === 'image').length, 4)
    assert.match(bodyOf(many), /截图共 6 张，只内联前 4 张/)
    const noSave = await toolOf('mc_script').run({ steps: [{ op: 'screenshot' }], save_screenshots: false })
    assert.match(bodyOf(noSave), /脚本 1 步全部成功/)
    assert.equal(bodyOf(noSave).includes('截图 #0（screenshot）：'), false)
    assert.equal(noSave.content.filter((item) => item.type === 'image').length, 0)
    const timed = await toolOf('mc_script').run({ steps: [{ op: 'wait', ticks: 2 }], timeout_ticks: 60 })
    assert.equal(lastBody().timeoutTicks, 60)
    assert.match(bodyOf(timed), /脚本 1 步全部成功/)
  })

  await test('脚本：失败步骤让整体失败，第一行是原因', async () => {
    const result = await toolOf('mc_script').run({
      steps: [{ op: 'command', command: '/fail' }, { op: 'wait', ticks: 1 }]
    })
    assert.equal(result.isError, true)
    assert.equal(firstLine(result), '脚本 2 步中 1 步失败：第 0 步（command）命令不存在')
    assert.match(bodyOf(result), /#1 wait 成功/)
  })

  await test('脚本：本地先拒绝非法步骤', async () => {
    const before = state.requests.length
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ steps: [] }, /非空数组/],
      [{ steps: 'nope' }, /非空数组/],
      [{ steps: ['x'] }, /第 0 步不是对象/],
      [{ steps: [{}] }, /第 0 步缺少 op/],
      [{ steps: [{ op: 'teleport' }] }, /不支持/]
    ]
    for (const [args, pattern] of cases) {
      const result = await toolOf('mc_script').run(args)
      assert.equal(result.isError, true, JSON.stringify(args))
      assert.match(firstLine(result), pattern)
    }
    assert.equal(state.requests.length, before)
  })

  await test('性能：FPS、MSPT、TPS 与内存', async () => {
    const result = await toolOf('mc_perf').run({})
    assert.equal(result.isError, undefined)
    assert.equal(firstLine(result), 'FPS 60，MSPT 5.2ms，TPS 20.0')
    assert.match(bodyOf(result), /实体 42，区块 81，内存 512\/2048 MB（25%）/)
  })

  await test('高亮：实体、方块、颜色、时长与清除', async () => {
    const entity = await toolOf('mc_highlight').run({ action: 'entity', selector: '@e[type=minecraft:zombie,limit=1]', color: 'FFCC00', seconds: 45 })
    assert.equal(entity.isError, undefined)
    assert.equal(firstLine(entity), '已高亮实体 @e[type=minecraft:zombie,limit=1]（#ffcc00，45 秒，截图里直接可见）')
    assert.match(bodyOf(entity), /id=hl-1，到期 \d\d:\d\d:\d\d/)
    assert.deepEqual(lastBody(), { action: 'entity', selector: '@e[type=minecraft:zombie,limit=1]', color: '#ffcc00', seconds: 45 })
    assert.equal(state.requests[state.requests.length - 1].path, '/highlight')
    const block = await toolOf('mc_highlight').run({ action: 'block', pos: [1, 64, -2] })
    assert.equal(firstLine(block), '已高亮方块 (1, 64, -2)（默认色，30 秒，截图里直接可见）')
    assert.deepEqual(lastBody(), { action: 'block', pos: [1, 64, -2] })
    const uuid = await toolOf('mc_highlight').run({ action: 'entity', uuid: 'u-1', seconds: 900 })
    assert.equal(firstLine(uuid), '已高亮实体 u-1（默认色，600 秒，截图里直接可见）')
    assert.deepEqual(lastBody(), { action: 'entity', uuid: 'u-1', seconds: 600 })
    const cleared = await toolOf('mc_highlight').run({ action: 'clear' })
    assert.equal(firstLine(cleared), '已清除全部高亮（2 个）')
    assert.deepEqual(lastBody(), { action: 'clear' })
  })

  await test('高亮：参数校验先于请求', async () => {
    const before = state.requests.length
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{}, /action 不能为空/],
      [{ action: 'sparkle' }, /未知 action sparkle/],
      [{ action: 'entity' }, /entity 需要 selector 或 uuid/],
      [{ action: 'entity', selector: '@e', uuid: 'u-1' }, /只能选一个/],
      [{ action: 'entity', selector: '@e', color: 'red' }, /color 要写成 #rrggbb/],
      [{ action: 'block' }, /block 需要 pos/]
    ]
    for (const [args, pattern] of cases) {
      const result = await toolOf('mc_highlight').run(args)
      assert.equal(result.isError, true, JSON.stringify(args))
      assert.match(firstLine(result), pattern)
    }
    assert.equal(state.requests.length, before)
  })

  await test('等待：界面、进入世界、tick、聊天、实体与玩家条件', async () => {
    state.screen = 'inventory'
    const screen = await toolOf('mc_wait').run({ until: 'screen', screen: 'Crafting' })
    assert.equal(screen.isError, undefined)
    assert.equal(firstLine(screen), '已等到：界面类名或标题包含「Crafting」（等了 0ms，tick=200）')
    assert.match(bodyOf(screen), /当时：InventoryScreen Crafting/)
    assert.deepEqual(lastBody(), { until: 'screen', screen: 'Crafting' })
    assert.equal(state.requests[state.requests.length - 1].path, '/wait')
    const anyScreen = await toolOf('mc_wait').run({ until: 'screen' })
    assert.equal(firstLine(anyScreen), '已等到：任意界面打开（等了 0ms，tick=200）')
    assert.deepEqual(lastBody(), { until: 'screen' })
    const inWorld = await toolOf('mc_wait').run({ until: 'in_world' })
    assert.equal(firstLine(inWorld), '已等到：进入世界且可操作（等了 0ms，tick=200）')
    const waitTicks = await toolOf('mc_wait').run({ until: 'ticks', ticks: 40, timeout_ms: 2000, poll_ticks: 1 })
    assert.equal(firstLine(waitTicks), '已等到：40 tick（等了 2000ms，tick=240）')
    assert.deepEqual(lastBody(), { until: 'ticks', ticks: 40, timeoutMs: 2000, pollTicks: 1 })
    const chat = await toolOf('mc_wait').run({ until: 'chat', match: 'hello', since: 1 })
    assert.equal(firstLine(chat), '已等到：聊天出现「hello」（等了 400ms，tick=208）')
    assert.match(bodyOf(chat), /当时：#2 <Dev> hello/)
    assert.deepEqual(lastBody(), { until: 'chat', match: 'hello', since: 1 })
    const entity = await toolOf('mc_wait').run({ until: 'entity', selector: '@e[type=minecraft:zombie]' })
    assert.equal(firstLine(entity), '已等到：选择器 @e[type=minecraft:zombie] 有匹配（等了 100ms，tick=202）')
    const player = await toolOf('mc_wait').run({ until: 'player', field: 'health', gt: 10 })
    assert.equal(firstLine(player), '已等到：玩家 health 大于 10（等了 300ms，tick=206）')
    assert.deepEqual(lastBody(), { until: 'player', field: 'health', gt: 10 })
    const equal = await toolOf('mc_wait').run({ until: 'player', field: 'health', equals: 20 })
    assert.equal(firstLine(equal), '已等到：玩家 health 等于 20（等了 300ms，tick=206）')
    assert.deepEqual(lastBody(), { until: 'player', field: 'health', equals: 20 })
  })

  await test('等待：超时先给结论而不是抛错', async () => {
    state.screen = 'none'
    const timeout = await toolOf('mc_wait').run({ until: 'screen', timeout_ms: 500 })
    assert.equal(timeout.isError, true)
    assert.equal(firstLine(timeout), '等待超时：任意界面打开（500ms 内没等到，tick=210，已等 500ms）')
    assert.match(bodyOf(timeout), /当时：当前没有界面/)
    assert.match(bodyOf(timeout), /别直接加大 timeout 重试/)
    const chatMiss = await toolOf('mc_wait').run({ until: 'chat', match: '不会出现', since: 3, timeout_ms: 200 })
    assert.equal(chatMiss.isError, true)
    assert.match(firstLine(chatMiss), /^等待超时：聊天出现「不会出现」/)
    assert.match(bodyOf(chatMiss), /自 seq=3 后没有包含「不会出现」的消息/)
    const playerMiss = await toolOf('mc_wait').run({ until: 'player', field: 'health', lt: 10, timeout_ms: 200 })
    assert.equal(playerMiss.isError, true)
    assert.match(bodyOf(playerMiss), /当时：health=20/)
    state.screen = 'inventory'
  })

  await test('等待：参数校验与取值限制', async () => {
    const before = state.requests.length
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{}, /until 不能为空/],
      [{ until: 'spawned' }, /未知 until spawned/],
      [{ until: 'ticks' }, /ticks 需要 ticks/],
      [{ until: 'chat' }, /chat 需要 match/],
      [{ until: 'entity' }, /entity 需要 selector/],
      [{ until: 'player' }, /player 需要 field/],
      [{ until: 'player', field: 'health' }, /equals、lt 或 gt/]
    ]
    for (const [args, pattern] of cases) {
      const result = await toolOf('mc_wait').run(args)
      assert.equal(result.isError, true, JSON.stringify(args))
      assert.match(firstLine(result), pattern)
    }
    assert.equal(state.requests.length, before)
    const clamped = await toolOf('mc_wait').run({ until: 'ticks', ticks: 0, timeout_ms: 1, poll_ticks: 9999 })
    assert.equal(clamped.isError, undefined)
    assert.deepEqual(lastBody(), { until: 'ticks', ticks: 1, timeoutMs: 100, pollTicks: 200 })
  })

  await test('截图：mc_view 与 mc_script 转发 grid', async () => {
    assert.equal(gridRequest(true), true)
    assert.deepEqual(gridRequest({ step: 25 }), { step: 25 })
    assert.deepEqual(gridRequest(30), { step: 30 })
    assert.equal(gridRequest(undefined), undefined)
    const project = {
      projectDir: root,
      image: async (path: string, body: Record<string, unknown> = {}) => {
        state.images.push({ path, body })
        return shotPng
      },
      control: async () => ({ owner: 'agent' } as const)
    } as unknown as DevProject
    const view = createTools({ project: () => project } as unknown as McpContext).find((tool) => tool.name === 'mc_view')
    assert.ok(view)
    const plain = await view.run({ target: 'screen' })
    assert.equal(plain.content.filter((item) => item.type === 'image').length, 1)
    assert.deepEqual(state.images[state.images.length - 1].body, {})
    const gridded = await view.run({ target: 'screen', grid: true })
    assert.equal(gridded.content.filter((item) => item.type === 'image').length, 1)
    assert.equal(state.images[state.images.length - 1].path, '/screenshot')
    assert.deepEqual(state.images[state.images.length - 1].body, { grid: true })
    const stepped = await view.run({ target: 'screen', grid: { step: 25 }, crop: [0, 0, 4, 4] })
    assert.equal(stepped.isError, undefined)
    assert.deepEqual(state.images[state.images.length - 1].body, { crop: [0, 0, 4, 4], grid: { step: 25 } })
    const scripted = await toolOf('mc_script').run({ steps: [{ op: 'screenshot', grid: { step: 10 } }] })
    assert.equal(scripted.isError, undefined)
    assert.deepEqual((lastBody().steps as Array<Record<string, unknown>>)[0].grid, { step: 10 })
  })

  await test('启动参数：默认传后台输入模式', () => {
    const args = agentWindowJvmArgs(root)
    assert.ok(args.includes('-Dinkstone.input=background'), args.join(' '))
    assert.ok(args.includes('-Dinkstone.control=agent'), args.join(' '))
  })

  await test('用户接管：写操作统一拒绝，只读照常', async () => {
    state.owner = 'user'
    state.screen = 'inventory'
    state.chat = ''
    try {
      const writes: Array<[string, Record<string, unknown>]> = [
        ['mc_input', { action: 'attack' }],
        ['mc_input', { action: 'key', key: 'e' }],
        ['mc_ui', { action: 'click', slot: 0 }],
        ['mc_ui', { action: 'type', text: 'x' }],
        ['mc_ui', { action: 'close' }],
        ['mc_script', { steps: [{ op: 'wait', ticks: 1 }] }],
        ['mc_highlight', { action: 'clear' }],
        ['mc_wait', { until: 'in_world' }]
      ]
      for (const [name, args] of writes) {
        const result = await toolOf(name).run(args)
        assert.equal(result.isError, true, `${name} ${JSON.stringify(args)} 应该被拒绝`)
        assert.equal(bodyOf(result), USER_IN_CONTROL)
        assert.equal(firstLine(result), USER_IN_CONTROL)
      }
      assert.equal(state.screen, 'inventory')
      assert.equal(state.chat, '')
      const read = await toolOf('mc_ui').run({ action: 'read' })
      assert.equal(read.isError, undefined)
      assert.match(bodyOf(read), /界面：InventoryScreen/)
      const chat = await toolOf('mc_chat').run({ since: 1 })
      assert.equal(chat.isError, undefined)
      assert.match(bodyOf(chat), /自 seq=1 之后 2 条新消息/)
      const perf = await toolOf('mc_perf').run({})
      assert.equal(perf.isError, undefined)
      assert.match(firstLine(perf), /^FPS 60/)
    } finally {
      state.owner = 'agent'
    }
  })

  await test('错误：token 不对、旧版本没有路由、进程不可达', async () => {
    const wrong = toolsFor({ port, token: 'wrong' })
    const unauthorized = await toolOf('mc_perf', wrong).run({})
    assert.equal(unauthorized.isError, true)
    assert.match(firstLine(unauthorized), /伴随 mod 返回 HTTP 401：unauthorized/)

    const bare = createHttpServer((request, response) => {
      void readBody(request).then(() => json(response, 404, { error: 'unknown route' }))
    })
    const barePort = await listen(bare)
    try {
      const legacy = toolsFor({ port: barePort, token: TOKEN })
      const missing = await toolOf('mc_ui', legacy).run({ action: 'read' })
      assert.equal(missing.isError, true)
      assert.match(firstLine(missing), /伴随 mod 返回 HTTP 404：unknown route（伴随 mod 可能还是旧版本/)
    } finally {
      bare.close()
    }

    const closed = createHttpServer(() => undefined)
    const closedPort = await listen(closed)
    await new Promise<void>((done) => closed.close(() => done()))
    const offline = toolsFor({ port: closedPort, token: TOKEN })
    const failed = await toolOf('mc_input', offline).run({ action: 'look', yaw: 0, pitch: 0 })
    assert.equal(failed.isError, true)
    assert.match(firstLine(failed), /伴随 mod 请求失败/)
    assert.match(firstLine(failed), /开发客户端没在运行|fetch failed|ECONNREFUSED/)
    assert.equal((await toolOf('mc_script', offline).run({ steps: [{ op: 'wait', ticks: 1 }] })).isError, true)
  })

  await test('错误：伴随 mod 报错原样带回', async () => {
    const broken = createHttpServer((request, response) => {
      void readBody(request).then(() => json(response, 503, { error: '还没进入世界' }))
    })
    const brokenPort = await listen(broken)
    try {
      const result = await toolOf('mc_perf', toolsFor({ port: brokenPort, token: TOKEN })).run({})
      assert.equal(result.isError, true)
      assert.match(firstLine(result), /HTTP 503：还没进入世界（还没进入世界）/)
    } finally {
      broken.close()
    }
  })

  console.log(`✓ ${passed} 项通过`)
} finally {
  server.close()
  rmSync(root, { recursive: true, force: true })
}
