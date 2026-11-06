import { useRealWindow } from '../lib/perf-probes.mjs'

export const meta = { description: '分屏格目标换了会话（侧栏选了不在分屏里的会话）后，同一格是否残留上一个会话的只读历史：冷会话 A 先作为非焦点格读取历史，聚焦后再从侧栏选冷会话 C，逐帧检查该格是否出现 A 的内容，不调用真实模型' }

const SAMPLER = (own, foreign) => `(() => {
  window.__sh = { frames: [], stop: false, start: performance.now() };
  const sample = () => {
    const t = Math.round(performance.now() - window.__sh.start);
    for (const tile of document.querySelectorAll('[data-tile-key]')) {
      const stream = [...tile.querySelectorAll('.v3-stream')].find((el) => el.clientHeight > 0) ?? tile.querySelector('.v3-conv');
      const text = stream ? stream.textContent : '';
      window.__sh.frames.push({ t, key: tile.dataset.tileKey, live: tile.dataset.live, pane: tile.dataset.pane, view: tile.querySelector('.v3-session')?.dataset.viewKey?.slice(-12) ?? null, ro: !!tile.querySelector('.v3-split-peer'), foreign: ${JSON.stringify(foreign)}.filter((tag) => text.includes(tag)), own: text.includes(${JSON.stringify(own)}), rows: tile.querySelectorAll('.v3-msg[data-turn-id]').length });
    }
    if (!window.__sh.stop) requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
})()`

export default async function run({ cdp, box, check, report, sleep, shot, log, autoApprove, newSession, state, turn }) {
  const ev = (expr) => cdp.evaluate(expr)
  report.viewport = await useRealWindow(cdp, sleep, { maximize: true })
  await autoApprove()

  const refs = []
  const names = ['ALPHA', 'BRAVO', 'CHARLIE']
  for (const [index, name] of names.entries()) {
    await newSession(box.projects[index % 2] ?? box.project)
    await turn(`${name} FLOW SHORT first`)
    refs.push({ sessionId: await state('s.session.sessionId'), path: await state('s.session.sessionFile') })
  }
  const clickTitle = async (ref) => {
    const point = await ev(`(() => { const el = document.querySelector('[data-tile-key="${ref.sessionId}"] .v3-split-title'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(40, r.width / 2)), y: Math.round(r.top + r.height / 2) } })()`)
    if (!point) return false
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    return true
  }

  await ev(`window.__yanStore.setState({ sessionRuntimes: {} })`)
  await ev(`window.__yanSplit.getState().apply({ tiles: ${JSON.stringify([refs[0], refs[1]])}, live: 1 })`)
  await sleep(2000)
  const cached = await ev(`Object.keys(window.__yanStore.getState().sessionRuntimes).map((k) => k.slice(-6))`)
  log('runtimes-after-split', cached)
  await clickTitle(refs[0])
  await sleep(1500)
  log('focused-A', await ev(`[...document.querySelectorAll('[data-tile-key]')].map((el) => ({ key: el.dataset.tileKey.slice(-6), live: el.dataset.live }))`))

  await ev(`window.__yanStore.setState({ sessionRuntimes: Object.fromEntries(Object.entries(window.__yanStore.getState().sessionRuntimes).filter(([k]) => k !== ${JSON.stringify(refs[2].sessionId)})) })`)
  await ev(SAMPLER('CHARLIE', ['ALPHA', 'BRAVO']))
  await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(refs[2].path)})`)
  await sleep(3000)
  const frames = await ev(`(() => { window.__sh.stop = true; return window.__sh.frames })()`)
  const liveFrames = frames.filter((frame) => frame.live === '1')
  const wrong = liveFrames.filter((frame) => frame.foreign.length > 0)
  const summary = { total: frames.length, liveFrames: liveFrames.length, wrongFrames: wrong.length, first: wrong[0] ?? null, last: wrong.at(-1) ?? null, tiles: [...new Set(frames.map((frame) => frame.key.slice(-6) + '/live' + frame.live))] }
  report.summary = summary
  log('summary', summary)
  check('the pane the sidebar session lands in never shows another session history', wrong.length === 0, summary)
  await shot('after-sidebar-switch')
}
