import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const meta = { description: '消息流跳动与顺序：假模型 FLOW（慢思考、夹叙述的 bash、慢参数、长答案），记录 layout-shift、发送横移、标题变化与叙述顺序，连拍完成瞬间' }

const PROBE = `(() => {
  if (window.__flow) return true
  const st = window.__yanStore
  const f = window.__flow = { t0: performance.now(), shifts: [], marks: [], labels: [], answer: [], composer: [] }
  const now = () => Math.round(performance.now() - f.t0)
  const describe = (node) => {
    if (!node || !node.closest) return String(node && node.nodeName)
    const el = node.nodeType === 1 ? node : node.parentElement
    if (!el) return node.nodeName
    const tagged = el.closest('[data-testid]')
    return (el.className && typeof el.className === 'string' ? el.className.split(' ')[0] : el.tagName.toLowerCase()) + (tagged ? '@' + tagged.dataset.testid : '')
  }
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      f.shifts.push({ t: Math.round(e.startTime - f.t0), value: e.value, input: e.hadRecentInput, sources: (e.sources || []).slice(0, 4).map((s) => ({ node: describe(s.node), dy: Math.round(s.currentRect.y - s.previousRect.y), dx: Math.round(s.currentRect.x - s.previousRect.x), dh: Math.round(s.currentRect.height - s.previousRect.height) })) })
    }
  }).observe({ type: 'layout-shift', buffered: false })
  let live = null
  let running = false
  let thinkingLive = false
  st.subscribe((s) => {
    const r = !!(s.session && (s.session.isStreaming || s.session.isAgentRunning))
    if (r !== running) { running = r; f.marks.push({ t: now(), kind: r ? 'run' : 'done' }) }
    const last = s.messages[s.messages.length - 1]
    const tl = !!(last && last.role === 'assistant' && last.thinkingLive)
    if (tl !== thinkingLive) { thinkingLive = tl; f.marks.push({ t: now(), kind: tl ? 'think' : 'think-end' }) }
  })
  const lastRow = new Map()
  let answerY = null
  let composerX = null
  const tick = () => {
    const heads = document.querySelectorAll('.v3-msg.assistant .v3-seg h2')
    const head = heads[heads.length - 1]
    const y = head ? Math.round(head.getBoundingClientRect().top) : null
    if (y !== answerY) { answerY = y; f.answer.push({ t: now(), y }) }
    const comp = document.querySelector('.v3-composer .composer')
    const cx = comp ? Math.round(comp.getBoundingClientRect().x * 10) / 10 : null
    if (cx !== composerX) { composerX = cx; f.composer.push({ t: now(), x: cx }) }
    const rows = document.querySelectorAll('.v3-process-body [data-testid=v3-step], .v3-process-body [data-testid=v3-step-group]')
    rows.forEach((row, index) => {
      const text = row.querySelector('.v3-step-line')?.textContent ?? ''
      const key = index
      if (lastRow.get(key) !== text) { lastRow.set(key, text); f.labels.push({ t: now(), row: index, text }) }
    })
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  return true
})()`

const GEOMETRY = `(() => {
  const rect = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
  const chat = rect('.v3-chat')
  const greet = rect('.v3-empty-greet')
  const composer = rect('.v3-composer .composer')
  const mid = (r) => r ? r.x + r.w / 2 : null
  const home = chat && greet ? { greetOffset: Math.round((mid(greet) - mid(chat)) * 10) / 10, composerOffset: composer ? Math.round((mid(composer) - mid(chat)) * 10) / 10 : null, chatX: chat.x, chatW: chat.w } : null
  return { home, composer, user: rect('.v3-msg.user .v3-bubble'), sessionbar: !!document.querySelector('[data-testid=v3-sessionbar]'), win: { w: innerWidth, h: innerHeight } }
})()`

function maxMove(xs) {
  let move = 0
  for (const s of xs) for (const src of s.sources) if (!/^v3-side|^ui-|^v3-head/.test(src.node)) move = Math.max(move, Math.abs(src.dy), Math.abs(src.dx))
  return move
}

function maxStep(trace, key, from, to) {
  let worst = 0
  for (let i = 1; i < trace.length; i++) {
    const a = trace[i - 1]
    const b = trace[i]
    if (b.t < from || b.t > to || a[key] === null || b[key] === null) continue
    worst = Math.max(worst, Math.abs(b[key] - a[key]))
  }
  return Math.round(worst * 10) / 10
}

function maxRate(trace, key, from, to) {
  let worst = 0
  for (let i = 1; i < trace.length; i++) {
    const a = trace[i - 1]
    const b = trace[i]
    if (b.t < from || b.t > to || a[key] === null || b[key] === null) continue
    worst = Math.max(worst, Math.abs(b[key] - a[key]) / Math.max(b.t - a.t, 16.7) * 16.7)
  }
  return Math.round(worst * 10) / 10
}

function summarize(flow, from = -Infinity, to = Infinity) {
  const xs = flow.shifts.filter((s) => !s.input && s.t >= from && s.t <= to)
  return { count: xs.length, total: +xs.reduce((a, s) => a + s.value, 0).toFixed(4), max: +Math.max(0, ...xs.map((s) => s.value)).toFixed(4), maxMovePx: maxMove(xs) }
}

function labelFlicker(labels) {
  const byRow = new Map()
  for (const item of labels) {
    if (!byRow.has(item.row)) byRow.set(item.row, [])
    byRow.get(item.row).push(item)
  }
  let worst = 0
  for (const list of byRow.values()) {
    for (let i = 0; i < list.length; i++) {
      let n = 1
      for (let j = i + 1; j < list.length && list[j].t - list[i].t <= 300; j++) n++
      worst = Math.max(worst, n)
    }
  }
  return worst
}

export default async function run({ cdp, newSession, check, sleep, shot, report, runDir, state, waitFor, autoApprove }) {
  const tag = process.env.FLOW_TAG || 'run'
  const short = process.env.FLOW_SHORT === '1'
  const burstDir = join(runDir, `burst-${tag}`)
  mkdirSync(burstDir, { recursive: true })
  const ev = (expr) => cdp.evaluate(expr)
  await autoApprove()
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN', reduceMotion: false })`)
  await newSession()
  let width = 0
  let stableSince = Date.now()
  for (const stop = Date.now() + 15000; Date.now() < stop;) {
    const w = await ev('innerWidth')
    if (w !== width) { width = w; stableSince = Date.now() }
    if (Date.now() - stableSince > 2000) break
    await sleep(200)
  }
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'light' })`)
  await sleep(500)
  await shot(`${tag}-00-home-light`)
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark' })`)
  await sleep(500)
  await ev(PROBE)
  const before = await ev(GEOMETRY)
  await shot(`${tag}-00-home`)
  await ev(`window.__flow.marks.push({ t: Math.round(performance.now() - window.__flow.t0), kind: 'send' })`)
  const sent = await ev(`window.__yanStore.getState().send(${JSON.stringify(short ? '请处理 FLOW SHORT 演示任务' : '请处理 FLOW 演示任务')})`)
  if (sent === false) throw new Error('发送失败')
  const sendDir = join(runDir, `burst-send-${tag}`)
  mkdirSync(sendDir, { recursive: true })
  const noBurst = process.env.FLOW_NOBURST === '1'
  if (noBurst) await sleep(1200)
  for (let i = 0, stop = noBurst ? 0 : Date.now() + 1200; Date.now() < stop; i++) {
    const res = await cdp.call('Page.captureScreenshot', { format: 'jpeg', quality: 70 })
    writeFileSync(join(sendDir, `${String(i).padStart(3, '0')}.jpg`), Buffer.from(res.result.data, 'base64'))
  }
  const after = await ev(GEOMETRY)
  await shot(`${tag}-01-after-send`)
  report.geometry = { before, after }

  let liveOrder = null
  let shotThinking = false
  let shotThinkEnd = false
  let burst = 0
  let doneAt = 0
  const scrolled = process.env.FLOW_SCROLLED === '1'
  let scrolledUp = 0
  const end = Date.now() + 120000
  while (Date.now() < end) {
    const snap = await state(`(() => { const r = !!(s.session?.isStreaming || s.session?.isAgentRunning); const last = s.messages.at(-1); return { r, think: !!last?.thinkingLive, tools: s.messages.reduce((a, m) => a + (m.toolCalls?.length ?? 0), 0), answer: (last?.text ?? '').includes('修复结果'), mid: (last?.text ?? '').includes('第 22 项') } })()`)
    if (snap.think && !shotThinking && snap.tools >= 1) { shotThinking = true; await shot(`${tag}-02-thinking-live`) }
    if (!snap.think && shotThinking && !shotThinkEnd && snap.tools >= 1) { shotThinkEnd = true; await shot(`${tag}-03-thinking-ended`) }
    if (!liveOrder && snap.tools >= 3) {
      liveOrder = await ev(`(() => { const t = document.querySelector('.v3-process')?.innerText ?? ''; return { a: t.indexOf('读取 README'), b: t.indexOf('开始修复金额精度') } })()`)
    }
    if (scrolled && snap.mid && !scrolledUp) {
      scrolledUp = await ev(`(() => { const el = document.querySelector('.v3-stream'); el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true })); el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 60); window.__flow.marks.push({ t: Math.round(performance.now() - window.__flow.t0), kind: 'scroll-up', top: el.scrollTop }); return Math.round(el.scrollHeight - el.clientHeight - el.scrollTop) })()`)
    }
    if (!noBurst && (snap.answer || (!snap.r && snap.tools >= 4))) {
      const file = join(burstDir, `${String(burst).padStart(3, '0')}.png`)
      const res = await cdp.call('Page.captureScreenshot', { format: 'jpeg', quality: 70 })
      writeFileSync(file.replace(/png$/, 'jpg'), Buffer.from(res.result.data, 'base64'))
      burst++
    }
    if (!snap.r && snap.tools >= 4) {
      if (!doneAt) doneAt = Date.now()
      if (Date.now() - doneAt > 1200) break
    }
    await sleep(snap.answer ? 0 : 60)
  }
  await sleep(600)
  await shot(`${tag}-04-done-dark`)
  const flow = await ev('window.__flow')
  const send = flow.marks.find((m) => m.kind === 'send')?.t ?? 0
  const done = flow.marks.filter((m) => m.kind === 'done').at(-1)?.t ?? Infinity
  const thinkEnds = flow.marks.filter((m) => m.kind === 'think-end').map((m) => m.t)
  const answerBefore = flow.answer.filter((a) => a.t < done).at(-1)?.y ?? null
  const answerAfter = flow.answer.filter((a) => a.t <= done + 1500).at(-1)?.y ?? null
  const nearThinkEnd = flow.shifts.filter((s) => !s.input && thinkEnds.some((t) => s.t >= t - 50 && s.t <= t + 400))
  const midRun = flow.shifts.filter((s) => !s.input && s.t > send + 1500 && s.t < done - 100)
  report.motion = {
    all: summarize(flow),
    send: summarize(flow, send, send + 1500),
    thinkEnd: { count: nearThinkEnd.length, total: +nearThinkEnd.reduce((a, s) => a + s.value, 0).toFixed(4), max: +Math.max(0, ...nearThinkEnd.map((s) => s.value)).toFixed(4), maxMovePx: maxMove(nearThinkEnd) },
    running: { count: midRun.length, total: +midRun.reduce((a, s) => a + s.value, 0).toFixed(4), max: +Math.max(0, ...midRun.map((s) => s.value)).toFixed(4), maxMovePx: maxMove(midRun) },
    done: summarize(flow, done - 100, done + 1200),
    labelChangesWithin300ms: labelFlicker(flow.labels),
    answerMoveAtDone: answerBefore !== null && answerAfter !== null ? answerAfter - answerBefore : null,
    composerShiftX: before.composer && after.composer ? after.composer.x - before.composer.x : null,
    composerMaxFrameStepX: maxStep(flow.composer, 'x', send, send + 1500),
    composerMaxRateX: maxRate(flow.composer, 'x', send, send + 1500),
    composerStepsX: flow.composer.filter((c) => c.t >= send && c.t <= send + 1500).length,
    answerMaxFrameStepAtDone: maxStep(flow.answer, 'y', done, done + 1200),
    answerMaxRateAtDone: maxRate(flow.answer, 'y', done, done + 1200),
    answerStepsAtDone: flow.answer.filter((a) => a.t >= done && a.t <= done + 1200).length,
    homeGreetOffset: before.home?.greetOffset ?? null,
    homeComposerOffset: before.home?.composerOffset ?? null,
    scrolledUp
  }
  report.liveOrder = liveOrder
  const heldAfterDone = await ev(`!!document.querySelector('.v3-msg.assistant [data-testid=v3-process-body]')`)
  const blankAfterDone = await ev(`(() => { const b = document.querySelector('.v3-msg.assistant [data-testid=v3-process-body]'); return b ? b.style.minHeight || '' : '' })()`)
  await ev(`window.__yanStore.getState().send('你好')`)
  await waitFor(`s.messages.filter((m) => m.role === 'user').length >= 2 && !(s.session?.isStreaming || s.session?.isAgentRunning)`, 30000)
  await sleep(600)
  const heldAfterNext = await ev(`!!document.querySelector('.v3-msg.assistant [data-testid=v3-process-body]')`)
  report.held = { heldAfterDone, heldAfterNext, blankAfterDone }
  await ev(`document.querySelector('[data-testid=v3-process-toggle]')?.click()`)
  await sleep(500)
  await ev(`document.querySelector('[data-testid=v3-process]')?.scrollIntoView({ block: 'start' })`)
  await sleep(300)
  const doneOrder = await ev(`(() => { const t = document.querySelector('.v3-process')?.innerText ?? ''; return { a: t.indexOf('读取 README'), b: t.indexOf('开始修复金额精度') } })()`)
  report.doneOrder = doneOrder
  await shot(`${tag}-05-expanded-dark`)
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'light' })`)
  await sleep(500)
  await shot(`${tag}-06-expanded-light`)
  await ev(`document.querySelector('[data-testid=v3-process-toggle]')?.click()`)
  await sleep(400)
  await shot(`${tag}-07-done-light`)
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark' })`)
  report.flow = flow
  writeFileSync(join(runDir, `flow-${tag}.json`), JSON.stringify({ motion: report.motion, geometry: report.geometry, liveOrder, doneOrder, flow }, null, 2))
  check('叙述按时间顺序（运行中）', !!liveOrder && liveOrder.a >= 0 && liveOrder.b > liveOrder.a, liveOrder)
  check('叙述按时间顺序（结束后展开）', doneOrder.a >= 0 && doneOrder.b > doneOrder.a, doneOrder)
  check('回合结束即收起，不留占位', !report.held.heldAfterDone && !report.held.blankAfterDone, report.held)
  check('首页居中（与原版一致，偏差不超过 6px）', Math.abs(report.motion.homeGreetOffset ?? 99) <= 6 && Math.abs(report.motion.homeComposerOffset ?? 99) <= 6, { greet: report.motion.homeGreetOffset, composer: report.motion.homeComposerOffset })
  check('发送后输入框横向无硬跳（每 16.7ms 不超过 12px）', report.motion.composerMaxRateX <= 12, { rate: report.motion.composerMaxRateX, step: report.motion.composerMaxFrameStepX, steps: report.motion.composerStepsX })
  check('完成瞬间答案无硬跳（每 16.7ms 不超过 12px）', report.motion.answerMaxRateAtDone <= 12, { rate: report.motion.answerMaxRateAtDone, step: report.motion.answerMaxFrameStepAtDone, move: report.motion.answerMoveAtDone })
  check('同一行 0.3 秒内换字不超过 2 次', report.motion.labelChangesWithin300ms <= 2, report.motion.labelChangesWithin300ms)
  console.log(JSON.stringify(report.motion, null, 2))
}
