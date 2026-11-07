import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const meta = { description: '回合结束前后逐帧记录答复各段与过程区的位置（真实模型用 --real-model，假模型默认），结束后答复首段不得位移' }

const PROBE = `(() => {
  window.__ef = []
  let on = true
  window.__efStop = () => { on = false }
  const tick = () => {
    if (!on) return
    const s = window.__yanStore.getState()
    const stream = document.querySelector('.v3-stream')
    const msgs = stream ? stream.querySelectorAll('.v3-msg.assistant') : []
    const msg = msgs[msgs.length - 1]
    const base = stream ? stream.getBoundingClientRect().top : 0
    const top = (el) => Math.round((el.getBoundingClientRect().top - base) * 10) / 10
    const segs = msg ? [...msg.querySelectorAll('.v3-prose')].map((el) => ({ k: (el.closest('[data-seg-id]')?.getAttribute('data-seg-id') ?? el.closest('.v3-process') ? 'in-process' : 'free') + ':' + (el.textContent ?? '').slice(0, 12), top: top(el), h: Math.round(el.getBoundingClientRect().height) })) : []
    const proc = msg ? msg.querySelector('[data-testid="v3-process"]') : null
    const panel = proc ? proc.querySelector('.ui-collapsible__panel') : null
    const leave = proc ? proc.querySelector('.v3-process-leave') : null
    const reply = msg ? [...msg.querySelectorAll('.v3-prose')].at(-1) : null
    const chain = []
    for (let el = reply; el && el !== msg?.parentElement; el = el.parentElement) { const prev = el.previousElementSibling; chain.push((el.className && typeof el.className === 'string' ? el.className.split(' ')[0] : el.tagName) + '@' + top(el) + (prev ? '|prev:' + (typeof prev.className === 'string' ? prev.className.split(' ')[0] : prev.tagName) + ':' + Math.round(prev.getBoundingClientRect().height) + ':' + (prev.getAttribute('style') ?? '') : '')) }
    const sg = reply ? reply.closest('.v3-seg') : null
    const scs = sg ? getComputedStyle(sg) : null
    const pr = sg && sg.previousElementSibling ? sg.previousElementSibling.getBoundingClientRect() : null
    const body = sg ? sg.parentElement : null
    window.__ef.push({ sty: scs ? [scs.marginTop, scs.translate, scs.transform, scs.paddingTop, body ? getComputedStyle(body).rowGap : null, pr ? Math.round(pr.bottom - base) : null, sg ? sg.parentElement.children.length : null].join('/') : null, chain, t: Math.round(performance.now()), running: !!(s.session?.isStreaming || s.session?.isAgentRunning), st: stream ? Math.round(stream.scrollTop) : null, segs, procTop: proc ? top(proc) : null, procH: proc ? Math.round(proc.getBoundingClientRect().height * 10) / 10 : null, panelH: panel ? Math.round(panel.getBoundingClientRect().height * 10) / 10 : null, leaveH: leave ? Math.round(leave.getBoundingClientRect().height * 10) / 10 : 0, live: proc ? proc.hasAttribute('data-live') : null })
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  return true
})()`

export default async function run({ cdp, check, sleep, newSession, live, box, out, log, autoApprove }) {
  const ev = (expr) => cdp.evaluate(expr)
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1500, height: Number(process.env.EF_H ?? 2600), deviceScaleFactor: 1, mobile: false })
  if (autoApprove) await autoApprove()
  await newSession(box.project)
  await ev(PROBE)
  const prompt = process.env.EF_PROMPT ?? '读一下 README.md、INCIDENT.md 和 docs/REPORTING.md，然后用三四句话概括这个项目要解决什么问题。'
  await live(prompt, { timeout: 300000, settleMs: 1500 })
  await sleep(1500)
  const frames = await ev('window.__ef')
  await ev('window.__efStop()')
  const end = frames.findIndex((f, i) => i > 0 && frames[i - 1].running && !f.running)
  writeFileSync(join(out, 'stream-end-frames.json'), JSON.stringify(frames))
  const last = (f) => f.segs[f.segs.length - 1]
  let worst = 0
  const window5 = end >= 0 ? frames.slice(Math.max(0, end - 5), end + 40) : []
  for (let i = 1; i < window5.length; i++) {
    const a = window5[i - 1]
    const b = window5[i]
    if (a.st !== b.st) continue
    const keys = b.segs.map((s) => s.k).filter((k) => a.segs.some((s) => s.k === k))
    for (const k of keys) {
      const d = Math.abs(b.segs.find((s) => s.k === k).top - a.segs.find((s) => s.k === k).top)
      if (d > 12) { worst = Math.max(worst, d); console.log('JUMP ' + k + ' ' + d + ' at +' + (b.t - frames[end].t) + 'ms') }
    }
  }
  const lastTops = window5.map((f) => (last(f) ? last(f).top : null))
  console.log('END ' + end + ' frames ' + frames.length)
  console.log('PROC ' + window5.slice(0, 20).map((f) => [f.running ? 'R' : 'D', f.procH, f.panelH, f.leaveH, last(f)?.top].join('/')).join(' '))
  log('结束帧', { frames: frames.length, end, worst, lastTops: lastTops.slice(0, 30) })
  check('答复结束前后各段位置不跳（滚动不变时 单帧 ≤12px）', end >= 0 && worst === 0, { worst })
}
