import { useRealWindow } from '../lib/perf-probes.mjs'

export const meta = { description: '分屏两种渲染（焦点格与非焦点格）下同一会话的 .v3-msg 高度、行容器与内边距对比，定位锚点位移来源' }

const DUMP = `(() => {
  const out = {};
  for (const tile of document.querySelectorAll('[data-tile-key]')) {
    const stream = [...tile.querySelectorAll('.v3-stream')].find((el) => el.clientHeight > 0);
    if (!stream) continue;
    const top = stream.getBoundingClientRect().top - stream.scrollTop;
    const inner = stream.querySelector('.v3-stream-inner') ?? stream.firstElementChild;
    const cs = getComputedStyle(inner);
    const rows = [...stream.querySelectorAll('.v3-msg[data-turn-id]')].map((el) => {
      const r = el.getBoundingClientRect();
      const m = getComputedStyle(el);
      return { id: el.dataset.turnId, kind: el.className, h: Math.round(r.height * 10) / 10, y: Math.round((r.top - top) * 10) / 10, mt: m.marginTop, mb: m.marginBottom, parent: el.parentElement.className };
    });
    out[tile.dataset.pane] = { live: tile.dataset.live, streamW: stream.clientWidth, scrollH: stream.scrollHeight, padding: cs.padding, innerParent: inner.parentElement.className, rows };
  }
  return out;
})()`

export default async function run({ cdp, box, runDir, waitFor, check, report, sleep, shot, log, autoApprove, newSession, state, turn }) {
  const ev = (expr) => cdp.evaluate(expr)
  report.viewport = await useRealWindow(cdp, sleep, { maximize: true })
  await autoApprove()
  const sessions = []
  for (const [index, project] of [box.projects[0] ?? box.project, box.projects[1] ?? box.project].entries()) {
    await newSession(project)
    const tag = index ? 'B' : 'A'
    await turn(`FLOW SHORT ${tag}1 \u5148\u770b\u770b\u9879\u76ee`)
    await turn(`MANYTOOLS ${tag}2 \u8dd1\u56db\u5341\u6b65`, { timeout: 180000 })
    await turn(`FLOW ${tag}3 \u4fee\u590d\u91d1\u989d`)
    await turn(`LONGTEXT ${tag}4 \u957f\u6587`)
    sessions.push({ sessionId: await state('s.session.sessionId'), path: await state('s.session.sessionFile') })
  }
  await ev(`window.__yanSplit.getState().apply({ tiles: ${JSON.stringify(sessions)}, live: 1 })`)
  await sleep(2500)
  const first = await ev(DUMP)
  const keys = await ev(`[...document.querySelectorAll('[data-tile-key]')].map((el) => ({ key: el.dataset.tileKey, live: el.dataset.live }))`)
  const left = keys.find((item) => item.live === '0').key
  const point = await ev(`(() => { const el = document.querySelector('[data-tile-key="${left}"] .v3-split-title'); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) } })()`)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await sleep(2500)
  const second = await ev(DUMP)
  report.first = first
  report.second = second
  const diffs = {}
  for (const pane of Object.keys(first)) {
    const a = first[pane]
    const b = second[pane]
    if (!b) continue
    const byId = new Map(b.rows.map((row) => [row.id, row]))
    diffs[pane] = { liveA: a.live, liveB: b.live, scrollH: [a.scrollH, b.scrollH], padding: [a.padding, b.padding], width: [a.streamW, b.streamW], parents: [a.innerParent, b.innerParent], rows: a.rows.map((row) => { const o = byId.get(row.id); return o ? { id: row.id, kind: row.kind, dh: Math.round((o.h - row.h) * 10) / 10, dy: Math.round((o.y - row.y) * 10) / 10 } : null }).filter((x) => x && (x.dh || x.dy)) }
  }
  report.diffs = diffs
  log('diffs', diffs)
}
