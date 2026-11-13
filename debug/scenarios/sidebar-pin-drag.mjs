export const meta = { description: '左栏把活跃会话向上拖进置顶区：被拖卡片必须跟着指针上移，松手后变为置顶' }

export default async function run({ cdp, sleep, waitFor, newSession, turn, check, shot, log }) {
  const ev = (expr) => cdp.evaluate(expr)
  await newSession()
  await turn('first session')
  await newSession()
  await turn('second session')
  await waitFor('s.sessions.length >= 2', 30000, 50)
  await ev(`window.__yanStore.getState().patchSettings({ sidebarLayout: 'flat', reduceMotion: false })`)
  await sleep(1200)

  const sessions = await ev(`window.__yanStore.getState().sessions.map((x) => ({ id: x.id, path: x.path }))`)
  const rows = async () => ev(`[...document.querySelectorAll('[data-sidebar-row]')].filter((n) => n.dataset.sidebarRow.startsWith('local:')).map((n) => { const b = n.getBoundingClientRect(); return { key: n.dataset.sidebarRow, x: b.left + b.width / 2, y: b.top + b.height / 2, top: b.top, bottom: b.bottom } })`)
  const before = await rows()
  check('列表里有两个会话行', before.length >= 2, before.length)
  if (before.length < 2) return

  const pinTarget = before[0]
  const pinnedId = await ev(`(() => { const s = window.__yanStore.getState(); const row = document.querySelector('[data-sidebar-row="${pinTarget.key}"]'); return s.sessions.find((x) => row.dataset.sessionPath && x.path === row.dataset.sessionPath)?.id ?? null })()`)
  check('取得要先置顶的会话', !!pinnedId, pinnedId)
  await ev(`window.__yanStore.getState().setSessionPinned(${JSON.stringify(pinnedId)}, true)`)
  await sleep(1500)

  const after = await rows()
  const pinned = after.find((row) => row.key === pinTarget.key)
  const dragged = after.find((row) => row.key !== pinTarget.key)
  const move = (x, y) => cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
  const topOf = (key) => ev(`document.querySelector('[data-sidebar-row="${key}"]').getBoundingClientRect().top`)

  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragged.x, y: dragged.y })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, x: dragged.x, y: dragged.y })
  const tops = []
  const stops = [dragged.y - 14, pinned.bottom + 8, pinned.y + 10]
  let y = dragged.y
  for (const stop of stops) {
    for (let i = 1; i <= 6; i++) {
      await move(dragged.x, y + ((stop - y) * i) / 6)
      await sleep(40)
    }
    y = stop
    await sleep(350)
    tops.push(Math.round(await topOf(dragged.key)))
  }
  await shot('pin-drag-hover')
  log('dragged top per stop', tops, 'start', Math.round(dragged.top))
  check('被拖卡片随指针上移（不被固定在原位）', tops[2] < tops[0] - 20 && tops[2] < dragged.top - 20, { start: Math.round(dragged.top), tops })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, x: dragged.x, y })
  await sleep(1200)

  const pinnedCount = await ev(`window.__yanStore.getState().sessions.filter((x) => x.pinned).length`)
  check('松手后两个会话都已置顶', pinnedCount === 2, pinnedCount)
  void sessions
}
