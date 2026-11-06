import { useRealWindow } from '../lib/perf-probes.mjs'

export const meta = { description: '大会话（走虚拟列表）分屏时，非焦点格被点击变成焦点格后阅读位置是否位移：逐行记录切换前后的行高与锚点偏移，找出位移来自哪些行，不调用真实模型' }

const SNAP = (key) => `(() => {
  const tile = [...document.querySelectorAll('[data-tile-key]')].find((el) => el.dataset.tileKey === ${JSON.stringify(key)});
  const stream = [...tile.querySelectorAll('.v3-stream')].find((el) => el.clientHeight > 0);
  const top = stream.getBoundingClientRect().top;
  const rows = [...stream.querySelectorAll('.v3-msg[data-turn-id]')].map((el) => ({ id: el.dataset.turnId, kind: el.classList.contains('assistant') ? 'a' : 'u', h: Math.round(el.getBoundingClientRect().height), y: Math.round(el.getBoundingClientRect().top - top), tools: el.dataset.tools ?? null, html: el.innerHTML.length }));
  return { live: tile.dataset.live, scrollTop: Math.round(stream.scrollTop), sh: stream.scrollHeight, ch: stream.clientHeight, rows, virtual: !!tile.querySelector('[data-virtual], .v3-vlist'), kids: [...stream.querySelectorAll(':scope > *, :scope > * > *')].map((el) => (el.className || el.tagName).toString().slice(0, 40) + '@' + Math.round(el.getBoundingClientRect().height) + (el.style.height ? '/' + el.style.height : '') + (el.style.paddingBottom ? '/pb' + el.style.paddingBottom : '')) };
})()`

export default async function run({ cdp, box, waitFor, check, report, sleep, shot, log, autoApprove, newSession, state, turn }) {
  const ev = (expr) => cdp.evaluate(expr)
  report.viewport = await useRealWindow(cdp, sleep, { maximize: true })
  await autoApprove()
  const refs = []
  for (const [index, project] of [box.projects[0] ?? box.project, box.projects[1] ?? box.project].entries()) {
    await newSession(project)
    const tag = index ? 'B' : 'A'
    for (let i = 0; i < 6; i++) await turn(`MANYTOOLS ${tag}${i} go`, { timeout: 180000 })
    log('messages', await state('s.messages.length'))
    refs.push({ sessionId: await state('s.session.sessionId'), path: await state('s.session.sessionFile') })
  }
  await ev(`window.__yanSplit.getState().apply({ tiles: ${JSON.stringify(refs)}, live: 1 })`)
  await sleep(2000)
  const peerKey = refs[0].sessionId
  const liveKey = refs[1].sessionId
  for (const key of [peerKey, liveKey]) {
    await ev(`(() => { const tile = [...document.querySelectorAll('[data-tile-key]')].find((el) => el.dataset.tileKey === ${JSON.stringify(key)}); const stream = [...tile.querySelectorAll('.v3-stream')].find((el) => el.clientHeight > 0); stream.scrollTop = Math.round((stream.scrollHeight - stream.clientHeight) * 0.35) })()`)
  }
  await sleep(1200)
  const before = await ev(SNAP(peerKey))
  const beforeLive = await ev(SNAP(liveKey))
  const point = await ev(`(() => { const el = document.querySelector('[data-tile-key="${peerKey}"] .v3-split-title'); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(40, r.width / 2)), y: Math.round(r.top + r.height / 2) } })()`)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await waitFor(`document.querySelector('[data-tile-key="${peerKey}"]')?.dataset.live === '1' && !s.switchLoading`, 15000, 10)
  await sleep(2000)
  const after = await ev(SNAP(peerKey))
  const afterLive = await ev(SNAP(liveKey))
  const diffRows = (a, b) => a.rows.flatMap((row) => { const other = b.rows.find((item) => item.id === row.id); return other && (other.h !== row.h) ? [{ id: row.id, kind: row.kind, from: row.h, to: other.h, tools: row.tools }] : [] })
  const result = {
    gained: { scrollTop: [before.scrollTop, after.scrollTop], sh: [before.sh, after.sh], rowCount: [before.rows.length, after.rows.length], changed: diffRows(before, after) },
    lost: { scrollTop: [beforeLive.scrollTop, afterLive.scrollTop], sh: [beforeLive.sh, afterLive.sh], rowCount: [beforeLive.rows.length, afterLive.rows.length], changed: diffRows(beforeLive, afterLive) }
  }
  result.kids = { before: before.kids, after: after.kids, lostBefore: beforeLive.kids, lostAfter: afterLive.kids }
  report.result = result
  log('result', result)
  const anchorOf = (snap) => snap.rows.find((row) => row.y + row.h > 20)
  const a0 = anchorOf(before)
  const a1 = after.rows.find((row) => row.id === a0?.id)
  const moved = a0 && a1 ? a1.y - a0.y : null
  report.anchorMoved = moved
  check('pane that gains focus keeps its reading position (anchor moves <= 24px)', moved !== null && Math.abs(moved) <= 24, { moved, a0, a1 })
  await shot('after-focus-switch')
}
