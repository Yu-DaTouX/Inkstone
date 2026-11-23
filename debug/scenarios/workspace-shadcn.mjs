import { createServer } from 'node:http'
import { click, MOD, press, textAudit } from '../lib/review-kit.mjs'

export const meta = { description: 'shadcn 外观覆盖全应用：深浅色、消息/输入框与外围同一套外观、模型弹层、设置、命令面板和原生浏览器；只用夹具' }

export default async function run({ cdp, check, waitFor, sleep, newSession, shot }) {
  const ev = (expr) => cdp.evaluate(expr)
  const width = (width) => cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
  const exists = (selector) => `!!document.querySelector(${JSON.stringify(selector)})`
  const wait = (selector) => waitFor(exists(selector), 12000)
  const gone = (selector) => waitFor(`!(${exists(selector)})`, 12000)
  const el = (selector) => `document.querySelector(${JSON.stringify(selector)})`
  const style = (selector, property) => `getComputedStyle(${el(selector)}).getPropertyValue(${JSON.stringify(property)})`
  const workspaceRoot = '.v3-root'
  const settings = '.ui-settings-modal'
  const modelTrigger = '[data-chat-provider-model-picker]'
  const modelPopup = '.t3-model-popover'
  const browserTabs = '[data-testid="browser-pane-tabs"]'
  const snapshot = `() => Array.from(document.querySelectorAll('.v3-conv, .v3-composer, .v3-conv *, .v3-composer *'), node => {
    const s = getComputedStyle(node), r = node.getBoundingClientRect()
    return [node.tagName, s.color, s.background, s.border, s.borderRadius, s.font, s.boxShadow, r.x, r.y, r.width, r.height]
  })`
  await width(1480)
  await newSession()
  await ev(`window.__yanStore.getState().patchSettings({theme:'light',lang:'zh-CN',workspaceTiles:true,promptSuggestions:false,reduceMotion:true,windowGlass:'full',windowGlassOpacity:45})`)
  await ev(`window.__yanStore.setState(s => ({ messages: [
    { id: 'workspace-u', role: 'user', text: '看看导出脚本改了什么，再跑一下相关测试。' },
    { id: 'workspace-a', role: 'assistant', text: '现在会先检查输出目录，已有同名文件时不再静默覆盖。',
      toolCalls: [{ id: 'workspace-tool', name: 'bash', args: { command: 'git diff' }, output: 'export.py', status: 'ok' }] }
  ], session: { ...s.session, isAgentRunning: false, isStreaming: false }, historyLoading: false, switchLoading: false }))`)
  await wait('.v3-conv [data-turn-id="workspace-a"]')
  await wait('.v3-sessionbar .wb-tile')
  await waitFor(`document.documentElement.dataset.theme === 'light' && document.documentElement.dataset.glass === 'full' && document.documentElement.style.getPropertyValue('--window-glass') === '45%'`)
  await sleep(350)

  for (const theme of ['light', 'dark']) {
    await ev(`window.__yanStore.getState().patchSettings({theme:${JSON.stringify(theme)}})`)
    await waitFor(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`)
    await sleep(260)
    const { now, old, sidebar, oldSidebar, glass, oldGlass } = await ev(`(() => {
      const read = ${snapshot}, root = ${el(workspaceRoot)}
      const readGlass = () => {
        const bar = document.querySelector('.v3-sessionbar')
        const tiles = [...bar.querySelectorAll('.wb-tile')]
        return {
          header: getComputedStyle(document.querySelector('.v3-head')).backgroundColor,
          bar: getComputedStyle(bar).backgroundColor,
          tiles: tiles.map(tile => {
            const css = getComputedStyle(tile)
            return [css.backgroundColor, css.boxShadow, css.borderTopWidth]
          }),
          separator: getComputedStyle(tiles[1], '::before').backgroundColor
        }
      }
      const now = read(), glass = readGlass(), sidebar = ${style('.v3-side', 'background-color')}
      root.removeAttribute('data-workspace-ui')
      try { return { now, old: read(), glass, oldGlass: readGlass(), sidebar, oldSidebar: ${style('.v3-side', 'background-color')} } }
      finally { root.setAttribute('data-workspace-ui', '') }
    })()`)
    const diffs = now.flatMap((row, i) => JSON.stringify(row) === JSON.stringify(old[i]) ? [] : [{ row, old: old[i] }])
    check(`${theme} 消息流和输入框随外围同一套外观`, now.length > 25 && now.length === old.length && diffs.length > 0, { elements: now.length, diffs: diffs.slice(0, 3) })
    check(`${theme} 侧栏保留 55% 不透明度，直接用玻璃令牌`, sidebar === oldSidebar && sidebar.endsWith(' / 0.55)'), { sidebar, oldSidebar })
    const clear = 'rgba(0, 0, 0, 0)'
    check(`${theme} 会话栏共用半透明底，条目只用分隔线`, glass.header === oldGlass.header && glass.bar === oldGlass.bar && glass.bar !== clear && glass.tiles.length > 1 && glass.tiles.every(([bg, shadow, border]) => bg === clear && shadow === 'none' && border === '0px') && glass.separator !== clear && glass.separator === oldGlass.separator, glass)
    await shot(`workspace-${theme}`)
    if (theme === 'light') {
      await ev(`${el(workspaceRoot)}.removeAttribute('data-workspace-ui')`)
      try { await shot('workspace-light-before') }
      finally { await ev(`${el(workspaceRoot)}.setAttribute('data-workspace-ui','')`) }
    }
  }

  await click(cdp, modelTrigger)
  await wait(modelPopup)
  check('聊天模型弹层采用外围样式', await ev(`!!${el(modelPopup)}.closest('[data-workspace-ui]')`))
  await press(cdp, 'Escape')
  await gone(modelPopup)
  check('关闭模型弹层后焦点回到输入框控件', await ev(`!!document.activeElement.closest('.v3-composer')`))

  await press(cdp, 'k', { modifiers: MOD.ctrl })
  await wait('.cmd-surface')
  check('命令面板的 Portal 采用外围样式', await ev(`!!${el('.cmd-surface')}.closest('[data-workspace-ui]') && ${style('.cmd-surface', 'border-radius')} === '10px'`))
  await press(cdp, 'Escape')
  await gone('.cmd-surface')

  await ev(`window.__yanStore.getState().openSettings()`)
  await wait(settings)
  await click(cdp, '[data-testid="v3-settings-nav-models"]')
  await wait(`${settings} .ui-setting-rows`)
  check('设置弹层采用外围样式', await ev(`!!${el(settings)}.closest('[data-workspace-ui]') && ${style(settings, 'border-radius')} === '10px'`))
  await shot('settings-dark')
  await width(730)
  await ev(`window.__yanStore.getState().patchSettings({theme:'light'})`)
  await wait(`${settings} [data-layout="stacked"]`)
  await sleep(300)
  check('浅色窄窗设置没有横向溢出', await ev(`${el('.ui-settings__content')}.scrollWidth <= ${el('.ui-settings__content')}.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1`))
  const audit = await textAudit(cdp, settings)
  check('浅色窄窗设置可见文字对比检查', audit.textNodes > 0 && audit.lowContrastCount === 0, audit.lowContrast)
  await shot('settings-light-narrow')
  await press(cdp, 'Escape')
  await gone(settings)

  const page = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>Workspace fixture</title><h1>Workspace fixture</h1>')
  })
  await new Promise((resolve, reject) => { page.on('error', reject); page.listen(0, '127.0.0.1', resolve) })
  try {
    await width(1480)
    await ev(`window.__yanStore.getState().patchSettings({panelMotionMs:600,reduceMotion:false})`)
    await waitFor(`document.documentElement.style.getPropertyValue('--panel-dur')==='600ms' && !document.documentElement.matches('[data-window-resizing], [data-motion-hold], [data-reduce-motion]')`)
    await ev(`window.__yanStore.getState().openBrowser('http://127.0.0.1:${page.address().port}/')`)
    await waitFor('s.browserState.open', 12000)
    await wait(browserTabs)
    await waitFor('s.browserNativeVisible', 12000)
    check('内置浏览器的标签栏不额外铺底', await ev(`!!${el(browserTabs)}.closest('[data-workspace-ui]') && ${style(browserTabs, 'background-color')} === 'rgba(0, 0, 0, 0)'`))
    await ev(`window.__yanStore.getState().openSettings()`)
    await wait(settings)
    await waitFor('!s.browserNativeVisible')
    check('浏览器开启时设置仍是可交互顶层弹窗', await ev(`(() => { const n = ${el(settings)}, r = n.getBoundingClientRect(); return n.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) && !!n.querySelector('[role="dialog"]') })()`))
    await shot('settings-over-browser')
    await press(cdp, 'Escape')
    await gone(settings)
    await waitFor('s.browserNativeVisible')
    const toggle = '[data-testid="v3-head-panel-toggle"]'
    const viewport = el('[data-testid="browser-pane-viewport"]')
    await click(cdp, toggle)
    await waitFor('!s.browserNativeVisible')
    await gone('.t3-rp--docked')
    await click(cdp, toggle)
    await waitFor('s.browserNativeVisible')
    check('固定的右栏开关能重新打开原生浏览器，网页由右栏裁切', await ev(`(() => {
      const surface = ${viewport}?.closest('[data-native-clip]')
      return surface?.hasAttribute('data-rp-surface') && getComputedStyle(surface).overflowX === 'clip'
    })()`))
  } finally { page.closeAllConnections(); await new Promise(resolve => page.close(resolve)) }
}
