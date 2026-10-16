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
  MAX_RECENT,
  buildPickerSections,
  modelCostOf,
  parseRecentModels,
  priceLabel,
  recentModelsAfterPick,
  shortWindow
} = mod

const model = (over = {}) => ({
  id: over.id ?? 'm',
  name: over.name ?? 'M',
  provider: over.provider ?? 'acme',
  reasoning: over.reasoning ?? false,
  contextWindow: over.contextWindow ?? 0,
  ...over
})

const keys = (sections) => sections.map((s) => `${s.kind}:${s.id}:${s.models.map((m) => `${m.provider}/${m.id}`).join(',')}`)

assert.equal(shortWindow(0), '', '0 = 未知，不提示')
assert.equal(shortWindow(-1), '', '负数当未知')
assert.equal(shortWindow(999), '999')
assert.equal(shortWindow(1000), '1k')
assert.equal(shortWindow(200_000), '200k')
assert.equal(shortWindow(1_000_000), '1M')
assert.equal(shortWindow(1_500_000), '1.5M', '非整百万保留一位小数')

assert.equal(priceLabel(undefined), '', '没有报价就不提示')
assert.equal(priceLabel({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 }), '$3 / $15')
assert.equal(priceLabel({ input: 0.8, output: 1.6, cacheRead: 0.2, cacheWrite: 0 }), '$0.8 / $1.6')
assert.equal(modelCostOf({ id: 'x' }), undefined, '模型不带 cost 时没有报价')
assert.deepEqual(
  modelCostOf({ id: 'x', cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } }),
  { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }
)
assert.equal(
  modelCostOf({ id: 'x', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  undefined,
  '全 0 当作没有报价，不显示 $0'
)
assert.equal(modelCostOf({ id: 'x', cost: '!command' }), undefined, '可执行字符串不算报价')

assert.deepEqual(parseRecentModels(null), [])
assert.deepEqual(parseRecentModels('not json'), [], '坏值当空，不抛')
assert.deepEqual(parseRecentModels('{"provider":"a"}'), [], '不是数组当空')
assert.deepEqual(
  parseRecentModels(
    JSON.stringify([
      { provider: 'a', id: '1', name: 'One' },
      { provider: 'a', id: '1' },
      { provider: 'unknown', id: 'x' },
      { provider: 'b', id: '2' }
    ])
  ),
  [
    { provider: 'a', id: '1', name: 'One' },
    { provider: 'b', id: '2' }
  ],
  '去重并过滤 unknown 占位'
)
const longRecent = Array.from({ length: 9 }, (_, i) => ({ provider: 'p', id: `m${i}` }))
assert.equal(parseRecentModels(JSON.stringify(longRecent)).length, MAX_RECENT, '最多保留 MAX_RECENT 条')

assert.deepEqual(
  recentModelsAfterPick([{ provider: 'a', id: '1', name: 'One' }], { provider: 'b', id: '2', name: 'Two' }),
  [
    { provider: 'b', id: '2', name: 'Two' },
    { provider: 'a', id: '1', name: 'One' }
  ],
  '新选的置顶'
)
assert.deepEqual(
  recentModelsAfterPick(
    [
      { provider: 'a', id: '1', name: 'One' },
      { provider: 'b', id: '2', name: 'Two' }
    ],
    { provider: 'b', id: '2', name: 'Two' }
  ),
  [
    { provider: 'b', id: '2', name: 'Two' },
    { provider: 'a', id: '1', name: 'One' }
  ],
  '重复选择去重后置顶，不产生重复行'
)
assert.equal(
  recentModelsAfterPick(longRecent, { provider: 'p', id: 'new' }).length,
  MAX_RECENT,
  '超出上限时截断'
)

const models = [
  model({ id: 'fav1', name: 'Fav', provider: 'a' }),
  model({ id: 'rec1', name: 'Rec One', provider: 'b' }),
  model({ id: 'rec2', name: 'Rec Two', provider: 'b' }),
  model({ id: 'other', name: 'Other', provider: 'b' }),
  model({ id: 'normal', name: 'Normal', provider: 'c' })
]
const favorites = [{ provider: 'a', id: 'fav1' }]
const recent = [
  { provider: 'b', id: 'rec1' },
  { provider: 'b', id: 'rec2' }
]

assert.deepEqual(
  keys(buildPickerSections({ models, favorites, recent, query: '', providerOrder: [] })),
  ['favorites:favorites:a/fav1', 'recent:recent:b/rec1,b/rec2', 'provider:b:b/other', 'provider:c:c/normal'],
  '收藏置顶、最近次之，且不重复出现在服务分组里'
)

assert.deepEqual(
  keys(buildPickerSections({ models, favorites, recent, query: 'normal', providerOrder: [] })),
  ['provider:c:c/normal'],
  '搜索词过滤所有分组，收藏 / 最近不匹配时不显示'
)

assert.deepEqual(
  keys(buildPickerSections({ models, favorites: [], recent: [], query: '', providerOrder: ['c'] })),
  ['provider:c:c/normal', 'provider:a:a/fav1', 'provider:b:b/other,b/rec2,b/rec1'],
  '用户排过的供应商在前，其余按字母；组内仍按版本号降序'
)

assert.deepEqual(
  keys(
    buildPickerSections({
      models,
      favorites: [{ provider: 'gone', id: 'old' }],
      recent: [{ provider: 'gone', id: 'old2' }],
      query: '',
      providerOrder: []
    })
  ),
  ['provider:a:a/fav1', 'provider:b:b/other,b/rec2,b/rec1', 'provider:c:c/normal'],
  '不可用的旧收藏 / 旧最近不出现，也不占位'
)

assert.deepEqual(
  keys(buildPickerSections({ models, favorites: [{ provider: 'gone', id: 'old' }], recent: [], query: '', providerOrder: [] })),
  ['provider:a:a/fav1', 'provider:b:b/other,b/rec2,b/rec1', 'provider:c:c/normal'],
  '收藏分组只含本机可用的收藏模型'
)

assert.deepEqual(
  keys(buildPickerSections({ models, favorites: [], recent: [], query: '', providerOrder: [] })),
  [
    'provider:a:a/fav1',
    'provider:b:b/other,b/rec2,b/rec1',
    'provider:c:c/normal'
  ],
  '没有收藏 / 最近时不建空分组'
)

console.log('v3 模型选择器纯逻辑单测通过（收藏置顶 / 最近使用 / 搜索过滤 / 价格与窗口提示）')
