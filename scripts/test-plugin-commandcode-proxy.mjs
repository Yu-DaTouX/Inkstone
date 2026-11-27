import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

let checks = 0
const ok = (value, message) => { assert.ok(value, message); checks++; console.log(`  ✓ ${message}`) }

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer().once('error', reject)
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)) })
  })
}

const root = await mkdtemp(join(tmpdir(), 'inkstone-ccproxy-'))
const seen = []
const upstream = createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
    if (req.url !== '/alpha/generate') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const line of [
      { type: 'text-start' }, { type: 'text-delta', text: 'hello from fixture' }, { type: 'text-end' },
      { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 9, outputTokens: 3 } },
      { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 9, outputTokens: 3, cachedInputTokens: 0 } }
    ]) res.write(`${JSON.stringify(line)}\n`)
    res.end()
  })
})
let plugins, busyPlugins, blocker
try {
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const port = await freePort()
  const sources = join(root, 'sources')
  await cp('integrations/commandcode-proxy', join(sources, 'commandcode-proxy'), { recursive: true })
  const manifestPath = join(sources, 'commandcode-proxy', 'inkstone-plugin.json')
  const shipped = JSON.parse(await readFile(manifestPath, 'utf8'))
  ok(shipped.id === 'commandcode-proxy' && shipped.process === 'plugin.mjs' && !shipped.extension, '清单只声明独立进程，不向 pi 注入扩展')
  ok(!shipped.environment.some(name => /KEY|TOKEN|SECRET/i.test(name)), '清单不转发任何密钥类环境变量')
  await writeFile(manifestPath, JSON.stringify({ ...shipped, environment: [...shipped.environment, 'CC_API_BASE', 'CC_USE_PROVIDER_MODELS'] }))
  Object.assign(process.env, { YAN_COMMANDCODE_PROXY_PORT: String(port), CC_API_BASE: `http://127.0.0.1:${upstream.address().port}`, CC_USE_PROVIDER_MODELS: 'false' })

  const bundle = join(root, 'host.mjs')
  await build({ entryPoints: ['src/main/bundled-plugins.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { BundledPlugins } = await import(pathToFileURL(bundle).href)
  const host = dataDir => new BundledPlugins({ sources: [sources], dataDir, runtime: process.execPath, complete: async () => '', showWindow: () => undefined, listProcesses: async () => [] })
  plugins = host(join(root, 'data'))

  const before = await plugins.action('commandcode-proxy', 'status')
  ok(before.ok && before.installed === false, '未安装时状态为未安装')
  const installed = await plugins.action('commandcode-proxy', 'install')
  ok(installed.ok && installed.installed && installed.status?.running === true, `安装后代理进程就绪：${JSON.stringify(installed.status ?? installed.error)}`)
  ok(installed.status.url === `http://127.0.0.1:${port}/v1`, '只在本机回环地址监听并报告 Base URL')
  ok(plugins.installed('commandcode-proxy') && plugins.extensionPaths().length === 0, '安装标记写入且没有 pi 扩展路径')

  const base = `http://127.0.0.1:${port}`
  ok((await fetch(`${base}/health`)).ok, '健康检查可访问')
  const unauth = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] }) })
  ok(unauth.status === 401 || unauth.status === 400, `缺少密钥时拒绝请求（${unauth.status}）`)
  const chat = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer user_fixturekey' }, body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] }) })
  const chatBody = await chat.json()
  ok(chat.ok && chatBody.choices?.[0]?.message?.content === 'hello from fixture', 'OpenAI Chat Completions 经代理返回上游内容')
  const generate = seen.filter(item => item.url === '/alpha/generate').pop()
  ok(generate && JSON.stringify(generate.headers).includes('user_fixturekey'), '请求头里的密钥被转发到上游 /alpha/generate')
  const stream = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'user_fixturekey' }, body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] }) })
  const events = await stream.text()
  ok(stream.ok && events.includes('message_stop') && events.includes('hello from fixture'), 'Anthropic Messages 流式响应完整')
  const status = await plugins.action('commandcode-proxy', 'status')
  ok(status.ok && status.status?.running === true, '安装后再次查询状态仍在运行')

  busyPlugins = host(join(root, 'data-busy'))
  const busy = await busyPlugins.action('commandcode-proxy', 'install')
  ok(busy.ok && busy.status?.running === false && /已被占用/.test(busy.status?.error ?? ''), '端口被占用时插件不崩溃并说明原因')
  ok((await fetch(`${base}/health`)).ok, '端口冲突不影响已运行的代理')

  const removed = await plugins.action('commandcode-proxy', 'remove')
  ok(removed.ok && removed.installed === false, '卸载成功')
  const gone = await fetch(`${base}/health`).then(() => false, () => true)
  ok(gone, '卸载后代理进程退出、端口释放')

  const providerBundle = join(root, 'provider.mjs')
  await build({ entryPoints: ['src/main/commandcode-proxy-provider.ts'], outfile: providerBundle, bundle: true, platform: 'node', format: 'esm', external: ['electron'], logLevel: 'silent' })
  const { ensureCommandCodeProxyProvider, COMMANDCODE_PROXY_PROVIDER } = await import(pathToFileURL(providerBundle).href)
  const asked = []
  const discover = async input => {
    asked.push(input.baseUrl)
    if (input.baseUrl.startsWith('https://api.commandcode.ai')) return { ok: true, models: ['deepseek/deepseek-v4-flash', 'claude-sonnet-5-5'], entries: [{ id: 'deepseek/deepseek-v4-flash', reasoning: true, contextWindow: 1000000 }, { id: 'claude-sonnet-5-5', api: 'anthropic-messages', baseUrl: 'https://api.commandcode.ai/provider', input: ['text', 'image'] }], message: '' }
    return { ok: false, models: [], message: 'unused' }
  }
  const proxyUrl = `http://127.0.0.1:${port}/v1`
  const first = await ensureCommandCodeProxyProvider(proxyUrl, { discover })
  const modelsFile = join(process.env.PI_CODING_AGENT_DIR, 'models.json')
  const saved = JSON.parse(await readFile(modelsFile, 'utf8')).providers[COMMANDCODE_PROXY_PROVIDER]
  ok(first.created && asked[0].startsWith('https://api.commandcode.ai') && saved?.baseUrl === proxyUrl && saved.api === 'openai-completions', `安装后自动建立指向本机代理的自定义服务：${JSON.stringify(first)}`)
  ok(!('apiKey' in saved), '自动建立的服务不含任何密钥')
  ok(saved.models.length === 2 && saved.models.every(model => !model.baseUrl && !model.api) && saved.models[0].reasoning === true, '模型取自官方目录、保留能力信息，且每个模型都走代理地址')
  const edited = JSON.parse(await readFile(modelsFile, 'utf8'))
  edited.providers[COMMANDCODE_PROXY_PROVIDER].apiKey = 'user_kept'
  await writeFile(modelsFile, JSON.stringify(edited))
  const again = await ensureCommandCodeProxyProvider(proxyUrl, { discover })
  ok(!again.created && JSON.parse(await readFile(modelsFile, 'utf8')).providers[COMMANDCODE_PROXY_PROVIDER].apiKey === 'user_kept', '已有服务时重装不覆盖用户填的 Key')
  const fallback = await ensureCommandCodeProxyProvider(proxyUrl, { list: async () => [], save: async input => ({ ok: true, input }), discover: async input => input.baseUrl === proxyUrl ? { ok: true, models: ['m1'], message: '' } : { ok: false, models: [], message: 'offline' } })
  ok(fallback.created, '官方目录不可达时改用代理给出的模型列表')
  const none = await ensureCommandCodeProxyProvider(proxyUrl, { list: async () => [], discover: async () => ({ ok: false, models: [], message: 'offline' }) })
  ok(!none.created && none.error, '取不到模型时不写入并返回原因')

  const quotaBundle = join(root, 'quota.mjs')
  await build({ entryPoints: ['src/main/quota-credentials.ts'], outfile: quotaBundle, bundle: true, platform: 'node', format: 'esm', external: ['electron'], logLevel: 'silent' })
  const { customCommandCodeQuotaProviders, resolveQuotaProviderCredential } = await import(pathToFileURL(quotaBundle).href)
  const quotaDir = join(root, 'quota-agent')
  const writeModels = providers => cp(modelsFile, join(quotaDir, 'models.json')).then(() => writeFile(join(quotaDir, 'models.json'), JSON.stringify({ providers })))
  const resolveKey = id => resolveQuotaProviderCredential(id, { agentDir: quotaDir, env: {}, readAuth: async () => undefined, quotaProvider: 'commandcode' })
  const entry = { api: "openai-completions", models: [{ id: "deepseek/deepseek-v4-flash" }] }
  await writeModels({ [COMMANDCODE_PROXY_PROVIDER]: { ...entry, baseUrl: proxyUrl, apiKey: 'user_quota' } })
  ok((await customCommandCodeQuotaProviders(quotaDir)).includes(COMMANDCODE_PROXY_PROVIDER) && (await resolveKey(COMMANDCODE_PROXY_PROVIDER)).secret === 'user_quota', '代理服务列入 Command Code 额度并解析出其 Key')
  await writeModels({ [COMMANDCODE_PROXY_PROVIDER]: { ...entry, baseUrl: 'https://relay.example.com/v1', apiKey: 'user_quota' } })
  ok(!(await customCommandCodeQuotaProviders(quotaDir)).length && !(await resolveKey(COMMANDCODE_PROXY_PROVIDER)).secret, '代理服务地址被改成远程时不发送 Key 查额度')
  await writeModels({ [COMMANDCODE_PROXY_PROVIDER]: { ...entry, baseUrl: proxyUrl, apiKey: 'user_quota', models: [{ id: 'm', baseUrl: 'https://relay.example.com/v1' }] } })
  ok(!(await resolveKey(COMMANDCODE_PROXY_PROVIDER)).secret, '单个模型指向远程地址时也不发送 Key')
  await writeModels({ 'yan-other-local': { ...entry, baseUrl: proxyUrl, apiKey: 'user_quota' } })
  ok(!(await customCommandCodeQuotaProviders(quotaDir)).length && !(await resolveKey('yan-other-local')).secret, '其他本机服务不会被当成 Command Code')

  blocker = createNetServer()
  await new Promise(resolve => blocker.listen(port, '127.0.0.1', resolve))
  await new Promise(resolve => blocker.close(resolve))
  blocker = undefined
  ok(true, '端口可被重新占用')
  console.log(`plugin-commandcode-proxy: ${checks}/${checks} 通过（假上游，未连接 Command Code）`)
} finally {
  await plugins?.close().catch(() => undefined)
  await busyPlugins?.close().catch(() => undefined)
  blocker?.close()
  upstream.closeAllConnections?.()
  await new Promise(resolve => upstream.close(resolve))
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => undefined)
}
