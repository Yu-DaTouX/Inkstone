import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(
  new URL('../src/renderer/src/features/settings/models/models-model.ts', import.meta.url)
)
const result = await build({
  entryPoints: [source],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const mod = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
)

const {
  authInfoFor,
  canRemoveCredential,
  credentialFromEnv,
  entryState,
  isFavorite,
  needsInAppLogin,
  newestFirst,
  providerRank,
  serviceState,
  serviceSummary,
  splitServices,
  toggleFavorite
} = mod

const provider = (over = {}) => ({
  id: over.id ?? 'p',
  name: over.name ?? 'P',
  kind: over.kind ?? 'api_key',
  envVar: over.envVar ?? '',
  authKey: over.authKey ?? '',
  status: over.status ?? 'missing',
  ...over
})

assert.equal(serviceState('acme', [provider({ id: 'acme', status: 'ready' })]), 'ready', '已配置')
assert.equal(entryState(provider({ status: 'ready' })), 'ready', '条目自身的已配置状态')
assert.equal(entryState(provider({ status: 'missing', kind: 'subscription', inAppLogin: true })), 'loginable')
assert.equal(entryState(provider({ status: 'unknown' })), 'unknown')
assert.equal(serviceState('acme', [provider({ id: 'acme', status: 'missing' })]), 'missing', 'API key 未配置')
assert.equal(
  serviceState('acme', [provider({ id: 'acme', kind: 'subscription', inAppLogin: true, status: 'missing' })]),
  'loginable',
  '订阅可应用内登录但未配置'
)
assert.equal(serviceState('acme', [provider({ id: 'acme', status: 'unknown' })]), 'unknown', '状态未知不是未配置')
assert.equal(serviceState('acme', []), 'unknown', '目录里没有该服务商时不猜测')
assert.equal(
  serviceState('xai', [provider({ id: 'xai-api', authKey: 'xai', status: 'ready' })]),
  'ready',
  'provider 按 authKey 归到同一凭证条目'
)
assert.equal(authInfoFor('', [provider()]), undefined, '空 provider 不匹配')
assert.equal(needsInAppLogin(provider({ kind: 'subscription', inAppLogin: true })), true)
assert.equal(needsInAppLogin(provider({ kind: 'subscription' })), false, '没有应用内登录模块的订阅不算 loginable')
assert.equal(needsInAppLogin(provider({ kind: 'api_key', inAppLogin: true })), false, 'API key 永远不显示应用内登录')

assert.equal(
  canRemoveCredential(provider({ status: 'ready', source: 'auth.json' })),
  true,
  'auth.json 的凭证可移除'
)
assert.equal(
  canRemoveCredential(provider({ status: 'ready', source: 'env' })),
  false,
  '环境变量凭证不可在界面移除'
)
assert.equal(credentialFromEnv(provider({ status: 'ready', source: 'env' })), true)
assert.equal(credentialFromEnv(provider({ status: 'ready', source: 'auth.json' })), false)
assert.equal(canRemoveCredential(provider({ status: 'missing' })), false)

const services = [
  provider({ id: 'sub', kind: 'subscription', status: 'missing' }),
  provider({ id: 'key-ready', kind: 'api_key', status: 'ready' }),
  provider({ id: 'key-missing', kind: 'api_key', status: 'missing' })
]
const split = splitServices(services)
assert.deepEqual(split.subscriptions.map((p) => p.id), ['sub'])
assert.deepEqual(split.readyKeys.map((p) => p.id), ['key-ready'], '已配置 key 常显')
assert.deepEqual(split.otherKeys.map((p) => p.id), ['key-missing'], '未配置 key 折叠')
assert.deepEqual(serviceSummary(services), { ready: 1, total: 3 })

assert.equal(providerRank('a', []), 0)
assert.equal(providerRank('a', ['b', 'a']), 1)
assert.equal(isFavorite([], { provider: 'a', id: '1' }), false)
assert.equal(isFavorite([{ provider: 'a', id: '1' }], { provider: 'a', id: '1' }), true)
const added = toggleFavorite([], { provider: 'a', id: '1', name: 'One' })
assert.deepEqual(added, [{ provider: 'a', id: '1', name: 'One' }])
const readded = toggleFavorite(added, { provider: 'a', id: '1', name: 'One' })
assert.deepEqual(readded, [], '再点一次取消收藏')
assert.deepEqual(
  toggleFavorite([{ provider: 'a', id: '1' }], { provider: 'a', id: '2' }).map((m) => m.id),
  ['1', '2'],
  '不同模型各自收藏，不去重错误'
)

assert.ok(
  newestFirst({ provider: 'a', id: 'x-10', name: '' }, { provider: 'a', id: 'x-2', name: '' }) < 0,
  '数字版本按数值比较而非字典序（x-10 在 x-2 之前）'
)

console.log('v3 模型与服务纯逻辑单测通过（服务状态 / 凭证门禁 / 供应商排序 / 收藏）')
