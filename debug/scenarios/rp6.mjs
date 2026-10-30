import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const EVIDENCE = 'E:/pi-desktop/.local-docs/evidence/2026-10-30-t3-replica/rp6'
const PHASE = process.env.RP6_PHASE === 'before' ? 'before' : 'after'
const DIR = join(EVIDENCE, PHASE)

export const meta = { demo: true, description: '右栏收尾：副标题菜单改 T3 菜单、sheet 不盖顶栏、标签条键盘、减少动效、顶栏对照' }

const KEY_CODES = {
  ArrowLeft: 37,
  ArrowRight: 39,
  Enter: 13,
  NumpadEnter: 13,
  ' ': 32,
  Delete: 46,
  PageUp: 33,
  PageDown: 34,
  Escape: 27,
  w: 87,
  W: 87,
  t: 84,
  T: 84
}

export default async function run({ cdp, waitFor, check, log, sleep }) {
  mkdirSync(DIR, { recursive: true })
  const shot = (name) => cdp.shot(`${PHASE}-${name}`, DIR)
  const evaluate = (expr) => cdp.evaluate(expr)
  const key = async (name, modifiers = 0) => {
    const windowsVirtualKeyCode = KEY_CODES[name] ?? name.toUpperCase().charCodeAt(0)
    const code = name === ' ' ? 'Space' : name.length === 1 ? `Key${name.toUpperCase()}` : name
    const text = name === 'Enter' ? '\r' : name.length === 1 ? name : undefined
    const base = { key: name, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers }
    await cdp.call('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text === undefined ? {} : { text, unmodifiedText: text }) })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    await sleep(120)
  }

  const geometry = () => evaluate(`(() => {
    const round = (value) => Math.round(value * 100) / 100
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) } }
    const style = (el, props) => { if (!el) return null; const cs = getComputedStyle(el); return Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)])) }
    const chip = document.querySelector('[data-tab-id][data-active-tab="true"]')
    const chipLabel = chip?.querySelector('button[role="tab"]')
    const add = document.querySelector('[data-testid="rp-new-tab"]')
    const max = document.querySelector('[data-testid="rp-maximize"]')
    const hide = document.querySelector('[data-testid="rp-hide"]')
    const head = document.querySelector('.v3-head')
    const headToggle = document.querySelector('[data-right-panel-toggle]')
    const bar = document.querySelector('[data-right-panel-tabbar]')
    const panel = document.querySelector('[data-testid="rp"]')
    const sub = document.querySelector('.rp-sub')
    const subMenu = document.querySelector('.rp-sub-menu')
    const winBtn = document.querySelector('.v3-winbtn')
    const winClose = document.querySelector('[data-testid="v3-close"]')
    return {
      chip: rect(chip),
      chipStyle: style(chip, ['background-color', 'color', 'font-size', 'border-radius', 'padding-left', 'padding-right']),
      chipLabelStyle: style(chipLabel, ['font-size', 'font-weight']),
      add: rect(add),
      addIcon: rect(add?.querySelector('svg')),
      max: rect(max),
      maxIcon: rect(max?.querySelector('svg')),
      hide: rect(hide),
      hideIcon: rect(hide?.querySelector('svg')),
      bar: rect(bar),
      barStyle: style(bar, ['padding-left', 'padding-right']),
      head: rect(head),
      headToggle: rect(headToggle),
      headToggleIcon: rect(headToggle?.querySelector('svg')),
      headStyle: style(head, ['padding-left', 'padding-right', 'background-color']),
      panel: rect(panel),
      panelStyle: style(panel, ['background-color', 'border-left-width', 'border-left-color']),
      sub: rect(sub),
      subStyle: style(sub, ['font-size', 'color', 'padding-left', 'padding-right']),
      subMenu: rect(subMenu),
      winBtn: rect(winBtn),
      winClose: rect(winClose),
      winIcon: rect(winClose?.querySelector('svg')),
      headingHeight: getComputedStyle(document.documentElement).getPropertyValue('--size-head'),
      mode: document.querySelector('[data-preview-panel-mode]')?.getAttribute('data-preview-panel-mode') ?? null
    }
  })()`)

  const chipFocus = () => evaluate(`(() => { const el = document.activeElement; const chip = el instanceof Element ? el.closest('[data-tab-id]') : null; return { id: chip?.getAttribute('data-tab-id') ?? null, role: el?.getAttribute('role') ?? null } })()`)
  const panelState = () => evaluate(`(() => { const s = window.__yanRightPanel.getState(); return { open: !!document.querySelector('[data-testid="rp"]'), count: document.querySelectorAll('[data-tab-id]').length, active: [...document.querySelectorAll('[data-tab-id]')].find((el) => el.getAttribute('data-active-tab') === 'true')?.getAttribute('data-tab-id') ?? null } })()`)

  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1672, height: 1000, deviceScaleFactor: 1, mobile: false })
  await evaluate(`window.__yanStore.getState().patchSettings({ lang: 'zh-CN', theme: 'dark' })`)
  await waitFor(`!!document.querySelector('.v3-root')`, 30000)
  await evaluate(`document.documentElement.removeAttribute('data-reduce-motion')`)
  await sleep(700)

  await evaluate(`window.__yanRightPanel.getState().setOpen(false)`)
  await sleep(400)
  await evaluate(`window.__yanRightPanel.getState().open({ id: 'files', kind: 'files' })`)
  await waitFor(`!!document.querySelector('[data-right-panel-tabbar]')`, 10000)
  await sleep(700)
  const dark = await geometry()
  log('深色度量', dark)
  check('深色：右栏底与主区同为纯黑', dark.panelStyle?.['background-color'] === 'rgb(0, 0, 0)', dark.panelStyle)
  check('深色：标签条与顶栏同高', dark.bar?.h === 40 && dark.head?.h === 40, { bar: dark.bar, head: dark.head })
  check('标签 chip 24 高、12px 字、圆角 6', Math.round(dark.chip?.h ?? 0) === 24 && dark.chipStyle?.['font-size'] === '12px' && dark.chipStyle?.['border-radius'] === '6px', dark.chipStyle)
  await shot('01-dark-files')

  await evaluate(`document.querySelector('[data-testid="rp-menu-files"]')?.click()`)
  await sleep(450)
  const menu = await evaluate(`(() => {
    const popup = document.querySelector('[data-slot="menu-popup"]')
    if (!popup) return null
    const r = popup.getBoundingClientRect()
    const item = popup.querySelector('[data-slot="menu-item"]')
    const sep = popup.querySelector('[data-slot="menu-separator"]')
    const ir = item?.getBoundingClientRect()
    const cs = item ? getComputedStyle(item) : null
    return {
      popup: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      background: getComputedStyle(popup).backgroundColor,
      radius: getComputedStyle(popup).borderRadius,
      item: ir ? { w: Math.round(ir.width), h: Math.round(ir.height), font: cs.fontSize, radius: cs.borderRadius, color: cs.color } : null,
      separator: sep ? { height: sep.getBoundingClientRect().height, background: getComputedStyle(sep).backgroundColor } : null,
      items: [...popup.querySelectorAll('[data-slot="menu-item"]')].map((el) => el.textContent?.trim()),
      slot: popup.getAttribute('data-slot')
    }
  })()`)
  log('副标题菜单', menu)
  check('副标题「⋯」弹出的是 T3 菜单基元', !!menu && menu.slot === 'menu-popup', menu?.slot ?? 'none')
  check('菜单项 28 高（T3 sm:min-h-7）', menu?.item?.h === 28, menu?.item)
  await shot('02-dark-pane-menu')
  await key('Escape')
  await sleep(300)

  await evaluate(`window.__yanStore.getState().patchSettings({ theme: 'light' })`)
  await sleep(700)
  await shot('03-light-files')
  await evaluate(`document.querySelector('[data-testid="rp-menu-files"]')?.click()`)
  await sleep(450)
  await shot('04-light-pane-menu')
  await key('Escape')
  await sleep(250)

  await evaluate(`window.__yanStore.getState().patchSettings({ theme: 'dark' })`)
  await sleep(400)
  await evaluate(`window.__yanRightPanel.getState().open({ id: 'changes', kind: 'changes' })`)
  await sleep(900)
  await shot('05-dark-diff')
  const tabs = await evaluate(`[...document.querySelectorAll('[data-tab-id]')].map((el) => el.getAttribute('data-tab-id'))`)
  log('标签', tabs)

  const focusChip = async (id) => {
    await evaluate(`(() => { const chip = document.querySelector('[data-tab-id="${id}"]'); chip?.querySelector('button[role="tab"]')?.focus() })()`)
    await sleep(120)
  }
  await focusChip(tabs[0])
  const startFocus = await chipFocus()
  await evaluate(`document.querySelector('[data-testid="rp-new-tab"]')?.focus()`)
  await sleep(120)
  await key('Tab', 8)
  const tabbedIn = await chipFocus()
  check('标签条：Shift+Tab 从「+」回到标签', startFocus.id !== null && tabbedIn.role === 'tab', { startFocus, tabbedIn })
  await key('Tab')
  const tabbedOut = await evaluate(`document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? null`)
  check('标签条：Tab 在标签与「+」之间顺序移动', tabbedOut === 'rp-new-tab', tabbedOut)
  await focusChip(tabs[0])
  await key('ArrowRight')
  const rightFocus = await chipFocus()
  check('标签条：方向键右移焦点', rightFocus.id === tabs[1] && rightFocus.role === 'tab', { startFocus, rightFocus })
  await key('ArrowLeft')
  const leftFocus = await chipFocus()
  check('标签条：方向键左移焦点', leftFocus.id === tabs[0], leftFocus)
  await key('Enter')
  const afterEnter = await panelState()
  check('标签条：Enter 激活焦点标签', afterEnter.active === tabs[0], afterEnter)
  await key(' ')
  const afterSpace = await panelState()
  check('标签条：空格不改变已选中标签', afterSpace.active === tabs[0], afterSpace)
  await focusChip(tabs[1])
  await key('Delete')
  const afterDelete = await panelState()
  check('标签条：Delete 关闭焦点标签', afterDelete.count === 1, afterDelete)
  const left = await evaluate(`[...document.querySelectorAll('[data-tab-id]')].map((el) => el.getAttribute('data-tab-id'))`)
  await focusChip(left[0])
  await key('w', 2)
  const afterCtrlW = await panelState()
  check('标签条：Ctrl+W 关闭焦点标签', afterCtrlW.count === 0, afterCtrlW)
  await key('T', 2 | 8)
  await sleep(600)
  const afterReopen = await panelState()
  check('标签条：Ctrl+Shift+T 重开已关标签', afterReopen.count === 1, afterReopen)

  await evaluate(`window.__yanRightPanel.getState().open({ id: 'files', kind: 'files' }); window.__yanRightPanel.getState().open({ id: 'changes', kind: 'changes' })`)
  await sleep(600)
  const beforePage = await panelState()
  await evaluate(`document.querySelector('[data-tab-id][data-active-tab="true"] button[role="tab"]')?.focus()`)
  await key('PageDown', 2)
  const afterPageDown = await panelState()
  check('标签条：Ctrl+PageDown 切到下一个标签', afterPageDown.active !== beforePage.active, { beforePage, afterPageDown })
  await key('PageUp', 2)
  const afterPageUp = await panelState()
  check('标签条：Ctrl+PageUp 切回上一个标签', afterPageUp.active === beforePage.active, afterPageUp)
  await evaluate(`window.__yanRightPanel.getState().open({ id: 'files', kind: 'files' })`)
  await sleep(500)
  await evaluate(`document.querySelector('[data-tab-id][data-active-tab="true"] button[role="tab"]')?.focus()`)
  await key('PageDown', 2)
  await sleep(300)
  const pageFocus = await chipFocus()
  check('标签条：Ctrl+PageDown 后焦点落到选中标签', pageFocus.role === 'tab' || pageFocus.id !== null, pageFocus)

  await evaluate(`(() => { const root = document.documentElement; root.dataset.reduceMotion = 'true'; window.dispatchEvent(new Event('yan:reduced-motion')) })()`)
  await sleep(200)
  const reduceInline = await evaluate(`(() => {
    const panel = document.querySelector('[data-testid="rp"]')
    const host = panel?.querySelector('.t3-rp') ?? panel
    return { panel: host ? getComputedStyle(host).transitionDuration : null, sheet: null }
  })()`)
  const reduceOpen = await evaluate(`(async () => {
    const store = window.__yanRightPanel.getState()
    store.setOpen(false)
    await new Promise((done) => setTimeout(done, 60))
    const closing = document.querySelector('.t3-rp')
    const closingDuration = closing ? getComputedStyle(closing).transitionDuration : null
    store.setOpen(true)
    await new Promise((done) => setTimeout(done, 60))
    const opening = document.querySelector('.t3-rp')
    return { closingDuration, openingDuration: opening ? getComputedStyle(opening).transitionDuration : null }
  })()`)
  log('减少动效（右栏开合）', { reduceInline, reduceOpen })
  check('减少动效：右栏展开/收起不播宽度动画', reduceOpen.openingDuration !== null && parseFloat(reduceOpen.openingDuration) <= 0.001 && (reduceOpen.closingDuration === null || parseFloat(reduceOpen.closingDuration) <= 0.001), reduceOpen)

  const surfaceAnimation = await evaluate(`(() => {
    const surfaces = [...document.querySelectorAll('.rp-surface')]
    return surfaces.map((el) => ({ hidden: el.hasAttribute('hidden'), animation: getComputedStyle(el).animationDuration, motion: el.getAttribute('data-motion') }))
  })()`)
  log('减少动效（标签切换）', surfaceAnimation)
  check('减少动效：标签切换无入场动画', surfaceAnimation.every((item) => parseFloat(item.animation) <= 0.001), surfaceAnimation)

  await evaluate(`(() => { const root = document.documentElement; delete root.dataset.reduceMotion; window.dispatchEvent(new Event('yan:reduced-motion')) })()`)

  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 720, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(900)
  const sheet = await evaluate(`(() => {
    const popup = document.querySelector('[data-slot="sheet-popup"]')
    const backdrop = document.querySelector('[data-slot="sheet-backdrop"]')
    const head = document.querySelector('.v3-head')
    const closeBtn = document.querySelector('[data-testid="v3-close"]')
    const r = popup?.getBoundingClientRect()
    const b = backdrop?.getBoundingClientRect()
    const h = head?.getBoundingClientRect()
    const c = closeBtn?.getBoundingClientRect()
    const hit = c ? document.elementFromPoint(c.x + c.width / 2, c.y + c.height / 2) : null
    return {
      mode: document.querySelector('[data-preview-panel-mode]')?.getAttribute('data-preview-panel-mode') ?? null,
      popup: r ? { top: Math.round(r.top), height: Math.round(r.height) } : null,
      backdrop: b ? { top: Math.round(b.top), height: Math.round(b.height) } : null,
      head: h ? { top: Math.round(h.top), height: Math.round(h.height) } : null,
      close: c ? { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.width), h: Math.round(c.height) } : null,
      closeHit: hit ? { tag: hit.tagName, testid: hit.closest('[data-testid]')?.getAttribute('data-testid') ?? null, slot: hit.closest('[data-slot]')?.getAttribute('data-slot') ?? null } : null
    }
  })()`)
  log('窄窗 sheet', sheet)
  check('窄窗：sheet 从顶栏下方开始', sheet.mode === 'sheet' && sheet.popup?.top === 40, sheet.popup)
  check('窄窗：sheet 遮罩不盖顶栏', sheet.backdrop?.top === 40, sheet.backdrop)
  check('窄窗：窗口关闭按钮可点', sheet.closeHit?.testid === 'v3-close', sheet.closeHit)
  await shot('06-sheet-dark')
  await evaluate(`window.__yanStore.getState().patchSettings({ theme: 'light' })`)
  await sleep(600)
  await shot('07-sheet-light')
  await evaluate(`window.__yanStore.getState().patchSettings({ theme: 'dark' })`)
  await sleep(400)

  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1672, height: 1000, deviceScaleFactor: 1, mobile: false })
  await sleep(700)
  await evaluate(`window.__yanRightPanel.getState().setMaximized(true)`)
  await sleep(600)
  await shot('08-dark-maximized')
  await evaluate(`window.__yanRightPanel.getState().setMaximized(false)`)
  await sleep(500)
  await evaluate(`window.__yanRightPanel.getState().setOpen(false)`)
  await sleep(600)
  await shot('09-dark-closed')
}
