#!/usr/bin/env node
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let checks = 0
const ok = (condition, label) => {
  assert.ok(condition, label)
  checks++
  console.log(`✓ ${label}`)
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps

const modelSrc = resolve(ROOT, 'src/renderer/src/app/split-resizer-model.ts')
const modelBundle = await build({
  entryPoints: [modelSrc],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const model = await import(
  `data:text/javascript;base64,${Buffer.from(modelBundle.outputFiles[0].text).toString('base64')}`
)
const {
  MIN_COLUMN,
  KEY_STEP,
  measurePair,
  samePair,
  pairBounds,
  clampPairValue,
  weightsForLeft,
  readPair,
  bindPairObserver
} = model

ok(MIN_COLUMN === 320, '最小列宽对齐参考 320px')
ok(KEY_STEP === 8, '方向键步长对齐参考 8px')

ok(samePair(measurePair(600, 400), { left: 600, total: 1000 }), '首帧读取：两列像素宽得到 left/total')
ok(samePair(measurePair(Number.NaN, -5), { left: 0, total: 0 }), '非法像素宽归一为 0，不产生 NaN')
ok(pairBounds(0).min === 0 && pairBounds(0).max === 0, '未测量时范围收成 0，原语不会拖出数值')
ok(samePair(null, null) === false, 'null 度量不算相同')

{
  const normal = pairBounds(1000)
  ok(normal.min === MIN_COLUMN && normal.max === 1000 - MIN_COLUMN, '正常宽度范围 = [最小列宽, 合计−最小列宽]')
  const edge = pairBounds(2 * MIN_COLUMN)
  ok(edge.min === MIN_COLUMN && edge.max === MIN_COLUMN, '恰好两倍最小宽时只有等分一个位置')
  const tight = pairBounds(500)
  ok(tight.min === 0 && tight.max === 500, '极窄（< 两倍最小宽）退化为整条可分配，与旧夹取一致')
  ok(pairBounds(Number.POSITIVE_INFINITY).max === 0, '非法合计宽退回 0 范围')
}

ok(clampPairValue(250, { min: 300, max: 700 }) === 300, '低于下界夹到下界')
ok(clampPairValue(900, { min: 300, max: 700 }) === 700, '高于上界夹到上界')
ok(clampPairValue(500, { min: 300, max: 700 }) === 500, '范围内原样')
ok(clampPairValue(Number.NaN, { min: 300, max: 700 }) === 300, '非有限值退回下界')

{
  const w = weightsForLeft(600, 1000, 2)
  ok(near(w.left, 1.2) && near(w.right, 0.8), '按新左列像素宽比例分配合计份额')
  ok(near(w.left + w.right, 2), '两列合计份额保持不变')
  const fill = weightsForLeft(1000, 1000, 2)
  ok(near(fill.left, 2) && near(fill.right, 0), '拖到最右时左列拿满、右列到 0')
  const empty = weightsForLeft(-50, 1000, 2)
  ok(near(empty.left, 0) && near(empty.right, 2), '拖到最左时夹到 0，右列拿满且不为负')
  const unknown = weightsForLeft(600, 0, 2)
  ok(near(unknown.left, 1) && near(unknown.right, 1), '合计宽未知时退回等分，不产生 NaN')
  const badShare = weightsForLeft(600, 1000, Number.NaN)
  ok(Number.isFinite(badShare.left) && Number.isFinite(badShare.right), '非法份额不产生 NaN')
}

{
  const total = 1000
  const share = 2
  const oldLeft = (share * 524) / total
  const w = weightsForLeft(524, total, share)
  ok(near(w.left, oldLeft), '换算与旧分隔条 share×next/total 一致')
}

{
  const total = 1000
  const share = 2
  const current = (total * 1) / 2
  const right = weightsForLeft(current + KEY_STEP, total, share)
  ok(near(right.left, (share * (current + KEY_STEP)) / total), 'ArrowRight 一步换算与键盘语义一致')
  const left = weightsForLeft(current - KEY_STEP, total, share)
  ok(near(left.left, (share * (current - KEY_STEP)) / total), 'ArrowLeft 一步换算与键盘语义一致')
  ok(near(weightsForLeft(total, total, share).left, share), '在端点继续按方向键被夹到最大份额')
  ok(near(weightsForLeft(0, total, share).right, share), '在另一端点继续按方向键被夹到最小份额')
}

for (const [leftPx, total, share] of [
  [0, 1000, 3],
  [321, 1000, 3],
  [700, 1000, 3],
  [1000, 1000, 3],
  [120, 240, 1.5],
  [10, 240, 1.5]
]) {
  const w = weightsForLeft(leftPx, total, share)
  ok(near(w.left + w.right, share), `合计份额守恒：leftPx=${leftPx} total=${total}`)
}

const fakeEl = (width) => ({ getBoundingClientRect: () => ({ width }) })
const makeHost = (left, right) => ({ previousElementSibling: left, nextElementSibling: right })

{
  const observers = []
  const factory = (onResize) => {
    const observer = {
      targets: [],
      disconnected: false,
      observe(target) { this.targets.push(target) },
      disconnect() { this.disconnected = true },
      fire() { onResize() }
    }
    observers.push(observer)
    return observer
  }

  const left = fakeEl(600)
  const right = fakeEl(400)
  const seen = []
  const stop = bindPairObserver(makeHost(left, right), (m) => seen.push(m), factory)

  ok(seen.length === 1 && samePair(seen[0], { left: 600, total: 1000 }), '首帧立刻读一次相邻两列真实像素')
  ok(observers.length === 1 && observers[0].targets.length === 2, '观察器分别观察左右两列')
  ok(observers[0].targets[0] === left && observers[0].targets[1] === right, '观察的是左右列元素本身')

  left.getBoundingClientRect = () => ({ width: 450 })
  right.getBoundingClientRect = () => ({ width: 300 })
  observers[0].fire()
  ok(seen.length === 2 && samePair(seen[1], { left: 450, total: 750 }), '窗口/列宽变化后复读新像素')

  observers[0].fire()
  ok(seen.length === 3, '不变化时观察器仍会回调，去重交给 samePair')
  ok(samePair(seen[2], seen[1]), 'samePair 挡住同一像素的重复上报')

  stop()
  ok(observers[0].disconnected === true, '清理函数断开观察')
}

{
  const left = fakeEl(600)
  const seen = []
  const stop = bindPairObserver({ previousElementSibling: left, nextElementSibling: null }, (m) => seen.push(m), () => {
    throw new Error('缺列时不应创建观察器')
  })
  ok(seen.length === 0, '缺任一侧不测量')
  ok(typeof stop === 'function', '缺列也返回可调用的清理函数')
  stop()
}

{
  const had = globalThis.ResizeObserver
  delete globalThis.ResizeObserver
  const seen = []
  const stop = bindPairObserver(makeHost(fakeEl(320), fakeEl(180)), (m) => seen.push(m))
  ok(seen.length === 1 && samePair(seen[0], { left: 320, total: 500 }), '没有 ResizeObserver 的环境仍先读一次')
  stop()
  if (had) globalThis.ResizeObserver = had
}

ok(
  typeof readPair(makeHost(fakeEl(100), fakeEl(50))) === 'object',
  'readPair 可直接读取一对像素'
)

console.log(`\n并排分隔条换算检查：${checks} 项通过`)
