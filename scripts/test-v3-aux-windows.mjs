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
  const submit = await compile('src/main/windows/quick-ask-submit.ts', join(dir, 'submit.mjs'))

  const area = { x: 0, y: 0, width: 1920, height: 1080 }

  console.log('geometry')
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
