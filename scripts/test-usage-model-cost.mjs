import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const entry = fileURLToPath(new URL('../src/renderer/src/features/settings/usage/usage-model.ts', import.meta.url))
const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' })
const { usageModelFree } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

const models = [
  { provider: 'openrouter', id: 'qwen/qwen3-coder:free', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  { provider: 'anthropic', id: 'claude-opus-5-5', cost: { input: 5, output: 25 } },
  { provider: 'local', id: 'llama-local' }
]

assert.equal(usageModelFree({ key: 'qwen3-coder:free', sources: ['openrouter/qwen/qwen3-coder:free'] }, models), true, '报价全为 0 的模型算免费')
assert.equal(usageModelFree({ key: 'claude-opus-5-5', sources: ['anthropic/claude-opus-5-5'] }, models), false, '有报价的模型不算免费')
assert.equal(usageModelFree({ key: 'llama-local', sources: ['local/llama-local'] }, models), false, '没有报价信息的模型不算免费')
assert.equal(usageModelFree({ key: 'unknown-model', sources: ['x/unknown-model'] }, models), false, '目录里找不到的模型不算免费')
assert.equal(usageModelFree({ key: 'claude-opus-5-5', sources: [] }, models), false, '只按 key 匹配时同样读报价')

console.log('usage-model-cost: 5 passed')
