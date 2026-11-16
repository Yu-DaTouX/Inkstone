import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROBES, RENDER_HOOK, RENDER_START, RENDER_TAKE, SUMMARY, useRealWindow } from '../lib/perf-probes.mjs'
import { cpuByKind, memoryByKind, sampleProcessTree } from '../lib/process-tree.mjs'
import { startProfile, stopProfile } from '../lib/cpu-profile.mjs'

export const meta = { description: '子代理群压测：一个后台会话跑 STORM，当前会话派 20 个假模型子代理（SUBLONG，每步流出约 20KB 长文）后继续 STORM；分阶段量渲染进程主线程忙碌比例、长帧、每秒 store 写入与 IPC 推送条数和字节、各进程 CPU，抓 CPU 剖面列热点（YAN_SWARM_PANEL_ONLY=1 只测记录面板），统计组件渲染次数，再打开一个子代理记录面板看它是否流畅更新，并核对渲染端子代理记录与主进程一致（YAN_SWARM_COUNT 改子代理数，YAN_SWARM_MS 改每段时长，YAN_SWARM_LONG=0 关长文，YAN_SWARM_TASK_PAD=<n> 给每个子代理的任务文本补 n 个字符，YAN_SWARM_BG=<n> 改后台 STORM 会话数，YAN_SWARM_TRACE=1 加一段 Performance trace 统计强制布局、样式、绘制与合成层，YAN_SWARM_SKIP_PANEL=1 跳过记录面板阶段，YAN_SWARM_AB=<名>=<规格>||… 在同一实例内交替开关做对比，YAN_SWARM_FOCUS=1 让页面始终按有焦点运行）' }

const TRACE_CATEGORIES = ['devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack,disabled-by-default-devtools.timeline.frame,v8.execute', process.env.YAN_SWARM_TRACE_CATS].filter(Boolean).join(',')

const DOM_STATS = `(() => {
  const count = (sel) => [...document.querySelectorAll(sel)].reduce((n, el) => n + el.getElementsByTagName('*').length, 0)
  return { all: document.getElementsByTagName('*').length, streams: document.querySelectorAll('.v3-stream').length, stream: count('.v3-stream'), sidebar: count('.v3-sessionbar'), tiles: count('[data-testid="v3-subagent-tile"]'), workbench: count('.v3-workbench, .v3-rail') }
})()`

const ANIMATIONS = `(() => {
  const by = {}
  for (const a of document.getAnimations()) {
    if (a.playState !== 'running') continue
    const el = a.effect?.target
    const props = a.effect?.getKeyframes?.().flatMap((k) => Object.keys(k).filter((p) => !['offset', 'easing', 'composite', 'computedOffset'].includes(p))) ?? []
    const key = (a.animationName || a.constructor.name) + ' ' + [...new Set(props)].join('+') + ' .' + String(el?.className?.baseVal ?? el?.className ?? '').split(' ').slice(0, 2).join('.')
    by[key] = (by[key] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 20))
})()`

const RAF_WRAP = `(() => {
  if (window.__rafWrap) return
  const native = window.requestAnimationFrame.bind(window)
  const nativeCancel = window.cancelAnimationFrame.bind(window)
  const kinds = new WeakMap()
  const kindOf = (cb) => {
    let k = kinds.get(cb)
    if (k) return k
    const src = String(cb)
    k = src.includes('followGlideRef') ? 'glide' : src.includes('stepReveal') ? 'reveal' : src.includes('pa.frames') ? 'probe' : src.includes('readScroll') ? 'readScroll' : (cb.name || 'anon')
    kinds.set(cb, k)
    return k
  }
  const live = new Map()
  const last = {}
  let seq = 0
  const cfg = window.__rafWrap = { throttle: new Set(), minMs: 15.5, stats: {} }
  window.requestAnimationFrame = (cb) => {
    const id = ++seq
    const kind = kindOf(cb)
    const run = (t) => {
      if (cfg.throttle.has(kind) && last[kind] !== undefined && t - last[kind] < cfg.minMs) { live.set(id, native(run)); return }
      live.delete(id)
      last[kind] = t
      const s = (cfg.stats[kind] ??= { n: 0, ms: 0 })
      const start = performance.now()
      try { cb(t) } finally { s.n++; s.ms += performance.now() - start }
    }
    live.set(id, native(run))
    return id
  }
  window.cancelAnimationFrame = (id) => {
    const n = live.get(id)
    if (n !== undefined) { nativeCancel(n); live.delete(id) } else nativeCancel(id)
  }
})()`

const ALIGN = "(() => {\n  if (window.__align) return\n  const native = window.requestAnimationFrame.bind(window)\n  const nativeCancel = window.cancelAnimationFrame.bind(window)\n  const PERIOD = 1000 / 60\n  const cfg = window.__align = { on: false, drive: true, raf: true, ticks: 0 }\n  const queue = new Map()\n  const driven = new Map()\n  let seq = 0\n  let timer = 0\n  let raf = 0\n  let last = 0\n  let scanAt = 0\n  const scan = (now) => {\n    scanAt = now\n    for (const a of document.getAnimations()) {\n      if (driven.has(a) || a.playState !== 'running') continue\n      const timing = a.effect?.getComputedTiming?.()\n      if (!timing) continue\n      driven.set(a, { base: a.currentTime ?? 0, t0: now, end: timing.endTime, rate: a.playbackRate || 1 })\n      a.pause()\n    }\n  }\n  const drive = (now) => {\n    for (const [a, d] of driven) {\n      if (a.playState === 'idle' || !a.effect?.target?.isConnected) { driven.delete(a); continue }\n      const t = d.base + (now - d.t0) * d.rate\n      if (t >= d.end) { driven.delete(a); try { a.finish() } catch {} continue }\n      a.currentTime = t\n    }\n  }\n  const pump = () => {\n    if (timer || raf) return\n    const wait = Math.max(0, last + PERIOD - performance.now() - 3)\n    timer = setTimeout(() => { timer = 0; raf = native(frame) }, wait)\n  }\n  const frame = (t) => {\n    raf = 0\n    last = t\n    cfg.ticks++\n    if (cfg.drive) {\n      if (t - scanAt > 400) scan(t)\n      drive(t)\n    }\n    const cbs = [...queue.values()]\n    queue.clear()\n    for (const cb of cbs) { try { cb(t) } catch (e) { console.error(e) } }\n    if (cfg.on && (queue.size || driven.size || cfg.drive)) pump()\n  }\n  window.requestAnimationFrame = (cb) => {\n    if (!cfg.on || !cfg.raf) return native(cb)\n    const id = -(++seq)\n    queue.set(id, cb)\n    pump()\n    return id\n  }\n  window.cancelAnimationFrame = (id) => { if (id < 0) queue.delete(id); else nativeCancel(id) }\n  cfg.start = () => { cfg.on = true; pump() }\n  cfg.stop = () => {\n    cfg.on = false\n    for (const [a] of driven) { try { if (a.playState === 'paused') a.play() } catch {} }\n    driven.clear()\n    const cbs = [...queue.values()]\n    queue.clear()\n    for (const cb of cbs) native(cb)\n  }\n})()\n"

function mainThreadMs(events, ms) {
  const outer = (name) => {
    let end = -1
    let sum = 0
    for (const e of events.filter((x) => x.name === name).sort((a, b) => a.ts - b.ts)) {
      if (e.ts < end) continue
      end = e.ts + e.dur
      sum += e.dur
    }
    return Math.round(sum / ms)
  }
  return { paintMsPerSec: outer('Paint'), layoutMsPerSec: outer('Layout'), styleMsPerSec: outer('UpdateLayoutTree'), layerizeMsPerSec: outer('Layerize'), prePaintMsPerSec: outer('PrePaint'), taskMsPerSec: outer('RunTask') }
}

async function frameRates(cdp, sleep, ms) {
  const from = cdp.events.length
  await cdp.call('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame', transferMode: 'ReturnAsStream' })
  await sleep(ms)
  await cdp.call('Tracing.end')
  let done = null
  while (!(done = cdp.events.slice(from).find((e) => e.method === 'Tracing.tracingComplete'))) await sleep(50)
  const handle = done.params.stream
  let text = ''
  for (;;) {
    const chunk = (await cdp.call('IO.read', { handle })).result
    text += chunk.data
    if (chunk.eof) break
  }
  await cdp.call('IO.close', { handle })
  const raw = JSON.parse(text)
  const events = Array.isArray(raw) ? raw : raw.traceEvents
  const names = new Map()
  for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') names.set(`${e.pid}:${e.tid}`, e.args.name)
  const counts = new Map()
  for (const e of events) { const k = `${e.pid}:${e.tid}`; if (names.get(k) === 'CrRendererMain') counts.set(k, (counts.get(k) ?? 0) + 1) }
  const main = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
  const pid = main?.split(':')[0]
  const per = (pred) => Math.round(events.filter(pred).length / (ms / 1000))
  const onMain = (e) => `${e.pid}:${e.tid}` === main
  const onComp = (e) => String(e.pid) === pid && names.get(`${e.pid}:${e.tid}`) === 'Compositor'
  return {
    commitPerSec: per((e) => onMain(e) && e.name === 'Commit' && (e.ph === 'X' || e.ph === 'B')),
    rafPerSec: per((e) => onMain(e) && e.name === 'FireAnimationFrame' && (e.ph === 'X' || e.ph === 'B')),
    paintPerSec: per((e) => onMain(e) && e.name === 'PrePaint' && (e.ph === 'X' || e.ph === 'B')),
    drawPerSec: per((e) => onComp(e) && e.name === 'DrawFrame'),
    longTasks: events.filter((e) => onMain(e) && e.name === 'RunTask' && e.ph === 'X' && e.dur > 50000).length,
    ...mainThreadMs(events.filter((e) => onMain(e) && e.ph === 'X' && typeof e.dur === 'number'), ms)
  }
}

async function captureTrace(cdp, sleep, ms) {
  const animations = await cdp.evaluate(ANIMATIONS)
  animations.dom = await cdp.evaluate(DOM_STATS)
  const from = cdp.events.length
  await cdp.call('LayerTree.enable').catch(() => {})
  await cdp.call('Tracing.start', { categories: TRACE_CATEGORIES, transferMode: 'ReturnAsStream' })
  await sleep(ms)
  await cdp.call('Tracing.end')
  let done = null
  while (!(done = cdp.events.slice(from).find((e) => e.method === 'Tracing.tracingComplete'))) await sleep(50)
  const handle = done.params.stream
  let text = ''
  for (;;) {
    const chunk = (await cdp.call('IO.read', { handle })).result
    text += chunk.data
    if (chunk.eof) break
  }
  await cdp.call('IO.close', { handle })
  const layerEvents = cdp.events.slice(from).filter((e) => e.method === 'LayerTree.layerTreeDidChange' && e.params?.layers)
  await cdp.call('LayerTree.disable').catch(() => {})
  const counts = layerEvents.map((e) => e.params.layers.length)
  const last = layerEvents.at(-1)?.params.layers ?? []
  const reasons = {}
  for (const layer of last.slice(0, 400)) {
    const why = await cdp.call('LayerTree.compositingReasons', { layerId: layer.layerId }).catch(() => null)
    for (const r of why?.result?.compositingReasonIds ?? why?.result?.compositingReasons ?? ['unknown']) reasons[r] = (reasons[r] ?? 0) + 1
  }
  return { text, animations, layers: { changes: layerEvents.length, max: Math.max(0, ...counts), last: last.length, drawn: last.filter((l) => l.drawsContent).length, reasons: Object.fromEntries(Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 15)) } }
}

const PUSH_COUNTER = `(() => {
  if (window.__pushRec) return
  const rec = window.__pushRec = { phase: 'boot', by: {}, span: {} }
  let tick = 0
  const sizeOf = (m) => { try { return JSON.stringify(m.payload).length } catch { return 0 } }
  window.yan.onPush((m) => {
    const slot = (rec.by[rec.phase] ??= {})
    const c = (slot[m.ch] ??= { n: 0, sampled: 0, bytes: 0 })
    c.n++
    if ((tick++ % 10) === 0) { c.sampled++; c.bytes += sizeOf(m) }
  })
})()`

const SET_PHASE = (name) => `(() => {
  const now = performance.now()
  const rec = window.__pushRec
  if (rec.phase !== 'between' && rec.span[rec.phase]) rec.span[rec.phase].end = now
  rec.phase = ${JSON.stringify(name)}
  window.__pa.phase = ${JSON.stringify(name)}
  if (${JSON.stringify(name)} !== 'between') rec.span[${JSON.stringify(name)}] = { start: now, end: now }
  return now
})()`

const PANE_RECORDER = `(() => {
  const el = document.querySelector('[data-testid="v3-subagent-pane"] .sa-pane-stream')
  const sig = () => { const paras = el ? el.querySelectorAll('.v3-para') : []; return paras.length + ':' + (paras.length ? paras[paras.length - 1].textContent.length : 0) }
  const rec = window.__paneRec = { on: true, at: [], first: sig() }
  if (!el) return
  const observer = new MutationObserver(() => { if (rec.on) rec.at.push(performance.now()) })
  observer.observe(el, { subtree: true, childList: true, characterData: true })
  rec.stop = () => { rec.on = false; observer.disconnect(); rec.last = sig() }
})()`

const CONSISTENCY = `(async () => {
  const st = window.__yanStore.getState()
  const out = { compared: 0, runs: 0, mismatches: [] }
  for (const run of st.subagents.filter((a) => a.transcript.length > 0).slice(-8)) {
    const full = await window.yan.subagents.get(run.id)
    if (!full) continue
    out.runs++
    const byId = new Map(full.transcript.map((m) => [m.id, m]))
    for (const msg of run.transcript) {
      const other = byId.get(msg.id)
      if (!other) continue
      out.compared++
      if (!(other.text ?? '').startsWith(msg.text ?? '') || !(other.thinking ?? '').startsWith(msg.thinking ?? '') || (other.toolCalls?.length ?? 0) < (msg.toolCalls?.length ?? 0)) out.mismatches.push({ id: run.id, msg: msg.id, mine: (msg.text ?? '').length, main: (other.text ?? '').length })
    }
  }
  return out
})()`

async function mainProfiler() {
  const port = process.env.YAN_DEBUG_MAIN_INSPECT
  if (!port) return null
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let id = 0
  const pending = new Map()
  ws.onmessage = ({ data }) => {
    const reply = JSON.parse(data)
    if (reply.id) { pending.get(reply.id)?.(reply); pending.delete(reply.id) }
  }
  return {
    call: (method, params = {}) => new Promise((resolve) => {
      const request = ++id
      pending.set(request, resolve)
      ws.send(JSON.stringify({ id: request, method, params }))
    }),
    close: () => ws.close()
  }
}

export default async function run({ cdp, box, runDir, waitFor, check, report, sleep, shot, log, autoApprove, newSession, state, running }) {
  const ev = (expr) => cdp.evaluate(expr)
  const count = Math.max(1, Math.min(24, Number(process.env.YAN_SWARM_COUNT ?? 20)))
  const windowMs = Math.max(3000, Number(process.env.YAN_SWARM_MS ?? 10000))
  const long = process.env.YAN_SWARM_LONG !== '0'
  const taskPad = Math.max(0, Number(process.env.YAN_SWARM_TASK_PAD ?? 0))
  report.variant = { count, windowMs, long, taskPad }
  const marker = box.userData
  if (process.env.YAN_SWARM_FOCUS === '1') await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true })
  await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: RENDER_HOOK })
  report.viewport = await useRealWindow(cdp, sleep)
  await cdp.call('Page.reload')
  await sleep(300)
  await waitFor('!!window.__yanStore && !!window.yan && !!document.querySelector(".ProseMirror")', 60000, 20)
  await waitFor('s.conn === "ready"', 60000, 50)
  await ev(PROBES)
  await ev(PUSH_COUNTER)
  await autoApprove()
  await cdp.call('Performance.enable')
  const mainCdp = await mainProfiler().catch((error) => { log('main inspector', String(error)); return null })
  const metrics = async () => Object.fromEntries((await cdp.call('Performance.getMetrics')).result.metrics.map((m) => [m.name, m.value]))

  const phase = async (name, action, { renders = false, profile = false } = {}) => {
    const procBefore = sampleProcessTree(marker)
    const before = await metrics()
    if (renders) await ev(RENDER_START)
    if (profile) await startProfile(cdp)
    if (profile && mainCdp) await startProfile(mainCdp)
    const started = await ev(SET_PHASE(name))
    const out = (await action()) ?? {}
    const ended = await ev(SET_PHASE('between'))
    const ms = Math.max(1, ended - started)
    if (profile) {
      const { totalMs, top, longBusy, profile: raw } = await stopProfile(cdp, runDir, 30)
      writeFileSync(join(runDir, `${name}.cpuprofile`), JSON.stringify(raw))
      out.profile = { totalMs, top, longBusy }
      if (mainCdp) {
        const mainRun = await stopProfile(mainCdp, runDir, 30)
        writeFileSync(join(runDir, `${name}.main.cpuprofile`), JSON.stringify(mainRun.profile))
        out.mainProfile = { totalMs: mainRun.totalMs, top: mainRun.top, longBusy: mainRun.longBusy }
      }
    }
    const after = await metrics()
    const procAfter = sampleProcessTree(marker)
    const wall = Math.max(1, procAfter.at - procBefore.at)
    const take = renders ? await ev(RENDER_TAKE) : null
    const summary = await ev(SUMMARY(name))
    const pushes = await ev(`window.__pushRec.by[${JSON.stringify(name)}] ?? {}`)
    const sec = ms / 1000
    const perSec = Object.fromEntries(Object.entries(pushes).sort((a, b) => b[1].n - a[1].n).map(([ch, c]) => [ch, { perSec: Math.round(c.n / sec), kbPerSec: c.sampled ? Math.round((c.bytes / c.sampled) * c.n / sec / 1024) : 0, avgBytes: c.sampled ? Math.round(c.bytes / c.sampled) : 0 }]))
    const busy = {}
    for (const key of ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration']) busy[key] = Math.round((after[key] - before[key]) * 1000)
    const result = {
      ms: Math.round(ms),
      ...out,
      mainThreadBusyPct: Math.round((busy.TaskDuration / wall) * 100),
      rendererMs: busy,
      frames: summary.frames,
      longTasks: summary.longTasks,
      longTaskMax: summary.longTaskMax,
      storeWritesPerSec: Math.round(summary.storeUpdates / sec),
      changedKeysPerSec: Object.fromEntries(Object.entries(summary.changedKeys).map(([k, n]) => [k, Math.round(n / sec)])),
      pushesPerSec: Math.round(Object.values(pushes).reduce((a, c) => a + c.n, 0) / sec),
      pushes: perSec,
      ipcRtt: summary.ipc,
      processCpuPercent: cpuByKind(procBefore, procAfter),
      memory: memoryByKind(procAfter),
      ...(take ? { renders: take.renders, causes: take.causes } : {})
    }
    report.timings[name] = result
    log(name, JSON.stringify({ ms: result.ms, busy: result.mainThreadBusyPct, frames: result.frames, longTasks: result.longTasks, longTaskMax: result.longTaskMax, store: result.storeWritesPerSec, pushes: result.pushesPerSec, cpu: result.processCpuPercent, top: Object.entries(perSec).slice(0, 4) }))
    if (out.profile) log(name + ' profile', JSON.stringify(out.profile.top.slice(0, 15)))
    if (out.mainProfile) log(name + ' main profile', JSON.stringify(out.mainProfile.top.slice(0, 15)))
    if (take) log(name + ' renders', JSON.stringify(take.renders))
    return result
  }

  const foreground = box.projects[0] ?? box.project
  const steps = Math.max(200, Number(process.env.YAN_SWARM_STEPS ?? 200))
  report.variant.steps = steps
  const bgCount = Math.max(1, Math.min(3, Number(process.env.YAN_SWARM_BG ?? 1)))
  const bgIds = []
  for (let i = 0; i < bgCount; i++) {
    await newSession(box.projects[i + 1] ?? box.projects[1] ?? box.project)
    await ev(`window.__yanStore.getState().send('STORM-BG${i} STEPS${steps} 后台会话持续输出')`)
    await waitFor(`${running} && !!s.session?.sessionId`, 30000, 20)
    bgIds.push(await state('s.session.sessionId'))
  }
  report.variant.bgCount = bgCount
  await newSession(foreground)
  await ev(`window.__yanStore.getState().send(${JSON.stringify(`SUBAGENTS${count}-FG ${long ? 'SUBLONG ' : ''}${taskPad ? `SUBPAD${taskPad} ` : ''}${steps > 200 ? `SUBSTEPS${Math.round(steps / 5)} FGSTEPS${Math.round(steps / 3)} ` : ''}当前会话派子代理后继续`)})`)
  await waitFor(`${running} && !!s.session?.sessionId`, 30000, 20)
  const fgId = await state('s.session.sessionId')
  report.sessions = { bgIds, fgId }
  await waitFor(`s.subagents.filter((a) => a.status === 'running').length >= ${Math.ceil(count * 0.8)}`, 180000, 200)
  await sleep(5000)
  const bgRunning = await ev(`window.__yanStore.getState().runners.filter((r) => ${JSON.stringify(bgIds)}.includes(r.sessionId) && (r.running || r.waiting)).length`)
  check('后台会话仍在流式输出', bgRunning === bgCount, { bgRunning, bgCount })
  log('running subagents', await state(`s.subagents.filter((a) => a.status === 'running').length`))

  const panelOnly = process.env.YAN_SWARM_PANEL_ONLY === '1'
  if (!panelOnly) await phase('swarm-watch', () => sleep(windowMs))
  if (process.env.YAN_SWARM_QUIET === '1') {
    await ev('window.__pa.rafOff = true')
    await sleep(500)
    await phase('swarm-quiet', () => sleep(windowMs))
    await ev('window.__pa.resumeRaf()')
  }
  const ab = (process.env.YAN_SWARM_AB ?? '').split('||').map((item) => item.trim()).filter(Boolean).map((item) => { const at = item.indexOf('='); return { name: item.slice(0, at), spec: item.slice(at + 1) } })
  const abRounds = Math.max(1, Number(process.env.YAN_SWARM_AB_ROUNDS ?? 3))
  const abMs = Math.max(3000, Number(process.env.YAN_SWARM_AB_MS ?? 6000))
  if (ab.some((variant) => variant.spec.startsWith('RAF:'))) await ev(RAF_WRAP)
  const toggle = async (variant, on) => {
    const { spec } = variant
    if (spec.startsWith('ALIGN')) { await ev(ALIGN); const opts = spec.slice(5); return ev(on ? `window.__align.drive = ${!opts.includes('nodrive')}; window.__align.raf = ${!opts.includes('noraf')}; window.__align.start()` : `window.__align.stop()`) }
    if (spec === 'REDUCE') return ev(`window.__yanStore.getState().patchSettings({ reduceMotion: ${on} })`)
    if (spec.startsWith('RAF:')) return ev(on ? `window.__rafWrap.throttle = new Set(${JSON.stringify(spec.slice(4).split(',').filter(Boolean))})` : `window.__rafWrap.throttle = new Set()`)
    if (spec.startsWith('JS:')) { const [onExpr, offExpr] = spec.slice(3).split('|'); return ev(on ? onExpr : offExpr) }
    return ev(on ? `(() => { const el = document.createElement('style'); el.id = '__swarm_ab'; el.textContent = ${JSON.stringify(spec)}; document.head.append(el) })()` : `document.getElementById('__swarm_ab')?.remove()`)
  }
  const abRows = []
  if (ab.length) { await ev('window.__pa.rafOff = true'); await sleep(300) }
  for (let round = 0; round < abRounds; round++) {
    for (const variant of ab) {
      const order = round % 2 === 0 ? [true, false] : [false, true]
      for (const on of order) {
        await toggle(variant, on)
        await sleep(800)
        const name = `ab-${variant.name}${on ? '' : '-ctl'}-r${round}`
        const result = await phase(name, () => sleep(abMs), { profile: process.env.YAN_SWARM_AB_PROFILE === "1" })
        const frames = await frameRates(cdp, sleep, 2000)
        result.frameRates = frames
        abRows.push({ variant: variant.name, on, round, focus: await ev('document.hasFocus()'), renderer: result.processCpuPercent.renderer, gpu: result.processCpuPercent.gpu, busy: result.mainThreadBusyPct, store: result.storeWritesPerSec, ...frames })
        log(name + ' frames', JSON.stringify(frames))
      }
      await toggle(variant, false)
    }
  }
  if (ab.length) {
    await ev('window.__pa.resumeRaf()')
    const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }
    const keys = ['renderer', 'gpu', 'busy', 'store', 'commitPerSec', 'rafPerSec', 'drawPerSec', 'paintPerSec', 'longTasks', 'paintMsPerSec', 'layoutMsPerSec', 'styleMsPerSec', 'layerizeMsPerSec', 'prePaintMsPerSec', 'taskMsPerSec']
    report.ab = { rows: abRows, summary: {} }
    for (const variant of ab) {
      for (const on of [true, false]) {
        const rows = abRows.filter((r) => r.variant === variant.name && r.on === on)
        report.ab.summary[`${variant.name}${on ? '' : '-ctl'}`] = Object.fromEntries(keys.map((k) => [k, median(rows.map((r) => r[k]))]))
      }
    }
    log('ab summary', JSON.stringify(report.ab.summary))
  }
  await shot('swarm-watch')
  const cards = await ev(`document.querySelectorAll('[data-testid="v3-subagent-row"], [data-testid="v3-subagent-tile"]').length`)
  check('子代理卡片在消息流里显示', cards >= Math.min(count, 12), { cards })
  const activity = await ev(`[...document.querySelectorAll('[data-testid="v3-subagent-tile"] .v3-sa-tile-detail')].map((el) => el.textContent).join('|')`)
  await sleep(1500)
  const activityLater = await ev(`[...document.querySelectorAll('[data-testid="v3-subagent-tile"] .v3-sa-tile-detail')].map((el) => el.textContent).join('|')`)
  check('子代理卡片上的最近动作在更新', activity !== activityLater)

  if (!panelOnly) {
    await phase('swarm-profile', () => sleep(Math.min(windowMs, 8000)), { profile: true })
    await phase('swarm-renders', () => sleep(5000), { renders: true })
    if (process.env.YAN_SWARM_TRACE === '1') {
      await phase('swarm-trace', async () => {
        const { text, layers, animations } = await captureTrace(cdp, sleep, 5000)
        writeFileSync(join(runDir, 'swarm-trace.json'), text)
        log('layers', JSON.stringify(layers))
        log('animations', JSON.stringify(animations))
        return { layers, animations }
      })
    }
    if (process.env.YAN_SWARM_CALM === '1') {
      await ev(`window.__yanStore.getState().patchSettings({ reduceMotion: true })`)
      await sleep(1000)
      await phase('swarm-calm', () => sleep(Math.min(windowMs, 8000)), { profile: true })
      await ev(`window.__yanStore.getState().patchSettings({ reduceMotion: false })`)
      await sleep(1000)
      await phase('swarm-motion', () => sleep(Math.min(windowMs, 8000)), { profile: true })
    }
  }

  const consistency = await ev(CONSISTENCY)
  report.consistency = consistency
  check('渲染端子代理记录与主进程一致', consistency.compared > 0 && consistency.mismatches.length === 0, { runs: consistency.runs, compared: consistency.compared, mismatches: consistency.mismatches.slice(0, 5) })

  const target = await state(`s.subagents.find((a) => a.status === 'running' && a.parentSessionId === ${JSON.stringify(fgId)})?.id ?? s.subagents.find((a) => a.status === 'running')?.id ?? null`)
  check('有运行中的子代理可打开记录面板', !!target, target)
  if (target && process.env.YAN_SWARM_SKIP_PANEL !== '1') {
    await ev(`document.querySelector('[data-run-id="${target}"]')?.click()`)
    await waitFor(`!!document.querySelector('[data-testid="v3-subagent-pane"]')`, 10000, 50)
    await sleep(800)
    await ev(PANE_RECORDER)
    const pane = await phase('swarm-panel', () => sleep(windowMs), panelOnly ? { profile: true, renders: true } : {})
    const rec = await ev(`(() => { const r = window.__paneRec; r.stop?.(); const gaps = r.at.slice(1).map((t, i) => t - r.at[i]).sort((a, b) => a - b); return { changes: r.at.length, first: r.first, last: r.last, p50Gap: gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]) : null, p95Gap: gaps.length ? Math.round(gaps[Math.floor(gaps.length * 0.95)]) : null, maxGap: gaps.length ? Math.round(gaps.at(-1)) : null } })()`)
    pane.paneUpdates = rec
    log('pane updates', rec)
    check('打开的子代理记录面板持续更新', rec.changes >= Math.round(windowMs / 1000) * 5 && rec.last !== rec.first, rec)
    await shot('swarm-panel')
    await phase('swarm-panel-profile', () => sleep(5000), { profile: true, renders: true })
  }

  await ev(`window.yan.subagents.stopAll()`)
  await waitFor(`!s.subagents.some((a) => a.status === 'running' || a.status === 'starting')`, 60000, 200)
  await sleep(500)
  const final = await ev(`(async () => {
    const st = window.__yanStore.getState()
    const listed = await window.yan.subagents.list()
    const byId = new Map(listed.map((r) => [r.id, r]))
    return st.subagents.map((r) => ({ id: r.id, status: r.status, same: byId.get(r.id)?.status === r.status && byId.get(r.id)?.transcript.length === r.transcript.length }))
  })()`)
  check('停止后渲染端子代理状态与主进程一致', final.length >= count && final.every((r) => r.same && r.status !== 'running'), final.filter((r) => !r.same).slice(0, 5))
  await ev(`window.__yanStore.getState().abort()`)
  await ev('window.__pa.stop = true')
  mainCdp?.close()
}
