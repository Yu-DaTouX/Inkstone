#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dir = await mkdtemp(resolve('node_modules/.inkstone-smooth-reveal-'))
const outfile = join(dir, 'smooth-reveal.mjs')
await build({ entryPoints: [join(ROOT, 'src/renderer/src/features/session/smooth-reveal.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error', external: ['react'] })
const { startReveal, stepReveal, typeRate, tokenUnits, startBurstWatch, watchBurst, revealLength, revealActive, revealDraining, drainMs, initialShown, REVEAL_DRAIN_MS, MAX_DRAIN_MS, LIVE_TAIL_GRACE_MS, FRESH_TYPE_CHARS } = await import(pathToFileURL(outfile).href)
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
    assert.ok(run.doneAt !== null && run.doneAt <= MAX_DRAIN_MS + FRAME * 2, `排空用时 ${run.doneAt}`)
  }
})

function burst({ silenceMs, size, endAfter }) {
  const arrivals = []
  for (let t = 0; t < 3000; t += 33) arrivals.push([t, 2])
  const at = 3000 + silenceMs
  arrivals.push([at, size])
  const end = endAfter ? at : at + 4000
  if (!endAfter) for (let t = at + 33; t < end; t += 33) arrivals.push([t, 2])
  let state = startReveal(0, 0)
  let length = 0
  let index = 0
  let maxStep = 0
  let doneAt = null
  for (let now = FRAME; now <= end + 3000; now += FRAME) {
    while (index < arrivals.length && arrivals[index][0] <= now) length += arrivals[index++][1]
    const before = state.shown
    state = stepReveal(state, length, now, now <= end)
    maxStep = Math.max(maxStep, state.shown - before)
    if (now > end && doneAt === null && state.shown >= length) doneAt = now - end
  }
  return { maxStep, doneAt, done: state.shown === length }
}

check('细流中停顿后整块到达：摊开显示，不一下弹出', () => {
  const run = burst({ silenceMs: 3000, size: 1500 })
  assert.ok(run.done)
  assert.ok(run.maxStep <= 20, `单帧 ${run.maxStep}`)
})

check('最后一段整块到达后结束：排空按积压伸缩且有上限', () => {
  const run = burst({ silenceMs: 2000, size: 800, endAfter: true })
  assert.ok(run.done)
  assert.ok(run.maxStep <= 24, `单帧 ${run.maxStep}`)
  assert.ok(run.doneAt <= MAX_DRAIN_MS + FRAME * 2, `排空用时 ${run.doneAt}`)
  assert.equal(drainMs(10), REVEAL_DRAIN_MS)
  assert.equal(drainMs(100000), MAX_DRAIN_MS)
})

check('正常出字速度按文字折算：中文约每秒 144 字，英文约每秒 480 字', () => {
  assert.ok(Math.abs(typeRate('中文回答'.repeat(50)) - 0.144) < 1e-9, `${typeRate('中文回答'.repeat(50))}`)
  assert.ok(Math.abs(typeRate('english reply '.repeat(30)) - 0.48) < 1e-9)
  const half = '中'.repeat(200) + 'a'.repeat(200)
  assert.ok(Math.abs(typeRate(half) - 0.12 * 400 / (200 / 1.2 + 200 / 4)) < 1e-9, `中英各半按 token 加权：${typeRate(half)}`)
  assert.ok(Math.abs(typeRate(half) - 0.2215) < 0.001)
  assert.equal(typeRate(''), 0.48)
  assert.ok(Math.abs(typeRate('中'.repeat(400) + 'code '.repeat(200)) - 0.144) < 1e-9, '只看待显示的开头，后面追加的代码不改变中文的速度')
})

function arrive({ startedAt, waitMs, chunk, everyMs, totalMs }) {
  let watch = startBurstWatch(0)
  let text = ''
  let burstAt = null
  for (let now = startedAt + waitMs; now <= startedAt + waitMs + totalMs; now += everyMs) {
    text += chunk
    watch = watchBurst(watch, text, now, startedAt)
    if (watch.burst && burstAt === null) burstAt = now - startedAt - waitMs
  }
  return burstAt
}

check('稳定 200 tok/s 的模型不算突发：不论首字等多久都不限速', () => {
  const zh200 = { chunk: '中文中文中文', everyMs: 25, totalMs: 6000 }
  assert.ok(Math.abs(tokenUnits(zh200.chunk) / 25 * 1000 - 200) < 1e-6)
  assert.equal(arrive({ startedAt: 1000, waitMs: 800, ...zh200 }), null)
  assert.equal(arrive({ startedAt: 1000, waitMs: 17000, ...zh200 }), null)
  assert.equal(arrive({ startedAt: 1000, waitMs: 17000, chunk: 'abcdefghabcdefghabcdefghabcdefgh', everyMs: 40, totalMs: 6000 }), null)
})

check('长时间无输出后正文高速到达：约半秒内判为突发', () => {
  const at = arrive({ startedAt: 1000, waitMs: 17300, chunk: '中文中文中文中文中文中文', everyMs: 33, totalMs: 3300 })
  assert.ok(at !== null && at <= 500, `判定用时 ${at}`)
  assert.equal(arrive({ startedAt: 1000, waitMs: 3000, chunk: '中文中文中文中文中文中文', everyMs: 33, totalMs: 3300 }), null, '首字正常时不凭速度判突发')
  assert.equal(arrive({ startedAt: undefined, waitMs: 0, chunk: '中文中文中文中文中文中文', everyMs: 33, totalMs: 3300 }), null, '不知道开始时间时不猜')
})

check('停顿半秒以上后一次到达大段：判为突发；没停顿的大块不算', () => {
  let watch = watchBurst(startBurstWatch(0), '开头', 1000, 0)
  watch = watchBurst(watch, '开头' + '中'.repeat(300), 1700, 0)
  assert.equal(watch.burst, true)
  let quick = watchBurst(startBurstWatch(0), '开头', 1000, 0)
  quick = watchBurst(quick, '开头' + '中'.repeat(300), 1100, 0)
  assert.equal(quick.burst, false)
  const small = watchBurst(watchBurst(startBurstWatch(0), '开头', 1000, 0), '开头' + '中'.repeat(100), 2000, 0)
  assert.equal(small.burst, false)
})

check('突发一旦判定就保持到这条消息结束；文字变短只更新长度', () => {
  let watch = { ...startBurstWatch(10), burst: true }
  watch = watchBurst(watch, 'abc', 5000, 0)
  assert.equal(watch.burst, true)
  assert.equal(watch.length, 3)
  assert.equal(watchBurst(watch, 'abc', 6000, 0), watch)
})

function capped({ size, overMs, cap, tailMs = 12000 }) {
  let state = startReveal(0, 0)
  let length = 0
  let maxStep = 0
  let maxLag = 0
  let doneAt = null
  for (let now = FRAME; now <= overMs + tailMs; now += FRAME) {
    const live = now <= overMs
    length = live ? Math.min(size, Math.round((size * now) / overMs)) : size
    const before = state.shown
    state = stepReveal(state, length, now, live, cap)
    maxStep = Math.max(maxStep, state.shown - before)
    maxLag = Math.max(maxLag, length - state.shown)
    if (!live && doneAt === null && state.shown >= size) doneAt = now - overMs
  }
  return { maxStep, maxLag, doneAt }
}

check('隐藏思考后正文集中到达（3.3 秒到 1200 字）：按正常出字速度打完，不一秒吐完', () => {
  const cap = typeRate('中文'.repeat(200))
  const run = capped({ size: 1200, overMs: 3300, cap })
  assert.ok(run.maxStep <= cap * 50 + 1, `单帧 ${run.maxStep}`)
  assert.ok(run.doneAt !== null && run.doneAt >= 1500 && run.doneAt <= 4000 + FRAME * 2, `结束后补完用时 ${run.doneAt}`)
})

check('有上限时落后有界：持续高速到达也不超过约 4 秒', () => {
  const run = capped({ size: 10000, overMs: 20000, cap: 0.144 })
  assert.ok(run.maxLag <= 0.5 * 4000 + 50, `最大落后 ${run.maxLag}`)
  assert.ok(run.doneAt !== null && run.doneAt <= 4000 + FRAME * 2, `结束后补完用时 ${run.doneAt}`)
})

check('低于正常速度的流不受上限影响', () => {
  const slow = capped({ size: 600, overMs: 6000, cap: 0.48, tailMs: 2000 })
  const free = capped({ size: 600, overMs: 6000, cap: Infinity, tailMs: 2000 })
  assert.equal(slow.maxLag, free.maxLag)
  assert.equal(slow.doneAt, free.doneAt)
  assert.ok(slow.maxLag < 0.1 * 300, `最大落后 ${slow.maxLag}`)
  assert.ok(slow.doneAt !== null && slow.doneAt <= MAX_DRAIN_MS + FRAME * 2, `结束后补完用时 ${slow.doneAt}`)
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

check('中英文都逐字出现，像打字', () => {
  assert.equal(revealLength('你好世界', 1.9), 1)
  assert.equal(revealLength('abc', 1.9), 1)
  assert.equal(revealLength('run npm install', 5.2), 5)
  assert.equal(revealLength('x'.repeat(100), 3), 3)
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
  for (let now = 316; now < 316 + MAX_DRAIN_MS + 100 && state.shown < 300; now += 16) state = stepReveal(state, 300, now, false)
  assert.equal(state.shown, 300)
  assert.equal(revealDraining(true, state.shown, 300, false), false)
})

check('新出现的短文字从头打出，重新挂载接着上次进度，历史与长文不重放', () => {
  assert.equal(initialShown(30, true, undefined, false), 0)
  assert.equal(initialShown(FRESH_TYPE_CHARS + 1, true, undefined, false), FRESH_TYPE_CHARS + 1)
  assert.equal(initialShown(30, false, undefined, false), 30)
  assert.equal(initialShown(30, false, 12, false), 12)
  assert.equal(initialShown(30, true, 50, false), 30)
  assert.equal(initialShown(30, true, undefined, true), 30)
})

check('整段已到的短句按打字速度排空，不一下弹出', () => {
  let state = startReveal(0, 0)
  let firstFrame = 0
  let doneAt = null
  for (let now = FRAME; now < 2000 && doneAt === null; now += FRAME) {
    state = stepReveal(state, 40, now, false)
    if (!firstFrame) firstFrame = state.shown
    if (state.shown >= 40) doneAt = now
  }
  assert.ok(firstFrame <= 5, `首帧 ${firstFrame}`)
  assert.ok(doneAt >= REVEAL_DRAIN_MS - FRAME && doneAt <= MAX_DRAIN_MS + FRAME * 2, `用时 ${doneAt}`)
})

process.stdout.write(`smooth-reveal: ${pass} 项通过\n`)
