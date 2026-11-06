export const meta = { description: '流式回合的跳动与闪烁：假模型 FLOW，逐帧记录过程区高度、思考行/活动行位置与存在、答复首段位置、滚动位置，并列出布局位移来源，不调用模型' }

const PROBE = `(() => {
  const f = window.__jit = { t0: performance.now(), frames: [], shifts: [], marks: [] }
  const now = () => Math.round(performance.now() - f.t0)
  const cls = (n) => { const el = n && n.nodeType === 1 ? n : n && n.parentElement; return el ? (typeof el.className === 'string' ? el.className.split(' ')[0] : el.tagName) : String(n) }
  new PerformanceObserver((list) => { for (const e of list.getEntries()) f.shifts.push({ t: Math.round(e.startTime - f.t0), v: +e.value.toFixed(4), src: (e.sources || []).slice(0, 3).map((s) => cls(s.node) + ' dy=' + Math.round(s.currentRect.top - s.previousRect.top)) }) } ).observe({ type: 'layout-shift' })
  const tick = () => {
    const stream = document.querySelector('.v3-stream')
    const msgs = stream ? stream.querySelectorAll('.v3-msg.assistant') : []
    const msg = msgs[msgs.length - 1]
    const base = stream ? stream.getBoundingClientRect().top : 0
    const rel = (el) => el ? Math.round(el.getBoundingClientRect().top - base) : null
    const proc = msg ? msg.querySelector('[data-testid="v3-process"]') : null
    const head = proc ? proc.querySelector('.v3-process-head') : null
    const body = proc ? proc.querySelector('.v3-process-body') : null
    const act = msg ? msg.querySelector('.v3-act') : null
    const seg = msg ? msg.querySelector('.v3-seg') : null
    const cs = act ? getComputedStyle(act) : null
    if (seg && !f.segHtml) f.segHtml = seg.outerHTML.slice(0, 600)
    f.frames.push({ t: now(), st: stream ? Math.round(stream.scrollTop) : null, sh: stream ? stream.scrollHeight : null, proc: rel(proc), procH: proc ? Math.round(proc.getBoundingClientRect().height) : null, open: proc ? proc.hasAttribute('data-open') : null, live: proc ? proc.hasAttribute('data-live') : null, head: rel(head), bodyH: body ? Math.round(body.getBoundingClientRect().height) : null, minH: body ? body.style.minHeight : null, stage: body ? body.dataset.stage ?? '' : null, act: rel(act), actOp: cs ? +cs.opacity : null, seg: rel(seg), segH: seg ? Math.round(seg.getBoundingClientRect().height) : null, msgH: msg ? Math.round(msg.getBoundingClientRect().height) : null })
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  const st = window.__yanStore
  let running = false
  st.subscribe((s) => { const r = !!(s.session && (s.session.isStreaming || s.session.isAgentRunning)); if (r !== running) { running = r; f.marks.push({ t: now(), kind: r ? 'run' : 'done' }) } const last = s.messages[s.messages.length - 1]; const tl = !!(last && last.role === 'assistant' && last.thinkingLive); if (f.tl !== tl) { f.tl = tl; f.marks.push({ t: now(), kind: tl ? 'think' : 'think-end' }) } })
  return true
})()`

export default async function run({ cdp, box, check, report, sleep, newSession, turn, autoApprove, log }) {
  const ev = (expr) => cdp.evaluate(expr)
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1500, height: 940, deviceScaleFactor: 1, mobile: false })
  await autoApprove()
  await newSession(box.projects[0] ?? box.project)
  await ev(PROBE)
  const trigger = process.env.JIT_TRIGGER ?? 'FLOW'
  await turn(trigger + ' 先看看项目，然后修复金额', { timeout: 120000 })
  await sleep(1500)
  const data = await ev('window.__jit')
  report.marks = data.marks
  console.log('SEGHTML ' + data.segHtml)
  const fr = data.frames
  const keys = ['st', 'sh', 'proc', 'procH', 'open', 'live', 'head', 'bodyH', 'minH', 'stage', 'act', 'actOp', 'seg', 'segH', 'msgH']
  const changes = []
  fr.forEach((f, i) => {
    if (!i) return
    const p = fr[i - 1]
    const diff = keys.filter((k) => f[k] !== p[k]).map((k) => k + ':' + p[k] + '>' + f[k])
    if (diff.length) changes.push(f.t + 'ms ' + diff.join(' '))
  })
  console.log('MARKS ' + JSON.stringify(data.marks))
  console.log('SHIFTS ' + data.shifts.filter((s) => s.v > 0.0005).map((s) => s.t + 'ms v=' + s.v + ' ' + s.src.join(',')).join(' | '))
  console.log('FRAMES ' + fr.length)
  console.log('CHANGES\n' + changes.slice(0, 400).join('\n'))
  const actFlick = []
  fr.forEach((f, i) => { const p = fr[i - 1]; if (p && (f.act === null) !== (p.act === null)) actFlick.push(f.t + (f.act === null ? ' act removed' : ' act added')) })
  console.log('ACT ' + actFlick.join(' | '))
  report.shiftCount = data.shifts.length
  const flashes = []
  fr.forEach((f, i) => {
    if (i && fr[i - 1].seg === null && f.seg !== null) {
      const gone = fr.slice(i).find((g) => g.seg === null)
      if (gone && gone.t - f.t < 300) flashes.push(f.t + '>' + gone.t)
    }
  })
  check('过渡中的叙述不会在答复区闪现', flashes.length === 0, flashes)
  const shrinks = fr.filter((f, i) => i && f.live === true && fr[i - 1].live === true && f.procH !== null && fr[i - 1].procH !== null && f.procH < fr[i - 1].procH - 1)
  check('直播期过程区高度只增不缩', shrinks.length === 0, shrinks.slice(0, 5).map((f) => f.t))
  const endAt = fr.findIndex((f, i) => i && fr[i - 1].live === true && f.live === false)
  let maxStep = 0
  for (let i = Math.max(1, endAt); i < Math.min(fr.length, endAt + 60); i += 1) if (fr[i].seg !== null && fr[i - 1].seg !== null && fr[i].st === fr[i - 1].st) maxStep = Math.max(maxStep, Math.abs(fr[i].seg - fr[i - 1].seg))
  report.collapseMaxStepPx = maxStep
  check('回合结束过程区收起时答复首段逐帧位移不超过 12px', endAt < 0 || maxStep <= 12, { maxStep })
}
