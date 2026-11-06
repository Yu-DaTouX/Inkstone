import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { useRealWindow } from '../lib/perf-probes.mjs'

export const meta = { description: '分屏里放超过虚拟阈值的大会话（YAN_LONG_SCROLL_SOURCE）加一个小会话，来回切换焦点：逐帧记录空白帧、锚点跳动、帧间隔最大值、长任务与切换耗时，不调用模型' }

const SAMPLER = `(() => {
  const w = window.__sbs = { frames: [], tasks: [], stop: false, last: 0, anchors: {} }
  const tiles = () => [...document.querySelectorAll('[data-tile-key]')]
  const tick = (now) => {
    const gap = w.last ? now - w.last : 0
    w.last = now
    const rec = { gap: Math.round(gap), tiles: [] }
    for (const tile of tiles()) {
      const stream = [...tile.querySelectorAll('.v3-stream')].find((el) => el.clientHeight > 0)
      const first = stream ? stream.querySelector('.v3-msg[data-turn-id]') : null
      const top = stream && first ? stream.getBoundingClientRect().top : 0
      rec.tiles.push({ key: tile.dataset.tileKey, rows: first ? 1 : 0, id: first?.dataset.turnId ?? null, off: first ? Math.round(first.getBoundingClientRect().top - top) : null, st: stream ? Math.round(stream.scrollTop) : null, sh: stream ? stream.scrollHeight : null })
    }
    w.frames.push(rec)
    if (!w.stop) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  w.observer = new PerformanceObserver((list) => w.tasks.push(...list.getEntries().map((e) => Math.round(e.duration))))
  w.observer.observe({ type: 'longtask' })
})()`

export default async function run({ cdp, box, waitFor, check, report, sleep, shot, log, autoApprove, newSession, state, turn }) {
  const source = process.env.YAN_LONG_SCROLL_SOURCE
  if (!source) throw new Error('需要 YAN_LONG_SCROLL_SOURCE 指向测试用会话副本')
  const ev = (expr) => cdp.evaluate(expr)
  report.viewport = await useRealWindow(cdp, sleep, { maximize: true })
  await autoApprove()
  await newSession(box.projects[0] ?? box.project)
  await turn('FLOW SHORT S1 先看看项目')
  await turn('FLOW S2 修复金额')
  const small = { sessionId: await state('s.session.sessionId'), path: await state('s.session.sessionFile') }
  const dir = join(box.sessionsDir, '--long-scroll-fixture--')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, basename(source))
  copyFileSync(source, file)
  await ev(`window.__yanStore.getState().refreshSessions()`)
  const t0 = Date.now()
  await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(file)})`)
  await waitFor(`!s.switchLoading && s.messages.length > 500`, 90000)
  report.openBigMs = Date.now() - t0
  log('openBigMs', report.openBigMs)
  await sleep(1200)
  const big = { sessionId: await state('s.session.sessionId'), path: file }
  await ev(`window.__yanSplit.getState().apply({ tiles: ${JSON.stringify([big, small])}, live: 0 })`)
  await sleep(2500)
  const keys = await ev(`[...document.querySelectorAll('[data-tile-key]')].map((el) => ({ key: el.dataset.tileKey, live: el.dataset.live }))`)
  check('两格分屏已打开', keys.length === 2, keys)
  if (keys.length !== 2) return
  const bigKey = keys.find((item) => item.live === '1' || item.live === 'true')?.key ?? keys[0].key
  const smallKey = keys.find((item) => item.key !== bigKey).key
  log('keys', { bigKey, smallKey, keys })
  const mode = await ev(`(() => { const t = document.querySelector('[data-tile-key="${bigKey}"]'); const s = [...t.querySelectorAll('.v3-stream')].find((e) => e.clientHeight > 0); return { rows: s.querySelectorAll('.v3-msg[data-turn-id]').length, sh: s.scrollHeight } })()`)
  report.bigMode = mode
  check('大会话格走虚拟列表', mode.rows < 40, mode)
  await ev(`(async () => { const t = document.querySelector('[data-tile-key="${bigKey}"]'); const s = [...t.querySelectorAll('.v3-stream')].find((e) => e.clientHeight > 0); s.scrollTop = Math.round((s.scrollHeight - s.clientHeight) * 0.45); await new Promise((r) => setTimeout(r, 1200)) })()`)
  await shot('before')
  const clickTitle = async (key) => {
    const point = await ev(`(() => { const el = document.querySelector('[data-tile-key="${key}"] .v3-split-title'); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(40, r.width / 2)), y: Math.round(r.top + r.height / 2) } })()`)
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  }
  await cdp.call('Performance.enable')
  const metrics = async () => Object.fromEntries((await cdp.call('Performance.getMetrics')).result.metrics.map((m) => [m.name, m.value]))
  if (process.env.YAN_SBS_REDUCE) await cdp.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await ev(SAMPLER)
  const results = []
  const sequence = [smallKey, bigKey, smallKey, bigKey, smallKey, bigKey]
  for (const [index, key] of sequence.entries()) {
    const mark = await ev(`window.__sbs.frames.length`)
    const profiling = process.env.YAN_SBS_PROFILE && index === Number(process.env.YAN_SBS_PROFILE)
    if (profiling) { await cdp.call('Profiler.enable'); await cdp.call('Profiler.start') }
    const tracing = process.env.YAN_SBS_TRACE && index === Number(process.env.YAN_SBS_TRACE)
    if (tracing) await cdp.call('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.invalidationTracking,disabled-by-default-devtools.timeline.cssSelectorStats', transferMode: 'ReturnAsStream' })
    const m0 = await metrics()
    const t = Date.now()
    await clickTitle(key)
    await waitFor(`document.querySelector('[data-tile-key="${key}"]')?.dataset.live === '1' || document.querySelector('[data-tile-key="${key}"]')?.dataset.live === 'true'`, 10000, 10).catch(() => {})
    const switchMs = Date.now() - t
    await sleep(900)
    if (tracing) {
      await cdp.call('Tracing.end')
      while (!cdp.events.some((e) => e.method === 'Tracing.tracingComplete')) await sleep(50)
      const stream = cdp.events.find((e) => e.method === 'Tracing.tracingComplete').params.stream
      let trace = ''
      for (;;) { const c = (await cdp.call('IO.read', { handle: stream })).result; trace += c.data; if (c.eof) break }
      writeFileSync(process.env.YAN_SBS_TRACE_OUT, trace)
    }
    if (profiling) {
      const profile = (await cdp.call('Profiler.stop')).result.profile
      const nodes = new Map(profile.nodes.map((n) => [n.id, n]))
      const self = new Map()
      const dt = profile.timeDeltas
      profile.samples.forEach((id, i) => { const f = nodes.get(id).callFrame; const k = `${f.functionName || '(anon)'} @ ${(f.url || '').split('/').slice(-1)[0]}:${f.lineNumber + 1}`; self.set(k, (self.get(k) ?? 0) + (dt[i] ?? 0) / 1000) })
      console.log('cpuTop', JSON.stringify([...self].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${Math.round(v)}ms ${k}`), null, 1))
    }
    const m1 = await metrics()
    const slice = await ev(`window.__sbs.frames.slice(${mark}).map((f) => ({ gap: f.gap, tiles: f.tiles }))`)
    const bigFrames = slice.map((f) => f.tiles.find((x) => x.key === bigKey)).filter(Boolean)
    const base = bigFrames[0]
    const blank = slice.filter((f) => f.tiles.some((x) => x.rows === 0)).length
    const ids = new Set(bigFrames.map((x) => x.id))
    const sameAnchor = bigFrames.filter((x) => x.id === base?.id && x.off !== null)
    const jump = sameAnchor.length ? Math.max(...sameAnchor.map((x) => Math.abs(x.off - base.off))) : null
    const stJump = Math.max(...bigFrames.map((x) => Math.abs((x.st ?? 0) - (base?.st ?? 0))))
    const maxGap = Math.max(...slice.map((f) => f.gap))
    const over50 = slice.filter((f) => f.gap > 50).length
    const result = { to: key === bigKey ? 'big' : 'small', switchMs, frames: slice.length, maxGap, over50, blankBig: blank, anchorIds: ids.size, anchorJump: jump, scrollTopJump: stJump, layoutMs: Math.round((m1.LayoutDuration - m0.LayoutDuration) * 1000), styleMs: Math.round((m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000), scriptMs: Math.round((m1.ScriptDuration - m0.ScriptDuration) * 1000), layouts: m1.LayoutCount - m0.LayoutCount, styles: m1.RecalcStyleCount - m0.RecalcStyleCount }
    results.push(result)
    console.log('switch', index, JSON.stringify(result))
  }
  report.switches = results
  report.longTasks = await ev(`window.__sbs.tasks`)
  await ev(`window.__sbs.stop = true`)
  console.log('longTasks', JSON.stringify(report.longTasks))
  check('切换无空白帧', results.every((r) => r.blankBig === 0), results)
  check('大会话格阅读位置不跳（滚动位移 ≤ 24px）', results.every((r) => r.scrollTopJump <= 24), results.map((r) => r.scrollTopJump))
  check('切换期间无 >100ms 帧', results.every((r) => r.maxGap <= 100), results.map((r) => r.maxGap))
  await shot('after')
}
