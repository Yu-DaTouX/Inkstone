import { useRealWindow } from '../lib/perf-probes.mjs'

export const meta = { description: '分屏各格的会话级附注归属：给两个会话设置不同的分支来源，核对每格只显示自己会话的分支来源行（焦点格与非焦点格），不调用真实模型' }

export default async function run({ cdp, box, check, report, sleep, shot, log, autoApprove, newSession, state, turn }) {
  const ev = (expr) => cdp.evaluate(expr)
  report.viewport = await useRealWindow(cdp, sleep, { maximize: true })
  await autoApprove()
  const refs = []
  for (const [index, name] of ['ALPHA', 'BRAVO'].entries()) {
    await newSession(box.projects[index % 2] ?? box.project)
    await turn(`${name} FLOW SHORT first`)
    refs.push({ sessionId: await state('s.session.sessionId'), path: await state('s.session.sessionFile') })
  }
  const origins = { [refs[0].sessionId]: 'ORIGIN-OF-ALPHA', [refs[1].sessionId]: '' }
  const applyOrigins = (map) => ev(`window.__yanStore.setState((s) => ({ sessions: s.sessions.map((item) => item.id in ${JSON.stringify(map)} ? { ...item, branchOrigin: ${JSON.stringify(map)}[item.id] || undefined } : item) }))`)
  await applyOrigins(origins)
  await ev(`window.__yanSplit.getState().apply({ tiles: ${JSON.stringify(refs)}, live: 1 })`)
  await sleep(1500)
  const read = () => ev(`Object.fromEntries([...document.querySelectorAll('[data-tile-key]')].map((tile) => [tile.dataset.tileKey, { live: tile.dataset.live, origin: tile.querySelector('[data-testid="v3-branch-summary"]')?.textContent ?? null }]))`)
  await applyOrigins(origins)
  await sleep(500)
  const first = await read()
  log('alpha-has-origin, bravo-live', first)
  check('peer pane of a branched session shows its own branch origin', first[refs[0].sessionId]?.origin?.includes('ORIGIN-OF-ALPHA') === true, first)
  check('live pane of a plain session shows no branch origin', first[refs[1].sessionId]?.origin === null, first)

  const clickTitle = async (ref) => {
    const point = await ev(`(() => { const el = document.querySelector('[data-tile-key="${ref.sessionId}"] .v3-split-title'); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(40, r.width / 2)), y: Math.round(r.top + r.height / 2) } })()`)
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  }
  await clickTitle(refs[0])
  await sleep(2000)
  await applyOrigins(origins)
  await sleep(500)
  const second = await read()
  log('alpha-live', second)
  check('after focusing the branched session its pane shows the origin', second[refs[0].sessionId]?.origin?.includes('ORIGIN-OF-ALPHA') === true, second)
  check('the now-peer plain session pane shows no branch origin', second[refs[1].sessionId]?.origin === null, second)
  await shot('origins')

  await applyOrigins({ [refs[0].sessionId]: '', [refs[1].sessionId]: 'ORIGIN-OF-BRAVO' })
  await sleep(500)
  const third = await read()
  log('bravo-origin-alpha-live', third)
  check('a plain focused session does not inherit the other pane origin', third[refs[0].sessionId]?.origin === null, third)
  check('the peer pane shows its own origin and not another one', third[refs[1].sessionId]?.origin?.includes('ORIGIN-OF-BRAVO') === true && !third[refs[1].sessionId]?.origin?.includes('ALPHA'), third)
  await shot('origins-3')
}
