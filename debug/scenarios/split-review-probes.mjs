import { useRealWindow } from '../lib/perf-probes.mjs'

export const meta = { description: '分屏对抗复审探针：运行中快速切换焦点时各格是否混入另一会话内容、只读格里残留的可操作控件、查找栏等单例数量、关闭分屏回单格的滚动位置，不调用真实模型' }

const SAMPLER = (tags) => `(() => {
  const tags = ${JSON.stringify(tags)};
  window.__sp = { frames: [], stop: false, start: performance.now() };
  const sample = () => {
    const t = Math.round(performance.now() - window.__sp.start);
    for (const tile of document.querySelectorAll('[data-tile-key]')) {
      const key = tile.dataset.tileKey;
      const own = tags[key];
      const other = Object.entries(tags).filter(([k]) => k !== key).map(([, v]) => v);
      const stream = [...tile.querySelectorAll('.v3-stream')].find((el) => el.clientHeight > 0) ?? tile.querySelector('.v3-conv');
      const text = stream ? stream.textContent : '';
      window.__sp.frames.push({ t, key, live: tile.dataset.live, rows: tile.querySelectorAll('.v3-msg[data-turn-id]').length, hasOwn: text.includes(own), foreign: other.some((tag) => text.includes(tag)) });
    }
    if (!window.__sp.stop) requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
})()`

export default async function run({ cdp, box, waitFor, check, report, sleep, shot, log, autoApprove, newSession, state, running, turn }) {
  const ev = (expr) => cdp.evaluate(expr)
  report.viewport = await useRealWindow(cdp, sleep, { maximize: true })
  await autoApprove()

  const refs = []
  const names = ['ALPHA', 'BRAVO']
  for (const [index, project] of [box.projects[0] ?? box.project, box.projects[1] ?? box.project].entries()) {
    await newSession(project)
    const tag = names[index]
    await turn(`${tag} FLOW SHORT first`)
    await turn(`${tag} LONGTEXT long`)
    refs.push({ sessionId: await state('s.session.sessionId'), path: await state('s.session.sessionFile') })
  }
  const tags = { [refs[0].sessionId]: names[0], [refs[1].sessionId]: names[1] }
  await ev(`window.__yanSplit.getState().apply({ tiles: ${JSON.stringify(refs)}, live: 1 })`)
  await sleep(1500)

  const clickTitle = async (ref) => {
    const point = await ev(`(() => { const el = document.querySelector('[data-tile-key="${ref.sessionId}"] .v3-split-title'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(40, r.width / 2)), y: Math.round(r.top + r.height / 2) } })()`)
    if (!point) return false
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    return true
  }

  const peerButtons = () => ev(`(() => {
    const out = {};
    for (const tile of document.querySelectorAll('[data-tile-key]')) {
      const live = tile.dataset.live;
      const conv = tile.querySelector('.v3-conv');
      out[tile.dataset.tileKey.slice(-6) + ':live' + live] = [...conv.querySelectorAll('button, [role="button"], a[href], input:not([disabled]), textarea:not([disabled]), select, summary')].map((el) => (el.dataset.testid || el.getAttribute('aria-label') || el.className.toString().slice(0, 30) || el.tagName) + (el.hasAttribute('disabled') ? '(disabled)' : '')).filter((value, index, arr) => arr.indexOf(value) === index);
    }
    return out;
  })()`)

  const idle = await peerButtons()
  report.idleButtons = idle
  log('idle-buttons', idle)

  const dupes = await ev(`(() => { const ids = {}; for (const el of document.querySelectorAll('[data-testid]')) ids[el.dataset.testid] = (ids[el.dataset.testid] ?? 0) + 1; return Object.fromEntries(Object.entries(ids).filter(([, n]) => n > 1)) })()`)
  report.duplicateTestIds = dupes
  log('duplicate-testids', dupes)

  await clickTitle(refs[0])
  await sleep(800)
  await ev(`window.__yanStore.getState().send('ALPHA STORM-A STEPS40')`)
  await waitFor(`${running}`, 20000, 20)
  await clickTitle(refs[1])
  await sleep(800)
  await ev(`window.__yanStore.getState().send('BRAVO STORM-B STEPS40')`)
  await waitFor(`${running}`, 20000, 20)

  await ev(SAMPLER(tags))
  for (let i = 0; i < 16; i++) {
    await clickTitle(refs[i % 2])
    await sleep(120 + ((i * 97) % 260))
  }
  const busy = await peerButtons()
  report.busyButtons = busy
  log('busy-buttons', busy)
  await sleep(1500)
  const frames = await ev(`(() => { window.__sp.stop = true; return window.__sp.frames })()`)
  const foreign = frames.filter((frame) => frame.foreign)
  const noOwn = frames.filter((frame) => !frame.hasOwn)
  const blank = frames.filter((frame) => frame.rows === 0)
  report.frames = { total: frames.length, foreign: foreign.length, noOwn: noOwn.length, blank: blank.length, firstForeign: foreign[0] ?? null, firstNoOwn: noOwn[0] ?? null, firstBlank: blank[0] ?? null }
  log('frames', report.frames)
  check('rapid switching: no tile shows the other session content', foreign.length === 0, report.frames)
  check('rapid switching: every tile keeps its own content', noOwn.length === 0, report.frames)
  check('rapid switching: no blank frames', blank.length === 0, report.frames)
  await shot('after-rapid')

  await waitFor(`window.__yanRuns.getState().runs.every((r) => r.phase.kind !== 'running')`, 240000, 200)
  await sleep(1000)

  await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 2 })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 2 })
  await sleep(500)
  const findCount = () => ev(`document.querySelectorAll('[data-testid="v3-session-findbar"]').length`)
  const opened = await findCount()
  await clickTitle(refs[0])
  await sleep(800)
  const afterSwitch = await findCount()
  report.finds = { opened, afterSwitch }
  log('finds', report.finds)
  check('find bar is a singleton while open', opened === 1, report.finds)
  check('find bar is not duplicated after switching focus', afterSwitch <= 1, report.finds)
  await shot('find-open')
  await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(300)

  const scrollInfo = () => ev(`(() => {
    const stream = [...document.querySelectorAll('.v3-stream')].find((el) => el.clientHeight > 0);
    if (!stream) return null;
    const top = stream.getBoundingClientRect().top;
    const block = [...stream.querySelectorAll('.v3-msg[data-turn-id] p, .v3-msg[data-turn-id] li, .v3-msg[data-turn-id] pre, .v3-msg[data-turn-id] h1, .v3-msg[data-turn-id] h2, .v3-msg[data-turn-id] h3')].find((el) => el.getBoundingClientRect().top >= top);
    return { scrollTop: Math.round(stream.scrollTop), scrollHeight: stream.scrollHeight, clientHeight: stream.clientHeight, turn: block ? block.closest('.v3-msg').dataset.turnId + ':' + block.textContent.slice(0, 40) : null, offset: block ? Math.round(block.getBoundingClientRect().top - top) : null };
  })()`)
  await ev(`(() => { const stream = [...document.querySelectorAll('[data-live="1"] .v3-stream')].find((el) => el.clientHeight > 0); stream.scrollTop = Math.round((stream.scrollHeight - stream.clientHeight) * 0.4) })()`)
  await sleep(700)
  const beforeClose = await scrollInfo()
  await ev('window.__yanSplit.getState().close()')
  await sleep(120)
  const early = await scrollInfo()
  await sleep(1500)
  const afterClose = await scrollInfo()
  report.close = { beforeClose, early, afterClose }
  log('close-split-scroll', report.close)
  check('closing split keeps reading position', !!beforeClose && !!afterClose && afterClose.turn === beforeClose.turn && Math.abs((afterClose.offset ?? 0) - (beforeClose.offset ?? 0)) <= 24, report.close)
  await shot('after-close')

  const here = await state('s.session.sessionFile')
  const other = refs.find((ref) => ref.path !== here)
  await ev(`(() => { const stream = [...document.querySelectorAll('.v3-stream')].find((el) => el.clientHeight > 0); stream.scrollTop = Math.round((stream.scrollHeight - stream.clientHeight) * 0.4) })()`)
  await sleep(700)
  const singleBefore = await scrollInfo()
  await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(other.path)})`)
  await sleep(1500)
  await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(here)})`)
  await sleep(1800)
  const singleAfter = await scrollInfo()
  report.control = { singleBefore, singleAfter }
  log('control-single-switch', report.control)
}
