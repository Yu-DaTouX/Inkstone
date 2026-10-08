/*
 * 左栏会话拖进工作区：左半边 / 右半边落点（`npm run test:live -- splitdrop`，合成会话）。
 *
 * 用合成 PointerEvent 走和手拖同一条路径：pointerdown（会话行）→ pointermove（越过阈值）→
 * pointermove（落点）→ pointerup。验：拖动中两个落点都在、指针所在的那一半高亮；
 * 松手后会话放在那一侧（左 = 主会话位，右 = 旁边）；两侧的会话与焦点符合预期。
 */
;(async () => {
  const out = []
  const ok = (c, s) => { out.push((c ? '  ✓ ' : '  ✗ ') + s); return !!c }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore
  const split = window.__yanSplit
  const st = store.getState()
  st.closeSettings?.()
  st.setRailPinned?.(true)
  const now = Date.now()
  const cwd = st.session?.cwd || 'C:/fixture/demo'
  const mk = (id, title, ago) => ({ id, path: `C:/fixture/sd/${id}.jsonl`, cwd, title, named: true, scope: 'global', createdAt: now - ago, updatedAt: now - ago, lastActivityAt: now - ago, messageCount: 4, lastOpenedAt: now - ago })
  const fx = [mk('sd-a', '拖拽测试甲', 60_000), mk('sd-b', '拖拽测试乙', 120_000), mk('sd-c', '拖拽测试丙', 180_000)]
  store.setState({ sessions: [...st.sessions.filter((s) => !s.id.startsWith('sd-')), ...fx] })
  split.getState().close()
  await sleep(600)

  const pointer = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, isPrimary: true, pointerType: 'mouse' }))
  const rowOf = (id) => [...document.querySelectorAll(`[data-session-path$="${id}.jsonl"] .srow`)][0]
  const canvas = document.querySelector('.tile-workspace-canvas')
  if (!canvas) return out.concat('  ✗ 没有工作区画布').join('\n')

  /* 落点：每块磁贴的左半 / 右半；按「第几个落点」取指针位置（现算，磁贴数会变） */
  const zoneSpot = (i) => {
    const z = document.querySelectorAll('[data-split-at]')[i]
    const r = z?.getBoundingClientRect()
    return r ? [r.left + r.width / 2, r.top + r.height / 2] : null
  }
  const frames = () => [...document.querySelectorAll('.tile-frame.primary')].map((el) => el.getBoundingClientRect()).sort((x, y) => x.left - y.left)
  const spotOf = (tile, half) => { const r = frames()[tile]; return [r.left + r.width * (half === 'left' ? 0.25 : 0.75), r.top + r.height * 0.5] }

  const drag = async (id, tile, half) => {
    const row = rowOf(id)
    if (!row) { ok(false, `找不到会话行 ${id}`); return false }
    const r = row.getBoundingClientRect()
    const sx = r.left + 40, sy = r.top + r.height / 2
    const [px, py] = spotOf(tile, half)
    pointer(row, 'pointerdown', sx, sy)
    pointer(window, 'pointermove', sx + 30, sy + 10)
    pointer(window, 'pointermove', px, py)
    await sleep(200)
    const zones = document.querySelectorAll('[data-split-at]')
    ok(zones.length === frames().length * 2, `拖动中每块磁贴有左右两个落点（${zones.length}）`)
    ok(document.querySelectorAll('.split-drop.over').length === 1, '只有指针所在的那一个落点高亮')
    pointer(window, 'pointerup', px, py)
    await sleep(500)
    return true
  }
  const ids = () => split.getState().split?.tiles.map((t) => t.sessionId) ?? []

  const cur = () => store.getState().session?.sessionId
  const first = cur()
  await drag('sd-a', 0, 'right')
  ok(ids().join() === [first, 'sd-a'].join() && split.getState().split?.live === 0, '放到右半：拖进来的在右，当前会话留在左')
  await drag('sd-b', 0, 'left')
  ok(ids()[0] === 'sd-b' && ids().length === 3 && split.getState().split?.live === 1, '放到最左：成为第三块，插在最前，焦点跟着原会话')
  ok(!document.querySelector('[data-split-at]'), '松手后落点消失')
  await sleep(500)
  ok(document.querySelectorAll('.tile-frame.primary').length === 3, '工作区里有三块会话磁贴')
  await drag('sd-c', 2, 'right')
  ok(ids()[3] === 'sd-c' && ids().length === 4, '放到最右：追加成第四块')
  split.getState().close()
  await sleep(300)
  await drag('sd-c', 0, 'left')
  ok(ids()[0] === 'sd-c' && split.getState().split?.live === 1, '没分屏时直接放到左侧：拖进来的在左，当前会话在右并保持焦点')
  split.getState().close()
  return out.join('\n')
})()
