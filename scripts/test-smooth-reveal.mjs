#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dir = await mkdtemp(join(tmpdir(), 'yan-smooth-reveal-'))
const outfile = join(dir, 'smooth-reveal.mjs')
await build({ entryPoints: [join(ROOT, 'src/renderer/src/features/session/smooth-reveal.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error', external: ['react'] })
const { startReveal, stepReveal, revealLength, revealActive, revealDraining, REVEAL_DRAIN_MS, LIVE_TAIL_GRACE_MS } = await import(pathToFileURL(outfile).href)
await rm(dir, { recursive: true, force: true })

let pass = 0
function check(label, fn) {
  fn()
  pass += 1
  process.stdout.write(`  ✓ ${label}\n`)
}

const FRAME = 1000 / 60

function simulate({ chunk, everyMs, totalMs, tailMs = 600 }) {
  let state = startReveal(0, 0)
  let length = 0
  let nextArrival = 0
  const steps = []
  const lags = []
  let doneAt = null
  for (let now = FRAME; now <= totalMs + tailMs; now += FRAME) {
    const live = now <= totalMs
    while (live && nextArrival <= now) {
      length += chunk
      nextArrival += everyMs
    }
    const before = Math.floor(state.shown)
    state = stepReveal(state, length, now, live)
    assert.ok(state.shown <= length + 1e-9, '不超过已到达长度')
    assert.ok(state.shown >= before - 1e-9, '不回退')
    if (live && now > 1500) {
      steps.push(Math.floor(state.shown) - before)
      lags.push(length - state.shown)
    }
    if (!live && doneAt === null && state.shown >= length) doneAt = now - totalMs
  }
  return { steps, lags, doneAt, length, shown: state.shown }
}

function spread(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  return { mean, max: Math.max(...values), cv: Math.sqrt(variance) / (mean || 1) }
}

check('新挂载时已有的文字不重放', () => {
  const state = startReveal(5000, 0)
  assert.equal(state.shown, 5000)
  assert.equal(stepReveal(state, 5000, 16, true).shown, 5000)
})

check('细碎的小块：出字贴近到达，落后不超过约 0.2 秒', () => {
  const run = simulate({ chunk: 4, everyMs: 20, totalMs: 6000 })
  const rate = 4 / 20
  assert.ok(Math.max(...run.lags) < rate * 200 + 4, `最大落后 ${Math.max(...run.lags)}`)
  assert.ok(spread(run.steps).cv < 0.6, `每帧出字波动 ${spread(run.steps).cv}`)
})

check('成块到达（每 0.4 秒 120 字）：每帧出字平稳，不一阵一阵', () => {
  const run = simulate({ chunk: 120, everyMs: 400, totalMs: 8000 })
  const stats = spread(run.steps)
  assert.ok(stats.max <= stats.mean * 2.5, `峰值 ${stats.max} 均值 ${stats.mean}`)
  assert.ok(Math.min(...run.steps) >= 1, `有停顿帧，最小 ${Math.min(...run.steps)}`)
  assert.ok(stats.cv < 0.45, `波动 ${stats.cv}`)
  assert.ok(Math.max(...run.lags) < 260, `最大落后 ${Math.max(...run.lags)}`)
})

check('大块到达（每 1 秒 500 字）：不停顿，落后有界', () => {
  const run = simulate({ chunk: 500, everyMs: 1000, totalMs: 9000 })
  assert.ok(Math.min(...run.steps) >= 1, `有停顿帧，最小 ${Math.min(...run.steps)}`)
  assert.ok(Math.max(...run.lags) < 760, `最大落后 ${Math.max(...run.lags)}`)
})

check('结束后在排空时限内显示完', () => {
  for (const pattern of [{ chunk: 4, everyMs: 20 }, { chunk: 120, everyMs: 400 }, { chunk: 500, everyMs: 1000 }]) {
    const run = simulate({ ...pattern, totalMs: 4000 })
    assert.equal(run.shown, run.length)
    assert.ok(run.doneAt !== null && run.doneAt <= REVEAL_DRAIN_MS + FRAME * 2, `排空用时 ${run.doneAt}`)
  }
})

check('文字被改短时跟着收回', () => {
  let state = startReveal(100, 0)
  state = stepReveal(state, 40, 16, true)
  assert.equal(state.shown, 40)
})

check('时间不走时不前进，长帧按上限计', () => {
  let state = stepReveal(startReveal(0, 0), 400, 16, true)
  const still = stepReveal(state, 400, state.at, true)
  assert.equal(still.shown, state.shown)
  const jumped = stepReveal(state, 400, state.at + 5000, true)
  const capped = stepReveal(state, 400, state.at + 50, true)
  assert.ok(jumped.shown > state.shown && jumped.shown <= capped.shown, `${jumped.shown} vs ${capped.shown}`)
})

check('不把代理对切成两半', () => {
  const text = '😀'.repeat(200)
  for (let shown = 0; shown <= text.length; shown += 1) {
    const length = revealLength(text, shown)
    if (length > 0 && length < text.length) {
      const code = text.charCodeAt(length - 1)
      assert.ok(!(code >= 0xd800 && code <= 0xdbff), `停在高位代理 @${length}`)
    }
  }
  assert.equal(revealLength('abc', 9), 3)
})

check('中文逐字，英文与数字按整词出现', () => {
  assert.equal(revealLength('你好世界', 1.9), 1)
  assert.equal(revealLength('abc', 1.9), 3)
  assert.equal(revealLength('run npm install', 5.2), 7)
  assert.equal(revealLength('run npm install', 3.5), 3)
  assert.equal(revealLength('用 useEffect 订阅', 4), 11)
  assert.equal(revealLength('x'.repeat(100), 3), 15)
  let previous = 0
  const text = '先运行 npm run build，再看 out/main/index.js 是否更新。'
  for (let shown = 0; shown <= text.length; shown += 0.37) {
    const length = revealLength(text, shown)
    assert.ok(length >= previous, `回退 @${shown}`)
    previous = length
  }
})

check('结束后短暂宽限只补末尾迟到块，不重放历史', () => {
  assert.equal(revealActive(false, 100, 50, 10, 20, false), true)
  assert.equal(revealActive(false, 100, 100, 10, 20, false), false)
  assert.equal(revealActive(false, 100, 50, 20, 20, false), false)
  assert.equal(revealActive(false, 100, 50, 10, 20, true), false)
  assert.equal(revealActive(true, 0, 50, 20, 20, false), true)
  assert.ok(LIVE_TAIL_GRACE_MS >= 150)
})

check('末块迟到时在宽限内按排空推进，不整块弹出', () => {
  const text = '前文。结论一段'
  let state = stepReveal(startReveal(3, 0), text.length, 60, false)
  assert.ok(state.shown < text.length)
  for (let now = 76; now < 400; now += 16) state = stepReveal(state, text.length, now, false)
  assert.equal(state.shown, text.length)
})

check('宽限只限制接纳，已开始的排空不因宽限过期强弹', () => {
  let state = stepReveal(startReveal(100, 0), 300, 100, false)
  assert.ok(state.drain > 0 && state.shown < 300)
  assert.equal(revealActive(false, 200, 300, state.shown, 300, false), false)
  assert.equal(revealDraining(true, state.shown, 300, false), true)
  assert.equal(revealDraining(false, state.shown, 300, false), false)
  assert.equal(revealDraining(true, state.shown, 300, true), false)
  for (let now = 316; now < 1000 && state.shown < 300; now += 16) state = stepReveal(state, 300, now, false)
  assert.equal(state.shown, 300)
  assert.equal(revealDraining(true, state.shown, 300, false), false)
})

process.stdout.write(`smooth-reveal: ${pass} 项通过\n`)
