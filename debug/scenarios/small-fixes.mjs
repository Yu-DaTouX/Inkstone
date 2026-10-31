import { mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const EVIDENCE = 'E:/pi-desktop/.local-docs/evidence/2026-10-31-small-fixes'

export const meta = { demo: true, description: '更改页顶栏不重叠、额度行无信息图标、环境分支行计数对齐、侧栏开关位置一致的截图与度量' }

const WIDTHS = [340, 360, 420, 640]

export default async function run({ cdp, check, sleep, waitFor, box, log }) {
  mkdirSync(EVIDENCE, { recursive: true })
  const shot = (name) => cdp.shot(`sf-${name}`, EVIDENCE)
  const key = (k, code, vk) => cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk })
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1000, deviceScaleFactor: 1, mobile: false })
  await cdp.evaluate(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN', rightPanelOpen: true })`)
  await waitFor(`!!document.querySelector('[data-testid=wb-rail-branch]')`, 20000)
  await sleep(600)

  const rowRight = await cdp.evaluate(`(() => {
    const rects = [...document.querySelectorAll('.ui-rail-row')].map((row) => { const v = row.querySelector('.ui-rail-row__value'); const main = row.querySelector('.ui-rail-row__main'); return v ? { text: row.innerText.slice(0, 12), right: Math.round(v.getBoundingClientRect().right), li: Math.round(row.getBoundingClientRect().right), main: Math.round(main.getBoundingClientRect().right), btn: main.className.includes('ui-btn') } : null }).filter(Boolean)
    return rects
  })()`)
  const branchRow = rowRight.find((r) => /main|·/.test(r.text)) ?? rowRight[0]
  log('dbg', await cdp.evaluate(`(() => { const li = document.querySelector('[data-testid=wb-rail-branch]').closest('li'); const m = li.querySelector('.ui-rail-row__main'); return { m1: m.matches(".ui-rail-row[data-action-reveal='hover'] > .ui-btn.ui-rail-row__main"), m2: li.matches('.ui-rail-row:not(:has(> .ui-rail-row__action))'), fileMr: getComputedStyle(document.querySelectorAll('.ui-rail-row__main')[3] || m).marginRight, attr: li.getAttribute('data-action-reveal'), mr: getComputedStyle(m).marginRight, cls: m.className, parent: m.parentElement === li } })()`))
  check('环境各行数值右边缘一致', new Set(rowRight.map((r) => r.right)).size === 1, rowRight)
  await shot('overview-dark')
  await cdp.evaluate(`document.querySelector('[data-testid=wb-rail-branch]').closest('li').scrollIntoView()`)
  const rowBox = await cdp.evaluate(`(() => { const r = document.querySelector('[data-testid=wb-rail-branch]').closest('li').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rowBox.x + rowBox.w / 2, y: rowBox.y + rowBox.h / 2 })
  await sleep(300)
  await shot('overview-branch-hover')

  const toggle = async (label) => {
    const r = await cdp.evaluate(`(() => { const vis = (e) => e && e.getBoundingClientRect().width > 0 && getComputedStyle(e).visibility !== 'hidden'; const a = document.querySelector('[data-testid=v3-side-close]'); const el = vis(a) && a.getBoundingClientRect().x >= 0 ? a : document.querySelector('[data-testid=v3-rail-toggle]'); const b = el.getBoundingClientRect(); return { id: el.dataset.testid, x: b.x, y: b.y, w: b.width, h: b.height } })()`)
    await shot(`toggle-${label}`)
    return r
  }
  const open = await toggle('open')
  await cdp.evaluate(`window.__yanUiV3?.getState().setSidebarOpen(false)`)
  await sleep(700)
  const closed = await toggle('closed')
  check('侧栏开关展开/收起坐标一致', open.x === closed.x && open.y === closed.y && open.w === closed.w, { open, closed })
  await cdp.evaluate(`window.__yanUiV3?.getState().setSidebarOpen(true)`)
  await sleep(500)

  execFileSync('git', ['-C', box.project, 'checkout', '-q', '-b', 'feature/reconciliation-long-branch-name'])
  await cdp.evaluate(`window.__yanStore.getState().patchSettings({ lang: 'en-US' })`)
  await sleep(1500)
  await cdp.evaluate(`window.__yanRightPanel.getState().open({ id: 'changes', kind: 'changes' })`)
  await sleep(1200)
  for (const width of WIDTHS) {
    await cdp.evaluate(`document.querySelectorAll('[style*="--rp-w"]').forEach((el) => el.style.setProperty('--rp-w', '${width}px'))`)
    await sleep(500)
    const m = await cdp.evaluate(`(() => {
      const sub = document.querySelector('.rp-surface:not([hidden]) .rp-sub')
      const title = sub?.querySelector('.rp-sub-title'); const tools = sub?.querySelector('.rp-sub-tools')
      if (!title || !tools) return null
      const t = tools.getBoundingClientRect()
      const items = [...title.querySelectorAll('.changes-pane__title > *')].map((el) => { const r = el.getBoundingClientRect(); return { c: el.className.toString().slice(0, 30), l: Math.round(r.left), r: Math.round(r.right), vis: getComputedStyle(el).display !== 'none' && r.width > 0 } }).filter((i) => i.vis)
      let overlap = false
      for (let i = 1; i < items.length; i++) if (items[i].l < items[i - 1].r - 1) overlap = true
      const last = items[items.length - 1]
      if (last && last.r > t.left + 1) overlap = true
      return { width: Math.round(sub.getBoundingClientRect().width), toolsLeft: Math.round(t.left), toolsW: Math.round(t.width), items, overlap }
    })()`)
    check(`更改页顶栏 ${width}px 不重叠`, m && !m.overlap, m)
    await shot(`changes-${width}`)
  }

  const HOUR = 3600_000, DAY = 24 * HOUR, now = Date.now()
  const win = (id, label, used, durationMs, leftMs, extra = {}) => ({ id, label, used, total: 100, durationMs, resetAt: now + leftMs, ...extra })
  const data = { checkedAt: now, cards: [
    { key: 'a', source: 'yan', provider: 'openai-codex', name: 'main', label: '主号', email: 'main@example.com', plan: 'pro', active: true, switchable: true, status: 'ok', checkedAt: now, windows: [win('5h', '5 小时', 0, 5 * HOUR, 3 * HOUR), win('weekly', '每周', 71, 7 * DAY, 2 * DAY)] },
    { key: 'b', source: 'yan', provider: 'openai-codex', name: 'alt', label: '备用', email: 'b@example.com', plan: 'plus', switchable: true, status: 'ok', checkedAt: now, windows: [win('5h', '五小时', 8, 5 * HOUR, 4 * HOUR, { forecast: { kind: 'sampling', needMs: 15 * 60_000 } }), win('weekly', '本周', 12, 7 * DAY, 5 * DAY, { forecast: { kind: 'uncertain' } })] },
    { key: 'c', source: 'claude-code', provider: 'anthropic', name: 'claude', email: 'me@example.com', plan: 'max', status: 'ok', checkedAt: now, windows: [win('5h', '5 小时', 55, 5 * HOUR, 2 * HOUR), win('monthly', '本月', 40, 30 * DAY, 12 * DAY, { estimated: true })] }
  ] }
  await cdp.evaluate(`window.__yanRightPanel.getState().open({ id: 'quota', kind: 'quota' })`)
  await sleep(800)
  const injected = await cdp.evaluate(`(() => {
    const root = document.querySelector('[data-testid="v3-wb-quota"]')
    if (!root) return 'no-root'
    const key = Object.keys(root).find((k) => k.startsWith('__reactFiber'))
    let fiber = root[key]
    while (fiber && !(fiber.memoizedState && fiber.type && typeof fiber.type === 'function' && fiber.type.name === 'QuotaPane')) fiber = fiber.return
    if (!fiber) return 'no-fiber'
    const setters = []
    for (let hook = fiber.memoizedState; hook; hook = hook.next) if (hook.queue && typeof hook.queue.dispatch === 'function') setters.push(hook.queue.dispatch)
    setters[0](${JSON.stringify(data)})
    setters[2]('')
    return 'ok'
  })()`)
  check('额度数据注入', injected === 'ok', injected)
  await sleep(700)
  for (const width of [360, 640]) {
    await cdp.evaluate(`document.querySelectorAll('[style*="--rp-w"]').forEach((el) => el.style.setProperty('--rp-w', '${width}px'))`)
    await sleep(500)
    const q = await cdp.evaluate(`(() => {
      const card = document.querySelector('[data-testid="v3-wb-quota"]')
      const rows = [...card.querySelectorAll('.quota-win[data-detail]')]
      const rights = rows.map((r) => Math.round(r.querySelector('.quota-win-value').getBoundingClientRect().right))
      const cardRight = Math.round(card.getBoundingClientRect().right)
      const rowRights = rows.map((r) => Math.round(r.getBoundingClientRect().right))
      const overflow = rows.some((r) => r.querySelector('.quota-win-value').scrollWidth > r.querySelector('.quota-win-value').clientWidth + 1)
      return { rights, rowRights, cardRight, overflow, info: card.querySelectorAll('.quota-win-note').length }
    })()`)
    check(`额度页 ${width}px 数值右边缘一致且不溢出`, q.rights.length > 0 && new Set(q.rights).size === 1 && !q.overflow && q.info === 0 && q.rights[0] <= q.rowRights[0], q)
    await shot(`quota-${width}`)
  }
}
