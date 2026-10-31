import { mkdirSync } from 'node:fs'

const EVIDENCE = 'E:/pi-desktop/.local-docs/evidence/2026-10-31-settings-t3'

export const meta = { demo: true, description: '设置各页截图：SETTINGS_TAG 前缀（before/after），中文深色，外观页加浅色' }

export default async function run({ cdp, check, sleep }) {
  mkdirSync(EVIDENCE, { recursive: true })
  const tag = process.env.SETTINGS_TAG || 'after'
  const patch = (theme) => cdp.evaluate(`window.__yanStore.getState().patchSettings({ theme: ${JSON.stringify(theme)}, lang: 'zh-CN' })`)
  await patch('dark')
  await sleep(500)
  await cdp.evaluate(`window.__yanStore.getState().openSettings()`)
  await sleep(1200)
  const ids = await cdp.evaluate(`Array.from(document.querySelectorAll('.ui-settings [data-testid^="v3-settings-nav-"], .ui-settings [data-testid^="caps-tab-"]')).map((n) => n.getAttribute('data-testid'))`)
  check('找到导航项', ids.length > 5, ids.length)
  const ratios = []
  let index = 0
  for (const id of ids) {
    index += 1
    const pad = String(index).padStart(2, '0')
    const name = id.replace(/^v3-settings-nav-/, '').replace(/^caps-tab-/, 'caps-')
    await cdp.evaluate(`document.querySelector('[data-testid="${id}"]')?.click()`)
    await sleep(900)
    await cdp.shot(`${tag}-${pad}-${name}-dark`, EVIDENCE)
    const extent = await cdp.evaluate(`(() => { const c = document.querySelector('.ui-settings__content'); return c ? [c.scrollHeight, c.clientHeight] : [0, 0] })()`)
    ratios.push(`${name}: ${extent[0]}/${extent[1]} = ${(extent[0] / Math.max(extent[1], 1)).toFixed(2)}`)
    let page = 1
    while (extent[0] > extent[1] + 40 && page < 4) {
      await cdp.evaluate(`(() => { const c = document.querySelector('.ui-settings__content'); c.scrollTop = ${page} * (c.clientHeight - 80) })()`)
      await sleep(300)
      await cdp.shot(`${tag}-${pad}-${name}-dark-p${page + 1}`, EVIDENCE)
      if (page * (extent[1] - 80) + extent[1] >= extent[0]) break
      page += 1
    }
    if (name === 'session' && process.env.SETTINGS_TAG !== 'before') {
      await cdp.evaluate(`document.querySelector('[data-testid="v3-session-advanced"]')?.click()`)
      await sleep(700)
      await cdp.evaluate(`(() => { const c = document.querySelector('.ui-settings__content'); c.scrollTop = c.scrollHeight })()`)
      await sleep(300)
      await cdp.shot(`${tag}-${pad}-session-advanced-open`, EVIDENCE)
      await cdp.evaluate(`document.querySelector('[data-testid="v3-session-advanced"]')?.click()`)
      await sleep(400)
    }
    if (name === 'appearance') {
      await patch('light')
      await sleep(600)
      await cdp.shot(`${tag}-${pad}-${name}-light`, EVIDENCE)
      await patch('dark')
      await sleep(400)
    }
  }
  console.log(ratios.join(' | '))
  await cdp.evaluate(`document.querySelector('[data-testid="v3-settings-nav-about"]')?.focus()`)
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: '/', code: 'Slash', text: '/' })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: '/', code: 'Slash' })
  await sleep(300)
  const slashFocus = await cdp.evaluate(`document.activeElement?.classList.contains('ui-settings-search__input')`)
  check('按 / 聚焦设置搜索', slashFocus === true, slashFocus)
  await cdp.evaluate(`document.activeElement?.blur?.()`)
  await cdp.evaluate(`document.querySelector('[data-testid="v3-settings-nav-models"]')?.click()`)
  await sleep(700)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1000, y: 500 })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 1000, y: 500, deltaX: 0, deltaY: 120 })
  await sleep(300)
  await cdp.shot(`${tag}-scrollbar-content-hover`, EVIDENCE)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 300, y: 600 })
  await sleep(300)
  await cdp.shot(`${tag}-scrollbar-nav-hover`, EVIDENCE)
  await cdp.evaluate(`document.querySelector('[data-testid="v3-settings-nav-models"]')?.click()`)
  await sleep(800)
  await cdp.evaluate(`document.querySelector('.ui-settings__content').scrollTop = 0`)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 1000, y: 500, deltaX: 0, deltaY: 100 })
  await sleep(700)
  const wheel = await cdp.evaluate(`document.querySelector('.ui-settings__content').scrollTop`)
  check('滚轮 deltaY=100 滚动距离不被放大', wheel > 0 && wheel <= 120, wheel)
  if (tag === 'before') return
  await cdp.evaluate(`(() => { const input = document.querySelector('[data-testid="settings-search"] input, input[data-testid="settings-search"]'); if (!input) return; input.focus() })()`)
  await cdp.call('Input.insertText', { text: '重试' })
  await sleep(600)
  await cdp.shot(`${tag}-search-retry`, EVIDENCE)
  const hit = await cdp.evaluate(`(() => { const n = document.querySelector('[data-testid^="settings-hit-"]'); if (!n) return null; const id = n.getAttribute('data-testid'); n.click(); return id })()`)
  check('搜索「重试」有结果', !!hit, hit)
  await sleep(1800)
  const open = await cdp.evaluate(`document.querySelector('[data-testid="v3-session-advanced"]')?.getAttribute('aria-expanded')`)
  check('搜索命中高级项时自动展开', open === 'true', open)
  await cdp.shot(`${tag}-search-revealed`, EVIDENCE)
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 640, height: 800, deviceScaleFactor: 1, mobile: false })
  await sleep(900)
  await cdp.shot(`${tag}-narrow-640`, EVIDENCE)
  const overflow = await cdp.evaluate(`(() => { const c = document.querySelector('.ui-settings__content'); return c ? c.scrollWidth - c.clientWidth : null })()`)
  check('窄宽度无横向溢出', overflow === 0, overflow)
  await cdp.call('Emulation.clearDeviceMetricsOverride', {})
}
