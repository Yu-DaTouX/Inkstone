/**
 * v3 设置「模型与服务」纯逻辑单测（S1）。
 *
 * 只编译 `src/renderer/src/features/settings/models/models-model.ts`（纯函数，无 React /
 * store / DOM / 网络依赖），在 Node 里直接跑；不启动 Electron、不碰 pi、不读用户
 * 凭证、不拉模型、不发任何请求。可独立执行：
 *
 *   node scripts/test-v3-model-settings.mjs
 *
 * 覆盖：服务状态三档（ready / loginable / missing / unknown，含 authKey 匹配与
 * 环境变量凭证）、凭证移除门禁、服务分组统计、模型目录过滤 / 供应商顺序 / 版本
 * 排序 / 收藏（含已不可用收藏）、收藏增删、思考档位展示三态，以及「本地收藏不等于
 * 已登录」这一边界（目录行只看权威模型列表判断可用性）。
 */
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
  buildCatalogRows,
  canRemoveCredential,
  catalogProviders,
  credentialFromEnv,
  entryState,
  isFavorite,
  needsInAppLogin,
  newestFirst,
  providerRank,
  serviceState,
  serviceSummary,
  splitServices,
  thinkingView,
  toggleFavorite
} = mod

/* ── 工具 ───────────────────────────────────────────────────── */

const provider = (over = {}) => ({
  id: over.id ?? 'p',
  name: over.name ?? 'P',
  kind: over.kind ?? 'api_key',
  envVar: over.envVar ?? '',
  authKey: over.authKey ?? '',
  status: over.status ?? 'missing',
  ...over
})

const model = (over = {}) => ({
  id: over.id ?? 'm',
  name: over.name ?? 'M',
  provider: over.provider ?? 'acme',
  reasoning: over.reasoning ?? false,
  reasoningStatus: over.reasoningStatus ?? 'unsupported',
  contextWindow: over.contextWindow ?? 0,
  contextWindowStatus: over.contextWindowStatus ?? 'unknown',
  input: over.input,
  inputStatus: over.inputStatus,
  ...over
})

/* ── 服务状态 ───────────────────────────────────────────────── */

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

/* ── 凭证移除门禁 ───────────────────────────────────────────── */

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

/* ── 服务分组与统计 ─────────────────────────────────────────── */

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

/* ── 目录过滤与排序 ─────────────────────────────────────────── */

const models = [
  model({ id: 'deepseek-v3', name: 'DeepSeek V3', provider: 'deepseek', reasoningStatus: 'known', reasoning: true }),
  model({ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', provider: 'deepseek', contextWindow: 1_000_000, contextWindowStatus: 'known' }),
  model({ id: 'cc-flash', name: 'CommandCode Flash', provider: 'commandcode' })
]
const sortModels = (rows) => rows.map((r) => `${r.provider}/${r.id}`)

const all = buildCatalogRows({
  models,
  favorites: [],
  query: '',
  provider: '',
  favoriteOnly: false,
  providerOrder: []
})
assert.equal(all.length, 3, '默认列出全部模型')
assert.equal(all.every((r) => r.available), true)

const byQuery = buildCatalogRows({
  models,
  favorites: [],
  query: '  flash ',
  provider: '',
  favoriteOnly: false,
  providerOrder: []
})
assert.deepEqual(
  sortModels(byQuery).sort(),
  ['commandcode/cc-flash', 'deepseek/deepseek-v4.1-flash'],
  '查询匹配名字 / id / 供应商，去空白且大小写不敏感'
)

const byProvider = buildCatalogRows({
  models,
  favorites: [],
  query: '',
  provider: 'deepseek',
  favoriteOnly: false,
  providerOrder: []
})
assert.equal(byProvider.length, 2)

const ordered = buildCatalogRows({
  models,
  favorites: [],
  query: '',
  provider: '',
  favoriteOnly: false,
  providerOrder: ['deepseek']
})
assert.deepEqual(
  sortModels(ordered),
  ['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v3', 'commandcode/cc-flash'],
  '用户排过的供应商在前，版本号降序'
)

/* 收藏但已不在本机模型列表：仍显示，标为不可用，且不因收藏就当成已就绪 */
const staleFav = [{ provider: 'gone', id: 'old-model', name: 'Old' }]
const withFav = buildCatalogRows({
  models,
  favorites: staleFav,
  query: '',
  provider: '',
  favoriteOnly: false,
  providerOrder: []
})
const staleRow = withFav.find((r) => r.provider === 'gone')
assert.ok(staleRow, '收藏的不可用模型仍列出')
assert.equal(staleRow.available, false, '不在权威模型列表就不标可用（本地收藏 ≠ 已登录/可用）')
assert.equal(staleRow.starred, true)

const favoriteOnly = buildCatalogRows({
  models,
  favorites: staleFav,
  query: '',
  provider: '',
  favoriteOnly: true,
  providerOrder: []
})
assert.deepEqual(favoriteOnly.map((r) => `${r.provider}/${r.id}`), ['gone/old-model'], '只看收藏时忽略供应商筛选')

/* ── 供应商顺序 ─────────────────────────────────────────────── */

assert.equal(providerRank('a', []), 0)
assert.equal(providerRank('a', ['b', 'a']), 1)
assert.deepEqual(catalogProviders({ models, favorites: staleFav, providerOrder: ['commandcode'] }), [
  'commandcode',
  'deepseek',
  'gone'
])

/* ── 收藏增删 ───────────────────────────────────────────────── */

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

/* ── 思考档位展示 ───────────────────────────────────────────── */

assert.deepEqual(thinkingView([], undefined), { kind: 'unknown' })
assert.deepEqual(thinkingView(['off'], 'unknown'), { kind: 'unknown' })
assert.deepEqual(thinkingView([], 'unsupported'), { kind: 'unsupported' })
assert.deepEqual(thinkingView(['off'], 'known'), { kind: 'no-levels' }, '只有 off 表示未声明，不说“不支持”')
assert.deepEqual(
  thinkingView(['off', 'low', 'high'], 'known'),
  { kind: 'levels', values: ['off', 'low', 'high'] },
  '多档位原样透传，不合并也不按模型名硬编码'
)
assert.notEqual(
  JSON.stringify(thinkingView(['off', 'low'], 'known')),
  JSON.stringify(thinkingView(['off', 'low'], 'unknown')),
  'known 与 unknown 必须区分'
)

/* ── 版本排序稳定性 ─────────────────────────────────────────── */

assert.ok(
  newestFirst({ provider: 'a', id: 'x-10', name: '' }, { provider: 'a', id: 'x-2', name: '' }) < 0,
  '数字版本按数值比较而非字典序（x-10 在 x-2 之前）'
)

console.log('v3 模型与服务纯逻辑单测通过（服务状态 / 凭证门禁 / 目录过滤排序 / 收藏 / 思考档位）')
