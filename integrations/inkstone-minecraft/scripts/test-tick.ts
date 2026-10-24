import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { companionRequest } from '../src/core/dev/companion.ts'
import type { DevProject } from '../src/core/dev/runner.ts'
import type { ToolResult } from '../mcp/protocol.ts'
import { createInteractTools } from '../mcp/tools-interact.ts'
import { createTickTools, parseTickOutput, tickCommands } from '../mcp/tools-tick.ts'
import { createTools, loadExtraTools, USER_IN_CONTROL, type McpContext } from '../mcp/tools.ts'

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

const root = mkdtempSync(join(tmpdir(), 'inkstone-tick-test-'))
const TOKEN = 'tick-token'
const MCP_DIR = fileURLToPath(new URL('../mcp/', import.meta.url))

const state = {
  owner: 'agent' as 'agent' | 'user',
  frozen: false,
  rate: 20,
  requests: [] as Array<{ path: string; body: Record<string, unknown> }>
}

function tickReply(command: string): { ok: boolean; output: string[] } {
  const parts = command.trim().split(/\s+/)
  if (parts[0] !== 'tick') return { ok: false, output: [`Unknown or incomplete command: ${command}`] }
  const sub = parts[1] ?? ''
  if (sub === 'query')
    return {
      ok: true,
      output: [
        state.frozen ? 'The game is frozen' : 'The game is running normally',
        `Target tick rate: ${state.rate.toFixed(1)} per second`,
        'Average time per tick: 5.000ms (20.0 TPS)'
      ]
    }
  if (sub === 'rate') {
    const value = Number(parts[2])
    if (!(value >= 1 && value <= 10000)) return { ok: false, output: ['The tick rate must be a positive number'] }
    state.rate = value
    return { ok: true, output: [`Successfully set the target tick rate to ${value} per second`] }
  }
  if (sub === 'freeze') {
    state.frozen = true
    return { ok: true, output: ['Froze the game'] }
  }
  if (sub === 'unfreeze') {
    state.frozen = false
    return { ok: true, output: ['Unfroze the game'] }
  }
  if (sub === 'step') {
    const ticks = Number(parts[2] ?? 1)
    return state.frozen ? { ok: true, output: [`Stepping ${ticks} tick(s)`] } : { ok: false, output: [`Could not step ${ticks} tick(s)`] }
  }
  if (sub === 'sprint') {
    if (parts[2] === 'stop') return { ok: true, output: ['Successfully stopped the sprint'] }
    return { ok: true, output: [`Sprinting for ${parts[2]} ticks`] }
  }
  return { ok: false, output: [`Incorrect argument for command: ${sub}`] }
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

function scriptReply(body: Record<string, unknown>): unknown {
  const steps = Array.isArray(body.steps) ? body.steps : []
  return {
    results: steps.map((entry, index) => {
      const step = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
      return { index, op: typeof step.op === 'string' ? step.op : '', tick: 100 + index, timeMs: 1, ok: true }
    })
  }
}

async function fakeCompanion(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readBody(request)
  const path = (request.url ?? '').split('?')[0]
  if (request.headers.authorization !== `Bearer ${TOKEN}`) return json(response, 401, { error: 'unauthorized' })
  state.requests.push({ path, body })
  if (path === '/command' && state.owner === 'user') return json(response, 423, { error: 'user_control' })
  if (path === '/command') {
    const command = typeof body.command === 'string' ? body.command : ''
    const reply = tickReply(command)
    return json(response, 200, { ok: reply.ok, command, output: reply.output })
  }
  if (path === '/status')
    return json(response, 200, {
      env: { world: 'inkstone-test', version: '1.21.1', difficulty: 'peaceful', gamemode: 'creative', lang: 'en_us', pos: [0, 64, 0], dimension: 'minecraft:overworld', paused: false }
    })
  if (path === '/perf') return json(response, 200, { fps: 60, mspt: 5, tps: 20, memory: { used: 512, max: 2048 }, entities: 42, chunks: 81 })
  if (path === '/script') return json(response, 200, scriptReply(body))
  return json(response, 404, { error: 'unknown route' })
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

const SESSION = { state: 'running', companionReady: true, pid: 4242, minecraftVersion: '1.21.1', world: 'inkstone-test' }

function projectFor(target = endpoint): DevProject {
  return {
    projectDir: root,
    companion: (path: string, body: Record<string, unknown> = {}, timeoutMs?: number) => companionRequest(target, path, body, timeoutMs),
    control: async () => ({ owner: state.owner }),
    status: async () => SESSION,
    stop: async () => ({ ...SESSION, state: 'stopped' }),
    restart: async () => SESSION
  } as unknown as DevProject
}

const project = projectFor()
const context = { project: () => project, options: { log: () => undefined, runtimesDir: root, javaPaths: [], maxMemoryMb: 2048 } } as unknown as McpContext
const tools = createTickTools(context)
const tool = tools[0]
const bodyOf = (result: ToolResult): string => result.content.map((item) => item.text ?? '').filter(Boolean).join('\n')
const firstLine = (result: ToolResult): string => bodyOf(result).split('\n')[0] ?? ''
const lastBody = (): Record<string, unknown> => state.requests[state.requests.length - 1].body
const resetTick = () => {
  state.frozen = false
  state.rate = 20
}

try {
  await test('注册：tools.ts 的 EXTRA_MODULES 能加载 mc_tick', async () => {
    const extras = await loadExtraTools(context, MCP_DIR)
    const names = extras.map((item) => item.name)
    assert.ok(names.includes('mc_tick'), names.join(' '))
    const listed = extras.find((item) => item.name === 'mc_tick')
    assert.equal(listed?.title, '调游戏 tick 速度与单步')
    assert.ok(listed?.description.includes('mc_wait'))
  })

  await test('工具清单：动作、参数说明与标注', () => {
    assert.deepEqual(
      tools.map((item) => item.name),
      ['mc_tick']
    )
    assert.ok(tool.title.length > 0)
    assert.match(tool.description, /1–10000/)
    assert.match(tool.description, /不影响渲染帧率/)
    assert.match(tool.description, /toast/)
    assert.match(tool.description, /reset/)
    assert.equal(tool.annotations?.readOnlyHint, false)
    assert.equal(tool.annotations?.destructiveHint, false)
    const properties = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string; enum?: string[] }>
    assert.deepEqual(properties.action.enum, ['status', 'rate', 'freeze', 'unfreeze', 'step', 'sprint', 'reset'])
    for (const [key, value] of Object.entries(properties)) assert.ok((value.description ?? '').length > 8, `${key} 缺参数描述`)
    assert.deepEqual(tool.inputSchema.required, ['action'])
  })

  await test('解析：英文与中文回显', () => {
    const frozen = parseTickOutput(['The game is frozen', 'Target tick rate: 5.0 per second', 'Average time per tick: 5.000ms (20.0 TPS)'])
    assert.equal(frozen.frozen, true)
    assert.equal(frozen.rate, 5)
    assert.equal(frozen.tps, 20)
    const running = parseTickOutput(['The game is running normally', 'Target tick rate: 20.0 per second'])
    assert.equal(running.frozen, false)
    assert.equal(running.rate, 20)
    assert.equal(parseTickOutput(['Froze the game']).frozen, true)
    assert.equal(parseTickOutput(['Unfroze the game']).frozen, false)
    const chinese = parseTickOutput(['游戏已冻结', '目标刻速率：每秒 2.5'])
    assert.equal(chinese.frozen, true)
    assert.equal(chinese.rate, 2.5)
    assert.equal(parseTickOutput(['游戏正常运行']).frozen, false)
    assert.equal(parseTickOutput(['Sprinting for 100 ticks']).sprintTicks, 100)
    const empty = parseTickOutput([])
    assert.equal(empty.rate, null)
    assert.equal(empty.frozen, null)
    assert.equal(empty.tps, null)
  })

  await test('命令构造与参数校验', () => {
    assert.deepEqual(tickCommands({}), ['tick query'])
    assert.deepEqual(tickCommands({ action: 'status' }), ['tick query'])
    assert.deepEqual(tickCommands({ action: 'rate', rate: 30 }), ['tick rate 30'])
    assert.deepEqual(tickCommands({ action: 'rate', rate: '2.5' }), ['tick rate 2.5'])
    assert.deepEqual(tickCommands({ action: 'freeze' }), ['tick freeze'])
    assert.deepEqual(tickCommands({ action: 'unfreeze' }), ['tick unfreeze'])
    assert.deepEqual(tickCommands({ action: 'step' }), ['tick step 1'])
    assert.deepEqual(tickCommands({ action: 'step', ticks: 5 }), ['tick step 5'])
    assert.deepEqual(tickCommands({ action: 'sprint', ticks: 100 }), ['tick sprint 100'])
    assert.deepEqual(tickCommands({ action: 'sprint', stop: true }), ['tick sprint stop'])
    assert.deepEqual(tickCommands({ action: 'reset', rate: 3 }), ['tick unfreeze', 'tick rate 20'])
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ action: 'rate' }, /需要 rate/],
      [{ action: 'rate', rate: 0 }, /1–10000/],
      [{ action: 'rate', rate: 10001 }, /1–10000/],
      [{ action: 'step', ticks: 0 }, /至少 1/],
      [{ action: 'sprint' }, /需要 ticks/],
      [{ action: 'sprint', ticks: -2 }, /至少 1/],
      [{ action: 'slowmo' }, /未知 action slowmo/]
    ]
    for (const [args, pattern] of cases) assert.throws(() => tickCommands(args), pattern, JSON.stringify(args))
  })

  await test('状态：结论第一行，回显在后', async () => {
    resetTick()
    state.frozen = true
    const result = await tool.run({ action: 'status' })
    assert.equal(result.isError, undefined)
    assert.equal(firstLine(result), 'tick：速率 20/秒 · 已冻结（只按 step 推进） · TPS 20')
    assert.match(bodyOf(result), /回显：\n\/tick query\nThe game is frozen/)
    assert.equal(state.requests[state.requests.length - 1].path, '/command')
    assert.deepEqual(lastBody(), { command: 'tick query' })
    resetTick()
  })

  await test('调速率：执行后回读状态并提醒 reset', async () => {
    resetTick()
    const before = state.requests.length
    const result = await tool.run({ action: 'rate', rate: 30 })
    assert.equal(result.isError, undefined)
    assert.equal(firstLine(result), 'tick：速率 30/秒 · 运行中 · TPS 20')
    assert.match(bodyOf(result), /已执行：\/tick rate 30/)
    assert.match(bodyOf(result), /Successfully set the target tick rate to 30 per second/)
    assert.match(bodyOf(result), /提示：测完用 action=reset/)
    assert.equal(state.rate, 30)
    const sent = state.requests.slice(before).map((entry) => entry.body.command)
    assert.deepEqual(sent, ['tick rate 30', 'tick query'])
    resetTick()
  })

  await test('冻结与解冻', async () => {
    resetTick()
    const frozen = await tool.run({ action: 'freeze' })
    assert.equal(frozen.isError, undefined)
    assert.equal(firstLine(frozen), 'tick：速率 20/秒 · 已冻结（只按 step 推进） · TPS 20')
    assert.match(bodyOf(frozen), /\/tick freeze\nFroze the game/)
    assert.equal(state.frozen, true)
    const unfrozen = await tool.run({ action: 'unfreeze' })
    assert.equal(unfrozen.isError, undefined)
    assert.equal(firstLine(unfrozen), 'tick：速率 20/秒 · 运行中 · TPS 20')
    assert.equal(bodyOf(unfrozen).includes('提示：'), false)
    assert.equal(state.frozen, false)
  })

  await test('单步：只在冻结时推进，失败给提示', async () => {
    resetTick()
    const notFrozen = await tool.run({ action: 'step', ticks: 5 })
    assert.equal(notFrozen.isError, true)
    assert.equal(firstLine(notFrozen), '命令失败：/tick step 5 → Could not step 5 tick(s)')
    assert.match(bodyOf(notFrozen), /先 action=freeze 再 step/)
    assert.equal(state.frozen, false)
    await tool.run({ action: 'freeze' })
    const stepped = await tool.run({ action: 'step', ticks: 3 })
    assert.equal(stepped.isError, undefined)
    assert.match(bodyOf(stepped), /Stepping 3 tick\(s\)/)
    assert.equal(bodyOf(stepped).includes('命令失败'), false)
    const single = await tool.run({ action: 'step' })
    assert.match(bodyOf(single), /\/tick step 1\nStepping 1 tick\(s\)/)
    resetTick()
  })

  await test('冲刺：定时与提前停止', async () => {
    resetTick()
    const sprint = await tool.run({ action: 'sprint', ticks: 100 })
    assert.equal(sprint.isError, undefined)
    assert.match(bodyOf(sprint), /已执行：\/tick sprint 100/)
    assert.match(firstLine(sprint), /冲刺剩 100 tick/)
    assert.match(bodyOf(sprint), /Sprinting for 100 ticks/)
    const stopped = await tool.run({ action: 'sprint', stop: true })
    assert.match(bodyOf(stopped), /已执行：\/tick sprint stop/)
    assert.match(bodyOf(stopped), /Successfully stopped the sprint/)
    resetTick()
  })

  await test('reset：解除冻结并把速率调回 20', async () => {
    state.frozen = true
    state.rate = 4
    const before = state.requests.length
    const result = await tool.run({ action: 'reset' })
    assert.equal(result.isError, undefined)
    assert.equal(firstLine(result), 'tick：速率 20/秒 · 运行中 · TPS 20')
    assert.match(bodyOf(result), /已执行：\/tick unfreeze、\/tick rate 20/)
    assert.equal(state.frozen, false)
    assert.equal(state.rate, 20)
    const sent = state.requests.slice(before).map((entry) => entry.body.command)
    assert.deepEqual(sent, ['tick unfreeze', 'tick rate 20', 'tick query'])
    assert.equal(bodyOf(result).includes('提示：'), false)
  })

  await test('参数校验先于请求', async () => {
    resetTick()
    const before = state.requests.length
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ action: 'rate' }, /需要 rate/],
      [{ action: 'rate', rate: 0 }, /1–10000/],
      [{ action: 'rate', rate: 20000 }, /1–10000/],
      [{ action: 'sprint' }, /需要 ticks/],
      [{ action: 'teleport' }, /未知 action teleport/]
    ]
    for (const [args, pattern] of cases) {
      const result = await tool.run(args)
      assert.equal(result.isError, true, JSON.stringify(args))
      assert.match(firstLine(result), pattern)
    }
    assert.equal(state.requests.length, before)
  })

  await test('用户接管：423 统一拒绝文案', async () => {
    resetTick()
    state.owner = 'user'
    try {
      for (const args of [{ action: 'freeze' }, { action: 'rate', rate: 5 }, { action: 'reset' }, { action: 'status' }]) {
        const result = await tool.run(args)
        assert.equal(result.isError, true, JSON.stringify(args))
        assert.equal(bodyOf(result), USER_IN_CONTROL)
      }
      assert.equal(state.frozen, false)
      assert.equal(state.rate, 20)
    } finally {
      state.owner = 'agent'
    }
  })

  await test('脚本：op=tick 转成 command 步，reset 展开两步', async () => {
    resetTick()
    const script = createInteractTools(context).find((item) => item.name === 'mc_script')
    assert.ok(script)
    const result = await script.run({
      steps: [{ op: 'tick', action: 'freeze' }, { op: 'tick', action: 'reset' }, { op: 'tick', action: 'sprint', stop: true }, { op: 'tick', action: 'step', ticks: 2 }],
      save_screenshots: false
    })
    assert.equal(result.isError, undefined)
    const forwarded = (lastBody().steps as Array<Record<string, unknown>>).map((step) => `${String(step.op)} ${String(step.command)}`)
    assert.deepEqual(forwarded, ['command tick freeze', 'command tick unfreeze', 'command tick rate 20', 'command tick sprint stop', 'command tick step 2'])
    assert.match(firstLine(result), /脚本 5 步全部成功/)
  })

  await test('脚本：非法 tick 步在本地被拒绝', async () => {
    const script = createInteractTools(context).find((item) => item.name === 'mc_script')
    assert.ok(script)
    const before = state.requests.length
    const result = await script.run({ steps: [{ op: 'tick', action: 'rate', rate: 99999 }] })
    assert.equal(result.isError, true)
    assert.match(firstLine(result), /第 0 步 tick：rate 要在 1–10000 之间/)
    assert.equal(state.requests.length, before)
  })

  await test('mc_run status 附 tick 一行，stop 前提醒', async () => {
    resetTick()
    state.frozen = true
    state.rate = 3
    const runTool = createTools(context).find((item) => item.name === 'mc_run')
    assert.ok(runTool)
    const status = await runTool.run({ action: 'status' })
    assert.equal(status.isError, undefined)
    assert.match(bodyOf(status), /tick：速率 3\/秒 · 已冻结（只按 step 推进）/)
    const stop = await runTool.run({ action: 'stop' })
    assert.equal(stop.isError, undefined)
    assert.match(bodyOf(stop), /tick 还没恢复：速率 3\/秒 · 已冻结/)
    assert.match(bodyOf(stop), /mc_tick action=reset/)
    resetTick()
    const clean = await runTool.run({ action: 'status' })
    assert.match(bodyOf(clean), /tick：速率 20\/秒 · 运行中/)
    const cleanStop = await runTool.run({ action: 'restart' })
    assert.equal(bodyOf(cleanStop).includes('tick 还没恢复'), false)
  })

  await test('错误：伴随 mod 不可达时给出结论而不是崩', async () => {
    const closed = createHttpServer(() => undefined)
    const closedPort = await listen(closed)
    await new Promise<void>((done) => closed.close(() => done()))
    const offline = createTickTools({ project: () => projectFor({ port: closedPort, token: TOKEN }), options: context.options } as unknown as McpContext)
    const result = await offline[0].run({ action: 'freeze' })
    assert.equal(result.isError, true)
    assert.match(firstLine(result), /伴随 mod 请求失败/)
    assert.match(firstLine(result), /开发客户端没在运行|fetch failed|ECONNREFUSED/)
    const runTool = createTools({ project: () => projectFor({ port: closedPort, token: TOKEN }), options: context.options } as unknown as McpContext).find((item) => item.name === 'mc_run')
    assert.ok(runTool)
    const status = await runTool.run({ action: 'status' })
    assert.equal(status.isError, undefined)
    assert.equal(bodyOf(status).includes('tick：'), false)
  })

  await test('错误：伴随 mod 报错原样带回', async () => {
    const broken = createHttpServer((request, response) => {
      void readBody(request).then(() => json(response, 503, { error: '还没进入世界' }))
    })
    const brokenPort = await listen(broken)
    try {
      const result = await createTickTools({ project: () => projectFor({ port: brokenPort, token: TOKEN }), options: context.options } as unknown as McpContext)[0].run({ action: 'status' })
      assert.equal(result.isError, true)
      assert.match(firstLine(result), /HTTP 503：还没进入世界/)
    } finally {
      broken.close()
    }
  })

  console.log(`✓ ${passed} 项通过`)
} finally {
  server.close()
  rmSync(root, { recursive: true, force: true })
}
