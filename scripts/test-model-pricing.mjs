/**
 * 会话花费的兜底估算（src/shared/model-pricing.ts + main/normalize.ts 的 toUsage）。
 * 单独运行：node scripts/test-model-pricing.mjs
 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

/* 两个模块打进同一个包：估算目录是模块级状态，分开打会各有一份 */
async function load(out) {
  await build({
    stdin: { contents: "export * from './src/shared/model-pricing'; export { toUsage } from './src/main/normalize'", resolveDir: process.cwd(), loader: 'ts' },
    outfile: out, bundle: true, format: 'esm', platform: 'node', packages: 'external', logLevel: 'silent'
  })
  return import(pathToFileURL(out).href)
}

export async function runModelPricingTests(ok) {
  const { toUsage, setPricingCatalog, estimateCost, priceOf } = await load('out/test/model-pricing.mjs')
  const m = { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 }

  setPricingCatalog({})
  ok(estimateCost('deepseek/deepseek-v4-pro', { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }) === undefined, '目录里没有报价：不估算')

  setPricingCatalog({ 'deepseek-v4-pro': { provider: 'deepseek', api: 'openai-completions', reasoning: true, cost: m }, 'free-one': { provider: 'x', api: 'openai-completions', reasoning: false } })
  ok(priceOf('deepseek/deepseek-v4-pro')?.output === 4 && priceOf('DeepSeek-V4-Pro')?.input === 1, '带不带厂商前缀、大小写都查到同一条报价')
  ok(priceOf('free-one') === undefined && priceOf(undefined) === undefined, '没有标价的模型 / 没有模型名：没有报价')
  const c = estimateCost('deepseek/deepseek-v4-pro', { input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 0 })
  ok(Math.abs(c - (1 + 2 + 0.2)) < 1e-9, '按每百万 token 报价累加（输入 + 输出 + 缓存读）')

  const raw = { input: 1000, output: 2000, cacheRead: 3000, cacheWrite: 0, cost: { total: 0 } }
  const est = toUsage(raw, 'deepseek/deepseek-v4-pro')
  ok(est.costEstimated === true && Math.abs(est.cost - (1000 * 1 + 2000 * 4 + 3000 * 0.1) / 1e6) < 1e-12, 'pi 报 0 费用：按公开价补估算并标记')
  ok(toUsage({ ...raw, cost: { total: 0.5 } }, 'deepseek/deepseek-v4-pro').cost === 0.5 && toUsage({ ...raw, cost: { total: 0.5 } }, 'deepseek/deepseek-v4-pro').costEstimated === undefined, 'pi 已经算出费用：原值不动')
  ok(toUsage(raw).cost === 0 && toUsage(raw, 'free-one').cost === 0, '不知道模型或没报价：保持 0')
  ok(toUsage({ cost: { total: 0 } }, 'deepseek/deepseek-v4-pro').cost === 0, '没有 token 不估算')
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let failed = 0
  let passed = 0
  await runModelPricingTests((cond, name) => { if (cond) passed++; else { failed++; console.error('✗', name) } })
  console.log(failed ? `✗ ${failed} 项失败，${passed} 项通过` : `✓ 花费估算 ${passed} 项通过`)
  process.exit(failed ? 1 : 0)
}
