import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

async function compile(entry, outfile) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

const dir = await mkdtemp(join(tmpdir(), 'v3-aux-windows-'))
try {
  const geometry = await compile('src/main/windows/geometry.ts', join(dir, 'geometry.mjs'))
  const state = await compile('src/main/windows/aux-state.ts', join(dir, 'state.mjs'))
  const items = await compile('src/main/windows/attention-items.ts', join(dir, 'items.mjs'))
  const submit = await compile('src/main/windows/quick-ask-submit.ts', join(dir, 'submit.mjs'))

  const area = { x: 0, y: 0, width: 1920, height: 1080 }

  console.log('geometry')
  check('迷你小窗贴工作区右上角', () => {
    const b = geometry.computeMiniBounds({ area, size: { width: 320, height: 264 } })
    assert.deepEqual(b, { x: 1588, y: 12, width: 320, height: 264 })
  })
  check('迷你小窗贴主窗口右上角', () => {
    const b = geometry.computeMiniBounds({ area, anchor: { x: 100, y: 100, width: 1000, height: 800 }, size: { width: 320, height: 264 } })
    assert.deepEqual(b, { x: 768, y: 112, width: 320, height: 264 })
  })
  check('迷你小窗裁回工作区（主窗口贴右边）', () => {
    const b = geometry.computeMiniBounds({ area, anchor: { x: 1500, y: 0, width: 420, height: 600 }, size: { width: 320, height: 264 } })
    assert.ok(b.x + b.width <= area.x + area.width)
    assert.ok(b.y >= area.y)
  })
  check('快速提问无主窗口时工作区居中偏上', () => {
    const b = geometry.computeQuickAskBounds({ area, size: { width: 560, height: 160 } })
    assert.deepEqual(b, { x: 680, y: 230, width: 560, height: 160 })
  })
  check('快速提问贴主窗口水平居中', () => {
    const b = geometry.computeQuickAskBounds({ area, anchor: { x: 0, y: 0, width: 1000, height: 800 }, size: { width: 560, height: 160 } })
    assert.deepEqual(b, { x: 220, y: 160, width: 560, height: 160 })
  })
  check('主窗口拖到屏幕外时快速提问仍可见', () => {
    const b = geometry.computeQuickAskBounds({ area, anchor: { x: 1800, y: 1000, width: 400, height: 300 }, size: { width: 560, height: 160 } })
    assert.ok(b.x >= area.x && b.x + b.width <= area.x + area.width)
    assert.ok(b.y >= area.y && b.y + b.height <= area.y + area.height)
  })
  check('工作区小于窗口时至少贴左上', () => {
    const b = geometry.clampToArea({ x: -50, y: -50, width: 1200, height: 900 }, { x: 0, y: 0, width: 800, height: 600 })
    assert.deepEqual(b, { x: 0, y: 0, width: 800, height: 600 })
  })

  console.log('aux-state')
  check('快速提问：show / hide / 提交错误', () => {
    let s = state.INITIAL_QUICK_ASK_STATE
    s = state.quickAskReducer(s, { type: 'show' })
    assert.equal(s.visible, true)
    s = state.quickAskReducer(s, { type: 'submit-start' })
    assert.equal(s.submitting, true)
    s = state.quickAskReducer(s, { type: 'submit-error', code: 'send-failed', message: 'boom' })
    assert.equal(s.submitting, false)
    assert.equal(s.errorCode, 'send-failed')
    assert.equal(s.errorMessage, 'boom')
    s = state.quickAskReducer(s, { type: 'submit-ok' })
    assert.deepEqual(s, state.INITIAL_QUICK_ASK_STATE)
  })
  check('快速提问：hide 清除提交中', () => {
    const s = state.quickAskReducer({ visible: true, submitting: true, errorCode: null, errorMessage: null }, { type: 'hide' })
    assert.equal(s.visible, false)
    assert.equal(s.submitting, false)
  })
  check('校验：空问题 / 无当前会话 / 通过', () => {
    assert.equal(state.validateQuickAsk('   ', 'new', true), 'empty')
    assert.equal(state.validateQuickAsk('hi', 'current', false), 'no-current')
    assert.equal(state.validateQuickAsk('hi', 'current', true), null)
    assert.equal(state.validateQuickAsk('hi', 'new', false), null)
  })
  check('迷你小窗：默认关闭、启用后才能显示', () => {
    let s = state.INITIAL_MINI_STATE
    assert.equal(s.enabled, false)
    s = state.miniReducer(s, { type: 'show' })
    assert.equal(s.visible, false)
    s = state.miniReducer(s, { type: 'set-enabled', enabled: true })
    s = state.miniReducer(s, { type: 'show' })
    assert.equal(s.visible, true)
    s = state.miniReducer(s, { type: 'set-enabled', enabled: false })
    assert.equal(s.visible, false)
  })
  check('迷你小窗：高度随条目增长并有上限', () => {
    assert.equal(state.miniWindowHeight(0), 36 + 44)
    assert.equal(state.miniWindowHeight(3), 36 + 132)
    assert.equal(state.miniWindowHeight(100), 420)
  })

  console.log('attention-items')
  const run = (runId, phase, overrides = {}) => ({
    runId,
    code: overrides.code ?? 'S1',
    kind: 'session',
    sessionId: overrides.sessionId ?? 's1',
    title: overrides.title ?? '任务',
    startedAt: 0,
    phase,
    counts: { tools: 0, edits: 0, errors: 0 }
  })
  const summary = {
    needsYou: [run('a', { kind: 'needs-you', since: 200, request: { id: 'r', type: 'confirm', summary: 'q' } })],
    stalled: [run('b', { kind: 'stalled', since: 300, cause: 'retry' })],
    failed: [run('c', { kind: 'failed', at: 500, cause: 'host', message: 'x', seen: false })],
    doneUnread: [run('d', { kind: 'done', at: 900, seen: false })],
    active: [
      run('a', { kind: 'needs-you', since: 200, request: { id: 'r', type: 'confirm', summary: 'q' } }),
      run('b', { kind: 'stalled', since: 300, cause: 'retry' }),
      run('e', { kind: 'running', since: 100, activity: 'waiting-model' }),
      run('f', { kind: 'queued', since: 50, reason: 'followup' })
    ],
    waiting: true,
    busy: true,
    attentionCount: 3,
    total: 6
  }
  check('条目按 等你→停滞→失败→运行中→排队→完成 排序', () => {
    const list = items.attentionItems(summary)
    assert.deepEqual(
      list.map((item) => item.runId),
      ['a', 'b', 'c', 'e', 'f', 'd']
    )
    assert.deepEqual(
      list.map((item) => item.statusKey),
      ['needs-you', 'stalled', 'failed', 'running', 'queued', 'done']
    )
  })
  check('未读标记与阶段时间', () => {
    const list = items.attentionItems(summary)
    const failed = list.find((item) => item.runId === 'c')
    assert.equal(failed.unread, true)
    assert.equal(failed.since, 500)
    const done = list.find((item) => item.runId === 'd')
    assert.equal(done.unread, true)
  })
  check('同一类内进行中按等待时间从早到晚、终态从新到旧', () => {
    const many = {
      ...summary,
      stalled: [
        run('late', { kind: 'stalled', since: 900, cause: 'retry' }),
        run('early', { kind: 'stalled', since: 100, cause: 'retry' })
      ]
    }
    const stalled = items.attentionItems(many).filter((item) => item.statusKey === 'stalled')
    assert.deepEqual(stalled.map((item) => item.runId), ['early', 'late'])
  })

  console.log('quick-ask-submit')
  const fake = (overrides = {}) => {
    const calls = []
    const agent = {
      send: async (text) => {
        calls.push(`send:${text}`)
        return overrides.sendResult ?? { ok: true }
      },
      getState: () => overrides.state ?? { sessionId: 'sess-1', sessionFile: '/tmp/s.jsonl' }
    }
    return {
      calls,
      activeRunId: () => (overrides.activeRunId === undefined ? 'run-1' : overrides.activeRunId),
      agentOf: () => (overrides.agentAvailable === false ? null : agent),
      start: async () => {
        calls.push('start')
        return overrides.startResult ?? { ok: true }
      },
      createSession: async (opts) => {
        calls.push(`create:${opts.projectId ?? ''}`)
        return overrides.createResult ?? { ok: true, id: 'run-2' }
      },
      applyModel: async (_runId, model) => {
        calls.push(`model:${model.provider}:${model.id}`)
        return overrides.applyModelResult ?? { ok: true }
      }
    }
  }
  check('空问题直接拒绝', async () => {
    const res = await submit.submitQuickAsk(fake(), { prompt: '  ', target: 'new' })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'empty')
  })
  check('无当前会话时选当前会话被拒', async () => {
    const res = await submit.submitQuickAsk(fake({ activeRunId: null }), { prompt: 'hi', target: 'current' })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'no-current')
  })
  check('新会话：先 start 再 create 再 send', async () => {
    const deps = fake()
    const res = await submit.submitQuickAsk(deps, { prompt: ' 你好 ', target: 'new', projectId: 'p1' })
    assert.deepEqual(deps.calls, ['start', 'create:p1', 'send:你好'])
    assert.deepEqual(res, { ok: true, runId: 'run-2', sessionId: 'sess-1', sessionPath: '/tmp/s.jsonl' })
  })
  check('当前会话：不新建、直接 send', async () => {
    const deps = fake()
    const res = await submit.submitQuickAsk(deps, { prompt: 'hi', target: 'current', projectId: 'ignored' })
    assert.deepEqual(deps.calls, ['send:hi'])
    assert.equal(res.ok, true)
  })
  check('启动失败返回 start-failed，不继续建会话', async () => {
    const deps = fake({ startResult: { ok: false, error: 'pi down' } })
    const res = await submit.submitQuickAsk(deps, { prompt: 'hi', target: 'new' })
    assert.equal(res.code, 'start-failed')
    assert.equal(res.message, 'pi down')
    assert.deepEqual(deps.calls, ['start'])
  })
  check('发送失败返回 send-failed', async () => {
    const deps = fake({ sendResult: { ok: false, error: 'nope' } })
    const res = await submit.submitQuickAsk(deps, { prompt: 'hi', target: 'current' })
    assert.equal(res.code, 'send-failed')
  })
  check('选择模型时先切换模型再发送', async () => {
    const deps = fake()
    const res = await submit.submitQuickAsk(deps, { prompt: 'hi', target: 'current', model: { provider: 'openai', id: 'gpt-x' } })
    assert.deepEqual(deps.calls, ['model:openai:gpt-x', 'send:hi'])
    assert.equal(res.ok, true)
  })
  check('切换模型失败返回 model-failed，不发送', async () => {
    const deps = fake({ applyModelResult: { ok: false, error: 'no model' } })
    const res = await submit.submitQuickAsk(deps, { prompt: 'hi', target: 'current', model: { provider: 'p', id: 'm' } })
    assert.equal(res.code, 'model-failed')
    assert.deepEqual(deps.calls, ['model:p:m'])
  })

  console.log(`\nv3 辅助小窗：${passed} 项断言通过`)
} finally {
  await rm(dir, { recursive: true, force: true })
}
