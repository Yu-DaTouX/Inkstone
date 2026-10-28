import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const dir = await mkdtemp(join(tmpdir(), 'yan-session-sync-'))

const bundle = async (entry, name) => {
  const outfile = join(dir, `${name}.mjs`)
  await build({
    entryPoints: [join(ROOT, entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(pathToFileURL(outfile).href)
}

const user = (id, text = '问题') => ({ id, role: 'user', text })
const assistant = (id, text = '回答', extra = {}) => ({ id, role: 'assistant', text, ...extra })

try {
  const { planSessionSync } = await bundle('src/main/session-sync-plan.ts', 'session-sync-plan')
  const { applySyncDelta } = await bundle('src/renderer/src/state/session-message-merge.ts', 'session-message-merge')
  const { messageSyncSignature } = await bundle('src/shared/session-sync.ts', 'session-sync')
  const { projectHistory } = await bundle('src/main/session-items/projector.ts', 'projector')

  const section = (name) => console.log(`\n## ${name}`)

  section('planSessionSync')
  assert.deepEqual(planSessionSync(undefined, [user('m0')]), { kind: 'full' }, '没有基线（首次装载）退回全量')
  assert.deepEqual(planSessionSync([], [user('m0')]), { kind: 'full' }, '空基线退回全量')
  assert.deepEqual(planSessionSync([user('m0')], []), { kind: 'full' }, '目标为空也发全量，让渲染端知道被清空')

  const two = [user('m0'), assistant('m1')]
  assert.deepEqual(planSessionSync(two, two.map((m) => ({ ...m }))), { kind: 'none' }, '内容相同不发（压缩的主场景）')

  const appended = [...two, assistant('m2', '新回答')]
  const appendPlan = planSessionSync(two, appended)
  assert.equal(appendPlan.kind, 'delta', '尾部追加走增量')
  assert.equal(appendPlan.anchorId, 'm1', '锚点是最后一条已知消息')
  assert.equal(appendPlan.anchorIndex, 1, '锚点位置随增量一起下发')
  assert.deepEqual(appendPlan.messages.map((m) => m.id), ['m2'], '只发新增的那条')

  const streamed = [user('m0'), assistant('m1', '回答更长了一些')]
  const streamPlan = planSessionSync(two, streamed)
  assert.equal(streamPlan.kind, 'delta', '同一条消息继续流式增长走增量')
  assert.equal(streamPlan.anchorId, 'm0', '锚点退回到内容变化的前一条')
  assert.deepEqual(streamPlan.messages.map((m) => m.id), ['m1'], '变化的那条重发')

  const timed = [user('m0'), assistant('m1', '回答', { turnTiming: { logicalTurnId: 't1', startedAt: 1, endedAt: 2 } })]
  const timingPlan = planSessionSync(two, timed)
  assert.equal(timingPlan.kind, 'delta', '压缩后补上回合时序只重发变化的那条')
  assert.deepEqual(timingPlan.messages.map((m) => m.id), ['m1'])

  const rewound = planSessionSync([user('m0'), assistant('m1'), assistant('m2')], two)
  assert.equal(rewound.kind, 'delta', '回退（目标数组是基线的前缀）走增量')
  assert.equal(rewound.anchorId, 'm1', '锚在保留段的最后一条')
  assert.deepEqual(rewound.messages, [], '空增量表示截断尾部')

  const middleRemoved = planSessionSync([user('m0'), assistant('m1'), assistant('m2')], [user('m0'), assistant('m2')])
  assert.equal(middleRemoved.kind, 'delta', '中间少了一条也能用增量表达')
  assert.equal(middleRemoved.anchorIndex, 0, '锚点在分叉点之前')
  assert.deepEqual(middleRemoved.messages.map((m) => m.id), ['m2'])

  assert.deepEqual(
    planSessionSync([user('m0'), assistant('m1')], [user('x0'), assistant('x1')]),
    { kind: 'full' },
    '没有任何共同起点（换了会话/换了分支）退回全量'
  )

  const bigTail = Array.from({ length: 40 }, (_, index) => assistant(`m${index + 1}`, 'x'.repeat(50_000)))
  assert.equal(
    planSessionSync([user('m0')], [user('m0'), ...bigTail]).kind,
    'full',
    '增量超过 1MB 上限退回全量'
  )
  const mostlyRewritten = [user('m0'), ...Array.from({ length: 20 }, (_, index) => assistant(`m${index + 1}`, 'x'.repeat(1_000)))]
  const rewritten = [user('m0'), ...Array.from({ length: 20 }, (_, index) => assistant(`m${index + 1}`, 'y'.repeat(1_000)))]
  assert.equal(planSessionSync(mostlyRewritten, rewritten).kind, 'full', '增量超过全量 60% 时直接发全量')
  const medium = [user('m0'), ...Array.from({ length: 40 }, (_, index) => assistant(`m${index + 1}`, 'x'.repeat(1_000)))]
  const mediumPlan = planSessionSync(medium, [...medium, assistant('m41', 'y'.repeat(1_000))])
  assert.equal(mediumPlan.kind, 'delta', '小尾巴仍走增量')

  section('applySyncDelta')
  const current = [user('m0'), assistant('m1', '旧回答')]
  const anchorOf = (list, index) => ({
    anchorId: list[index].id,
    anchorIndex: index,
    anchorSignature: messageSyncSignature(list[index])
  })

  const appendedDelta = { ...anchorOf(current, 1), messages: [assistant('m2', '新增')] }
  assert.deepEqual(applySyncDelta(current, appendedDelta).map((m) => m.id), ['m0', 'm1', 'm2'], '锚点命中后接上新尾巴')

  assert.equal(applySyncDelta([user('m0')], appendedDelta), null, '锚点不存在（序号不连续）退回全量')
  assert.equal(
    applySyncDelta(current, { ...appendedDelta, anchorId: 'm7' }),
    null,
    '锚点 id 对不上退回全量'
  )
  assert.equal(
    applySyncDelta(current, { ...appendedDelta, anchorIndex: 5 }),
    null,
    '锚点位置对不上退回全量'
  )
  assert.equal(
    applySyncDelta([user('m0'), assistant('m1', '已经被改过')], appendedDelta),
    null,
    '锚点内容对不上退回全量'
  )
  assert.equal(
    applySyncDelta(current, { ...appendedDelta, messages: [assistant('m2'), assistant('m2')] }),
    null,
    '增量里出现重复 id 退回全量'
  )

  const truncating = { ...anchorOf([user('m0'), assistant('m1')], 1), messages: [] }
  assert.deepEqual(
    applySyncDelta([user('m0'), assistant('m1'), assistant('m2')], truncating).map((m) => m.id),
    ['m0', 'm1'],
    '空增量把锚点之后的尾巴截掉'
  )

  const fuller = applySyncDelta(
    [user('m0'), assistant('m1', '回答更完整')],
    { ...anchorOf([user('m0')], 0), messages: [assistant('m1', '回答')] }
  )
  assert.equal(fuller[1].text, '回答更完整', '同一 id 取内容更完整的一侧')

  const guarded = applySyncDelta(
    [user('m0'), assistant('m1', '回答'), assistant('streaming-1', '正在流式')],
    { ...anchorOf([user('m0')], 0), messages: [] },
    'streaming-1'
  )
  assert.deepEqual(guarded.map((m) => m.id), ['m0', 'streaming-1'], '正在流式的那条不会被增量截掉')

  const reproducible = planSessionSync(current, [...current, assistant('m2', '新增')])
  assert.equal(reproducible.anchorId, 'm1', '追加的锚点是最后一条已知消息')
  assert.equal(reproducible.anchorSignature, messageSyncSignature(current[1]), '锚点签名与渲染端算法一致')

  section('后台会话缓存（reduceSessionRuntime）')
  const { reduceSessionRuntime } = await bundle('src/renderer/src/state/session-runtime.ts', 'session-runtime')
  const runtime = { sessionId: 'session-a', runId: 'run-a', projectId: 'project-a', generation: 1 }
  const base = [user('m0'), assistant('m1')]
  let map = reduceSessionRuntime({}, runtime, { ch: 'sync', payload: base })
  const background = planSessionSync(base, [...base, assistant('m2', '后台新增')])
  map = reduceSessionRuntime(map, runtime, { ch: 'sync-delta', payload: background })
  assert.deepEqual(map['session-a'].messages.map((m) => m.id), ['m0', 'm1', 'm2'], '后台缓存按增量接上')
  assert.equal(map['session-a'].messagesLoaded, true, '增量成功即视为已装载')
  const broken = { anchorId: 'missing', anchorIndex: 9, anchorSignature: 'x', messages: [assistant('m9')] }
  map = reduceSessionRuntime(map, runtime, { ch: 'sync-delta', payload: broken })
  assert.equal(map['session-a'].messagesLoaded, false, '增量对不上时标记未装载，等切会话时的全量')
  assert.deepEqual(map['session-a'].messages.map((m) => m.id), ['m0', 'm1', 'm2'], '失败时保留旧数组，不写脏数据')

  section('活动视图（store.applyPush）')
  const storage = new Map()
  globalThis.localStorage = {
    getItem: (key) => (storage.has(String(key)) ? storage.get(String(key)) : null),
    setItem: (key, value) => storage.set(String(key), String(value)),
    removeItem: (key) => storage.delete(String(key)),
    clear: () => storage.clear(),
    key: () => null,
    length: 0
  }
  globalThis.requestAnimationFrame = (fn) => {
    fn(0)
    return 0
  }
  globalThis.cancelAnimationFrame = () => {}
  globalThis.document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: 'visible',
    hasFocus: () => true,
    documentElement: { lang: 'zh-CN' },
    querySelector: () => null,
    createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} })
  }
  if (typeof globalThis.navigator === 'undefined') globalThis.navigator = { userAgent: 'node' }
  const fullList = [user('m0'), assistant('m1', '回答'), assistant('m2', '补问'), assistant('m3', '补答')]
  const storeCalls = []
  globalThis.window = {
    yan: new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === 'getMessages') {
            return async () => {
              storeCalls.push('getMessages')
              return fullList
            }
          }
          return async (...args) => {
            storeCalls.push(`${String(prop)}:${args.length}`)
            return undefined
          }
        }
      }
    ),
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { href: 'http://localhost/' }
  }
  const { useStore } = await bundle('src/renderer/src/state/store.ts', 'store')
  const viewRuntime = { sessionId: 'session-a', runId: 'run-a', projectId: 'project-a', generation: 1 }
  const runner = { id: 'run-a', runId: 'run-a', sessionId: 'session-a', projectId: 'project-a', generation: 1, isActive: true }
  const resetView = (messages) => {
    useStore.setState({
      session: { sessionId: 'session-a', cwd: 'C:/a', isStreaming: false, isCompacting: false, messageCount: messages.length },
      runners: [runner],
      activeRunnerId: 'run-a',
      sessionRuntimes: {},
      messages,
      peekedPath: null,
      peekedSessionId: null,
      peekNote: null
    })
  }

  resetView([user('m0'), assistant('m1', '回答')])
  useStore.getState().applyPush({
    ch: 'sync-delta',
    runtime: viewRuntime,
    payload: { ...anchorOf([user('m0'), assistant('m1', '回答')], 1), messages: [assistant('m2', '新增')] }
  })
  assert.deepEqual(useStore.getState().messages.map((m) => m.id), ['m0', 'm1', 'm2'], '活动视图按增量接上')

  storeCalls.length = 0
  resetView([user('m0'), assistant('m1', '回答')])
  useStore.getState().applyPush({
    ch: 'sync-delta',
    runtime: viewRuntime,
    payload: { anchorId: 'missing', anchorIndex: 7, anchorSignature: 'x', messages: [assistant('m9')] }
  })
  assert.ok(storeCalls.includes('getMessages'), '锚点找不到时主动要一次全量')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(
    useStore.getState().messages.map((m) => m.id),
    fullList.map((m) => m.id),
    '全量兜底落到视图上'
  )

  section('agent.ts 接线')
  const agentSource = await readFile(join(ROOT, 'src/main/agent.ts'), 'utf8')
  const hydrateBody = agentSource.slice(
    agentSource.indexOf('private async hydrate()'),
    agentSource.indexOf('private pushSessionSync(')
  )
  assert.ok(hydrateBody.length > 0, '能找到 hydrate 方法体')
  const captureAt = hydrateBody.indexOf('const syncedBefore = this.messages')
  const firstAssignAt = hydrateBody.indexOf('this.messages =')
  assert.ok(captureAt >= 0 && firstAssignAt > captureAt, 'hydrate 一开始先抓取同步前的数组，再做重放')
  assert.ok(
    hydrateBody.includes('const scopeBefore = { sessionId: this.state?.sessionId, sessionFile: this.state?.sessionFile }'),
    'hydrate 记下重放前的会话身份'
  )
  assert.ok(hydrateBody.includes('this.pushSessionSync(scopeBefore, syncedBefore)'), 'hydrate 改走 pushSessionSync')
  assert.ok(!hydrateBody.includes("this.push({ ch: 'sync', payload: this.messages })"), 'hydrate 不再整份重推')
  const sendBody = agentSource.slice(
    agentSource.indexOf('private pushSessionSync('),
    agentSource.indexOf('async getCustomEntries(')
  )
  assert.ok(
    sendBody.includes('this.state?.sessionId === scopeBefore.sessionId && this.state?.sessionFile === scopeBefore.sessionFile'),
    '会话身份变化（切换/新建/重载）一律退回全量'
  )
  assert.ok(sendBody.includes("ch: 'sync-delta'"), '增量走 sync-delta 通道')
  assert.ok(sendBody.includes("ch: 'sync'"), '全量仍走原来的 sync 通道')

  section('压缩形态的增量（真实 projector）')
  const raw = []
  const turns = 24
  for (let turn = 0; turn < turns; turn += 1) {
    raw.push({ role: 'user', content: `第 ${turn} 轮问题`, timestamp: turn * 1000 })
    raw.push({
      role: 'assistant',
      content: [
        { type: 'text', text: `第 ${turn} 轮回答` },
        { type: 'toolCall', id: `call-${turn}`, name: 'read', arguments: { path: `big/a${turn}.txt` } }
      ],
      timestamp: turn * 1000 + 1
    })
    raw.push({
      role: 'toolResult',
      toolCallId: `call-${turn}`,
      toolName: 'read',
      content: [{ type: 'text', text: 'A'.repeat(40_000) }],
      timestamp: turn * 1000 + 2
    })
  }
  const projected = projectHistory(raw)
  assert.ok(projected.length >= turns, 'projector 产出真实 UI 消息')
  const compactPlan = planSessionSync(projected, projected.map((message) => ({ ...message })))
  assert.deepEqual(compactPlan, { kind: 'none' }, '压缩重放后完全一致时不发任何消息')

  const branchB = [user('m0', '第一句'), assistant('m1', '好'), { ...user('m2', '第二句 B'), entryId: 'u2b' }, { ...assistant('m3', '好'), entryId: 'a2b' }]
  const branchA = [{ ...user('m2', '第二句 A'), entryId: 'u2a' }, { ...assistant('m3', '好'), entryId: 'a2a' }]
  const switched = applySyncDelta(branchB, { anchorId: 'm1', anchorIndex: 1, anchorSignature: messageSyncSignature(branchB[1]), messages: branchA })
  assert.deepEqual(switched.map((message) => [message.text, message.entryId]), [['第一句', undefined], ['好', undefined], ['第二句 A', 'u2a'], ['好', 'a2a']], '切到等长的另一分支时以主进程的条目为准')

  const { withTrailingEntryIds } = await bundle('src/main/live-entry-ids.ts', 'live-entry-ids')
  const entry = (id, role) => ({ type: 'message', id, message: { role } })
  const live = [{ ...user('m0'), entryId: 'e0' }, { ...assistant('m1'), entryId: 'e1' }, user('m2'), assistant('m3'), assistant('m4'), { id: 'm5', role: 'bash', text: 'ls' }]
  const attached = withTrailingEntryIds(live, [entry('e0', 'user'), entry('e1', 'assistant'), { type: 'model_change', id: 'mc' }, entry('e2', 'user'), entry('e3', 'assistant'), entry('e4', 'toolResult'), entry('e5', 'assistant'), entry('e6', 'bashExecution')])
  assert.deepEqual(attached?.map((message) => message.entryId), ['e0', 'e1', 'e2', 'e3', 'e5', 'e6'], '回合结束后从文件尾部按角色补上实时消息的条目 id')
  assert.equal(withTrailingEntryIds(live.slice(0, 2), [entry('e0', 'user'), entry('e1', 'assistant')]), null, '都有条目 id 时不改')
  assert.equal(withTrailingEntryIds([user('m0')], [entry('e0', 'assistant')]), null, '角色对不上时不猜')

  console.log(`\nPASS: test-session-sync-plan（${projected.length} 条消息/${(JSON.stringify(projected).length / 1024).toFixed(0)}KB 的形态数据）`)
} finally {
  await rm(dir, { recursive: true, force: true })
}
