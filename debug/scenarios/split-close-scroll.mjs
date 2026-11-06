import { useRealWindow } from '../lib/perf-probes.mjs'

export const meta = { description: '分屏焦点切换后在焦点格滚到中段，再关闭分屏回到单格：阅读位置应保持（按段落锚点比较），并核对滚动在切换焦点后是否被拉回底部，不调用真实模型' }

const INFO = `(() => {
  const live = [...document.querySelectorAll('[data-live="1"] .v3-stream')].find((el) => el.clientHeight > 0);
  const stream = live ?? [...document.querySelectorAll('.v3-stream')].find((el) => el.clientHeight > 0);
  if (!stream) return null;
  const top = stream.getBoundingClientRect().top;
  const block = [...stream.querySelectorAll('.v3-msg[data-turn-id] li, .v3-msg[data-turn-id] p')].find((el) => el.getBoundingClientRect().top >= top + 10);
  return { scrollTop: Math.round(stream.scrollTop), sh: stream.scrollHeight, ch: stream.clientHeight, text: block ? block.textContent.slice(0, 30) : null, offset: block ? Math.round(block.getBoundingClientRect().top - top) : null };
})()`

export default async function run({ cdp, box, check, report, sleep, shot, log, autoApprove, newSession, state, turn }) {
  const ev = (expr) => cdp.evaluate(expr)
  report.viewport = await useRealWindow(cdp, sleep, { maximize: true })
  await autoApprove()
  const refs = []
  for (const [index, name] of ['ALPHA', 'BRAVO'].entries()) {
    await newSession(box.projects[index % 2] ?? box.project)
    await turn(`${name} LONGTEXT long`)
    refs.push({ sessionId: await state('s.session.sessionId'), path: await state('s.session.sessionFile') })
  }
  await ev(`window.__yanSplit.getState().apply({ tiles: ${JSON.stringify(refs)}, live: 1 })`)
  await sleep(1500)
  const clickTitle = async (ref) => {
    const point = await ev(`(() => { const el = document.querySelector('[data-tile-key="${ref.sessionId}"] .v3-split-title'); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(40, r.width / 2)), y: Math.round(r.top + r.height / 2) } })()`)
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  }
  const trial = async (label) => {
    const box = await ev(`(() => { const stream = [...document.querySelectorAll('[data-live="1"] .v3-stream')].find((el) => el.clientHeight > 0); const r = stream.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
    for (let i = 0; i < 12; i++) {
      await cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: -400 })
      await sleep(30)
    }
    const out = []
    for (const wait of [50, 300, 700, 1500]) {
      await sleep(wait)
      out.push(await ev(INFO))
    }
    log(label, out)
    return out
  }
  const control = await trial('scroll-before-switch')
  report.control = control
  check('control: scrolling the initially focused pane sticks', control.at(-1).scrollTop < (control.at(-1).sh - control.at(-1).ch) * 0.75, control)
  await clickTitle(refs[0])
  await sleep(1500)
  const samples = await trial('scroll-after-switch')
  report.afterScroll = samples
  const settled = samples.at(-1)
  check('scrolling to the middle of the focused pane sticks', !!settled && settled.scrollTop < (settled.sh - settled.ch) * 0.75, samples)
  await ev('window.__yanSplit.getState().close()')
  const closeSamples = []
  for (const wait of [100, 400, 1000, 2000]) {
    await sleep(wait)
    closeSamples.push(await ev(INFO))
  }
  report.afterClose = closeSamples
  log('after-close', closeSamples)
  const last = closeSamples.at(-1)
  check('closing the split keeps the same paragraph at the top', !!settled && !!last && last.text === settled.text, { settled, last })
  await shot('after-close')
}
