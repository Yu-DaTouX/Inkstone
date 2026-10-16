#!/usr/bin/env node
import assert from 'node:assert/strict'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(ROOT, 'src/renderer/src/ui/Splitter.tsx')

const result = await build({
  entryPoints: [source],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  logLevel: 'silent'
})
const mod = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
)

const {
  Splitter,
  clampSplitValue,
  resolveSplitValue,
  splitPointerDelta,
  splitValueFromPointer,
  beginSplitDrag,
  ownsSplitDrag,
  moveSplitDrag,
  splitValueForKey
} = mod

const report = { pass: 0, fail: 0 }
function check(name, fn) {
  try {
    fn()
    report.pass += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    report.fail += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

check('导出 Splitter 组件', () => {
  assert.equal(typeof Splitter, 'function')
})

check('导出全部纯函数', () => {
  for (const fn of [
    clampSplitValue,
    resolveSplitValue,
    splitPointerDelta,
    splitValueFromPointer,
    beginSplitDrag,
    ownsSplitDrag,
    moveSplitDrag,
    splitValueForKey
  ]) {
    assert.equal(typeof fn, 'function')
  }
})

check('clampSplitValue：区间内原样', () => {
  assert.equal(clampSplitValue(50, 0, 100), 50)
  assert.equal(clampSplitValue(0, 0, 100), 0)
  assert.equal(clampSplitValue(100, 0, 100), 100)
})

check('clampSplitValue：越界夹到两端', () => {
  assert.equal(clampSplitValue(-5, 0, 100), 0)
  assert.equal(clampSplitValue(180, 0, 100), 100)
})

check('clampSplitValue：min/max 顺序无所谓', () => {
  assert.equal(clampSplitValue(5, 10, 0), 5)
  assert.equal(clampSplitValue(-1, 10, 0), 0)
  assert.equal(clampSplitValue(11, 10, 0), 10)
})

check('clampSplitValue：NaN / Infinity 退回下界', () => {
  assert.equal(clampSplitValue(Number.NaN, 20, 80), 20)
  assert.equal(clampSplitValue(Number.POSITIVE_INFINITY, 20, 80), 20)
  assert.equal(clampSplitValue(Number.NEGATIVE_INFINITY, 20, 80), 20)
})

check('resolveSplitValue：未受控用 fallback', () => {
  assert.equal(resolveSplitValue(undefined, 30, 0, 100), 30)
})

check('resolveSplitValue：受控优先', () => {
  assert.equal(resolveSplitValue(40, 30, 0, 100), 40)
})

check('resolveSplitValue：受控越界仍夹取显示值', () => {
  assert.equal(resolveSplitValue(200, 30, 0, 100), 100)
  assert.equal(resolveSplitValue(-20, 30, 0, 100), 0)
})

check('splitPointerDelta：竖线取 x，横线取 y', () => {
  assert.equal(splitPointerDelta('vertical', 7, 99), 7)
  assert.equal(splitPointerDelta('horizontal', 7, 99), 99)
})

const pointer = (overrides = {}) => ({
  pointerId: 1,
  clientX: 0,
  clientY: 0,
  button: 0,
  isPrimary: true,
  ...overrides
})

check('splitValueFromPointer：竖线按横向位移', () => {
  assert.equal(
    splitValueFromPointer({
      orientation: 'vertical',
      startValue: 100,
      startX: 10,
      startY: 50,
      clientX: 40,
      clientY: 999,
      min: 0,
      max: 200
    }),
    130
  )
})

check('splitValueFromPointer：横线按纵向位移', () => {
  assert.equal(
    splitValueFromPointer({
      orientation: 'horizontal',
      startValue: 100,
      startX: 10,
      startY: 50,
      clientX: 999,
      clientY: 30,
      min: 0,
      max: 200
    }),
    80
  )
})

check('splitValueFromPointer：越界夹取', () => {
  assert.equal(
    splitValueFromPointer({
      orientation: 'vertical',
      startValue: 100,
      startX: 0,
      startY: 0,
      clientX: -50,
      clientY: 0,
      min: 60,
      max: 140
    }),
    60
  )
  assert.equal(
    splitValueFromPointer({
      orientation: 'vertical',
      startValue: 100,
      startX: 0,
      startY: 0,
      clientX: 500,
      clientY: 0,
      min: 60,
      max: 140
    }),
    140
  )
})

check('beginSplitDrag：主键主指针开始拖动', () => {
  const session = beginSplitDrag(pointer(), 42)
  assert.ok(session)
  assert.equal(session.pointerId, 1)
  assert.equal(session.startValue, 42)
})

check('beginSplitDrag：非主键 / 非主指针 / 非法 pointerId 返回 null', () => {
  assert.equal(beginSplitDrag(pointer({ button: 2 }), 42), null)
  assert.equal(beginSplitDrag(pointer({ isPrimary: false }), 42), null)
  assert.equal(beginSplitDrag(pointer({ pointerId: Number.NaN }), 42), null)
})

check('ownsSplitDrag：按 pointerId 认领', () => {
  const session = beginSplitDrag(pointer({ pointerId: 7 }), 42)
  assert.equal(ownsSplitDrag(session, { pointerId: 7 }), true)
  assert.equal(ownsSplitDrag(session, { pointerId: 8 }), false)
  assert.equal(ownsSplitDrag(null, { pointerId: 7 }), false)
})

check('moveSplitDrag：无会话或别人的 pointerId 不动', () => {
  const session = beginSplitDrag(pointer({ pointerId: 7 }), 42)
  assert.equal(moveSplitDrag(null, pointer({ pointerId: 7 }), { orientation: 'vertical', min: 0, max: 100 }), null)
  assert.equal(
    moveSplitDrag(session, pointer({ pointerId: 8, clientX: 999 }), { orientation: 'vertical', min: 0, max: 100 }),
    null
  )
})

check('moveSplitDrag：同一 pointerId 得到夹取后的新值', () => {
  const session = beginSplitDrag(pointer({ pointerId: 7, clientX: 100 }), 50)
  assert.equal(
    moveSplitDrag(session, pointer({ pointerId: 7, clientX: 130 }), { orientation: 'vertical', min: 0, max: 100 }),
    80
  )
  assert.equal(
    moveSplitDrag(session, pointer({ pointerId: 7, clientX: 1000 }), { orientation: 'vertical', min: 0, max: 100 }),
    100
  )
})

const key = (overrides = {}) => ({ key: '', min: 0, max: 100, step: 5, orientation: 'vertical', ...overrides })

check('splitValueForKey：竖线响应左右，不响应上下', () => {
  assert.equal(splitValueForKey(key({ key: 'ArrowRight', value: 50 })), 55)
  assert.equal(splitValueForKey(key({ key: 'ArrowLeft', value: 50 })), 45)
  assert.equal(splitValueForKey(key({ key: 'ArrowUp', value: 50 })), null)
  assert.equal(splitValueForKey(key({ key: 'ArrowDown', value: 50 })), null)
})

check('splitValueForKey：横线响应上下，不响应左右', () => {
  const horizontal = { orientation: 'horizontal', step: 5, min: 0, max: 100 }
  assert.equal(splitValueForKey(key({ ...horizontal, key: 'ArrowDown', value: 50 })), 55)
  assert.equal(splitValueForKey(key({ ...horizontal, key: 'ArrowUp', value: 50 })), 45)
  assert.equal(splitValueForKey(key({ ...horizontal, key: 'ArrowLeft', value: 50 })), null)
  assert.equal(splitValueForKey(key({ ...horizontal, key: 'ArrowRight', value: 50 })), null)
})

check('splitValueForKey：Home / End 到两端（与轴向无关）', () => {
  assert.equal(splitValueForKey(key({ key: 'Home', value: 50, min: 10, max: 90 })), 10)
  assert.equal(splitValueForKey(key({ key: 'End', value: 50, min: 10, max: 90 })), 90)
  assert.equal(splitValueForKey(key({ key: 'Home', value: 50, min: 10, max: 90, orientation: 'horizontal' })), 10)
  assert.equal(splitValueForKey(key({ key: 'End', value: 50, min: 10, max: 90, orientation: 'horizontal' })), 90)
})

check('splitValueForKey：Shift 步长 ×10', () => {
  assert.equal(splitValueForKey(key({ key: 'ArrowRight', value: 50, shiftKey: true })), 100)
  assert.equal(splitValueForKey(key({ key: 'ArrowLeft', value: 50, shiftKey: true })), 0)
})

check('splitValueForKey：步长非法兜底为 1', () => {
  assert.equal(splitValueForKey(key({ key: 'ArrowRight', value: 50, step: 0 })), 51)
  assert.equal(splitValueForKey(key({ key: 'ArrowRight', value: 50, step: Number.NaN })), 51)
  assert.equal(splitValueForKey(key({ key: 'ArrowRight', value: 50, step: -5 })), 51)
})

check('splitValueForKey：方向键在端点夹取', () => {
  assert.equal(splitValueForKey(key({ key: 'ArrowRight', value: 100 })), 100)
  assert.equal(splitValueForKey(key({ key: 'ArrowLeft', value: 0 })), 0)
})

check('splitValueForKey：无关按键返回 null', () => {
  for (const k of ['Enter', 'Escape', 'Tab', 'a', 'PageUp']) {
    assert.equal(splitValueForKey(key({ key: k, value: 50 })), null)
  }
})

console.log(`\nv3 Splitter 纯逻辑：${report.pass} 通过 / ${report.fail} 失败`)
if (report.fail > 0) process.exit(1)
