/**
 * v3 模型价格字段的纯逻辑单测（WP-40）。
 *
 * 只编译两个纯模块，在 Node 里直接跑，不启动 Electron、不碰 pi、不读用户凭证、
 * 不发任何请求、不按模型名猜价格：
 *   · `src/main/models/price.ts` —— 主进程从 pi 原始记录取报价并接到 ModelInfo；
 *   · `src/renderer/src/features/settings/models/models-model.ts` —— 渲染端价格读取与
 *     展示（`modelCostOf` / `priceLabel`），用来核对两侧字段名一致。
 *
 * 可独立执行：
 *
 *   node scripts/test-v3-model-price.mjs
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'

/* 两个模块打进同一个包：它们都 import shared/custom-provider，分开打会各带一份实现。
   入口用 stdin，避免为一个测试新增中间文件。 */
const result = await build({
  stdin: {
    contents: [
      "export { modelPriceOf, attachModelPrice } from './src/main/models/price'",
      "export { modelCostOf, priceLabel } from './src/renderer/src/features/settings/models/models-model'"
    ].join('\n'),
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const { modelPriceOf, attachModelPrice, modelCostOf, priceLabel } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
)

const model = (over = {}) => ({
  id: 'm',
  name: 'M',
  provider: 'acme',
  reasoning: false,
  contextWindow: 0,
  ...over
})

/* ── 从 pi 原始记录取报价 ───────────────────────────────────── */

const full = modelPriceOf({
  id: 'claude',
  provider: 'anthropic',
  contextWindow: 200_000,
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
})
assert.deepEqual(
  full,
  { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  '四档费率原样取出（美元 / 百万 token）'
)

assert.equal(modelPriceOf(model({ provider: 'openai' })), undefined, '没有 cost：不猜价格')
assert.equal(modelPriceOf(model({ id: 'gpt-5.4' })), undefined, '只有模型名没有 cost：仍然不猜')
assert.equal(modelPriceOf(null), undefined, 'null 当没有元数据')
assert.equal(modelPriceOf('claude'), undefined, '非对象当没有元数据')
assert.equal(modelPriceOf([]), undefined, '数组当没有元数据')

assert.deepEqual(
  modelPriceOf({ cost: { input: 1, output: 2 } }),
  { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  'pi 的自定义 models.json 可只给 input/output：缓存档归 0'
)
assert.deepEqual(
  modelPriceOf({ cost: { input: 1, output: 2, tiers: [{ inputTokensAbove: 100_000, input: 5, output: 9 }] } }),
  { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  '分层计价只取基础档，不把 tiers 透传给界面'
)
assert.deepEqual(
  modelPriceOf({ cost: { input: -1, output: 2, cacheRead: 'x', cacheWrite: Number.NaN } }),
  { input: 0, output: 2, cacheRead: 0, cacheWrite: 0 },
  '非法费率归 0，合法的保留'
)
assert.equal(
  modelPriceOf({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  undefined,
  '明确全 0（免费 / 套餐）视为没有报价，不渲染 $0'
)

/* ── 接到 ModelInfo 上 ──────────────────────────────────────── */

const normalized = model({ id: 'claude', provider: 'anthropic', contextWindow: 200_000 })
const withCost = attachModelPrice(normalized, {
  id: 'claude',
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
})
assert.equal(withCost.id, 'claude', '接价格不改身份')
assert.equal(withCost.contextWindow, 200_000, '接价格不改能力字段')
assert.deepEqual(withCost.cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })
assert.equal('cost' in normalized, false, '接价格不改原对象（纯函数）')

const withoutCost = attachModelPrice(normalized, { id: 'claude' })
assert.equal(withoutCost, normalized, '没有报价时原样返回')
assert.equal('cost' in withoutCost, false, '没有报价时不写 cost: undefined（区分「没给」与「为 0」）')
assert.equal(attachModelPrice(undefined, { cost: { input: 1, output: 1 } }), undefined, '模型缺失时安全返回')

/* ── 与渲染端价格显示字段名一致 ─────────────────────────────── */

assert.deepEqual(
  modelCostOf({ id: 'claude', cost: withCost.cost }),
  { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  '渲染端 modelCostOf 认得主进程写出的字段名'
)
assert.equal(priceLabel(modelCostOf({ id: 'claude', cost: withCost.cost })), '$3 / $15', '价格提示展示输入 / 输出价')
assert.equal(modelCostOf({ id: 'claude' }), undefined, 'ModelInfo 没有 cost 时不显示价格')
assert.equal(priceLabel(undefined), '', '无报价时价格提示为空串')

console.log('v3 模型价格字段纯逻辑单测通过（取价 / 接字段 / 缺失与全 0 / 渲染端字段名一致）')
