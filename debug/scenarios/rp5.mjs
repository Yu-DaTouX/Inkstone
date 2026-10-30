import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const EVIDENCE = 'E:/pi-desktop/.local-docs/evidence/2026-10-30-t3-replica/rp5'

export const meta = { demo: true, description: '右栏换 T3 外壳与顶栏结构：通顶、标签条即顶栏、窗口按钮随右栏开合切换（含截图）' }

export default async function run({ cdp, box, waitFor, check, log, shot, sleep, state }) {
  mkdirSync(EVIDENCE, { recursive: true })
  const take = async (name) => {
    await cdp.evaluate(`document.activeElement instanceof HTMLElement && document.activeElement.blur()`)
    await sleep(150)
    await cdp.shot(name, EVIDENCE)
  }
  const rp = (expr) => cdp.evaluate(`(() => { const s = window.__yanStore.getState(); const r = ${expr}; return r })()`)
  const metrics = () => cdp.evaluate(`(() => {
    const head = document.querySelector('.v3-head')
    const bar = document.querySelector('[data-right-panel-tabbar]')
    const panel = document.querySelector('[data-testid="rp"]')
    const rect = (el) => el ? el.getBoundingClientRect() : null
    const h = rect(head)
    const b = rect(bar)
    const p = rect(panel)
    return {
      head: h ? { top: Math.round(h.top), height: Math.round(h.height) } : null,
      bar: b ? { top: Math.round(b.top), height: Math.round(b.height) } : null,
      panel: p ? { top: Math.round(p.top), height: Math.round(p.height), left: Math.round(p.left), width: Math.round(p.width) } : null,
      innerHeight: window.innerHeight,
      borderLeft: panel ? getComputedStyle(panel).borderLeftWidth : null,
      headWin: !!document.querySelector('.v3-head [data-testid="v3-close"]'),
      barWin: !!document.querySelector('[data-right-panel-tabbar] [data-testid="v3-close"]'),
      chipHeight: (() => { const c = document.querySelector('[data-tab-id]'); return c ? Math.round(c.getBoundingClientRect().height) : null })(),
      mode: document.querySelector('[data-preview-panel-mode]')?.getAttribute('data-preview-panel-mode') ?? null
    }
  })()`)

  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
  await cdp.evaluate(`window.__yanStore.getState().patchSettings({ lang: 'zh-CN' })`)
  await waitFor(`!!document.querySelector('.v3-head') && !!document.querySelector('.v3-root')`, 30000)
  await sleep(600)

  const files = [join(box.project, 'README.md'), join(box.project, 'package.json'), join(box.project, 'INCIDENT.md')]
  const existing = files.filter((file) => existsSync(file))
  log('演示项目文件', existing)

  await cdp.evaluate(`window.__yanStore.getState().patchSettings({ theme: 'dark' })`)
  await cdp.evaluate(`window.__yanRightPanel.getState().setOpen(false)`)
  await sleep(500)

  const closedDark = await metrics()
  check('右栏关闭：顶栏 40 高且会话列顶栏带窗口按钮', closedDark.head?.height === 40 && closedDark.headWin && !closedDark.barWin, closedDark)
  await take('rp5-dark-closed')

  await cdp.evaluate(`window.__yanRightPanel.getState().open({ id: 'files', kind: 'files' })`)
  await waitFor(`!!document.querySelector('[data-right-panel-tabbar]')`, 10000)
  await sleep(700)
  const openDark = await metrics()
  check('右栏打开：标签条与会话列顶栏同高同顶（40 / top 0）', openDark.head?.top === 0 && openDark.bar?.top === 0 && openDark.bar?.height === 40, openDark)
  check('右栏打开：面板通顶到底且左分隔线存在', openDark.panel?.top === 0 && openDark.panel.height === openDark.innerHeight && parseFloat(openDark.borderLeft ?? '0') > 0, openDark.panel)
  check('右栏打开：窗口按钮移到标签条右端，会话列顶栏不再有', openDark.barWin && !openDark.headWin, { headWin: openDark.headWin, barWin: openDark.barWin })
  check('标签片 24 高（T3 chip）', openDark.chipHeight === 24, openDark.chipHeight)
  await take('rp5-dark-files')

  for (const file of existing.slice(0, 2)) {
    await cdp.evaluate(`window.__yanRightPanel.getState().open({ id: 'file:' + ${JSON.stringify(file)}, kind: 'file', path: ${JSON.stringify(file)} })`)
    await sleep(500)
  }
  await cdp.evaluate(`window.__yanRightPanel.getState().open({ id: 'changes', kind: 'changes' })`)
  await sleep(900)
  const tabCount = await cdp.evaluate(`document.querySelectorAll('[data-right-panel-tab-list] [data-tab-id]').length`)
  check('多标签：标签条 3 个以上标签片', tabCount >= 3, tabCount)
  await take('rp5-dark-multitab')

  const addMenu = await cdp.evaluate(`(() => { const b = document.querySelector('[data-testid="rp-new-tab"]'); if (!b) return false; b.click(); return true })()`)
  await sleep(500)
  const menuRow = await cdp.evaluate(`(document.querySelector('[data-slot="menu-popup"]')?.innerText ?? '').slice(0, 80)`)
  check('「+」启动器菜单展开并列出面板', addMenu && menuRow.length > 0, menuRow)
  await take('rp5-dark-add-menu')
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(300)

  await cdp.evaluate(`window.__yanRightPanel.getState().activate('files')`)
  await sleep(500)
  await cdp.evaluate(`(() => { const el = document.querySelector('[data-right-panel-tab-list] [role="tab"]'); el?.focus() })()`)
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34, modifiers: 2 })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34, modifiers: 2 })
  await sleep(400)
  const stepped = await cdp.evaluate(`document.querySelector('[data-active-tab="true"]')?.getAttribute('data-tab-id') ?? null`)
  const focused = await cdp.evaluate(`document.activeElement?.getAttribute('role') === 'tab' && document.activeElement?.getAttribute('aria-selected') === 'true'`)
  check('Ctrl+PageDown 切到下一个标签且焦点落在标签片', stepped !== 'files' && focused, { stepped, focused })

  await cdp.evaluate(`window.__yanRightPanel.getState().setMaximized(true)`)
  await sleep(700)
  const maxed = await metrics()
  const mainHidden = await cdp.evaluate(`getComputedStyle(document.querySelector('.v3-main')).display === 'none'`)
  check('最大化：会话列收起、右栏占满主区', mainHidden, { mainHidden, panel: maxed.panel })
  check('最大化：窗口按钮仍在标签条', maxed.barWin, maxed.barWin)
  await take('rp5-dark-maximized')
  await cdp.evaluate(`window.__yanRightPanel.getState().setMaximized(false)`)
  await sleep(500)

  const closedTabs = await cdp.evaluate(`document.querySelectorAll('[data-right-panel-tab-list] [data-tab-id]').length`)
  await cdp.evaluate(`(() => { const t = document.querySelector('[data-active-tab="true"] [role="tab"]'); t?.focus(); return true })()`)
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 })
  await sleep(400)
  const afterDelete = await cdp.evaluate(`document.querySelectorAll('[data-right-panel-tab-list] [data-tab-id]').length`)
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'T', code: 'KeyT', windowsVirtualKeyCode: 84, modifiers: 10 })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'T', code: 'KeyT', windowsVirtualKeyCode: 84, modifiers: 10 })
  await sleep(700)
  const afterReopen = await cdp.evaluate(`document.querySelectorAll('[data-right-panel-tab-list] [data-tab-id]').length`)
  check('Delete 关标签后 Ctrl+Shift+T 重开', afterDelete === closedTabs - 1 && afterReopen === closedTabs, { closedTabs, afterDelete, afterReopen })

  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'N', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 10 })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'N', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 10 })
  await sleep(500)
  const addMenuByKey = await cdp.evaluate(`!!document.querySelector('[data-slot="menu-popup"]')`)
  check('Ctrl+Shift+N 打开「+」菜单', addMenuByKey, addMenuByKey)
  await take('rp5-dark-add-menu-key')
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(300)

  await cdp.evaluate(`window.__yanRightPanel.getState().setOpen(false)`)
  await sleep(500)
  await cdp.evaluate(`window.__yanStore.getState().patchSettings({ theme: 'light' })`)
  await sleep(400)
  await take('rp5-light-closed')
  await cdp.evaluate(`window.__yanRightPanel.getState().setOpen(true)`)
  await sleep(800)
  await take('rp5-light-open')
  await cdp.evaluate(`window.__yanStore.getState().patchSettings({ theme: 'dark' })`)
  await sleep(300)

  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 640, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(900)
  const narrow = await metrics()
  check('窄窗：右栏切成 sheet 覆盖', narrow.mode === 'sheet', narrow.mode)
  await take('rp5-dark-sheet')
  await cdp.evaluate(`window.__yanRightPanel.getState().setOpen(false)`)
  await sleep(500)
  const narrowClosed = await metrics()
  check('窄窗：右栏关闭时窗口按钮回到会话列顶栏', narrowClosed.headWin && !narrowClosed.barWin, { headWin: narrowClosed.headWin, barWin: narrowClosed.barWin })
  await take('rp5-dark-sheet-closed')
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
  await sleep(600)

  await cdp.evaluate(`window.__yanUiV3.getState().navigate({ name: 'usage' })`)
  await sleep(700)
  const usage = await cdp.evaluate(`(() => { const p = document.querySelector('.usage-page'); const b = document.querySelector('.v3-body'); return p && b ? { page: Math.round(p.getBoundingClientRect().height), body: Math.round(b.getBoundingClientRect().height) } : null })()`)
  check('非会话路由页仍占满主区（flex 改版后不漏高）', !usage || (usage.page === usage.body && usage.page > 100), usage)
  await cdp.evaluate(`window.__yanUiV3.getState().navigate({ name: 'chat' })`)
  await sleep(400)

  const errors = await state(`null`)
  void errors
}
