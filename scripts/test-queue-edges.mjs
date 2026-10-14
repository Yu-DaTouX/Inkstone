/**
 * 队列边界独立检查（攻击面：同文本身份/图片、缩短快照后的消费、
 * 闸门跨会话/代次、clear_queue/refill 失败恢复、快照往返）。
 *
 * 与 scripts/test-queue-rpc-live.mjs 同样的做法：现场把 src/main/agent.ts
 * 用 esbuild 编到临时 outfile，本机 loopback HTTP 夹具假装模型服务，
 * AgentController 直连；不访问外网、不使用真实凭证。
 *
 * 只读产品代码，本文件是独立的验证脚本，不修改任何产品实现。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'

const root = await mkdtemp(join(tmpdir(), 'inkstone-queue-edges-'))
const pi = join(root, 'pi')
const data = join(root, 'data')
const sessions = join(root, 'sessions')
const compiledDir = await mkdtemp(resolve('node_modules/.inkstone-queue-edges-'))
const envBefore = { ...process.env }
let checks = 0
let agent
let requests = []
let holdNext = false
let heldResponse
/** 渲染端 push 快照；live 段用它观察队列投影。 */
let queue = { steering: [], followUp: [] }

const check = (condition, label) => {
  assert.ok(condition, label)
  checks++
  console.log(`  ok  ${label}`)
}
const equal = (actual, expected, label) => {
  assert.deepEqual(actual, expected, label)
  checks++
  console.log(`  ok  ${label}`)
}
const wait = async (condition, label) => {
  const end = Date.now() + 25000
  while (Date.now() < end) {
    if (condition()) return
    await new Promise((done) => setTimeout(done, 25))
  }
  throw new Error(`Timeout: ${label}`)
}
const waitTick = async (condition, label) => {
  const end = Date.now() + 3000
  while (Date.now() < end) {
    if (condition()) return
    await new Promise((done) => setTimeout(done, 5))
  }
  throw new Error(`Timeout(tick): ${label}`)
}
const img = (tag) => ({ data: Buffer.from(tag).toString('base64'), mimeType: 'image/png' })
const red = img('edge-red')
const blue = img('edge-blue')
const green = img('edge-green')
const sameImages = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
/** 去掉 id 后的可比较形状（id 由宿主每次新建，不能跨实例比较）。 */
const shape = (snapshot) => ({
  steering: snapshot.steering,
  followUp: snapshot.followUp,
  items: snapshot.items
    ? {
        steering: snapshot.items.steering.map((item) => ({ text: item.text, images: item.images ?? null })),
        followUp: snapshot.items.followUp.map((item) => ({ text: item.text, images: item.images ?? null }))
      }
    : undefined
})

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    requests.push(JSON.parse(body))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (delta, finish_reason = null) => ({
      id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'model',
      choices: [{ index: 0, delta, finish_reason }]
    })
    res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'EDGE-OUT' }))}\n\n`)
    if (holdNext) {
      holdNext = false
      heldResponse = () => {
        res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\ndata: [DONE]\n\n`)
        res.end()
      }
    } else {
      res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\ndata: [DONE]\n\n`)
      res.end()
    }
  })
})

try {
  for (const path of [pi, data, sessions]) await mkdir(path)
  Object.assign(process.env, {
    YAN_PI_DIR: pi, PI_CODING_AGENT_DIR: pi, YAN_DATA_DIR: data, YAN_SESSIONS_DIR: sessions
  })
  for (const key of Object.keys(process.env)) {
    if (/API_KEY$|AUTH_TOKEN$|ACCESS_TOKEN$|^ANTHROPIC_|^CLAUDE_CODE_OAUTH_TOKEN$/.test(key)) delete process.env[key]
  }
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  await writeFile(join(pi, 'settings.json'), JSON.stringify({
    packages: [], defaultProvider: 'fixture', defaultModel: 'model', compaction: { enabled: false }
  }))
  await writeFile(join(pi, 'auth.json'), '{}')
  await writeFile(join(pi, 'models.json'), JSON.stringify({
    providers: {
      fixture: {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        api: 'openai-completions',
        apiKey: 'local',
        models: [{
          id: 'model', name: 'model', reasoning: false, input: ['text', 'image'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32000, maxTokens: 2048
        }]
      }
    }
  }))

  const outfile = join(compiledDir, 'agent.mjs')
  await build({
    entryPoints: ['src/main/agent.ts'],
    outfile,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    plugins: [{
      name: 'unused-electron',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          contents: `export const app={getLocale:()=>'en',getPath:()=>${JSON.stringify(root)}};export class BrowserWindow{};export const session={};`,
          loader: 'js'
        }))
      }
    }]
  })
  const { AgentController } = await import(pathToFileURL(outfile).href)
  const newHost = (push = () => {}) => new AgentController({ cwd: root, push })

  /* ============================================================ 方向 1 */
  /* 同文本多条消息（混有图/无图/纯图片）的身份与图片不会错配。 */
  console.log('1) 同文本队列身份与图片匹配（宿主侧，离线）')

  {
    const host = newHost()
    host.queueState = {
      steering: [],
      followUp: [
        { id: 'same-red', text: 'same', images: [red] },
        { id: 'same-plain', text: 'same' },
        { id: 'same-blue', text: 'same', images: [blue] }
      ]
    }
    // 乱序消费：先来带 blue 的那条，绝不能误摘前面的 red / 无图项。
    host.consumeQueued('same', [blue])
    equal(host.queueState.followUp.map((item) => item.id), ['same-red', 'same-plain'],
      '先消费带 blue 的重复文本项，只摘蓝图那条')
    host.consumeQueued('same', [])
    equal(host.queueState.followUp.map((item) => item.id), ['same-red'],
      '无图消息只摘无图项，不碰同文本的图项')
    host.consumeQueued('same', [red])
    equal(host.queueState.followUp, [], '最后一条 red 才被摘掉，图片顺序未错配')
  }

  {
    // 原生缩短快照：pi 从同文本队首 splice，宿主必须保留后面身份。
    const host = newHost()
    host.queueState = {
      steering: [],
      followUp: [
        { id: 'h-red', text: 'same', images: [red] },
        { id: 'h-plain', text: 'same' },
        { id: 'h-blue', text: 'same', images: [blue] }
      ]
    }
    host.publishQueue([], ['same', 'same'])
    equal(host.queueState.followUp.map((item) => item.id), ['h-plain', 'h-blue'],
      '缩短快照摘掉队首 red，保留中间无图与队尾 blue 身份')
    equal(host.queueState.followUp.map((item) => item.images ?? null), [null, [blue]],
      '缩短快照保留队尾图片，无图项仍无图')
    // 被缩短掉的那条随后到达 user 消息：不能再去摘后面的同文本项。
    host.consumeQueued('same', [red])
    equal(host.queueState.followUp.map((item) => item.id), ['h-plain', 'h-blue'],
      '队首已被缩短时到达的 red 消息不会误摘后面的同文本项')
    host.consumeQueued('same', [])
    equal(host.queueState.followUp.map((item) => item.id), ['h-blue'], '无图项按自身身份被消费')
    host.consumeQueued('same', [blue])
    equal(host.queueState.followUp, [], '三张同文本项各自消费一次，无重复消费')
  }

  {
    // 两条完全相同的“同文本 + 同图片”：按 FIFO 各消费一次。
    const host = newHost()
    host.queueState = {
      steering: [],
      followUp: [
        { id: 'twice-1', text: 'same', images: [red] },
        { id: 'twice-2', text: 'same', images: [red] }
      ]
    }
    host.publishQueue([], ['same'])
    host.consumeQueued('same', [red])
    equal(host.queueState.followUp.map((item) => item.id), ['twice-2'],
      '图片也相同的重复项不会被一条消息双消费')
    host.consumeQueued('same', [red])
    equal(host.queueState.followUp, [], '第二条同样的消息再消费第二条')
  }

  /* ============================================================ 方向 2 */
  /* 缩短快照 + user 消息超出闸门；纯图片消费不复活幽灵文本项。 */
  console.log('2) 缩短快照/消费竞态与纯图片幽灵（宿主侧，离线）')

  {
    // 闸门内：pi 先推缩短帧（仍带被消费项），再推 user 消息。
    const host = newHost()
    host.state = { sessionId: 's2a' }
    host.queueState = {
      steering: [],
      followUp: [
        { id: 'gate-1', text: 'dup' },
        { id: 'gate-2', text: 'dup' }
      ]
    }
    let release
    const gate = host.queueRun(() => new Promise((done) => { release = done }))
    await waitTick(() => typeof release === 'function', 'gate owner acquired')
    // 第一帧是消费前的旧镜像，仍含两条 dup。
    host.pendingQueueUpdate = { steering: [], followUp: ['dup', 'dup'], sessionId: 's2a', generation: undefined }
    host.consumeQueued('dup', []) // user 消息到达
    equal(host.queueState.followUp.map((item) => item.id), ['gate-2'],
      '闸门内 user 消息摘掉队首 dup')
    release()
    await gate
    equal(host.queueState.followUp.map((item) => item.id), ['gate-2'],
      '闸门收尾应用旧镜像后不重复消费、不复活第一条 dup')
    host.consumeQueued('dup', [])
    equal(host.queueState.followUp, [], '第二条 dup 仍可正常消费')
  }

  {
    // 闸门内：pi 已推缩短帧（只剩第二条），随后 user 消息才到。
    const host = newHost()
    host.state = { sessionId: 's2b' }
    host.queueState = {
      steering: [],
      followUp: [
        { id: 'shrink-1', text: 'dup' },
        { id: 'shrink-2', text: 'dup' }
      ]
    }
    let release
    const gate = host.queueRun(() => new Promise((done) => { release = done }))
    await waitTick(() => typeof release === 'function', 'gate owner acquired')
    host.pendingQueueUpdate = { steering: [], followUp: ['dup'], sessionId: 's2b', generation: undefined }
    host.consumeQueued('dup', [])
    release()
    await gate
    equal(host.queueState.followUp.map((item) => item.id), ['shrink-2'],
      '缩短帧后到达的 user 消息只消费一条，剩余同文本项保留')
    host.consumeQueued('dup', [])
    equal(host.queueState.followUp, [], '剩余 dup 之后可被消费')
  }

  {
    // 纯图片消费后，pi 的旧空文本镜像加上新空文本项：只应留下新的那一项。
    const host = newHost()
    host.consumedEmptyQueue = { steering: 0, followUp: 1 } // 已消费 1 条纯图片
    host.queueState = { steering: [], followUp: [{ id: 'fresh-empty', text: '', images: [blue] }] }
    host.publishQueue([], ['', '']) // pi 的镜像 = 1 条旧空 + 1 条新空
    equal(host.queueState.followUp.map((item) => item.id), ['fresh-empty'],
      '旧空文本镜像被跳过，新纯图片项既不被复活也不被吞掉')
    equal(host.queueState.followUp.map((item) => item.images), [[blue]], '新的纯图片项保留自身图片')
  }

  {
    // 闸门内消费纯图片，收尾的 pending 旧镜像不得复活它。
    const host = newHost()
    host.state = { sessionId: 's2c' }
    host.queueState = { steering: [], followUp: [{ id: 'gate-empty', text: '', images: [red] }] }
    let release
    const gate = host.queueRun(() => new Promise((done) => { release = done }))
    await waitTick(() => typeof release === 'function', 'gate owner acquired')
    host.pendingQueueUpdate = { steering: [], followUp: [''], sessionId: 's2c', generation: undefined }
    host.consumeQueued('', [red])
    release()
    await gate
    equal(host.queueState.followUp, [], '闸门内消费纯图片后旧空镜像不复活幽灵项')
  }

  /* ============================================================ 方向 3 */
  /* 闸门 owner 检查：跨会话 / 跨运行实例代次不把旧队列写进新会话。 */
  console.log('3) 闸门跨会话/代次（宿主侧，离线）')

  {
    const host = newHost()
    host.state = { sessionId: 'old-session' }
    host.capabilityOpts = { runnerGeneration: 1 }
    let unblock
    const first = host.queueRun(() => new Promise((done) => { unblock = done }))
    await waitTick(() => typeof unblock === 'function', 'first gate owner acquired')
    let lateRan = false
    const late = host.queueRun(async () => { lateRan = true }).catch((error) => error.message)
    host.capabilityOpts = { runnerGeneration: 2 } // 运行实例代次变化
    unblock()
    await first
    check((await late).includes('会话已切换') && !lateRan,
      '等待闸门的旧操作跨运行实例代次后被拒绝，未执行')
  }

  {
    const host = newHost()
    host.state = { sessionId: 'old-session' }
    host.capabilityOpts = { runnerGeneration: 1 }
    let release
    const gate = host.queueRun(() => new Promise((done) => { release = done }))
    await waitTick(() => typeof release === 'function', 'gate owner acquired')
    host.pendingQueueUpdate = { steering: [], followUp: ['old-queued'], sessionId: 'old-session', generation: 1 }
    host.state = { sessionId: 'new-session' } // 闸门未关就切了会话
    release()
    await gate
    equal(host.queueState, { steering: [], followUp: [] },
      '旧会话的 pending 队列帧不会落到新会话')
  }

  {
    // 会话在 RPC 期间切换：requireRpc 抛错，且不向新会话推送旧队列。
    const pushes = []
    const host = newHost((event) => pushes.push(event))
    let releaseCommand
    host.rpc = {
      running: true,
      command: async () => new Promise((done) => {
        releaseCommand = () => done({ success: true, data: { disposition: 'queued' } })
      })
    }
    host.state = { sessionId: 'rpc-old' }
    host.capabilityOpts = { runnerGeneration: 1 }
    const pending = host.steer('stale-prompt', [red]).catch((error) => error)
    await waitTick(() => typeof releaseCommand === 'function', 'steer rpc in flight')
    host.state = { sessionId: 'rpc-new' }
    releaseCommand()
    const result = await pending
    check(result instanceof Error && result.message.includes('会话已切换'),
      'RPC 期间切会话时旧插话被拒绝')
    check(!pushes.some((event) => event.ch === 'queue' && JSON.stringify(event.payload).includes('stale-prompt')),
      '旧插话没有作为队列帧推给新会话')
  }

  /* ============================================================ 方向 4 */
  /* clear_queue 失败 / refill 中途失败时原队列（含图片）完整恢复。 */
  console.log('4) clear_queue / refill 失败恢复（宿主侧，假 RPC，离线）')

  {
    const host = newHost()
    host.state = { sessionId: 'fail-clear' }
    host.capabilityOpts = { runnerGeneration: 1 }
    const calls = []
    host.rpc = {
      running: true,
      command: async (command) => {
        calls.push(command)
        if (command === 'clear_queue') return { success: false, error: '注入：clear_queue 失败' }
        return { success: true, data: {} }
      }
    }
    host.queueState = {
      steering: [],
      followUp: [
        { id: 'fc-1', text: 'keep', images: [red] },
        { id: 'fc-2', text: '', images: [blue] }
      ]
    }
    const result = await host.removeQueued('fc-1')
    check(!result.ok && result.error.includes('clear_queue 失败'), 'clear_queue 失败如实返回错误')
    equal(host.queueState.followUp.map((item) => item.id), ['fc-1', 'fc-2'],
      'clear_queue 失败后队列身份完全不变')
    equal(host.queueState.followUp.map((item) => item.images), [[red], [blue]],
      'clear_queue 失败后图片完全保留（无半丢）')
    equal(calls, ['clear_queue'], 'clear_queue 失败后不会盲目重排队列')
  }

  {
    const host = newHost()
    host.state = { sessionId: 'fail-refill' }
    host.capabilityOpts = { runnerGeneration: 1 }
    const calls = []
    let refillCount = 0
    const failAt = 2 // 第 2 条重建命令（followUp 第一条）失败
    host.rpc = {
      running: true,
      command: async (command, payload) => {
        if (command === 'clear_queue') {
          const cleared = {
            steering: host.queueState.steering.map((item) => item.text),
            followUp: host.queueState.followUp.map((item) => item.text)
          }
          calls.push({ command, ok: true })
          return { success: true, data: cleared }
        }
        refillCount++
        const ok = refillCount !== failAt
        calls.push({ command, message: payload?.message, ok })
        return ok ? { success: true, data: {} } : { success: false, error: '注入：refill 中途失败' }
      }
    }
    const original = {
      steering: [{ id: 'fr-s', text: 'lead', images: [green] }],
      followUp: [
        { id: 'fr-1', text: 'keep', images: [red] },
        { id: 'fr-2', text: 'keep' },
        { id: 'fr-3', text: '', images: [blue] }
      ]
    }
    host.queueState = structuredClone(original)
    const result = await host.removeQueued('fr-1')
    check(!result.ok && result.error.includes('未消费内容已恢复'), 'refill 失败被报告为「已恢复原队列」')
    equal(host.queueState.steering.map((item) => item.id), ['fr-s'], 'refill 失败恢复 steering 的图片项')
    equal(host.queueState.followUp.map((item) => item.id), ['fr-1', 'fr-2', 'fr-3'],
      'refill 中途失败后 followUp 顺序与身份完整恢复')
    equal(host.queueState.followUp.map((item) => item.images ?? null), [[red], null, [blue]],
      '恢复的 followUp 保留每条自己的图片与无图状态')
    const recovered = calls.filter((call) => call.command === 'follow_up' && call.ok)
    equal(recovered.map((call) => call.message), ['keep', 'keep', ''],
      '恢复时按原文顺序重排全部剩余 followUp（含纯图片的空文本）')
  }

  /* ============================================================ 方向 5 */
  /* queueSnapshot / restoreQueueSnapshot 往返保持图片与顺序。 */
  console.log('5) 快照往返（宿主侧，假 RPC，离线）')

  {
    const refilled = []
    const host = newHost()
    host.state = { sessionId: 'snap' }
    host.capabilityOpts = { runnerGeneration: 1 }
    host.rpc = {
      running: true,
      command: async (command, payload) => {
        refilled.push({ command, payload })
        return { success: true, data: {} }
      }
    }
    const snapshot = {
      steering: ['lead'],
      followUp: ['same', 'same', ''],
      items: {
        steering: [{ id: 'snap-s', text: 'lead', images: [green] }],
        followUp: [
          { id: 'snap-1', text: 'same', images: [red] },
          { id: 'snap-2', text: 'same' },
          { id: 'snap-3', text: '', images: [blue] }
        ]
      }
    }
    const restored = await host.restoreQueueSnapshot(snapshot)
    check(restored.ok, `空闲恢复成功：${restored.error ?? ''}`)
    equal(shape(host.queueSnapshot()), shape(snapshot),
      '恢复后的快照与源快照文字、顺序、图片逐项一致（含纯图片项）')
    check(new Set(host.queueState.followUp.map((item) => item.id)).size === 3,
      '恢复时三条同/空文本项各获得独立身份，不合并')
    equal(refilled.map((call) => call.command), ['steer', 'follow_up', 'follow_up', 'follow_up'],
      '恢复按 steering 先、followUp 后重排，顺序不颠倒')
    equal(refilled.map((call) => call.payload?.message), ['lead', 'same', 'same', ''],
      '恢复发出的原文顺序与原队列一致')
    equal(refilled.map((call) => call.payload?.images?.[0]?.data ?? null),
      [green.data, red.data, null, blue.data],
      '恢复发出的图片跟随各自身份，无图项不带图片')
  }

  {
    // 已有不同队列时拒绝覆盖，避免吞掉或重复。
    const host = newHost()
    host.state = { sessionId: 'snap-guard' }
    host.capabilityOpts = { runnerGeneration: 1 }
    host.rpc = { running: true, command: async () => ({ success: true, data: {} }) }
    host.queueState = { steering: [], followUp: [{ id: 'existing', text: 'other' }] }
    const refused = await host.restoreQueueSnapshot({
      steering: [], followUp: ['lead'], items: { steering: [], followUp: [{ id: 'x', text: 'lead', images: [green] }] }
    })
    check(!refused.ok && refused.error.includes('拒绝覆盖'), '新实例已有不同队列时拒绝覆盖')
    equal(host.queueState.followUp.map((item) => item.text), ['other'], '拒绝覆盖时原队列保持不变')
  }

  /* ============================================================ live 段 */
  /* 真实 pi + loopback 夹具：验证事件顺序下的身份/图片/幽灵。 */
  console.log('live) 真实 pi + loopback 夹具')
  agent = new AgentController({
    cwd: root,
    piBin: join(selectedPiRuntime(resolve('resources/pi-runtime')), 'dist/bundle/cli.js'),
    push: (event) => { if (event.ch === 'queue') queue = event.payload }
  })
  agent.maybeGenerateTitle = async () => null
  const rawQueueFrames = []
  const originalHandle = agent.handleEvent.bind(agent)
  agent.handleEvent = (event) => {
    if (event.type === 'queue_update') {
      rawQueueFrames.push({ steering: [...(event.steering ?? [])], followUp: [...(event.followUp ?? [])] })
    }
    return originalHandle(event)
  }

  const started = await agent.start()
  check(started.ok, started.error ?? '真实 pi 启动成功')

  const hold = async (label) => {
    const before = requests.length
    holdNext = true
    check((await agent.send(label)).ok, `发起并挂起：${label}`)
    await wait(() => requests.length > before && agent.getState()?.isStreaming, `${label} 进入流式`)
  }
  const release = async (label) => {
    heldResponse()
    await wait(() => !agent.getState()?.isAgentRunning && queue.steering.length === 0 && queue.followUp.length === 0,
      `${label} 队列消费完`)
  }

  // ---- live 1：同文本混有图/无图/纯图片，任意顺序撤回与插队 ----
  await hold('EDGE-HOLD-MIX')
  check((await agent.send('DUP', [red])).ok, '排队 DUP+red')
  check((await agent.send('DUP')).ok, '排队 DUP 无图')
  check((await agent.send('', [blue])).ok, '排队纯图片 blue')
  check((await agent.send('', [red])).ok, '排队纯图片 red')
  await wait(() => queue.followUp.length === 4, '四条混合 followUp 就绪')
  equal(queue.followUp.map((item) => item.text), ['DUP', 'DUP', '', ''],
    '宿主队列保留同文本与纯图片的原始文本形态')
  equal(queue.followUp.map((item) => item.images ?? null), [[red], null, [blue], [red]],
    '宿主队列保留每条消息自己的图片')
  const [mixDupRed, mixDupPlain, mixBlue, mixRed] = queue.followUp
  check(new Set([mixDupRed.id, mixDupPlain.id, mixBlue.id, mixRed.id]).size === 4,
    '同文本/纯图片四条各自有独立 id')

  const removedPlain = await agent.removeQueued(mixDupPlain.id)
  check(removedPlain.ok && removedPlain.text === 'DUP' && removedPlain.images === undefined,
    '撤回无图 DUP 返回原文且不带图片')
  equal(queue.followUp.map((item) => item.id), [mixDupRed.id, mixBlue.id, mixRed.id],
    '撤回无图 DUP 后其余三条身份不变')
  equal(queue.followUp.map((item) => item.images ?? null), [[red], [blue], [red]],
    '撤回无图 DUP 后其余图片仍各归其位')

  const removedRed = await agent.removeQueued(mixRed.id)
  check(removedRed.ok && removedRed.text === '' && sameImages(removedRed.images, [red]),
    '撤回纯图片 red 返回空文本与自己的图片')
  equal(queue.followUp.map((item) => item.id), [mixDupRed.id, mixBlue.id],
    '撤回纯图片 red 后剩余身份稳定')
  equal(queue.followUp.map((item) => item.images ?? null), [[red], [blue]],
    '撤回纯图片 red 后剩余图片不错配')

  check((await agent.steerQueued(mixBlue.id)).ok, '把纯图片 blue 插队提升为 steering')
  equal(queue.steering.map((item) => item.images ?? null), [[blue]], '提升后 steering 保留 blue 图片')
  equal(queue.followUp.map((item) => item.id), [mixDupRed.id], '提升后 followUp 只剩 DUP+red')
  equal(queue.followUp.map((item) => item.images ?? null), [[red]], '提升后 followUp 保留 red 图片')
  const mixSnapshot = agent.queueSnapshot()
  equal(mixSnapshot.steering, [''], '提升后快照 steering 文本为纯图片的空串')
  equal(mixSnapshot.followUp, ['DUP'], '提升后快照 followUp 文本为 DUP')
  equal(mixSnapshot.items?.steering?.[0]?.images, [blue], '提升后快照 steering 项保留 blue 图片')
  equal(mixSnapshot.items?.followUp?.[0]?.images, [red], '提升后快照 followUp 项保留 red 图片')

  await release('混合队列')
  const mixLast = requests.at(-1)
  const mixUserImages = (mixLast?.messages ?? [])
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((part) => part.type === 'image_url')
    .map((part) => part.image_url.url)
  equal(mixUserImages.filter((url) => url.includes(red.data)).length, 1,
    '被消费的 DUP+red 在最终请求里只出现一次')
  equal(mixUserImages.filter((url) => url.includes(blue.data)).length, 1,
    '被提升的纯图片 blue 在最终请求里只出现一次')
  equal(mixUserImages.length, 2,
    '被撤回的纯图片 red 与无图 DUP 从未到模型')

  // ---- live 2：纯图片消费，旧空文本镜像不产生幽灵、也不吞掉新项 ----
  await hold('EDGE-HOLD-EMPTY')
  check((await agent.send('', [green])).ok, '排队纯图片 green')
  check((await agent.send('', [blue])).ok, '排队纯图片 blue')
  await wait(() => queue.followUp.length === 2, '两条纯图片 followUp 就绪')
  equal(queue.followUp.map((item) => item.images ?? null), [[green], [blue]],
    '两条纯图片各自带图')
  await release('纯图片')
  equal(agent.queueSnapshot(), { steering: [], followUp: [] },
    '纯图片消费后无幽灵队列项')

  await hold('EDGE-HOLD-EMPTY-2')
  check((await agent.send('', [red])).ok, '旧空镜像存在时再排队纯图片 red')
  await wait(() => queue.followUp.length === 1, '新的纯图片恰好出现一次')
  equal(queue.followUp.map((item) => item.images ?? null), [[red]],
    '旧空文本镜像既不复活旧项，也不吞掉新的纯图片项')
  await release('新纯图片')
  equal(agent.queueSnapshot(), { steering: [], followUp: [] },
    '新纯图片消费后队列干净')
  check(rawQueueFrames.some((frame) => frame.followUp.length === 0),
    '观察到 pi 的缩短/清空队列帧（事件顺序可达）')

  // ---- live 3：同文本同图/异图的自然消费不重复不遗漏 ----
  await hold('EDGE-HOLD-DUP')
  check((await agent.send('X', [red])).ok, '排队 X+red')
  check((await agent.send('X')).ok, '排队 X 无图')
  check((await agent.send('X', [blue])).ok, '排队 X+blue')
  await wait(() => queue.followUp.length === 3, '三条同文本 followUp 就绪')
  equal(queue.followUp.map((item) => item.images ?? null), [[red], null, [blue]],
    '三条同文本项图片形态各自保留')
  await release('同文本')
  const dupLast = requests.at(-1)
  const dupMessages = (dupLast?.messages ?? []).filter((message) =>
    message.role === 'user' && Array.isArray(message.content) && message.content.some((part) => part.text === 'X'))
  equal(dupMessages.length, 3, '三条同文本 X 都在最终请求历史里')
  const dupImages = dupMessages
    .flatMap((message) => message.content.filter((part) => part.type === 'image_url'))
    .map((part) => part.image_url.url)
  equal(dupImages.filter((url) => url.includes(red.data)).length, 1,
    '同文本里的 X+red 恰好到模型一次')
  equal(dupImages.filter((url) => url.includes(blue.data)).length, 1,
    '同文本里的 X+blue 恰好到模型一次')
  equal(agent.queueSnapshot(), { steering: [], followUp: [] }, '同文本消费后无幽灵')

  console.log(`queue-edges: ${checks} checks passed (independent edges, loopback fixture, no external credentials)`)
} finally {
  await agent?.stop()
  server.closeAllConnections()
  if (server.listening) await new Promise((done) => server.close(done))
  for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key]
  Object.assign(process.env, envBefore)
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  await rm(compiledDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
