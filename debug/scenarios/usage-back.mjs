export const meta = { description: '用量页顶栏返回：按钮命中区不被隐藏标题或拖动层覆盖，点击能回到聊天' }

export default async function run({ cdp, check, state, sleep }) {
  await cdp.evaluate(`window.__yanStore.getState()`)
  await cdp.evaluate(`window.location.hash = '#/usage'`)
  await sleep(600)
  check('进入用量页', await cdp.evaluate(`!!document.querySelector('[data-testid="usage-details"]')`))

  const box = await cdp.evaluate(`(() => {
    const back = document.querySelector('[data-testid="v3-back"]')
    const title = document.querySelector('.v3-head-title')
    if (!back || !title) return null
    const a = back.getBoundingClientRect()
    const b = title.getBoundingClientRect()
    const overlap = !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top)
    const hits = [[0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9], [0.5, 0.5]].map(([fx, fy]) => {
      const x = a.left + a.width * fx
      const y = a.top + a.height * fy
      const hit = document.elementFromPoint(x, y)
      return { x: Math.round(x), y: Math.round(y), inside: !!hit && back.contains(hit), id: hit ? (hit.closest('[data-testid]')?.getAttribute('data-testid') ?? hit.tagName) : null }
    })
    return {
      back: { left: a.left, top: a.top, width: a.width, height: a.height },
      title: { left: b.left, top: b.top, width: b.width, height: b.height },
      titleRegion: getComputedStyle(title).getPropertyValue('-webkit-app-region'),
      headRegion: getComputedStyle(document.querySelector('.v3-head')).getPropertyValue('-webkit-app-region'),
      overlap,
      hits
    }
  })()`)
  check('用量页有返回按钮', !!box, box)
  if (!box) return
  check('隐藏标题不与返回按钮重叠', !box.overlap, { title: box.title, back: box.back })
  check('隐藏标题不是拖动区', box.titleRegion !== 'drag', { titleRegion: box.titleRegion, headRegion: box.headRegion })
  check('返回按钮九个方向的命中都是按钮本身', box.hits.every((hit) => hit.inside), box.hits)

  const x = box.back.left + box.back.width / 2
  const y = box.back.top + box.back.height / 2
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(400)
  check('点击后离开用量页', !(await cdp.evaluate(`!!document.querySelector('[data-testid="usage-details"]')`)), await cdp.evaluate('location.hash'))
  check('连接仍然正常', (await state('s.conn')) === 'ready', await state('s.conn'))
}
