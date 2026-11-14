import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const caps = await compile('src/shared/model-capabilities.ts')
  const local = (baseUrl) => caps.normalizeModelInfo({ id: 'm', provider: 'p', baseUrl })?.local === true

  ok(local('http://127.0.0.1:8080/v1'), '回环地址算本地')
  ok(local('http://localhost:11434/v1'), 'localhost 算本地')
  ok(local('http://[::1]:1234/v1'), 'IPv6 回环算本地')
  ok(local('http://192.168.1.20:8000/v1') && local('http://10.0.0.5/v1') && local('http://172.20.0.2/v1'), '局域网地址算本地')
  ok(local('http://my-box.local:8080/v1'), 'mDNS 主机名算本地')
  ok(!local('https://api.openai.com/v1'), '公网服务商不算本地')
  ok(!local('http://172.32.0.1/v1') && !local('http://8.8.8.8/v1'), '私网段以外的 IP 不算本地')
  ok(!local(undefined) && !local('not a url'), '没有或无效地址不算本地')

  const providers = await compile('src/renderer/src/t3/adapters/providers.ts')
  const entries = providers.providerInstanceEntries({
    models: [
      { id: 'q', name: 'q', provider: 'ninfer', local: true, reasoning: true, contextWindow: 1 },
      { id: 'g', name: 'g', provider: 'openai', reasoning: true, contextWindow: 1 }
    ],
    providers: [],
    order: [],
    setupMessage: () => ''
  })
  const byId = new Map(entries.map((entry) => [entry.instanceId, entry]))
  ok(byId.get('ninfer')?.local === true, '有本地模型的服务商条目带 local 标记')
  ok(byId.get('openai')?.local === undefined, '云端服务商条目不带 local 标记')
})
