import assert from 'node:assert/strict'
import { fakePiEvents } from './lib/fake-pi-events.mjs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fastMode, { fastModeSupported, withFastServiceTier } from '../resources/pi-extensions/fast-mode.js'

let checks = 0
const ok = (value, message) => {
  assert.ok(value, message)
  checks++
}

const codex = (id) => ({ provider: 'openai-codex', api: 'openai-codex-responses', id })

for (const id of ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra']) ok(fastModeSupported(codex(id)), `${id} 支持快速`)
for (const id of ['gpt-5.5', 'gpt-6-nano', 'gpt-6.1-solar', 'codex-mini']) ok(!fastModeSupported(codex(id)), `${id} 不支持快速`)
ok(!fastModeSupported({ provider: 'openai', api: 'openai-responses', id: 'gpt-6-luna' }), 'API Key 的 openai 不走订阅快速')
ok(!fastModeSupported({ provider: 'anthropic', api: 'anthropic-messages', id: 'claude-opus-5-5' }), 'Claude 不做')

const payload = { model: 'gpt-6-luna', input: [] }
const next = withFastServiceTier(payload)
ok(next.service_tier === 'priority' && next.input === payload.input, '加 service_tier 且保留原请求')
ok(payload.service_tier === undefined, '不改原对象')
ok(withFastServiceTier({ ...payload, service_tier: 'priority' }) === undefined, '已是 priority 不重复改')
ok(withFastServiceTier(null) === undefined && withFastServiceTier([]) === undefined, '非对象不处理')

const dir = mkdtempSync(join(tmpdir(), 'yan-fast-'))
process.env.YAN_DATA_DIR = dir
const handlers = {}
fastMode({ on: (name, fn) => { handlers[name] = fn }, events: fakePiEvents() })
const run = (model) => handlers.before_provider_request({ payload }, { model })
writeFileSync(join(dir, 'desktop.json'), JSON.stringify({}))
ok(run(codex('gpt-6-luna')) === undefined, '设置关闭时不改')
writeFileSync(join(dir, 'desktop.json'), JSON.stringify({ fastMode: true }))
ok(run(codex('gpt-6-luna'))?.service_tier === 'priority', '设置开启时 Codex 请求加 priority')
ok(run({ provider: 'fake', api: 'openai-responses', id: 'fake-model' }) === undefined, '其他模型不改')

console.log(`fast-mode: ${checks} checks passed`)
