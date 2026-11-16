import { runSuite } from './lib/test-suite.mjs'

function fakeFrames() {
  const pending = new Map()
  let id = 0
  let now = 0
  return {
    request(callback) {
      id += 1
      pending.set(id, callback)
      return id
    },
    cancel(handle) {
      pending.delete(handle)
    },
    advance(ms) {
      now += ms
      const due = [...pending.values()]
      pending.clear()
      for (const callback of due) callback(now)
    },
    get size() {
      return pending.size
    },
    get now() {
      return now
    }
  }
}

function fakeAnimation(currentTime = 0, endTime = Infinity) {
  return {
    playState: 'running',
    currentTime,
    playbackRate: 1,
    effect: { target: { isConnected: true }, getComputedTiming: () => ({ endTime, iterations: endTime === Infinity ? Infinity : 1 }) },
    pause() { this.playState = 'paused' },
    play() { this.playState = 'running' },
    finish() { this.playState = 'finished' }
  }
}

await runSuite(import.meta.url, async (ok, compile) => {
  const frames = fakeFrames()
  globalThis.requestAnimationFrame = (callback) => frames.request(callback)
  globalThis.cancelAnimationFrame = (handle) => frames.cancel(handle)
  const listeners = new Map()
  globalThis.window = { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener() {}, requestAnimationFrame: globalThis.requestAnimationFrame, setTimeout: (fn) => fn() }
  let timelineNow = 0
  let docFocus = true
  globalThis.document = { hasFocus: () => docFocus, addEventListener() {}, documentElement: { dataset: {} }, timeline: { get currentTime() { return timelineNow } }, getAnimations: () => [] }
  const clock = await compile('src/renderer/src/lib/frame-clock.ts')

  clock.installFrameClock()
  for (let i = 0; i < 9; i++) frames.advance(1000 / 279)
  ok(clock.highRefreshDisplay(), '连续几帧量出 279Hz 屏，判定为高刷')

  const fired = []
  const loop = (now) => {
    fired.push(now)
    if (fired.length < 40) clock.requestClockFrame(loop)
  }
  clock.requestClockFrame(loop)
  const start = frames.now
  while (fired.length < 40) frames.advance(1000 / 279)
  const span = fired.at(-1) - fired[0]
  const rate = ((fired.length - 1) / span) * 1000
  ok(rate > 52 && rate < 72, `高刷屏上连续请求的帧按约 60fps 回调（实际 ${rate.toFixed(1)}fps）`)
  ok(fired[0] - start < 1000 / 60 + 1, '第一次回调不晚于一个 60Hz 帧')
  ok(frames.size === 0, '没人请求时不再挂原生帧')

  const a = []
  const b = []
  clock.requestClockFrame((now) => a.push(now))
  const cancelled = clock.requestClockFrame((now) => b.push(now))
  clock.cancelClockFrame(cancelled)
  for (let i = 0; i < 6; i++) frames.advance(1000 / 279)
  ok(a.length === 1 && b.length === 0, '同一帧里的请求一起回调，取消的不再回调')
  const lone = clock.requestClockFrame(() => {})
  clock.cancelClockFrame(lone)
  ok(frames.size === 0, '取消最后一个请求时一并撤掉原生帧')

  const anim = fakeAnimation(100)
  timelineNow = frames.now
  clock.driveAnimation(anim)
  frames.advance(1000 / 279)
  ok(anim.playState === 'paused', '高刷屏上常驻动画在下一帧改由帧时钟推进（先暂停原生播放）')
  const ticks = []
  const watch = (now) => {
    ticks.push(anim.currentTime)
    if (ticks.length < 10) clock.requestClockFrame(watch)
  }
  clock.requestClockFrame(watch)
  for (let i = 0; i < 60; i++) frames.advance(1000 / 279)
  const moved = ticks.at(-1) - ticks[0]
  const wall = (ticks.length - 1) * (1000 / 60)
  ok(moved > wall * 0.7 && moved < wall * 1.5, `推进速度与真实时间一致（${moved.toFixed(0)}ms / 约 ${wall.toFixed(0)}ms）`)

  const short = fakeAnimation(0, 50)
  timelineNow = frames.now
  clock.driveAnimation(short)
  for (let i = 0; i < 40; i++) frames.advance(1000 / 279)
  ok(short.playState === 'finished', '有限动画推进到终点后结束并交还')

  anim.effect.target.isConnected = false
  for (let i = 0; i < 6; i++) frames.advance(1000 / 279)
  const after = anim.currentTime
  for (let i = 0; i < 6; i++) frames.advance(1000 / 279)
  ok(anim.currentTime === after, '元素离开文档后不再推进')
  ok(frames.size === 0, '没有要推进的动画时帧时钟停下')

  docFocus = false
  listeners.get('blur')?.()
  const blurred = []
  const slow = (now) => {
    blurred.push(now)
    if (blurred.length < 12) clock.requestClockFrame(slow)
  }
  clock.requestClockFrame(slow)
  while (blurred.length < 12) frames.advance(1000 / 279)
  const blurredRate = ((blurred.length - 1) / (blurred.at(-1) - blurred[0])) * 1000
  ok(blurredRate > 52 && blurredRate < 72, `窗口失焦但仍可见时，正文类回调（逐字出字、贴底滑动）保持约 60fps（实际 ${blurredRate.toFixed(1)}fps）`)
  listeners.get('focus')?.()
})

await runSuite(import.meta.url, async (ok, compile) => {
  const frames = fakeFrames()
  globalThis.requestAnimationFrame = (callback) => frames.request(callback)
  globalThis.cancelAnimationFrame = (handle) => frames.cancel(handle)
  globalThis.window = { addEventListener() {}, removeEventListener() {}, requestAnimationFrame: globalThis.requestAnimationFrame }
  let scans = 0
  globalThis.document = { hasFocus: () => true, addEventListener() {}, documentElement: { dataset: {} }, timeline: { currentTime: 0 }, getAnimations: () => { scans += 1; return [] } }
  const clock = await compile('src/renderer/src/lib/frame-clock.ts')
  clock.installFrameClock()
  for (let i = 0; i < 9; i++) frames.advance(1000 / 60)
  ok(scans === 0, '60Hz 屏上不扫描已有动画')
  ok(!clock.highRefreshDisplay(), '60Hz 屏不算高刷')
  const fired = []
  const loop = (now) => {
    fired.push(now)
    if (fired.length < 20) clock.requestClockFrame(loop)
  }
  clock.requestClockFrame(loop)
  while (fired.length < 20) frames.advance(1000 / 60)
  ok(fired.at(-1) - fired[0] < 20 * (1000 / 60), '60Hz 屏上每帧都回调，不会降到 30fps')
  const anim = fakeAnimation(0)
  clock.driveAnimation(anim)
  frames.advance(1000 / 60)
  ok(anim.playState === 'running', '60Hz 屏上常驻动画仍交给合成器播放')
})

await runSuite(import.meta.url, async (ok, compile) => {
  const frames = fakeFrames()
  globalThis.requestAnimationFrame = (callback) => frames.request(callback)
  globalThis.cancelAnimationFrame = (handle) => frames.cancel(handle)
  const listeners = new Map()
  globalThis.window = { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener() {}, requestAnimationFrame: globalThis.requestAnimationFrame }
  globalThis.CSSAnimation = class {
    constructor(name, iterations) {
      Object.assign(this, fakeAnimation(0))
      this.animationName = name
      this.effect = { target: { isConnected: true }, getComputedTiming: () => ({ endTime: iterations === Infinity ? Infinity : 1000, iterations }) }
    }
  }
  const dataset = {}
  const pulse = new globalThis.CSSAnimation('ui-status-pulse', Infinity)
  const spin = new globalThis.CSSAnimation('ui-spin', Infinity)
  const other = new globalThis.CSSAnimation('some-entrance', Infinity)
  const once = new globalThis.CSSAnimation('ui-spin', 1)
  globalThis.document = { hasFocus: () => true, addEventListener() {}, documentElement: { dataset }, timeline: { currentTime: 0 }, getAnimations: () => [pulse, spin, other, once] }
  const clock = await compile('src/renderer/src/lib/frame-clock.ts')
  clock.installFrameClock()
  for (let i = 0; i < 9; i++) frames.advance(1000 / 279)
  ok(pulse.playState === 'paused' && spin.playState === 'paused', '量出高刷后接管安装前已在播放的常驻动画')
  ok(other.playState === 'running' && once.playState === 'running', '不在白名单或有限次的动画不接管')
  dataset.reduceMotion = 'true'
  listeners.get('yan:reduced-motion')?.()
  ok(pulse.playState === 'running' && spin.playState === 'running', '打开减少动效时交还全部动画')
  delete dataset.reduceMotion
  listeners.get('yan:reduced-motion')?.()
  frames.advance(1000 / 279)
  ok(pulse.playState === 'paused' && spin.playState === 'paused', '关闭减少动效时重新扫描并接管')
  pulse.effect.target.isConnected = false
  spin.effect.target.isConnected = false
  for (let i = 0; i < 6; i++) frames.advance(1000 / 279)
  ok(frames.size === 0, '动画都离开文档后帧时钟停下')
})

await runSuite(import.meta.url, async (ok, compile) => {
  const frames = fakeFrames()
  globalThis.requestAnimationFrame = (callback) => frames.request(callback)
  globalThis.cancelAnimationFrame = (handle) => frames.cancel(handle)
  globalThis.window = { addEventListener() {}, removeEventListener() {}, requestAnimationFrame: globalThis.requestAnimationFrame }
  const style = { dirty: false, flushes: 0 }
  const flush = () => { if (style.dirty) { style.dirty = false; style.flushes++ } }
  class Styled {
    constructor() {
      this.state = 'running'
      this.time = 0
      this.playbackRate = 1
      this.effect = { target: { isConnected: true }, getComputedTiming: () => { flush(); return { endTime: Infinity, iterations: Infinity } } }
    }
    get playState() { flush(); return this.state }
    get currentTime() { return this.time }
    set currentTime(value) { this.time = value; style.dirty = true }
    pause() { this.state = 'paused'; style.dirty = true }
    play() { this.state = 'running'; style.dirty = true }
    finish() { this.state = 'finished'; style.dirty = true }
  }
  globalThis.CSSAnimation = Styled
  globalThis.document = { hasFocus: () => true, addEventListener() {}, documentElement: { dataset: {} }, timeline: { currentTime: 0 }, getAnimations: () => [] }
  const clock = await compile('src/renderer/src/lib/frame-clock.ts')
  clock.installFrameClock()
  for (let i = 0; i < 9; i++) frames.advance(1000 / 279)
  const many = Array.from({ length: 40 }, () => new Styled())
  for (const animation of many) clock.driveAnimation(animation)
  style.flushes = 0
  let ticks = 0
  for (let i = 0; i < 60; i++) {
    style.dirty = true
    frames.advance(1000 / 279)
    ticks++
  }
  ok(many.every((animation) => animation.state === 'paused'), '一批常驻动画全部接管')
  ok(many[0].time > 0, '接管后继续推进')
  ok(style.flushes <= ticks, `每帧最多强制刷新一次样式，先读后写（${ticks} 帧 ${style.flushes} 次）`)
})

await runSuite(import.meta.url, async (ok, compile) => {
  const frames = fakeFrames()
  globalThis.requestAnimationFrame = (callback) => frames.request(callback)
  globalThis.cancelAnimationFrame = (handle) => frames.cancel(handle)
  globalThis.window = { addEventListener() {}, removeEventListener() {}, requestAnimationFrame: globalThis.requestAnimationFrame, setTimeout: (fn, ms) => setTimeout(fn, ms) }
  globalThis.Element = class { constructor() { this.isConnected = true } }
  globalThis.CSSAnimation = class {
    constructor(name, target) {
      Object.assign(this, fakeAnimation(0))
      this.animationName = name
      this.effect = { target, getComputedTiming: () => ({ endTime: Infinity, iterations: Infinity }) }
    }
  }
  const docListeners = new Map()
  const live = []
  let scans = 0
  globalThis.document = { hasFocus: () => true, addEventListener: (type, fn) => docListeners.set(type, fn), documentElement: { dataset: {} }, timeline: { currentTime: 0 }, getAnimations: () => { scans += 1; return live } }
  const clock = await compile('src/renderer/src/lib/frame-clock.ts')
  clock.installFrameClock()
  for (let i = 0; i < 9; i++) frames.advance(1000 / 279)
  scans = 0
  const targets = Array.from({ length: 30 }, () => new globalThis.Element())
  const dots = targets.map((target) => new globalThis.CSSAnimation('ui-status-pulse', target))
  const caretTarget = new globalThis.Element()
  const caret = new globalThis.CSSAnimation('v3-blink', caretTarget)
  live.push(...dots, caret)
  for (const target of targets) docListeners.get('animationstart')({ animationName: 'ui-status-pulse', target, pseudoElement: '' })
  docListeners.get('animationstart')({ animationName: 'v3-blink', target: caretTarget, pseudoElement: '' })
  ok(scans === 0, '动画开始事件里不当场查找动画')
  await new Promise((resolve) => setTimeout(resolve, 320))
  frames.advance(1000 / 279)
  frames.advance(1000 / 279)
  ok(dots.every((animation) => animation.playState === 'paused'), '一批开始事件合并后接管常驻动画')
  ok(scans === 1, `一批开始事件只全文档查找一次（实际 ${scans} 次）`)
  ok(caret.playState === 'running', '打字光标闪烁不接管（流式时随新块重建）')
})

await runSuite(import.meta.url, async (ok, compile) => {
  const frames = fakeFrames()
  globalThis.requestAnimationFrame = (callback) => frames.request(callback)
  globalThis.cancelAnimationFrame = (handle) => frames.cancel(handle)
  const listeners = new Map()
  const retries = []
  globalThis.window = { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener() {}, requestAnimationFrame: globalThis.requestAnimationFrame, setTimeout: (fn, ms) => ms >= 10000 ? retries.push({ fn, ms }) : setTimeout(fn, ms) }
  globalThis.Element = class { constructor() { this.isConnected = true } }
  globalThis.CSSAnimation = class {
    constructor(name, target) {
      Object.assign(this, fakeAnimation(0))
      this.animationName = name
      this.effect = { target, getComputedTiming: () => ({ endTime: Infinity, iterations: Infinity }) }
    }
  }
  const dataset = {}
  const docListeners = new Map()
  const first = new globalThis.CSSAnimation('ui-spin', new globalThis.Element())
  const live = [first]
  let slow = false
  let focus = true
  globalThis.document = {
    hasFocus: () => focus,
    addEventListener: (type, fn) => docListeners.set(type, fn),
    documentElement: { dataset },
    timeline: { currentTime: 0 },
    getAnimations: () => {
      if (slow) { const end = performance.now() + 10; while (performance.now() < end) {} }
      return live
    }
  }
  const clock = await compile('src/renderer/src/lib/frame-clock.ts')
  clock.installFrameClock()
  for (let i = 0; i < 10; i++) frames.advance(1000 / 279)
  ok(first.playState === 'paused', '查找很快时接管常驻动画')

  const startOf = (name) => {
    const target = new globalThis.Element()
    const animation = new globalThis.CSSAnimation(name, target)
    live.push(animation)
    docListeners.get('animationstart')({ animationName: name, target, pseudoElement: '' })
    return animation
  }
  const settle = async (ms) => {
    await new Promise((resolve) => setTimeout(resolve, ms))
    frames.advance(1000 / 279)
    frames.advance(1000 / 279)
  }
  slow = true
  const later = startOf('ui-status-pulse')
  await settle(320)
  ok(first.playState === 'paused' && later.playState === 'paused' && clock.frameClockStatus().slowScans === 1, '只有一次全文档查找超过 8ms 时不停止接管')
  const later2 = startOf('ui-spin')
  await settle(650)
  const stopped = clock.frameClockStatus()
  ok(first.playState === 'running' && later.playState === 'running' && later2.playState === 'running', '连续两次全文档查找超过 8ms 时停止接管 CSS 动画并交回原生播放')
  ok(stopped.cssTakeover === false && stopped.stops === 1 && stopped.slowScans === 2, '调试场景可读到「已停止接管」与次数')
  slow = false
  const third = startOf('ui-spin')
  await settle(320)
  ok(third.playState === 'running', '停止接管后不再按开始事件接管')
  const own = fakeAnimation(0)
  clock.driveAnimation(own)
  frames.advance(1000 / 279)
  ok(own.playState === 'paused', '停止接管 CSS 动画后，自己创建的动画仍由帧时钟推进')
  ok(retries.length === 1 && retries[0].ms >= 30000 && retries[0].ms <= 60000, '停止后安排 30–60 秒后自动重试一次')
  retries.shift().fn()
  frames.advance(1000 / 279)
  ok(first.playState === 'paused' && third.playState === 'paused' && clock.frameClockStatus().retries === 1 && clock.frameClockStatus().cssTakeover, '自动重试时重新扫描并恢复接管')
  slow = true
  startOf('ui-spin')
  await settle(650)
  startOf('ui-spin')
  await settle(650)
  ok(clock.frameClockStatus().stops === 2 && !clock.frameClockStatus().cssTakeover, '重试后又连续超时则再次停止')
  ok(retries.length === 0, '自动重试只做一次')
  slow = false

  dataset.reduceMotion = 'true'
  listeners.get('yan:reduced-motion')?.()
  const reducedTarget = new globalThis.Element()
  const reducedSpin = new globalThis.CSSAnimation('ui-spin', reducedTarget)
  live.push(reducedSpin)
  docListeners.get('animationstart')({ animationName: 'ui-spin', target: reducedTarget, pseudoElement: '' })
  await new Promise((resolve) => setTimeout(resolve, 320))
  frames.advance(1000 / 279)
  ok(reducedSpin.playState === 'running', '减少动效开着时不接管新开始的动画')
  delete dataset.reduceMotion
  listeners.get('yan:reduced-motion')?.()
  frames.advance(1000 / 279)
  ok(first.playState === 'paused' && reducedSpin.playState === 'paused', '切换减少动效后恢复接管并重新扫描')

  const rates = () => {
    const fired = []
    const loop = (now) => {
      fired.push(now)
      if (fired.length < 30) clock.requestClockFrame(loop)
    }
    clock.requestClockFrame(loop)
    let changes = 0
    let last = first.currentTime
    let elapsed = 0
    while (fired.length < 30) {
      frames.advance(1000 / 279)
      elapsed += 1000 / 279
      if (first.currentTime !== last) {
        changes++
        last = first.currentTime
      }
    }
    return { content: ((fired.length - 1) / (fired.at(-1) - fired[0])) * 1000, decor: (changes / elapsed) * 1000 }
  }
  focus = true
  listeners.get('blur')?.()
  const iframe = rates()
  ok(iframe.content > 52 && iframe.decor > 52, `焦点进了页面内的 iframe（窗口 blur 但文档仍有焦点）时正文与装饰动画都保持约 60fps（实际 ${iframe.content.toFixed(1)} / ${iframe.decor.toFixed(1)}fps）`)
  focus = false
  rates()
  const viaIframe = rates()
  ok(viaIframe.decor > 25 && viaIframe.decor < 38 && viaIframe.content > 52, `焦点经 iframe 切到别的应用、顶层窗口没有再收到 blur 时，定期复查焦点后装饰动画降到约 30fps（实际 ${viaIframe.decor.toFixed(1)}fps）`)
  focus = true
  listeners.get('focus')?.()
  focus = false
  listeners.get('blur')?.()
  const away = rates()
  ok(away.content > 52, `窗口真正失焦时正文类回调仍约 60fps（实际 ${away.content.toFixed(1)}fps）`)
  ok(away.decor > 25 && away.decor < 38, `窗口真正失焦时被接管的装饰动画降到约 30fps（实际 ${away.decor.toFixed(1)}fps）`)
  focus = true
  listeners.get('focus')?.()
  const back = rates()
  ok(back.decor > 52, `窗口重新获得焦点后装饰动画回到约 60fps（实际 ${back.decor.toFixed(1)}fps）`)
})
