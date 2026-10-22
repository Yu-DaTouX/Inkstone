import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FILES = {
  'README.md': `# ultra

小型库存与下单模块。\`node test.mjs\` 跑测试。

- inventory.mjs：库存预留与释放
- pricing.mjs：折扣与金额取整（金额单位：元，保留两位小数）
- orders.mjs：下单（多件商品要么全部预留成功，要么一件都不预留）
`,
  'inventory.mjs': `export function createStock(entries) {
  return new Map(Object.entries(entries))
}

export function available(stock, sku) {
  return stock.get(sku) ?? 0
}

export function reserve(stock, sku, qty) {
  if (!Number.isInteger(qty) || qty <= 0) throw new Error('数量必须是正整数')
  const have = available(stock, sku)
  if (have > qty) {
    stock.set(sku, have - qty)
    return true
  }
  return false
}

export function release(stock, sku, qty) {
  stock.set(sku, available(stock, sku) + qty)
}
`,
  'pricing.mjs': `export function roundCents(amount) {
  return Math.floor(amount * 100) / 100
}

export function applyDiscount(total, percent) {
  if (percent < 0 || percent > 100) throw new Error('折扣比例应在 0 到 100 之间')
  return roundCents(total - percent)
}

export function lineTotal(price, qty) {
  return roundCents(price * qty)
}
`,
  'orders.mjs': `import { reserve } from './inventory.mjs'
import { applyDiscount, lineTotal } from './pricing.mjs'

export function placeOrder(stock, lines, discountPercent = 0) {
  for (const line of lines) {
    if (!reserve(stock, line.sku, line.qty)) {
      return { ok: false, reason: \`\${line.sku} 库存不足\` }
    }
  }
  const total = lines.reduce((sum, line) => sum + lineTotal(line.price, line.qty), 0)
  return { ok: true, total: applyDiscount(total, discountPercent) }
}
`,
  'test.mjs': `import assert from 'node:assert/strict'
import { createStock, reserve, available } from './inventory.mjs'
import { applyDiscount } from './pricing.mjs'

const stock = createStock({ pen: 3 })
assert.equal(reserve(stock, 'pen', 3), true, '库存正好够时应能预留')
assert.equal(available(stock, 'pen'), 0)
assert.equal(applyDiscount(200, 10), 180, '打九折')
console.log('ok')
`
}

export function writeUltracodeFixture(dir) {
  const root = join(dir, 'ultra')
  mkdirSync(root, { recursive: true })
  for (const [name, text] of Object.entries(FILES)) writeFileSync(join(root, name), text, 'utf8')
  return root
}

export const ULTRACODE_HIDDEN_CHECKS = `
import assert from 'node:assert/strict'
const dir = process.argv[2]
const { createStock, available, release } = await import(new URL('inventory.mjs', dir))
const { roundCents } = await import(new URL('pricing.mjs', dir))
const { placeOrder } = await import(new URL('orders.mjs', dir))
const results = {}
const run = (name, fn) => { try { fn(); results[name] = true } catch (error) { results[name] = String(error?.message ?? error).slice(0, 160) } }
run('取整按四舍五入', () => assert.equal(roundCents(1.005 + 0.004), 1.01))
run('释放拒绝非正数', () => { const s = createStock({ a: 1 }); let threw = false; try { release(s, 'a', -5) } catch { threw = true }; assert.ok(threw || available(s, 'a') === 1) })
run('下单失败时回滚已预留', () => { const s = createStock({ a: 5, b: 0 }); const r = placeOrder(s, [{ sku: 'a', qty: 2, price: 1 }, { sku: 'b', qty: 1, price: 1 }]); assert.equal(r.ok, false); assert.equal(available(s, 'a'), 5) })
console.log(JSON.stringify(results))
`

export function writeYanSnapshot(dir, repoRoot, execFileSync) {
  const target = join(dir, 'yan-snapshot')
  mkdirSync(target, { recursive: true })
  const tar = execFileSync('git', ['-C', repoRoot, 'archive', '--format=tar', 'HEAD', 'src', 'resources/pi-extensions', 'resources/skills', 'package.json', 'tsconfig.json', 'AGENTS.md'], { maxBuffer: 256 * 1024 * 1024 })
  execFileSync('tar', ['-x'], { cwd: target, input: tar, maxBuffer: 256 * 1024 * 1024 })
  const git = (...args) => execFileSync('git', ['-C', target, '-c', 'user.name=snapshot', '-c', 'user.email=snapshot@local', '-c', 'core.autocrlf=false', ...args], { stdio: 'ignore' })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'snapshot')
  return target
}
