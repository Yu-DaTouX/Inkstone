/**
 * 左栏收起时的悬停预览：指针停在标题栏开关上，左栏以浮层滑出，不推挤中栏；
 * 离开后收回；点击开关才固定展开。
 */
;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? '  ' + extra : ''))
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  if (!store) return '  ⤺ 跳过：没有 window.__yanStore（探针没被注入）'
  const hover = (el, inside) => {
    const type = inside ? 'pointerover' : 'pointerout'
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, relatedTarget: inside ? document.body : document.body, pointerType: 'mouse' }))
  }

  store.getState().setRailPinned(false)
  await sleep(300)
  const app = q('.app')
  const toggle = q('[data-testid="rail-toggle"]')
  const slot = q('.rail-slot')
  ok(!!app && !!toggle && !!slot, '应用外壳、开关与左栏槽都在')
  ok(app.classList.contains('rail-off') && !app.classList.contains('rail-peek'), '收起态默认没有预览')
  const centerBox = () => q('.tile-workspace')?.getBoundingClientRect()
  const center0 = centerBox()
  ok(!!center0 && center0.width > 300, '收起时中栏有可用宽度', `width=${Math.round(center0?.width ?? 0)}`)
  ok(slot.getBoundingClientRect().width === 0, '收起时左栏槽是 0 宽', `width=${slot.getBoundingClientRect().width}`)

  hover(toggle, true)
  await sleep(450)
  ok(app.classList.contains('rail-peek'), '指针停在开关上 → 进入预览')
  const rail = q('.rail')
  const w = rail ? rail.getBoundingClientRect().width : 0
  ok(w >= 200, '预览时左栏有完整宽度', `width=${Math.round(w)}`)
  ok(!!rail && getComputedStyle(rail).display !== 'none' && getComputedStyle(rail).visibility === 'visible', '预览时左栏内容可见')
  const center1 = centerBox()
  ok(!!center1 && Math.round(center1.left) === Math.round(center0.left) && Math.round(center1.width) === Math.round(center0.width), '预览不推挤中栏，也不让它消失', `${Math.round(center0.left)}/${Math.round(center0.width)} → ${Math.round(center1?.left ?? -1)}/${Math.round(center1?.width ?? 0)}`)
  const rb = rail.getBoundingClientRect()
  const hit = document.elementFromPoint(rb.left + 40, rb.top + 120)
  ok(!!hit?.closest('.rail'), '预览的左栏盖在中栏之上、可点击')
  ok(store.getState().railPinned === false, '预览不改变固定状态')

  hover(toggle, false)
  await sleep(500)
  ok(!app.classList.contains('rail-peek'), '指针离开 → 收回预览')

  hover(toggle, true)
  await sleep(450)
  ok(app.classList.contains('rail-peek'), '再次悬停可再次预览')
  toggle.click()
  await sleep(350)
  ok(store.getState().railPinned === true && !app.classList.contains('rail-off') && !app.classList.contains('rail-peek'), '点击开关 → 固定展开并清掉预览态')

  store.getState().setRailPinned(true)
  return out.join('\n')
})()
