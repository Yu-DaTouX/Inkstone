import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import extension, { PARALLEL_REJECTED_RETRY_HINT, isParallelRejection } from '../resources/pi-extensions/parallel-tool-calls.js'

const model = (extra = {}) => ({ api: 'openai-responses', provider: 'commandcode', baseUrl: 'https://api.commandcode.ai/provider/v1', id: 'deepseek/deepseek-v4.1-flash', ...extra })
const payload = (extra = {}) => ({ model: 'x', stream: true, input: [], tools: [{ type: 'function', name: 'read' }], ...extra })

function load() {
  const handlers = {}
  extension({ on: (name, fn) => { handlers[name] = fn } })
  return {
    request: (ctxModel, body) => handlers.before_provider_request({ type: 'before_provider_request', payload: body }, { model: ctxModel }),
    end: (message) => handlers.message_end({ type: 'message_end', message })
  }
}

const rejected = { role: 'assistant', stopReason: 'error', errorMessage: '400 Unknown parameter: \'parallel_tool_calls\'.' }
const ok = { role: 'assistant', stopReason: 'toolUse', content: [] }

{
  const ext = load()
  assert.equal(ext.request(model(), payload()).parallel_tool_calls, true, 'openai-responses 默认带上')
  assert.equal(ext.request(model({ api: 'openai-completions' }), payload()).parallel_tool_calls, true, 'openai-completions 默认带上')
  assert.equal(ext.request(model({ api: 'anthropic-messages' }), payload()), undefined, 'Anthropic 默认就允许并行，不改')
  assert.equal(ext.request(model({ api: 'openai-codex-responses' }), payload()), undefined, 'Codex 接口 pi 已自带')
  assert.equal(ext.request(model(), payload({ tools: [] })), undefined, '没有工具不加')
  assert.equal(ext.request(model(), payload({ parallel_tool_calls: false })), undefined, '已有设置不覆盖')
}

{
  const ext = load()
  const m = model({ baseUrl: 'https://relay.example/v1' })
  ext.request(m, payload())
  const out = ext.end(rejected)
  assert.ok(out.message.errorMessage.endsWith(PARALLEL_REJECTED_RETRY_HINT), '被拒时补上可重试提示')
  assert.match(out.message.errorMessage, /you can retry your request/i, '提示命中 pi 自动重试规则')
  assert.equal(ext.request(m, payload()), undefined, '被拒一次即关闭，重试不再带')
  assert.equal(ext.end(ok), undefined)
  assert.equal(ext.request(m, payload()), undefined, '之后一直不带')
  assert.equal(ext.request(model(), payload()).parallel_tool_calls, true, '其他地址不受影响')
}

{
  const ext = load()
  ext.request(model(), payload())
  assert.equal(ext.end({ role: 'assistant', stopReason: 'error', errorMessage: '400 This model\'s maximum context length is 200000 tokens' }), undefined, '无关的 400 不当作被拒')
  assert.equal(ext.request(model(), payload()).parallel_tool_calls, true)
  ext.end({ role: 'assistant', stopReason: 'error', errorMessage: '503 overloaded' })
  assert.equal(ext.request(model(), payload()).parallel_tool_calls, true, '临时错误不关闭')
}

assert.equal(isParallelRejection({ role: 'assistant', stopReason: 'error', errorMessage: '422 {"detail":[{"loc":["body","parallel_tool_calls"],"msg":"Extra inputs are not permitted"}]}' }), true)
assert.equal(isParallelRejection({ role: 'assistant', stopReason: 'error', errorMessage: '400 invalid_request_error: Unrecognized request argument supplied' }), true)
assert.equal(isParallelRejection({ role: 'assistant', stopReason: 'error', errorMessage: '401 invalid api key' }), false)

const host = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
assert.match(host, /PROVIDER_EXTENSION_FILES = \[[^\]]*'parallel-tool-calls\.js'/, '主会话与子代理共用的供应商扩展列表加载它')

console.log('parallel tool calls ok')
