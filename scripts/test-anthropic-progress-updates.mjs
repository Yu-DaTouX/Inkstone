import assert from 'node:assert/strict'
import { fakePiEvents } from './lib/fake-pi-events.mjs'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'yan-progress-'))
process.env.YAN_DATA_DIR = dataDir
const setDisplay = (value) => writeFileSync(join(dataDir, 'desktop.json'), JSON.stringify(value ? { thinkingDisplay: value } : {}))
setDisplay('updates')
import extension, { DISPLAY_REJECTED_RETRY_HINT, PROGRESS_UPDATES_BETA, PROGRESS_UPDATE_MODEL, isProgressUpdateModel } from '../resources/pi-extensions/anthropic-progress-updates.js'

const model = (id, extra = {}) => ({ api: 'anthropic-messages', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', id, ...extra })

for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-mythos-5-1', 'claude-fable-5-2', 'claude-mythos-5-2', 'claude-fable-5-2-20261001', 'claude-fable-5', 'claude-fable-5-20261001', 'anthropic/claude-opus-5.5', 'anthropic/claude-fable-5.2']) {
  assert.equal(isProgressUpdateModel(model(id)), true, id)
}
for (const id of ['claude-opus-4-6', 'claude-sonnet-4-5', 'claude-fable-5-3', 'claude-mythos-5-3', 'claude-mythos-5-20261001', 'deepseek-v4']) {
  assert.equal(isProgressUpdateModel(model(id)), false, id)
}
assert.ok(
  readFileSync(new URL('../src/main/session-items/projector.ts', import.meta.url), 'utf8').includes(`const PROGRESS_UPDATE_MODEL = ${PROGRESS_UPDATE_MODEL}\n`),
  '消息投影与扩展用同一条模型正则'
)
assert.equal(isProgressUpdateModel(model('claude-opus-5-5', { api: 'bedrock-converse-stream' })), false, 'Bedrock 不走 Messages beta')

function load() {
  const handlers = {}
  extension({ on: (name, fn) => { handlers[name] = fn }, events: fakePiEvents() })
  return {
    request: (ctxModel, payload) => handlers.before_provider_request({ type: 'before_provider_request', payload }, { model: ctxModel }),
    end: (message) => handlers.message_end({ type: 'message_end', message })
  }
}

const payload = () => ({ model: 'x', stream: true, betas: ['other'], thinking: { type: 'adaptive', display: 'summarized' } })
const rejected = { role: 'assistant', stopReason: 'error', errorMessage: '400 {"type":"error","error":{"type":"invalid_request_error","message":"thinking.display: \\"updates\\" requires beta"}}' }
const ok = { role: 'assistant', stopReason: 'toolUse', content: [] }

{
  const ext = load()
  const out = ext.request(model('claude-opus-5-5'), payload())
  assert.equal(out.thinking.display, 'updates')
  assert.deepEqual(out.betas, ['other', PROGRESS_UPDATES_BETA])
  assert.equal(ext.request(model('claude-opus-4-6'), payload()), undefined, '其他模型不改')
  assert.equal(ext.request(model('claude-opus-5-5'), { thinking: { type: 'disabled' } }), undefined, '关闭思考时不改')
}

{
  const ext = load()
  const m = model('claude-opus-5-5', { baseUrl: 'https://relay.example' })
  ext.request(m, payload())
  const first = ext.end(rejected)
  assert.ok(first.message.errorMessage.endsWith(DISPLAY_REJECTED_RETRY_HINT), '被拒时补上可重试提示，交给 pi 自动重试')
  assert.match(first.message.errorMessage, /you can retry your request/i)
  assert.equal(ext.request(m, payload()), undefined, '紧接着的重试用 summarized')
  assert.equal(ext.end(ok), undefined)
  assert.equal(ext.request(m, payload()).thinking.display, 'updates', '一次被拒不记住，下一轮仍试 updates')
  ext.end(rejected)
  assert.equal(ext.request(m, payload()), undefined)
  ext.end(ok)
  assert.equal(ext.request(m, payload()), undefined, '同一地址同一模型连续两次被拒后记住')
  assert.equal(ext.request(model('claude-opus-5-5'), payload()).thinking.display, 'updates', '其他地址不受影响')
}

{
  const ext = load()
  const m = model('claude-sonnet-5-5')
  ext.request(m, payload())
  ext.end(rejected)
  ext.request(m, payload())
  ext.end(ok)
  ext.request(m, payload())
  ext.end(ok)
  ext.request(m, payload())
  ext.end(rejected)
  assert.equal(ext.request(m, payload()), undefined)
  ext.end(ok)
  assert.equal(ext.request(m, payload()).thinking.display, 'updates', '中间成功过就重新计数')
}

{
  const ext = load()
  ext.request(model('claude-opus-5-5'), payload())
  assert.equal(ext.end({ role: 'assistant', stopReason: 'error', errorMessage: '400 prompt is too long' }), undefined, '与 display 无关的 400 不当作被拒')
  assert.equal(ext.request(model('claude-opus-5-5'), payload()).thinking.display, 'updates')
}

console.log('anthropic progress updates ok')

{
  setDisplay(undefined)
  const ext = load()
  assert.equal(ext.request(model('claude-opus-5-5'), payload()), undefined, '默认（思考摘要）不改请求，沿用 pi 原生')
  setDisplay('updates')
  assert.equal(ext.request(model('claude-opus-5-5'), payload()).thinking.display, 'updates', '设置为进度更新时才改写')
}
