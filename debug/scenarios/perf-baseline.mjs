import { SCROLL_HOOK, scrollStats } from '../lib/scroll-probes.mjs'
import { memoryByKind, sampleProcessTree } from '../lib/process-tree.mjs'

export const meta = { observation: true, description: '性能基线：两个大会话样本之间切换、长会话滚轮滚动、大会话与空会话里流式出字（长文本与工具风暴）的帧时间、长任务与主线程开销，以及各阶段的内存；结果在 report.timings.perf，用 debug/perf-summary.mjs 汇总多次运行', samples: 2 }

const PROBE = `
window.__pb = (() => {
  let on = false, dts = [], longs = [], raf = 0, last = 0, obs = null
  const tick = (now) => { if (!on) return; dts.push(now - last); last = now; raf = requestAnimationFrame(tick) }
  const q = (xs, f) => xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * f))] : 0
  return {
    start() {
      dts = []; longs = []; on = true; last = performance.now()
      obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) longs.push(e.duration) })
      obs.observe({ type: 'longtask' })
      raf = requestAnimationFrame(tick)
    },
    stop() {
      on = false; cancelAnimationFrame(raf); obs && obs.disconnect()
      const s = [...dts].sort((a, b) => a - b)
      return {
        frames: dts.length, p50Ms: +q(s, 0.5).toFixed(1), p95Ms: +q(s, 0.95).toFixed(1), p99Ms: +q(s, 0.99).toFixed(1), maxFrameMs: Math.round(s.at(-1) ?? 0),
        over33: dts.filter((x) => x > 33.4).length, over50: dts.filter((x) => x > 50).length,
        longTasks: longs.length, longTaskMs: Math.round(longs.reduce((a, b) => a + b, 0)), longTaskMax: Math.round(Math.max(0, ...longs))
      }
    }
  }
})()
`

export default async function run({ cdp, box, state, waitFor, check, report, sleep, log, turn, newSession, autoApprove }) {
  const ev = (expr) => cdp.evaluate(expr)
  const [big1, big2] = box.samples
  if (!big2) throw new Error('需要 2 个大会话样本：先跑 npm run debug -- samples pick')
  const perf = (report.timings.perf = {})
  const phases = new Set((process.env.YAN_PERF_PHASES ?? 'switch,scroll,stream').split(','))
  await autoApprove()
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false })
  await cdp.call('Performance.enable')
  await cdp.call('HeapProfiler.enable')
  await waitFor('s.sessions.length > 0', 60000, 20)
  await ev(`window.__yanStore.getState().patchSettings({ reduceMotion: false, workspaceTiles: true })`)
  await ev(PROBE)
  await ev(SCROLL_HOOK)
  await sleep(1500)

  const metrics = async () => Object.fromEntries((await cdp.call('Performance.getMetrics')).result.metrics.map((m) => [m.name, m.value]))
  const cpuDelta = (before, after) => {
    const out = {}
    for (const key of ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration']) out[key.replace('Duration', 'Ms')] = Math.round((after[key] - before[key]) * 1000)
    out.layoutCount = after.LayoutCount - before.LayoutCount
    out.recalcCount = after.RecalcStyleCount - before.RecalcStyleCount
    return out
  }
  const probed = async (action, settle = 600) => {
    const before = await metrics()
    await ev('window.__pb.start()')
    const t = Date.now()
    const value = (await action()) ?? {}
    const actionMs = Date.now() - t
    await sleep(settle)
    const frames = await ev('window.__pb.stop()')
    return { actionMs, ...value, ...frames, cpu: cpuDelta(before, await metrics()) }
  }
  const memory = async (label) => {
    for (let i = 0; i < 3; i++) { await cdp.call('HeapProfiler.collectGarbage').catch(() => {}); await sleep(150) }
    const m = await metrics()
    const proc = memoryByKind(sampleProcessTree(box.userData))
    perf.memory ??= {}
    perf.memory[label] = { heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), nodes: m.Nodes, listeners: m.JSEventListeners, rendererMB: proc.renderer?.workingSetMB ?? null, mainMB: proc.main?.workingSetMB ?? null, piMB: proc.pi?.workingSetMB ?? null, totalMB: proc.total.workingSetMB }
    log('memory', label, perf.memory[label])
  }
  await memory('idle')

  const switchTo = async (path) => {
    await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(path)})`)
    await waitFor(`!s.switchLoading && s.session?.sessionFile === ${JSON.stringify(path)} && s.messages.length > 0`, 120000, 10)
  }
  const switches = []
  for (let round = 0; round < (phases.has('switch') ? 4 : 0); round++) {
    for (const [name, target] of [['big1', big1], ['big2', big2]]) {
      const row = await probed(async () => { await switchTo(target); return { messages: await state('s.messages.length') } }, 700)
      switches.push({ round, name, ...row })
      log('switch', round, name, row)
      await sleep(500)
    }
  }
  const sw = (rows) => ({
    n: rows.length,
    ms: rows.map((r) => r.actionMs),
    longTaskMax: rows.map((r) => r.longTaskMax),
    maxFrameMs: rows.map((r) => r.maxFrameMs)
  })
  const first = switches.filter((r) => r.round === 0)
  const warm = switches.filter((r) => r.round > 0)
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
  perf.switchFirst = { medianMs: med(first.map((r) => r.actionMs)), maxMs: Math.max(...first.map((r) => r.actionMs)), longTaskMax: Math.max(...first.map((r) => r.longTaskMax)), maxFrameMs: Math.max(...first.map((r) => r.maxFrameMs)), messages: first.map((r) => r.messages) }
  perf.switchWarm = { medianMs: med(warm.map((r) => r.actionMs)), maxMs: Math.max(...warm.map((r) => r.actionMs)), longTaskMedian: med(warm.map((r) => r.longTaskMax)), longTaskMax: Math.max(...warm.map((r) => r.longTaskMax)), maxFrameMs: Math.max(...warm.map((r) => r.maxFrameMs)), scriptMsMedian: med(warm.map((r) => r.cpu.scriptMs)), layoutMsMedian: med(warm.map((r) => r.cpu.layoutMs)), recalcMsMedian: med(warm.map((r) => r.cpu.recalcStyleMs)) }
  perf.switchRaw = sw(switches)
  check('两个大会话来回切换完成', switches.every((r) => r.messages > 0), { first: first.map((r) => r.messages) })
  await memory('after-switches')

  await switchTo(big1)
  await sleep(1500)
  const point = () => ev(`(() => { const r = document.querySelector('.v3-stream').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  const wheel = async (deltaY, count, gap = 16) => {
    const p = await point()
    for (let i = 0; i < count; i++) {
      await cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...p, deltaX: 0, deltaY })
      await sleep(gap)
    }
  }
  const scrollPhase = async (name, action) => {
    const before = await metrics()
    await ev('window.__sp.start()')
    await action()
    await sleep(800)
    const raw = await ev('window.__sp.stop()')
    const stats = scrollStats(raw)
    perf[name] = {
      frames: stats.frames, p95Ms: stats.p95Ms, maxFrameMs: stats.maxFrameMs, over33: stats.over33, over50: stats.over50,
      longTasks: stats.longTasks, maxLongMs: stats.maxLongMs, blankFrames: stats.blankFrames, relShiftFrames: stats.relShiftFrames, relShiftMaxPx: stats.relShiftMaxPx,
      cpu: cpuDelta(before, await metrics())
    }
    log(name, perf[name])
  }
  if (phases.has('scroll')) {
    await scrollPhase('scrollUp', () => wheel(-120, 120))
    await scrollPhase('scrollUpFast', () => wheel(-400, 100, 8))
    await scrollPhase('scrollDown', () => wheel(300, 120, 12))
    await memory('after-scroll')
  }
  if (!phases.has('stream')) return

  await ev(`document.querySelector('[data-testid="v3-jump"]')?.click()`)
  await sleep(1500)
  const model = await ev(`window.__yanStore.getState().setModel('fake', 'fake-model', true)`)
  check('切到假模型', model?.ok !== false, model)
  await waitFor('!s.pendingActivation && !s.peekedPath', 30000, 20)
  perf.streamBigHistory = await state('s.messages.length')
  perf.streamBigLong = await probed(() => turn('请输出 LONGTEXT', { timeout: 180000, settleMs: 0 }), 300)
  log('streamBigLong', perf.streamBigLong)
  check('大会话长文本完整', (await state(`s.messages.filter((x) => x.role === 'assistant').at(-1)?.text ?? ''`)).includes('结束。'))
  await sleep(1000)
  perf.streamBigStorm = await probed(() => turn('STEPS12 STORM-big', { timeout: 180000, settleMs: 0 }), 300)
  log('streamBigStorm', perf.streamBigStorm)
  await memory('after-stream-big')

  await newSession()
  await sleep(800)
  perf.streamShortLong = await probed(() => turn('请输出 LONGTEXT', { timeout: 180000, settleMs: 0 }), 300)
  log('streamShortLong', perf.streamShortLong)
  perf.streamShortStorm = await probed(() => turn('STEPS12 STORM-short', { timeout: 180000, settleMs: 0 }), 300)
  log('streamShortStorm', perf.streamShortStorm)
  perf.shortHistory = await state('s.messages.length')
  await memory('after-stream-short')
}
