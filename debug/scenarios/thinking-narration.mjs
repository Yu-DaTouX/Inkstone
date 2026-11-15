export const meta = { anthropic: true, description: 'Opus 5.5 式旁白：假 Anthropic 模型把进度说明写成签名为 narration 的思考块，逐帧记录旁白先在思考行、块结束后改判到正文的过程，查闪烁、重复与过程区抖动，不调用真实模型' }

const PHRASES = ['先看看项目结构', '金额用浮点累加']

const PROBE = `(() => {
  const phrases = ${JSON.stringify(PHRASES)}
  const f = window.__narr = { t0: performance.now(), frames: [], shifts: [], marks: [] }
  const now = () => Math.round(performance.now() - f.t0)
  new PerformanceObserver((list) => { for (const e of list.getEntries()) f.shifts.push({ t: Math.round(e.startTime - f.t0), v: +e.value.toFixed(4) }) }).observe({ type: 'layout-shift' })
  const outside = (root) => {
    let text = ''
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) text += child.nodeValue
        else if (child.nodeType === 1 && !child.matches('[data-testid="v3-thinking"], [data-testid="v3-thinking-aside"]')) walk(child)
      }
    }
    walk(root)
    return text
  }
  const tick = () => {
    const stream = document.querySelector('.v3-stream')
    const msgs = stream ? stream.querySelectorAll('.v3-msg.assistant') : []
    const msg = msgs[msgs.length - 1]
    const thinkEls = msg ? [...msg.querySelectorAll('[data-testid="v3-thinking"], [data-testid="v3-thinking-aside"]')] : []
    const think = thinkEls.filter((el) => !el.closest('[aria-hidden="true"]')).map((el) => el.textContent).join('|')
    const closing = thinkEls.filter((el) => el.closest('[aria-hidden="true"]')).map((el) => el.textContent).join('|')
    const body = msg ? outside(msg) : ''
    const proc = msg ? msg.querySelector('[data-testid="v3-process"]') : null
    if (!f.bothHtml && msg && phrases.some((p) => body.includes(p) && think.includes(p))) {
      const el = thinkEls.filter((node) => !node.closest('[aria-hidden="true"]')).find((node) => phrases.some((p) => node.textContent.includes(p)))
      const chain = []
      for (let node = el; node && node !== msg; node = node.parentElement) chain.push(node.tagName + '.' + String(node.className).split(' ').join('.') + (node.dataset.live !== undefined ? '[live]' : ''))
      const holder = [...msg.querySelectorAll('*')].filter((node) => !node.closest('[data-testid="v3-thinking"]') && phrases.some((p) => node.textContent.includes(p))).at(-1)
      const bodyChain = []
      for (let node = holder; node && node !== msg; node = node.parentElement) bodyChain.push(node.tagName + '.' + String(node.className).split(' ').join('.'))
      f.bothHtml = { chain, bodyChain, t: now() }
    }
    f.frames.push({ t: now(), body: phrases.map((p) => body.includes(p)), think: phrases.map((p) => think.includes(p)), closing: phrases.map((p) => closing.includes(p)), live: proc ? proc.hasAttribute('data-live') : null, procH: proc ? Math.round(proc.getBoundingClientRect().height) : null, msgH: msg ? Math.round(msg.getBoundingClientRect().height) : null })
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  const st = window.__yanStore
  let running = false
  const seen = {}
  st.subscribe((s) => {
    const r = !!(s.session && (s.session.isStreaming || s.session.isAgentRunning))
    if (r !== running) { running = r; f.marks.push({ t: now(), kind: r ? 'run' : 'done' }) }
    for (const m of s.messages) {
      if (m.role !== 'assistant') continue
      phrases.forEach((p, i) => {
        if (!seen['think' + i] && (m.thinking ?? '').includes(p)) { seen['think' + i] = 1; f.marks.push({ t: now(), kind: 'store-think-' + i }) }
        if (!seen['text' + i] && (m.text ?? '').includes(p)) { seen['text' + i] = 1; f.marks.push({ t: now(), kind: 'store-text-' + i }) }
        if (seen['think' + i] && !seen['unthink' + i] && (m.text ?? '').includes(p) && !(m.thinking ?? '').includes(p)) { seen['unthink' + i] = 1; f.marks.push({ t: now(), kind: 'store-unthink-' + i }) }
      })
    }
  })
  return true
})()`

export default async function run({ cdp, check, report, sleep, newSession, turn, autoApprove, waitFor, shot }) {
  const ev = (expr) => cdp.evaluate(expr)
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1500, height: 940, deviceScaleFactor: 1, mobile: false })
  await autoApprove()
  await newSession()
  await ev(`window.__yanStore.getState().setModel('fake-anthropic', 'fake-narration')`)
  await waitFor(`s.session?.model?.id === 'fake-narration'`, 15000)
  await ev(PROBE)
  let flipShot = false
  await turn('NARRATE 先看看项目，然后修复金额', {
    timeout: 120000,
    during: async () => {
      if (await cdp.evaluate(`(window.__narr.marks || []).some((m) => m.kind === 'store-text-0')`).catch(() => false)) return
      for (let i = 0; i < 200; i++) {
        if (await cdp.evaluate(`(window.__narr.marks || []).some((m) => m.kind === 'store-text-0')`)) break
        await sleep(25)
      }
      await sleep(300)
      await shot('narration-flip')
      flipShot = true
    }
  })
  await sleep(800)
  await shot('narration-done')
  const data = await ev('({ frames: window.__narr.frames, marks: window.__narr.marks, shifts: window.__narr.shifts, bothHtml: window.__narr.bothHtml })')
  if (data.bothHtml) console.log('BOTH ' + JSON.stringify(data.bothHtml))
  const messages = await ev(`window.__yanStore.getState().messages.filter((m) => m.role === 'assistant').map((m) => ({ text: m.text, thinking: m.thinking ?? '' }))`)
  report.marks = data.marks
  const doneAt = data.marks.find((m) => m.kind === 'done')?.t ?? Infinity
  const frames = data.frames.filter((f) => f.t < doneAt)
  check('截到改判后的画面', flipShot)
  PHRASES.forEach((phrase, i) => {
    const owner = messages.find((m) => m.text.includes(phrase) || m.thinking.includes(phrase))
    check(`旁白 ${i + 1} 最终在正文、不在思考里`, !!owner && owner.text.includes(phrase) && !owner.thinking.includes(phrase), owner)
    const thinkAt = data.marks.find((m) => m.kind === `store-think-${i}`)?.t
    const textAt = data.marks.find((m) => m.kind === `store-text-${i}`)?.t
    const peeked = frames.filter((f) => f.think[i] && !f.body[i]).length
    check(`旁白 ${i + 1} 块结束前先按思考显示，签名到了再改判`, thinkAt !== undefined && textAt !== undefined && thinkAt < textAt && peeked > 0, { thinkAt, textAt, peekedFrames: peeked })
    const first = frames.findIndex((f) => f.body[i])
    const vanished = first < 0 ? [] : frames.slice(first).filter((f) => !f.body[i]).map((f) => f.t)
    check(`旁白 ${i + 1} 出现在正文后直播期间不再消失（无闪烁）`, first >= 0 && vanished.length === 0, vanished.slice(0, 5))
    const both = frames.filter((f) => f.body[i] && f.think[i]).map((f) => f.t)
    check(`旁白 ${i + 1} 不同时出现在可见的思考行和正文里`, both.length === 0, { frames: both.length, from: both[0], to: both.at(-1) })
    const closingFrames = frames.filter((f) => f.body[i] && f.closing[i]).map((f) => f.t)
    report[`closingOverlap${i + 1}`] = { frames: closingFrames.length, from: closingFrames[0], to: closingFrames.at(-1) }
  })
  const steadyFor = (i) => {
    let j = i - 1
    while (j > 0 && frames[j - 1].procH === frames[i - 1].procH) j -= 1
    return frames[i - 1].t - frames[j].t
  }
  const shrinks = frames.map((f, i) => ({ f, i })).filter(({ f, i }) => i && f.live === true && frames[i - 1].live === true && f.procH !== null && frames[i - 1].procH !== null && f.procH < frames[i - 1].procH - 1)
  report.liveShrinks = shrinks.map(({ f, i }) => ({ t: f.t, by: frames[i - 1].procH - f.procH, steadyMs: steadyFor(i) }))
  check('改判时过程区不来回抖：高度稳定 1 秒以上才收回留白', shrinks.every(({ i }) => steadyFor(i) >= 1000), report.liveShrinks.slice(0, 5))
  report.shifts = data.shifts.filter((s) => s.v > 0.0005 && s.t < doneAt)
  console.log('MARKS ' + JSON.stringify(data.marks))
  console.log('SHIFTS ' + JSON.stringify(report.shifts))
  await newSession()
  await ev(`window.__yanStore.getState().setModel('fake', 'fake-model')`)
  await waitFor(`s.session?.model?.id === 'fake-model'`, 15000)
  await ev(PROBE)
  await turn('FLOW SHORT 先看看项目，然后修复金额', { timeout: 120000 })
  const flow = await ev('window.__narr.frames')
  const flowOverlap = flow.filter((f) => f.body[0] && f.closing[0]).map((f) => f.t)
  report.flowClosingOverlap = { frames: flowOverlap.length, from: flowOverlap[0], to: flowOverlap.at(-1) }
  console.log('OVERLAP narration ' + JSON.stringify(report.closingOverlap1) + ' text-block ' + JSON.stringify(report.flowClosingOverlap))
}
