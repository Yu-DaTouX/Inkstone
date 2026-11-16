import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { useRealWindow } from '../lib/perf-probes.mjs'

export const meta = { description: '常驻动效走查：一个后台会话跑 STORM，当前会话派 6 个假模型子代理，量刷新间隔、每类常驻动画（状态点、转圈、微光、机器人画布）的屏上更新频率与播放速度（currentTime 推进÷真实时间），录一段页面帧（Page.screencast，帧与时间戳存 cast/），并截图；YAN_MOTION_MS 改测量时长，YAN_MOTION_CAST_MS 改录制时长，YAN_MOTION_RAF60=1 在页面加载前把 requestAnimationFrame 包成每 16.7ms 一次，模拟 60Hz 屏上主线程看到的刷新率（合成器仍按实际屏幕出帧）' }

const RAF60 = `(() => {
  const native = window.requestAnimationFrame.bind(window)
  const nativeCancel = window.cancelAnimationFrame.bind(window)
  const queue = new Map()
  let seq = 0
  let pending = 0
  let last = -Infinity
  const pump = (now) => {
    pending = 0
    if (now - last < 1000 / 60 - 2) { pending = native(pump); return }
    last = now
    const due = [...queue.values()]
    queue.clear()
    for (const cb of due) { try { cb(now) } catch (e) { setTimeout(() => { throw e }) } }
  }
  window.requestAnimationFrame = (cb) => { const id = ++seq; queue.set(id, cb); if (!pending) pending = native(pump); return id }
  window.cancelAnimationFrame = (id) => { queue.delete(id); if (!queue.size && pending) { nativeCancel(pending); pending = 0 } }
})()`

const MEASURE = (ms) => `(async () => {
  const ambient = /^(ui-spin|ui-status-pulse|ui-term-spin|ui-progress-indeterminate|ui-shimmer|v3-sa-wave|v3-blink|v3-split-ask-breathe|v3-boot-breathe|wb-ctxw-shimmer|ws-)/
  const visible = (el) => { const r = el?.getBoundingClientRect?.(); return !!r && r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth }
  const labelOf = (a) => a.animationName || ('waapi:' + String(a.effect?.target?.className?.baseVal ?? a.effect?.target?.className ?? '').split(' ')[0])
  const tracked = document.getAnimations()
    .filter((a) => (a.playState === 'running' || a.playState === 'paused') && (a.animationName ? ambient.test(a.animationName) : true))
    .slice(0, 300)
    .map((a) => ({ a, label: labelOf(a), driven: a.playState === 'paused', visible: visible(a.effect?.target), endless: a.effect?.getComputedTiming?.().endTime === Infinity, first: a.currentTime, last: a.currentTime, changes: 0 }))
  const canvases = [...document.querySelectorAll('.v3-subagent-bot canvas, canvas.v3-subagent-bot, .v3-subagent-bot')].map((el) => el instanceof HTMLCanvasElement ? el : el.querySelector('canvas')).filter((c) => c && visible(c)).slice(0, 6)
  const sig = (c) => { try { const d = c.getContext('2d')?.getImageData(0, 0, c.width, c.height).data; if (!d) return null; let h = 0; for (let i = 0; i < d.length; i += 8) h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 3] * 7) | 0; return h } catch { return null } }
  const bots = canvases.map((c) => ({ c, last: sig(c), changes: 0 }))
  const gaps = []
  const start = performance.now()
  let prev = start
  await new Promise((done) => {
    const tick = (now) => {
      gaps.push(now - prev)
      prev = now
      for (const t of tracked) {
        const time = t.a.currentTime
        if (time !== t.last) { t.changes++; t.last = time; t.movedAt = now }
      }
      for (const b of bots) { const s = sig(b.c); if (s !== b.last) { b.changes++; b.last = s } }
      if (now - start < ${ms}) requestAnimationFrame(tick)
      else done()
    }
    requestAnimationFrame(tick)
  })
  const wall = performance.now() - start
  const sorted = gaps.slice(1).sort((a, b) => a - b)
  const groups = {}
  for (const t of tracked) {
    const g = groups[t.label] ??= { n: 0, visible: 0, driven: 0, updatesPerSec: [], speed: [] }
    g.n++
    if (t.visible) g.visible++
    if (t.driven) g.driven++
    g.updatesPerSec.push(t.changes / wall * 1000)
    if (t.endless && typeof t.first === 'number' && typeof t.last === 'number') g.speed.push((t.last - t.first) / wall)
  }
  const finite = tracked.filter((t) => !t.endless).map((t) => ({ label: t.label, driven: t.driven, state: t.a.playState, connected: !!t.a.effect?.target?.isConnected, idleMs: Math.round(performance.now() - (t.movedAt ?? start)), at: Math.round(t.a.currentTime ?? -1), end: Math.round(t.a.effect?.getComputedTiming?.().endTime ?? -1) }))
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.floor(s.length / 2)] * 100) / 100 : null }
  const out = {}
  for (const [k, g] of Object.entries(groups)) out[k] = { n: g.n, visible: g.visible, driven: g.driven, updatesPerSec: med(g.updatesPerSec), speed: med(g.speed) }
  return {
    wallMs: Math.round(wall),
    rafPerSec: Math.round(gaps.length / wall * 1000),
    vsyncMs: Math.round(sorted[Math.floor(sorted.length / 2)] * 100) / 100,
    focus: document.hasFocus(),
    animations: out,
    stuck: finite.filter((f) => f.connected && f.state === 'paused' && f.idleMs > 500 && f.at < f.end),
    bots: { n: bots.length, updatesPerSec: med(bots.map((b) => b.changes / wall * 1000)) },
    clock: window.__yanFrameClock?.() ?? null
  }
})()`

const RECTS = `(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return b.width > 0 && b.bottom > 0 && b.top < innerHeight ? { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) } : null }
  const firstAnim = (re) => document.getAnimations().map((a) => a.effect?.target).find((el) => el && re.test(String(el.className?.baseVal ?? el.className ?? '')) && r(el))
  const card = document.querySelector('[data-testid="v3-subagent-tile"]') ?? document.querySelector('[data-testid="v3-subagent-row"]')
  return {
    dpr: devicePixelRatio, width: innerWidth, height: innerHeight,
    card: r(card),
    bot: r(card?.querySelector('canvas') ?? document.querySelector('.v3-subagent-bot')),
    dot: r(card?.querySelector('.ui-status__dot[data-kind="running"]') ?? document.querySelector('.ui-status__dot[data-kind="running"]')),
    spinner: r(firstAnim(/spin|ring|spinner/i)),
    shimmer: r(document.querySelector('.ui-shimmer[data-active]'))
  }
})()`

async function recordCast(cdp, sleep, dir, ms, dpr, width, height) {
  mkdirSync(dir, { recursive: true })
  const from = cdp.events.length
  let seen = from
  const frames = []
  await cdp.call('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1, maxWidth: Math.round(width * dpr), maxHeight: Math.round(height * dpr) })
  const end = Date.now() + ms
  while (Date.now() < end) {
    while (seen < cdp.events.length) {
      const event = cdp.events[seen++]
      if (event.method !== 'Page.screencastFrame') continue
      const name = `f${String(frames.length).padStart(4, '0')}.jpg`
      writeFileSync(join(dir, name), Buffer.from(event.params.data, 'base64'))
      frames.push({ name, t: event.params.metadata.timestamp })
      cdp.call('Page.screencastFrameAck', { sessionId: event.params.sessionId })
    }
    await sleep(5)
  }
  await cdp.call('Page.stopScreencast')
  writeFileSync(join(dir, 'frames.json'), JSON.stringify(frames))
  const span = frames.length > 1 ? frames.at(-1).t - frames[0].t : 0
  return { frames: frames.length, fps: span ? Math.round((frames.length - 1) / span) : 0 }
}

export default async function run({ cdp, box, runDir, waitFor, check, report, sleep, shot, log, autoApprove, newSession, state, running }) {
  const ev = (expr) => cdp.evaluate(expr)
  const measureMs = Math.max(1000, Number(process.env.YAN_MOTION_MS ?? 3000))
  const castMs = Math.max(1000, Number(process.env.YAN_MOTION_CAST_MS ?? 4000))
  const raf60 = process.env.YAN_MOTION_RAF60 === '1'
  report.variant = { raf60, measureMs, castMs }
  await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true })
  if (raf60) await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: RAF60 })
  report.viewport = await useRealWindow(cdp, sleep)
  await cdp.call('Page.reload')
  await sleep(300)
  await waitFor('!!window.__yanStore && !!window.yan && !!document.querySelector(".ProseMirror")', 60000, 20)
  await waitFor('s.conn === "ready"', 60000, 50)
  await autoApprove()

  await newSession(box.projects[1] ?? box.project)
  await ev(`window.__yanStore.getState().send('STORM-BG0 STEPS400 后台会话持续输出')`)
  await waitFor(`${running} && !!s.session?.sessionId`, 30000, 20)
  await newSession(box.projects[0] ?? box.project)
  await ev(`window.__yanStore.getState().send('SUBAGENTS6-FG SUBSTEPS120 FGSTEPS200 当前会话派子代理后继续')`)
  await waitFor(`${running} && !!s.session?.sessionId`, 30000, 20)
  await waitFor(`s.subagents.filter((a) => a.status === 'running').length >= 5`, 120000, 200)
  await sleep(4000)

  const measures = []
  for (let i = 0; i < 2; i++) {
    const m = await ev(MEASURE(measureMs))
    measures.push(m)
    log(`measure-${i}`, JSON.stringify(m))
  }
  report.measures = measures
  const rects = await ev(RECTS)
  report.rects = rects
  log('rects', JSON.stringify(rects))
  await shot('motion-a')
  report.cast = await recordCast(cdp, sleep, join(runDir, 'cast'), castMs, rects.dpr, rects.width, rects.height)
  log('cast', JSON.stringify(report.cast))
  await shot('motion-b')

  const last = measures.at(-1)
  check('量到刷新间隔', last.vsyncMs > 0, last.vsyncMs)
  check('有常驻动画在播放', Object.keys(last.animations).length > 0, Object.keys(last.animations))
  const off = Object.entries(last.animations).filter(([, g]) => g.speed !== null && (g.speed < 0.85 || g.speed > 1.15))
  check('常驻动画播放速度与真实时间一致（0.85–1.15）', off.length === 0, off)
  check('还在文档里的有限动画没有停在半途', measures.every((m) => m.stuck.length === 0), measures.flatMap((m) => m.stuck).slice(0, 5))
  check('录到页面帧', report.cast.frames > 10, report.cast)
  check('帧时钟仍在接管 CSS 动画', last.clock?.cssTakeover === true, last.clock)

  await ev(`window.yan.subagents.stopAll()`)
  await waitFor(`!s.subagents.some((a) => a.status === 'running' || a.status === 'starting')`, 60000, 200)
  await ev(`window.__yanStore.getState().abort()`)
}
