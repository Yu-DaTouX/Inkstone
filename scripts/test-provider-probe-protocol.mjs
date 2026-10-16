import { build } from 'esbuild'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'provider-probe-'))
process.once('exit', () => rmSync(root, { recursive: true, force: true }))
const piDir = join(root, 'pi')
process.env.YAN_PI_DIR = piDir
process.env.YAN_DATA_DIR = join(root, 'yan')
await mkdir(piDir, { recursive: true })

const KEY = {
  openai: 'sk-synthetic-openai',
  anthropic: 'sk-synthetic-anthropic',
  anthropicBare: 'sk-synthetic-anthropic-bare',
  google: 'sk-synthetic-google'
}

await writeFile(
  join(piDir, 'models.json'),
  `${JSON.stringify(
    {
      providers: {
        'yan-openai': { api: 'openai-completions', baseUrl: 'https://openai.example/v1', apiKey: KEY.openai, models: [{ id: 'm' }] },
        'yan-anthropic': { api: 'anthropic-messages', baseUrl: 'https://anthropic.example/v1', apiKey: KEY.anthropic, models: [{ id: 'm' }] },
        'yan-anthropic-bare': { api: 'anthropic-messages', baseUrl: 'https://anthropic-bare.example', apiKey: KEY.anthropicBare, models: [{ id: 'm' }] },
        'yan-google': { api: 'google-generative-ai', baseUrl: 'https://google.example/v1beta', apiKey: KEY.google, models: [{ id: 'm' }] }
      }
    },
    null,
    2
  )}\n`,
  'utf8'
)

const outfile = join(root, 'custom-providers.mjs')
await build({
  entryPoints: [fileURLToPath(new URL('../src/main/custom-providers.ts', import.meta.url))],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const providers = await import(pathToFileURL(outfile).href)

const calls = []
let handler = () => jsonResponse({ data: [{ id: 'model-a' }] })

const originalFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const record = { url: String(url), headers: new Headers(init.headers), method: init.method ?? 'GET' }
  calls.push(record)
  return handler(record)
}

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const reset = (nextHandler) => {
  calls.length = 0
  if (nextHandler) handler = nextHandler
}

let passed = 0
const check = (name) => {
  passed++
  console.log(`  ok ${passed} - ${name}`)
}

const assertNoKey = (text, ...keys) => {
  for (const key of keys) assert.equal(String(text).includes(key), false, `结果消息泄漏了密钥：${text}`)
}

reset(() => jsonResponse({ data: [{ id: 'model-a' }] }))

const openai = await providers.testCustomProviderEndpoint('yan-openai')
assert.equal(openai.ok, true)
assert.equal(calls.length, 1)
assert.equal(calls[0].url, 'https://openai.example/v1/models')
assert.equal(calls[0].headers.get('authorization'), `Bearer ${KEY.openai}`)
assert.equal(calls[0].headers.get('x-api-key'), null)
assert.equal(calls[0].headers.get('x-goog-api-key'), null)
assertNoKey(openai.message, KEY.openai)
check('OpenAI 免费测试：<baseUrl>/models + Authorization Bearer')

reset(() => jsonResponse({ data: [{ id: 'claude-a' }] }))
const anthropic = await providers.testCustomProviderEndpoint('yan-anthropic')
assert.equal(anthropic.ok, true)
assert.equal(calls.length, 1)
assert.equal(calls[0].url, 'https://anthropic.example/v1/models')
assert.equal(calls[0].headers.get('x-api-key'), KEY.anthropic)
assert.equal(calls[0].headers.get('anthropic-version'), '2023-06-01')
assert.equal(calls[0].headers.get('authorization'), null)
assertNoKey(anthropic.message, KEY.anthropic)
check('Anthropic 免费测试：x-api-key + anthropic-version，不带 Bearer')

reset(() => jsonResponse({ models: [{ name: 'models/gemini-x' }] }))
const google = await providers.testCustomProviderEndpoint('yan-google')
assert.equal(google.ok, true)
assert.equal(calls.length, 1)
assert.equal(calls[0].url, 'https://google.example/v1beta/models')
assert.equal(calls[0].headers.get('x-goog-api-key'), KEY.google)
assert.equal(calls[0].headers.get('authorization'), null)
assertNoKey(google.message, KEY.google)
check('Google 免费测试：x-goog-api-key，不带 Bearer')

reset((record) =>
  record.url.endsWith('/v1/models') ? jsonResponse({ data: [{ id: 'claude-bare' }] }) : new Response('missing', { status: 404 })
)
const fallback = await providers.testCustomProviderEndpoint('yan-anthropic-bare')
assert.equal(fallback.ok, true)
assert.equal(calls.length, 2)
assert.equal(calls[0].url, 'https://anthropic-bare.example/models')
assert.equal(calls[1].url, 'https://anthropic-bare.example/v1/models')
for (const call of calls) {
  assert.equal(call.headers.get('x-api-key'), KEY.anthropicBare)
  assert.equal(call.headers.get('authorization'), null)
}
assertNoKey(fallback.message, KEY.anthropicBare)
check('Anthropic 无 /v1 时按同一鉴权头回退一次 /v1')

reset(() => new Response('missing', { status: 404 }))
const openai404 = await providers.testCustomProviderEndpoint('yan-openai')
assert.equal(openai404.ok, false)
assert.equal(calls.length, 1, '非 Anthropic 协议不应做 /v1 回退')
assert.equal(calls[0].url, 'https://openai.example/v1/models')
assert.match(openai404.message, /地址可达，但端点没有模型列表/)
assertNoKey(openai404.message, KEY.openai)
check('OpenAI 404 不回退，按「地址可达但无模型列表」分类')

for (const status of [401, 403]) {
  reset(() => jsonResponse({ error: { message: `bad key ${KEY.google}` } }, status))
  const denied = await providers.testCustomProviderEndpoint('yan-google')
  assert.equal(denied.ok, false)
  assert.equal(denied.ms >= 0, true)
  assert.match(denied.message, new RegExp(`凭证被拒绝（HTTP ${status}）`))
  assertNoKey(denied.message, KEY.google)
}
check('401/403 归类为凭证被拒绝，且不回显响应体里的密钥')

reset(() => jsonResponse({ error: 'boom' }, 500))
const serverError = await providers.testCustomProviderEndpoint('yan-google')
assert.equal(serverError.ok, false)
assert.match(serverError.message, /端点返回 HTTP 500/)
assertNoKey(serverError.message, KEY.google)
check('其它非 2xx 归类为端点返回 HTTP 状态')

reset(() => {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  throw error
})
const aborted = await providers.testCustomProviderEndpoint('yan-google')
assert.equal(aborted.ok, false)
assert.match(aborted.message, /连接超时（10 秒）/)
check('AbortError 归类为连接超时')

reset(() => {
  const error = new Error('fetch failed')
  error.cause = { code: 'ENOTFOUND' }
  throw error
})
const unreachable = await providers.testCustomProviderEndpoint('yan-google')
assert.equal(unreachable.ok, false)
assert.match(unreachable.message, /连不上：fetch failed（ENOTFOUND）/)
check('网络错误带 cause code 说明')

reset(() => jsonResponse({ data: [{ id: 'claude-x', name: 'Claude X' }] }))
const discovered = await providers.discoverCustomProviderModels({
  api: 'anthropic-messages',
  baseUrl: 'https://anthropic.example/v1',
  apiKey: 'sk-synthetic-discover'
})
assert.equal(discovered.ok, true)
assert.equal(calls[0].url, 'https://anthropic.example/v1/models')
assert.equal(calls[0].headers.get('x-api-key'), 'sk-synthetic-discover')
assert.equal(calls[0].headers.get('anthropic-version'), '2023-06-01')
assert.equal(calls[0].headers.get('authorization'), null)
check('获取模型对 Anthropic 使用同一套鉴权头与端点')

reset(() => jsonResponse({ data: [{ id: 'model-a' }] }))
const changed = await providers.discoverCustomProviderModels({
  id: 'yan-openai',
  api: 'openai-completions',
  baseUrl: 'https://elsewhere.example/v1'
})
assert.equal(changed.ok, false)
assert.equal(calls.length, 0, '地址变化时不得发出带旧密钥的请求')
assert.match(changed.message, /服务地址已更改/)

const same = await providers.discoverCustomProviderModels({
  id: 'yan-openai',
  api: 'openai-completions',
  baseUrl: 'https://openai.example/v1'
})
assert.equal(same.ok, true)
assert.equal(calls.length, 1)
assert.equal(calls[0].headers.get('authorization'), `Bearer ${KEY.openai}`)
check('Base URL 变化时隔离旧密钥，未变化时才沿用磁盘密钥')

globalThis.fetch = originalFetch
console.log(`\nprovider-probe-protocol: ${passed} checks passed`)
