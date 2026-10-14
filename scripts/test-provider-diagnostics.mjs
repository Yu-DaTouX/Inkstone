import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const source = await readFile(new URL('../resources/pi-extensions/provider-diagnostics.js', import.meta.url), 'utf8')
const { default: install } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
const handlers = {}, entries = [], logs = []
const originalError = console.error
let checks = 0
const check = (condition, label) => { assert.ok(condition, label); checks++ }
const ctx = { model: { provider: 'openai-codex', api: 'openai-codex-responses', id: 'gpt-6-astra' } }
try {
  console.error = value => logs.push(value)
  install({ on: (name, fn) => { handlers[name] = fn }, appendEntry: (type, data) => entries.push({ type, data }) })
  const payload = { secret: 'private prompt', temperature: 1 }
  check(handlers.before_provider_request({ payload }, ctx) === undefined, 'diagnostics does not replace request payload')
  handlers.after_provider_response({ status: 200, headers: { 'X-Request-ID': 'req_test-1', authorization: 'Bearer secret', 'set-cookie': 'private' } }, ctx)
  handlers.provider_stream_event({ ...ctx.model, model: ctx.model.id, data: { type: 'response.created', response: { id: 'resp_test-1', output: ['private text'] } } }, ctx)
  handlers.provider_stream_event({ data: { type: 'response.output_text.delta', delta: 'private text' } }, ctx)
  check(entries.length === 0, 'successful streams do not create diagnostic entries')
  const error = { data: { type: 'error', error: { code: 'server_error', type: 'server_error', message: 'Bearer secret private prompt' }, api_key: 'sk-secret' } }
  handlers.provider_stream_event(error, ctx)
  check(entries.length === 1 && entries[0].type === 'inkstone-provider-error', 'stream failure is persisted as a custom diagnostic entry')
  check(entries[0].data.code === 'server_error' && entries[0].data.responseId === 'resp_test-1' && entries[0].data.requestId === 'req_test-1', 'error code and response/request identifiers preserved')
  check(entries[0].data.model === 'gpt-6-astra' && entries[0].data.status === 200, 'stream error may have successful HTTP status; model preserved')
  check(!JSON.stringify([entries, logs]).includes('private') && !JSON.stringify([entries, logs]).includes('secret'), 'prompt/error message/headers/credentials never copied')
  handlers.provider_stream_event(error, ctx)
  check(entries.length === 1, 'duplicate failure event in same request is suppressed')
  handlers.before_provider_request({}, ctx)
  handlers.provider_stream_event({ data: { type: 'response.failed', response: { id: 'resp_test-2', error: { code: 'invalid_request_error', status: 400 } } } }, ctx)
  check(entries[1].data.code === 'invalid_request_error' && entries[1].data.status === 400 && !entries[1].data.requestId, 'new request has no stale identifiers and supports response.failed')
  handlers.before_provider_request({}, ctx)
  handlers.after_provider_response({ status: 429, headers: new Headers({ 'x-request-id': 'req_test-3', 'cf-ray': 'abc-SEA' }) }, ctx)
  check(entries[2].data.event === 'http_error' && entries[2].data.requestId === 'req_test-3', 'HTTP failures before a stream retain safe request id')
  handlers.provider_stream_event({ data: { type: 'error', code: 'Bearer secret', response_id: 'sk-secret' } }, ctx)
  check(!entries.at(-1).data.code && !entries.at(-1).data.responseId, 'non-identifier and credential-shaped fields rejected')
  const throwing = {}
  install({ on: (name, fn) => { throwing[name] = fn }, appendEntry: () => { throw new Error('disk failure') } })
  check(throwing.provider_stream_event(error, ctx) === undefined, 'diagnostic write failure does not interrupt the model request')
  const host = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  check(host.includes("yanThinResourcePath('provider-diagnostics.js')"), 'shared provider extension list loads diagnostics for main and child agents')
} finally { console.error = originalError }
console.log(`provider-diagnostics: ${checks} checks passed (local hooks only, no network)`)
