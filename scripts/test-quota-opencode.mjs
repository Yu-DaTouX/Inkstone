import { runSuite } from './lib/test-suite.mjs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const RESET = '2026-11-18T04:29:48.000Z'
const PAYLOAD = { usage: {
  rolling: { status: 'ok', percent: 3, resetsAt: RESET },
  weekly: { status: 'ok', percent: 19, resetsAt: RESET },
  monthly: { status: 'rate-limited', percent: 99.5, resetsAt: RESET }
} }

await runSuite(import.meta.url, async (ok, compile) => {
  const { openCodeGoWindows } = await compile('src/main/quota-opencode.ts')
  const windows = openCodeGoWindows(PAYLOAD)
  ok(windows.map((window) => window.id).join(',') === 'rolling,weekly,monthly', 'Go 原生响应生成五小时、周、月窗口')
  ok(windows.map((window) => window.used).join(',') === '3,19,99.5' && windows.every((window) => window.total === 100), '保留官方百分比，不推算美元金额')
  ok(windows.every((window) => window.resetAt === Date.parse(RESET)), 'ISO 重置时间转换为毫秒')
  ok(windows[2].exceeded && !windows[0].exceeded, '尊重服务端 rate-limited，不只比较整数百分比')
  ok(openCodeGoWindows({ usage: { rolling: { percent: 0, resetsAt: 'bad' } } })[0]?.used === 0, '零用量保留，非法重置时间不伪造')
  ok(openCodeGoWindows({ usage: { rolling: { percent: 0, resetsAt: 'bad' } } })[0]?.resetAt === undefined, '未知重置时间保持未知')
  for (const payload of [null, {}, { usage: null }, { usage: { rolling: { percent: null }, weekly: { percent: '10' }, monthly: { percent: -1 } } }, { usage: { rolling: { percent: NaN }, weekly: { percent: Infinity } } }]) {
    ok(openCodeGoWindows(payload).length === 0, '缺失或异常百分比不伪造为零用量')
  }

  const credentials = await compile('src/main/quota-credentials.ts')
  const directory = await mkdtemp(join(tmpdir(), 'opencode-quota-'))
  try {
    const readAuth = async (provider) => ({ type: 'api_key', key: provider === 'opencode' ? 'zen-fixture' : 'go-fixture' })
    const options = { agentDir: directory, env: { OPENCODE_API_KEY: 'env-fixture' }, readAuth }
    for (const provider of ['opencode', 'opencode-go']) {
      ok((await credentials.resolveQuotaProviderCredential(provider, options)).secret === (provider === 'opencode' ? 'zen-fixture' : 'go-fixture'), `${provider} 按原生独立凭证优先于环境变量`)
      ok((await credentials.resolveQuotaProviderCredential(provider, { ...options, readAuth: async () => undefined })).secret === 'env-fixture', `${provider} 识别 OPENCODE_API_KEY`)
      await writeFile(join(directory, 'models.json'), JSON.stringify({ providers: { [provider]: { baseUrl: 'https://opencode.ai/inference/go/openai/v1', apiKey: '${OPENCODE_API_KEY}' } } }))
      ok((await credentials.resolveQuotaProviderCredential(provider, { ...options, readAuth: async () => undefined })).secret === 'env-fixture', `${provider} 接受官方模型配置环境引用`)
      await writeFile(join(directory, 'models.json'), JSON.stringify({ providers: { [provider]: { baseUrl: 'https://opencode.ai.evil.test/v1', apiKey: 'must-not-send' } } }))
      const blocked = await credentials.resolveQuotaProviderCredential(provider, options)
      ok(!blocked.secret && !!blocked.error && !blocked.error.includes('must-not-send'), `${provider} 不向官方转发代理服务的凭证，错误不泄露 Key`)
      await rm(join(directory, 'models.json'))
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }

  const stubs = {
    electron: 'export const net = { fetch: (...args) => globalThis.__opencodeQuotaFetch(...args) }',
    './credentials': 'export const readAuthEntry = async () => undefined; export const resolveCodexAccountId = async () => undefined',
    './image-credentials': 'export const hostImageCredentials = { codex: async () => null }',
    './quota-credentials': 'export const resolveQuotaProviderSecret = async () => globalThis.__opencodeQuotaKey'
  }
  const quota = await compile('src/main/quota.ts', { plugins: [{ name: 'opencode-quota-fixture', setup(build) {
    build.onResolve({ filter: /^(?:electron|\.\/(?:credentials|image-credentials|quota-credentials))$/ }, (args) => ({ path: args.path, namespace: 'opencode-fixture' }))
    build.onLoad({ filter: /.*/, namespace: 'opencode-fixture' }, (args) => ({ contents: stubs[args.path], loader: 'js' }))
  } }] })
  let calls = 0
  try {
    globalThis.__opencodeQuotaFetch = async (url, init) => {
      calls++
      ok(url === 'https://opencode.ai/zen/go/v1/usage', '只请求官方 Go 用量 GET 端点')
      ok(init.headers.Authorization === 'Bearer go-fixture' && init.redirect === 'error' && !init.body, '只发当前 Key，禁止重定向且不发推理请求')
      return new Response(JSON.stringify(PAYLOAD), { status: 200 })
    }
    const go = await quota.providerQuota('opencode-go', undefined, 'go-fixture')
    ok(go.supported && go.windows?.length === 3 && go.remaining === 0.5 && go.currency === 'PERCENT', '额度查询返回三窗口及百分比摘要')
    const before = calls
    const zen = await quota.providerQuota('opencode', undefined, 'zen-fixture')
    ok(!zen.supported && zen.error?.includes('Console') && zen.remaining === undefined && calls === before, 'Zen 无余额 API 时诚实说明，不请求猜测的接口')
    for (const status of [401, 403, 429, 503]) {
      globalThis.__opencodeQuotaFetch = async () => new Response('{}', { status })
      const failed = await quota.providerQuota('opencode-go', undefined, 'go-fixture')
      ok(failed.supported && failed.error === `HTTP ${status}` && !failed.windows, `Go HTTP ${status} 显示查询失败，不伪造额度`)
    }
    globalThis.__opencodeQuotaFetch = async () => new Response('{}')
    const empty = await quota.providerQuota('opencode-go', undefined, 'go-fixture')
    ok(!!empty.error && !empty.windows, '成功 HTTP 但无窗口也明确报错')
    globalThis.__opencodeQuotaKey = 'go-account-a'
    globalThis.__opencodeQuotaFetch = async () => new Response(JSON.stringify(PAYLOAD))
    await quota.providerQuotaWithFallback('opencode-go')
    globalThis.__opencodeQuotaFetch = async () => new Response('{}', { status: 503 })
    const stale = await quota.providerQuotaWithFallback('opencode-go')
    ok(stale.windows?.length === 3 && stale.staleError === 'HTTP 503', 'Go 实时用量保留同一 Key 的上次读数')
    globalThis.__opencodeQuotaKey = 'go-account-b'
    const otherAccount = await quota.providerQuotaWithFallback('opencode-go')
    ok(otherAccount.error === 'HTTP 503' && !otherAccount.windows && !otherAccount.staleError, 'Go 实时用量换 Key 不借用另一账号的缓存')
  } finally {
    delete globalThis.__opencodeQuotaKey
    delete globalThis.__opencodeQuotaFetch
  }
})
