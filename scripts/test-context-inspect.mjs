/**
 * 上下文构成观测扩展（resources/pi-extensions/context-inspect.js）与快照解析。
 * 只测纯函数与形状收敛；与宿主的 HTTP 上报在 live 场景里验证。
 */
import assert from 'node:assert/strict'

const { buildSnapshot, splitPrompt, estimateTokens } = await import('../resources/pi-extensions/context-inspect.js')

const prompt = [
  'You are an assistant.',
  '',
  '<tools>',
  '- read: read files',
  '</tools>',
  '',
  '<rules>',
  '```',
  '<tools>',
  'fenced example, not a section',
  '```',
  '- be brief',
  '</rules>',
  '',
  '追加一句中文说明。'
].join('\n')

const parts = splitPrompt(prompt)
assert.deepEqual(parts.map(p => p.id), ['preamble', 'tools', 'rules', 'additions'])
assert.ok(parts.every(p => p.tokens > 0 && p.chars > 0))

assert.equal(splitPrompt('plain text only')[0].id, 'prompt')
assert.ok(estimateTokens('你好世界') > estimateTokens('abcd'))

const snap = buildSnapshot(prompt, [
  { name: 'read', description: 'read a file', parameters: { type: 'object' } },
  { name: 'bash', description: 'run', parameters: {} }
], ['read'])
assert.equal(snap.tools.find(t => t.name === 'read').active, true)
assert.equal(snap.tools.find(t => t.name === 'bash').active, false)
assert.equal(snap.toolTokens, snap.tools.find(t => t.name === 'read').tokens)

console.log('context-inspect: ok')
