import { createServer } from 'node:http'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { deflateSync as zlibDeflate } from 'node:zlib'
import { shotKit } from '../lib/ui-shots.mjs'
import { buildFakeAdb } from '../lib/fake-adb.mjs'
import { listFrictionShots, measureUi, openFrictionSession } from '../lib/user-ui.mjs'

export const meta = {
  userData: true,
  userUi: true,
  observation: true,
  description: 'UI 打磨截图：镜像用户界面（会话副本、用户偏好与栏宽、窗口最大化），按 UI_POLISH_TARGETS（默认 browser）逐项截深色+背景、浅色、窄窗、悬停、键盘焦点与空/加载/错误/内容多；输出到 UI_POLISH_OUT 或运行目录 shots/'
}

const PAGES = [
  ['控制台 · 构建日志', '#0f172a', '#e2e8f0'],
  ['Inkstone 文档 - 快速开始', '#fafaf9', '#1c1917'],
  ['A very long English page title that should be truncated nicely in the tab column and tab row', '#f0f9ff', '#0c4a6e'],
  ['本地预览 · 首页', '#fff7ed', '#7c2d12'],
  ['GitHub · Pull request #128 修复额度页在窄窗下的换行问题', '#0d1117', '#c9d1d9'],
  ['Storybook', '#ffffff', '#111827'],
  ['设计稿评审 · 设置页第三版（含深浅主题对照与键盘焦点说明）', '#f5f3ff', '#3b0764'],
  ['API Reference', '#ecfeff', '#164e63'],
  ['监控面板', '#111111', '#a3e635'],
  ['表单测试', '#fefce8', '#713f12'],
  ['', '#ffffff', '#111111'],
  ['搜索结果：electron webcontentsview bounds', '#f8fafc', '#0f172a']
]

function pageServer(title, bg, fg) {
  return createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    const rows = Array.from({ length: 14 }, (_, i) => `<p style="margin:0 0 12px;opacity:${1 - i * 0.04}">第 ${i + 1} 段：${title || '无标题页面'} 的示例正文，用来填满页面看滚动与排版。</p>`).join('')
    res.end(`<!doctype html><html><head><meta charset="utf-8">${title ? `<title>${title}</title>` : ''}</head><body style="margin:0;font:15px/1.6 system-ui,sans-serif;background:${bg};color:${fg}"><header style="padding:20px 28px;border-bottom:1px solid rgba(127,127,127,.25);font-size:22px;font-weight:600">${title || '（无标题）'}</header><main style="padding:20px 28px;max-width:720px">${rows}</main></body></html>`)
  })
}

const listen = (server) => new Promise((done) => server.listen(0, '127.0.0.1', () => done(server.address().port)))

async function browserTarget({ kit, ev, until, sleep, log, check, report }) {
  const servers = []
  const urls = []
  for (const [title, bg, fg] of PAGES) {
    const server = pageServer(title, bg, fg)
    servers.push(server)
    urls.push(`http://127.0.0.1:${await listen(server)}/`)
  }
  const slow = createServer((_req, res) => { setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>slow</title>slow') }, 20000) })
  servers.push(slow)
  const slowUrl = `http://127.0.0.1:${await listen(slow)}/`
  const probe = createServer()
  const deadPort = await listen(probe)
  await new Promise((done) => probe.close(done))
  const deadUrl = `http://127.0.0.1:${deadPort}/`
  const S = kit
  const variants = async (name, { light = true, narrow = true } = {}) => {
    await S.shot(`${name}-dark`)
    if (light) { await S.theme('light'); await S.shot(`${name}-light`); await S.theme('dark') }
    if (narrow) { await S.narrow(); await S.shot(`${name}-narrow`); await S.clip(`${name}-narrow-toolbar`, '.v3-browser__toolbar', 0); await S.wide() }
  }
  const kbd = async (selector, name) => {
    const ok = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); return true })()`)
    if (!ok) { log('找不到焦点目标', selector); return null }
    await S.key('Tab')
    await S.key('Tab', { shift: true })
    const active = await ev(`document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName`)
    await S.shot(name)
    return active
  }
  const serversReady = (timeout = 15000) => until(`!!document.querySelector('[data-testid="browser-local-servers"][data-ready="1"]')`, timeout, 100)
  const iconServers = (timeout = 15000) => until(`!!document.querySelector('.v3-browser__tabcol [data-testid="browser-local-servers"][data-icon-only="1"]')`, timeout, 100)
  const settleServers = async () => { await serversReady(); await sleep(600) }
  const kbdLight = async (selector, name) => { await S.theme('light'); const active = await kbd(selector, name); await ev('document.activeElement?.blur?.()'); await S.theme('dark'); return active }
  try {
    await ev(`(() => { const rp = window.__yanRightPanel.getState(); rp.open({ id: 'browser', kind: 'browser' }); rp.setOpen(true); return true })()`)
    await until(`!!document.querySelector('[data-testid="browser-pane-not-open"], [data-testid="browser-pane"]')`, 15000)
    check('浏览器：空状态出现', await ev(`!!document.querySelector('[data-testid="browser-pane-not-open"]')`))
    const openTop = async () => ev(`Math.round(document.querySelector('[data-testid="browser-pane-open"]')?.getBoundingClientRect().top ?? -1)`)
    const topBefore = await openTop()
    await settleServers()
    const topAfter = await openTop()
    report.gateJump = { before: topBefore, after: topAfter }
    check('浏览器：本机服务加载前后「打开浏览器」按钮不动', Math.abs(topAfter - topBefore) <= 1, report.gateJump)
    await variants('browser-01-empty')
    await settleServers()
    report.hover.push(['browser-01-empty-hover-open', await S.hover('[data-testid="browser-pane-open"]', 900)])
    await S.shot('browser-01-empty-hover-open')
    await S.clip('browser-01-empty-hover-open-zoom', '.v3-browser__gate-main', 12)
    await S.unhover()
    report.focus.push(['browser-01-empty-focus-open', await kbd('[data-testid="browser-pane-open"]', 'browser-01-empty-focus-open')])
    await ev('document.activeElement?.blur?.()')
    report.focus.push(['browser-01-empty-focus-open-light', await kbdLight('[data-testid="browser-pane-open"]', 'browser-01-empty-focus-open-light')])
    const importBox = await ev(`(() => { const el = document.querySelector('.v3-browser__gate-main'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height } })()`)
    const importPause = await S.pauseAt('window.yan.browser.loginImportStatus(importId)', () => S.setHookState('[data-testid="browser-pane-not-open"]', [false, null, 'waiting', null], 1, 'ui-polish-import'))
    report.importWaiting = { paused: importPause?.paused ?? false, box: importBox }
    if (importPause?.paused) {
      await S.shotPaused('browser-01-import-waiting-dark')
      await importPause.resume()
    } else {
      await importPause?.resume()
    }
    check('浏览器：导入中状态提示拍到', report.importWaiting.paused, report.importWaiting)
    await sleep(600)

    await S.click('[data-testid="browser-pane-open"]', 1500)
    await until(`!!document.querySelector('[data-testid="browser-start-page"]')`, 15000)
    await sleep(800)
    await variants('browser-02-start')
    await S.click('[data-testid="browser-start-engine"]', 700)
    await S.shot('browser-02-start-engine-menu-dark')
    await S.key('Escape')
    report.focus.push(['browser-02-start-focus-engine', await kbd('[data-testid="browser-start-engine"]', 'browser-02-start-focus-engine')])

    void ev(`window.yan.browser.navigate(${JSON.stringify(slowUrl)})`)
    report.loadingSeen = await until('s.browserState.loading === true', 8000, 20)
    await sleep(300)
    await S.shot('browser-03-loading-dark')
    await S.clip('browser-03-loading-toolbar', '.v3-browser__toolbar')
    await S.theme('light')
    await S.shot('browser-03-loading-light')
    await S.theme('dark')
    report.stop = { button: await ev(`(() => { const el = document.querySelector('[data-testid="browser-pane-stop"]'); return el ? el.getAttribute('aria-label') : null })()`) }
    check('浏览器：加载中刷新按钮换成停止', report.stop.button === '停止' || report.stop.button === 'Stop', report.stop)
    report.hover.push(['browser-03-loading-hover-stop', await S.hover('[data-testid="browser-pane-stop"]', 1500)])
    await S.shot('browser-03-loading-hover-stop')
    await S.clip('browser-03-loading-hover-stop-zoom', '.v3-browser__main', 0)
    report.focus.push(['browser-03-loading-focus-stop', await kbd('[data-testid="browser-pane-stop"]', 'browser-03-loading-focus-stop')])
    await S.click('[data-testid="browser-pane-stop"]', 200)
    report.stop.stopped = await until('s.browserState.loading === false', 5000, 20)
    report.stop.reloadBack = await until(`!!document.querySelector('[data-testid="browser-pane-reload"]')`, 3000, 20)
    report.stop.focusKept = await ev(`document.activeElement?.getAttribute('data-testid') ?? null`)
    check('浏览器：点停止后加载结束、按钮回到刷新', report.stop.stopped && report.stop.reloadBack, report.stop)
    await sleep(500)
    await S.unhover()
    await S.clip('browser-03-stopped-toolbar', '.v3-browser__toolbar')
    await ev('document.activeElement?.blur?.()')

    await ev(`window.yan.browser.navigate(${JSON.stringify(deadUrl)})`)
    const proxyFailed = await until('!!s.browserState.loadError', 15000)
    await sleep(800)
    report.proxyFailure = await ev(`({ error: window.__yanStore.getState().browserState.loadError ?? null, title: document.querySelector('[data-testid="browser-pane-error-title"]')?.textContent ?? null, nativeVisible: window.__yanStore.getState().browserNativeVisible })`)
    check('浏览器：死端口显示砚的错误提示', proxyFailed && /端口没有服务在监听|nothing is listening/.test(report.proxyFailure.title ?? ''), report.proxyFailure)
    check('浏览器：加载失败时原生网页层隐藏', report.proxyFailure.nativeVisible === false, report.proxyFailure)
    await variants('browser-04-proxy-dead-port')
    await S.clip('browser-04-proxy-dead-port-status', '.v3-browser__main', 0)
    await ev(`window.yan.browser.navigate('https://example.invalid/')`)
    const failed = await until('s.browserState.loadError?.url?.startsWith("https://example.invalid")', 15000)
    check('浏览器：错误状态出现', failed)
    await sleep(800)
    await variants('browser-04-error')
    await S.clip('browser-04-error-status', '.v3-browser__main', 0)
    report.hover.push(['browser-04-error-hover-retry', await S.hover('[data-testid="browser-pane-retry"]', 900)])
    await S.shot('browser-04-error-hover-retry')
    await S.unhover()
    report.focus.push(['browser-04-error-focus-retry', await kbd('[data-testid="browser-pane-retry"]', 'browser-04-error-focus-retry')])
    await ev('document.activeElement?.blur?.()')

    await ev(`window.yan.browser.navigate(${JSON.stringify(urls[0])})`)
    await until('!s.browserState.loading && !s.browserState.loadError', 15000)
    for (const url of urls.slice(1)) {
      await ev(`window.yan.browser.newTab(${JSON.stringify(url)})`)
      await sleep(250)
    }
    await until(`(s.browserState.tabs ?? []).length >= ${urls.length}`, 20000)
    for (let i = 0; i < 12; i++) {
      const server = pageServer(`额外服务 ${i + 1}`, '#ffffff', '#111111')
      servers.push(server)
      await listen(server)
    }
    await iconServers()
    await until(`document.querySelectorAll('.v3-browser__tabcol [data-testid="browser-local-servers"] li').length >= 20`, 15000, 200)
    await sleep(1500)
    await S.shot('browser-05-tabs-collapsed-dark')
    await S.theme('light')
    await S.shot('browser-05-tabs-collapsed-light')
    await S.theme('dark')
    await S.narrow()
    report.narrowServers = await iconServers()
    await sleep(800)
    await S.shot('browser-05-tabs-collapsed-narrow')
    await S.clip('browser-05-tabs-collapsed-narrow-toolbar', '.v3-browser__toolbar', 0)
    await S.wide()
    await iconServers()
    await S.clip('browser-05-tabs-collapsed-column', '.v3-browser__tabcol', 0)
    report.collapsedServers = await ev(`(() => { const list = document.querySelector('.v3-browser__tabcol [data-testid="browser-local-servers-list"]'); return list ? { more: list.dataset.more ?? null, rows: list.children.length, scroll: list.scrollHeight, client: list.clientHeight } : null })()`)
    check('浏览器：收起态服务列表可滚动且有渐隐', report.collapsedServers?.more === '1', report.collapsedServers)
    await S.clip('browser-05-tabs-collapsed-servers', '.v3-browser__tabcol [data-testid="browser-local-servers"]', 6)
    await ev(`(() => { const list = document.querySelector('.v3-browser__tabcol [data-testid="browser-local-servers-list"]'); if (list) list.scrollTop = Math.round(list.scrollHeight / 2 - list.clientHeight / 2); return true })()`)
    await sleep(400)
    report.collapsedServers.midMore = await ev(`document.querySelector('.v3-browser__tabcol [data-testid="browser-local-servers-list"]')?.dataset.more ?? null`)
    await S.clip('browser-05-tabs-collapsed-servers-scrolled', '.v3-browser__tabcol [data-testid="browser-local-servers"]', 6)
    await ev(`(() => { const list = document.querySelector('.v3-browser__tabcol [data-testid="browser-local-servers-list"]'); if (list) list.scrollTop = list.scrollHeight; return true })()`)
    await sleep(400)
    report.collapsedServers.endMore = await ev(`document.querySelector('.v3-browser__tabcol [data-testid="browser-local-servers-list"]')?.dataset.more ?? null`)
    await S.clip('browser-05-tabs-collapsed-servers-end', '.v3-browser__tabcol [data-testid="browser-local-servers"]', 6)
    await ev(`(() => { const list = document.querySelector('.v3-browser__tabcol [data-testid="browser-local-servers-list"]'); if (list) list.scrollTop = 0; return true })()`)
    report.hover.push(['browser-05-tabs-peek', await S.hover('.v3-browser__tabcol [data-testid^="browser-pane-tab-select-"]', 1200)])
    await S.shot('browser-05-tabs-peek-dark')
    await S.unhover()
    await sleep(600)
    report.panelWidth = { user: await ev('window.__yanRightPanel.getState().width') }
    if (report.panelWidth.user < WIDE_PANEL) {
      await ev(`window.__yanRightPanel.getState().setWidth(${WIDE_PANEL})`)
      await sleep(1200)
      report.panelWidth.wide = await ev('window.__yanRightPanel.getState().width')
    }
    const pinned = await ev(`document.querySelector('[data-testid="browser-pane-tabs-toggle"]')?.getAttribute('aria-pressed')`)
    if (pinned !== 'true') await S.click('[data-testid="browser-pane-tabs-toggle"]', 900)
    await S.unhover()
    await settleServers()
    await variants('browser-06-tabs-pinned')
    await settleServers()
    await S.clip('browser-06-tabs-pinned-column', '.v3-browser__tabcol', 0)
    report.hover.push(['browser-06-tabs-pinned-hover-row', await S.hover('.v3-browser__tablist [data-testid^="browser-pane-tab-select-"]', 700, 2)])
    await S.shot('browser-06-tabs-pinned-hover-row')
    await S.clip('browser-06-tabs-pinned-hover-row-zoom', '.v3-browser__tablist', 4)
    await S.unhover()
    report.hover.push(['browser-06-hover-foot-import', await S.hover('.v3-browser__tabcol-foot [data-testid="browser-pane-import"]', 1500)])
    await S.shot('browser-06-hover-foot-import')
    await S.unhover()
    report.focus.push(['browser-06-focus-tab', await kbd('.v3-browser__tablist li:nth-child(2) [data-testid^="browser-pane-tab-select-"]', 'browser-06-tabs-pinned-focus-row')])
    report.focus.push(['browser-06-focus-reload', await kbd('[data-testid="browser-pane-reload"]', 'browser-06-focus-reload')])
    await ev('document.activeElement?.blur?.()')
    report.focus.push(['browser-06-focus-row-light', await kbdLight('.v3-browser__tablist li:nth-child(2) [data-testid^="browser-pane-tab-select-"]', 'browser-06-tabs-pinned-focus-row-light')])
    report.focus.push(['browser-06-focus-reload-light', await kbdLight('[data-testid="browser-pane-reload"]', 'browser-06-focus-reload-light')])
    report.hover.push(['browser-06-hover-reload', await S.hover('[data-testid="browser-pane-reload"]', 1500)])
    await S.shot('browser-06-hover-reload')
    await S.clip('browser-06-hover-reload-zoom', '.v3-browser__toolbar', 0)
    await S.unhover()
    report.hover.push(['browser-06-hover-viewport', await S.hover('[data-testid="browser-pane-viewport-menu"]', 1500)])
    await S.shot('browser-06-hover-viewport-tip')
    await S.unhover()
    await S.click('[data-testid="browser-pane-viewport-menu"]', 800)
    report.contrast = { viewportMenuDark: await S.textAudit('.ui-popover') }
    await S.shot('browser-07-viewport-menu-dark')
    await S.clip('browser-07-viewport-menu-dark-zoom', '.ui-popover', 6)
    await S.key('Escape')
    await S.theme('light')
    await S.click('[data-testid="browser-pane-viewport-menu"]', 800)
    report.contrast.viewportMenuLight = await S.textAudit('.ui-popover')
    await S.shot('browser-07-viewport-menu-light')
    await S.key('Escape')
    await S.theme('dark')
    await S.click('[data-testid="browser-pane-viewport-menu"]', 600)
    await S.click('[data-testid="browser-pane-layout-horizontal"]', 1200)
    await variants('browser-08-tabs-horizontal')
    await S.clip('browser-08-tabs-horizontal-row', '.v3-browser__tabrow', 0)
    await ev(`(() => { const strip = document.querySelector('[data-testid="browser-pane-htabs"]'); if (!strip) return false; const tabs = [...strip.querySelectorAll('[role="tab"]')]; const active = tabs.findIndex((n) => n.getAttribute('aria-selected') === 'true'); const pick = tabs[active > 0 ? active - 1 : active + 1]; pick?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); return !!pick })()`)
    await sleep(500)
    const visibleTab = await ev(`(() => { const strip = document.querySelector('[data-testid="browser-pane-htabs"]'); if (!strip) return null; const box = strip.getBoundingClientRect(); const tabs = [...strip.querySelectorAll('[role="tab"]')].filter((n) => n.getBoundingClientRect().width > 0); const index = tabs.findIndex((n) => { const r = n.getBoundingClientRect(); return r.left >= box.left && r.right <= box.right && n.getAttribute('aria-selected') !== 'true' }); return index < 0 ? null : { index, label: tabs[index].textContent.slice(0, 30) } })()`)
    report.horizontalHover = visibleTab
    check('浏览器：横排悬停目标在可视区内', !!visibleTab, visibleTab)
    report.hover.push(['browser-08-tabs-horizontal-hover', await S.hover('[data-testid="browser-pane-htabs"] [role="tab"]', 1200, visibleTab?.index ?? 0)])
    await S.shot('browser-08-tabs-horizontal-hover')
    await S.clip('browser-08-tabs-horizontal-hover-zoom', '.v3-browser__tabrow', 0)
    await S.unhover()
    await sleep(300)
    await S.hover('[data-testid="browser-pane-htabs"] [role="tab"]', 250, visibleTab?.index ?? 0)
    await S.clip('browser-08-tabs-horizontal-hover-near', '.v3-browser__tabrow', 0)
    await S.unhover()
    await S.click('[data-testid="browser-pane-servers-menu"]', 600)
    await until(`!!document.querySelector('.v3-browser__servers-pop [data-testid="browser-local-servers"][data-ready="1"]')`, 15000, 100)
    await sleep(600)
    report.contrast.serversPopoverDark = await S.textAudit('.v3-browser__servers-pop')
    await S.shot('browser-09-servers-popover-dark')
    await S.clip('browser-09-servers-popover', '.v3-browser__servers-pop', 4)
    await S.key('Escape')
    await until(`!document.querySelector('.v3-browser__servers-pop')`, 5000, 50)
    await sleep(400)
    await S.click('[data-testid="browser-pane-viewport-menu"]', 600)
    if (!(await until(`!!document.querySelector('[data-testid="browser-pane-layout-vertical"]')`, 3000, 50))) {
      await S.unhover()
      await sleep(400)
      await S.click('[data-testid="browser-pane-viewport-menu"]', 800)
    }
    await S.click('[data-testid="browser-pane-layout-vertical"]', 1000)
    if (pinned !== 'true') await S.click('[data-testid="browser-pane-tabs-toggle"]', 600)
    if (report.panelWidth.wide) {
      await ev(`window.__yanRightPanel.getState().setWidth(${report.panelWidth.user})`)
      await sleep(1200)
    }
    await ev(`window.yan.browser.setViewport('mobile')`)
    await sleep(1500)
    await S.shot('browser-10-viewport-mobile-dark')
    await ev(`window.yan.browser.setViewport('responsive')`)
    await sleep(800)
    report.audit.browser = await S.audit('[data-testid="browser-pane"]')
    report.fonts = await ev(`(() => { const f = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).fontFamily.slice(0, 80) : null }; return { address: f('[data-testid="browser-pane-address"]'), code: f('.v3-stream code, .v3-stream pre'), mono: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim().slice(0, 80), ui: getComputedStyle(document.body).fontFamily.slice(0, 60) } })()`)
    report.missedTargets = S.missed
  } finally {
    for (const server of servers) try { server?.close() } catch {}
  }
}

const WIDE_PANEL = 883

const buttonState = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const cs = getComputedStyle(el); return { bg: cs.backgroundColor, image: cs.backgroundImage.slice(0, 120), hover: el.matches(':hover'), pressed: el.hasAttribute('data-pressed') } })()`

const BEFORE_CSS = {
  buttons: "@layer primitives { @media (hover: hover) { .ui-btn--secondary:hover:not([data-disabled]):not([data-pending]) { background: var(--hover); } } .ui-btn.ui-btn--secondary[data-pressed]:not([data-disabled]):not([data-pending]) { background: var(--press); } }",
  rail: "@layer primitives { @media (hover: hover) { .ui-rail-row[data-action-reveal='hover'] .ui-rail-row__value { min-width: 0; } .ui-rail-row[data-action-reveal='hover']:not([data-icon-only='1']):is(:hover, :focus-within) .ui-btn.ui-rail-row__main { padding-inline-end: calc(var(--size-btn-sm) + var(--s-2)); } } }"
}

const injectBefore = (ev, name) => process.env.UI_POLISH_BEFORE === '1' ? ev(`(() => { const style = document.createElement('style'); style.dataset.uiPolishBefore = ${JSON.stringify(name)}; style.textContent = ${JSON.stringify(BEFORE_CSS[name])}; document.head.append(style); return true })()`) : null

async function buttonsTarget({ kit: S, ev, sleep, check, report }) {
  report.buttons = {}
  await injectBefore(ev, 'buttons')
  await ev('window.__yanStore.getState().openSettings()')
  await sleep(1200)
  for (const [nav, selector, name] of [['data', '[data-testid="v3-data-backup-verify"]', 'buttons-01-data-verify'], ['about', '[data-testid="v3-about-update-check"]', 'buttons-02-about-update']]) {
    await ev(`document.querySelector('[data-testid="v3-settings-nav-${nav}"]')?.click()`)
    await sleep(1200)
    await ev(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center' })`)
    await sleep(500)
    for (const theme of ['dark', 'light']) {
      await S.theme(theme)
      await S.unhover()
      const rest = await ev(buttonState(selector))
      await S.clip(`${name}-${theme}-rest`, selector, 16)
      await S.hover(selector, 500)
      const hover = await ev(buttonState(selector))
      await S.clip(`${name}-${theme}-hover`, selector, 16)
      const r = await ev(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })()`)
      await kitPress(S, r, async () => {
        report.buttons[`${name}-${theme}-pressed`] = await ev(buttonState(selector))
        await S.clip(`${name}-${theme}-pressed`, selector, 16)
      })
      report.buttons[`${name}-${theme}`] = { rest, hover }
      check(`次要按钮悬停叠在原底色上（${name} ${theme}）`, /gradient/.test(hover?.image ?? '') && hover?.bg === rest?.bg, { rest, hover })
    }
  }
  await S.theme('dark')
  await S.unhover()
  await S.key('Escape')
  await sleep(800)
}

async function kitPress(S, point, during) {
  const cdpCall = S.cdpCall
  await cdpCall('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  await cdpCall('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await new Promise((done) => setTimeout(done, 250))
  await during()
  await cdpCall('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2, button: 'left', buttons: 1 })
  await cdpCall('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 2, y: 2, button: 'left', clickCount: 1 })
  await new Promise((done) => setTimeout(done, 300))
}

const rowBox = (selector) => `(() => { const row = document.querySelector(${JSON.stringify(selector)}); if (!row) return null; const label = row.querySelector('.ui-rail-row__label'); const main = row.querySelector('.ui-rail-row__main'); const action = row.querySelector('.ui-rail-row__action'); const value = row.querySelector('.ui-rail-row__value'); const w = (el) => el ? Math.round(el.getBoundingClientRect().width * 10) / 10 : null; const right = (el) => el ? Math.round(el.getBoundingClientRect().right * 10) / 10 : null; const left = (el) => el ? Math.round(el.getBoundingClientRect().left * 10) / 10 : null; return { label: w(label), labelRight: right(label), labelText: label?.textContent?.slice(0, 40) ?? null, clipped: label ? label.scrollWidth > label.clientWidth : null, padEnd: main ? getComputedStyle(main).paddingRight : null, actionLeft: left(action), value: w(value) } })()`

async function railTarget({ kit: S, ev, cdp, sleep, until, check, report, newSession, turn, box }) {
  report.rail = {}
  await injectBefore(ev, 'rail')
  const friction = listFrictionShots().find((item) => item.viewport && item.viewport.width >= 1600 && item.sessionId)
  if (friction) await openFrictionSession(cdp, until, friction.sessionId)
  const rows = [['branch', '.v3-sessionbar li:has([data-testid="wb-rail-branch"])', '[data-testid="wb-rail-branch"]']]
  const hasBranch = await until(`!!document.querySelector('[data-testid="wb-rail-branch"]')`, 8000, 100)
  if (!hasBranch) {
    await newSession(box.project)
    await until(`!!document.querySelector('[data-testid="wb-rail-branch"]')`, 8000, 100)
  }
  await sleep(800)
  const shootRow = async (name, rowSel) => {
    await S.unhover()
    const rest = await ev(rowBox(rowSel))
    await S.clip(`${name}-rest`, rowSel, 8)
    await S.hover(rowSel, 700)
    const hover = await ev(rowBox(rowSel))
    await S.clip(`${name}-hover`, rowSel, 8)
    await S.unhover()
    report.rail[name] = { rest, hover }
    const noOverlap = hover?.actionLeft == null || hover.labelRight == null || hover.labelRight <= hover.actionLeft + 0.5
    check(`概览行悬停不再多截标题（${name}）`, !!rest && !!hover && Math.abs((rest.label ?? 0) - (hover.label ?? 0)) <= 0.5 && noOverlap, { rest, hover })
  }
  for (const [kind, rowSel] of rows) {
    if (await ev(`!!document.querySelector(${JSON.stringify(rowSel)})`)) await shootRow(`rail-01-${kind}`, rowSel)
  }
  await S.clip('rail-01-overview', '.v3-sessionbar', 0)
  const git = (args) => spawnSync('git', ['-c', 'user.name=ui-polish', '-c', 'user.email=ui-polish@example.invalid', ...args], { cwd: box.project, encoding: 'utf8' })
  if (git(['rev-parse', '--is-inside-work-tree']).status !== 0) {
    git(['init', '-b', 'feature/ui-polish-overview-branch-with-a-very-long-name'])
    git(['add', '-A'])
    git(['commit', '-m', 'fixture', '--allow-empty'])
  }
  await newSession(box.project)
  await turn('WRITES 产出文件行')
  const outputs = await until(`document.querySelectorAll('[data-testid="wb-rail-outputs"] li').length > 0`, 15000, 100)
  check('概览：产出文件行出现', outputs)
  await sleep(800)
  if (outputs) {
    await shootRow('rail-02-output', '[data-testid="wb-rail-outputs"] li')
    await S.theme('light')
    await S.hover('[data-testid="wb-rail-outputs"] li', 700)
    await S.clip('rail-02-output-hover-light', '[data-testid="wb-rail-outputs"]', 8)
    await S.unhover()
    await S.theme('dark')
  }
  const branchNow = '.v3-sessionbar li:has([data-testid="wb-rail-branch"])'
  if (await ev(`!!document.querySelector(${JSON.stringify(branchNow)})`)) await shootRow('rail-03-branch-project', branchNow)
  await S.clip('rail-03-overview', '.v3-sessionbar', 0)
}

function makeFixtures(base) {
  const empty = join(base, 'empty-folder')
  const gone = join(base, 'gone-folder')
  const many = join(base, 'many-files')
  mkdirSync(empty, { recursive: true })
  mkdirSync(join(gone, 'src'), { recursive: true })
  writeFileSync(join(gone, 'README.md'), '# gone\n')
  mkdirSync(many, { recursive: true })
  for (let i = 0; i < 24; i++) mkdirSync(join(many, `module-${String(i).padStart(2, '0')}`), { recursive: true })
  const kinds = ['csv', 'json', 'md', 'ts', 'png', 'log']
  for (let i = 0; i < 2400; i++) writeFileSync(join(many, `record-${String(i).padStart(4, '0')}-${['导出', 'snapshot', 'a-rather-long-generated-file-name-for-truncation'][i % 3]}.${kinds[i % kinds.length]}`), '')
  const partial = join(base, 'partial-folder')
  mkdirSync(join(partial, 'locked-dir'), { recursive: true })
  mkdirSync(join(partial, 'open-dir'), { recursive: true })
  writeFileSync(join(partial, 'locked-dir', 'secret.txt'), 'x\n')
  writeFileSync(join(partial, 'open-dir', 'notes.md'), '# notes\n')
  writeFileSync(join(partial, 'README.md'), '# partial\n')
  return { empty, gone, many, partial }
}

async function filesTarget({ kit: S, ev, sleep, until, check, log, report, newSession, runDir }) {
  report.files = {}
  const fx = makeFixtures(join(runDir, 'files-fixtures'))
  const repo = process.cwd()
  const openFiles = async () => {
    await ev(`(() => { const rp = window.__yanRightPanel.getState(); rp.open({ id: 'files', kind: 'files' }); rp.setOpen(true); return true })()`)
    return until(`!!document.querySelector('[data-testid="v3-files"]')`, 15000, 100)
  }
  const panel = '[data-testid="rp-column-0"]'
  const variants = async (name, { light = true, narrow = true } = {}) => {
    await S.shot(`${name}-dark`)
    await S.clip(`${name}-panel`, panel, 0)
    if (light) { await S.theme('light'); await S.clip(`${name}-light`, panel, 0); await S.theme('dark') }
    if (narrow) { await S.narrow(); await S.shot(`${name}-narrow`); await S.wide() }
  }
  const row = (path) => `[data-testid="v3-files-row-${path}"]`
  const bringRow = async (path) => {
    if (await ev(`(() => { const el = document.querySelector(${JSON.stringify(row(path))}); if (!el) return false; el.scrollIntoView({ block: 'nearest' }); return true })()`)) { await sleep(150); return true }
    await ev(`(() => { const el = document.querySelector('[data-testid="v3-files-tree"]'); if (el) el.scrollTop = 0; return true })()`)
    await sleep(150)
    for (let i = 0; i < 40; i++) {
      const found = await ev(`(() => { const el = document.querySelector(${JSON.stringify(row(path))}); if (!el) return false; el.scrollIntoView({ block: 'center' }); return true })()`)
      if (found) { await sleep(200); return true }
      await ev(`(() => { const el = document.querySelector('[data-testid="v3-files-tree"]'); if (el) el.scrollTop += Math.round(el.clientHeight * 0.7); return true })()`)
      await sleep(150)
    }
    return false
  }
  const expand = async (path) => {
    if (!(await bringRow(path))) return false
    if (await ev(`document.querySelector(${JSON.stringify(row(path))})?.getAttribute('aria-expanded')`) === 'true') return true
    await S.click(row(path), 300)
    return until(`document.querySelector(${JSON.stringify(row(path))})?.getAttribute('aria-expanded') === 'true' && !document.querySelector('[data-testid="v3-files-state-${path}"]')`, 8000, 100)
  }
  const filter = '[data-testid="v3-files-search-input"] input'
  const setQuery = async (text) => {
    await ev(`(() => { const el = document.querySelector(${JSON.stringify(filter)}); if (!el) return false; el.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await sleep(200)
    if (text) await S.typeText(text, 200)
  }
  const resultsDone = () => until(`!!document.querySelector('[data-testid="v3-files-search-results"]:not([aria-busy="true"]), [data-testid="v3-files-search-empty"], [data-testid="v3-files-search-hint"], [data-testid="v3-files-search-pattern"], [data-testid="v3-files-search-failed"]')`, 15000, 100)
  const mouse = async (type, point, extra = {}) => S.cdpCall('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, ...extra })
  const center = (selector, index = 0) => ev(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((n) => n.getBoundingClientRect().width > 0)[${index}]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  const modClick = async (selector, modifiers) => {
    const p = await center(selector)
    if (!p) return false
    await mouse('mouseMoved', p, { modifiers })
    await mouse('mousePressed', p, { button: 'left', clickCount: 1, modifiers })
    await mouse('mouseReleased', p, { button: 'left', clickCount: 1, modifiers })
    await sleep(300)
    return true
  }
  const rightClick = async (selector) => {
    const p = await center(selector)
    if (!p) return false
    await mouse('mouseMoved', p)
    await mouse('mousePressed', p, { button: 'right', clickCount: 1 })
    await mouse('mouseReleased', p, { button: 'right', clickCount: 1 })
    await sleep(700)
    return true
  }

  await newSession(repo)
  check('文件：面板打开', await openFiles())
  await until(`document.querySelectorAll('[data-tree-path]').length > 10`, 15000, 100)
  await sleep(800)
  for (const path of ['src', 'src/renderer', 'src/renderer/src', 'src/renderer/src/features', 'src/renderer/src/features/files']) {
    if (!(await expand(path))) log('展开失败', path)
  }
  await bringRow('src/renderer/src/features/files')
  await ev(`(() => { const el = document.querySelector(${JSON.stringify(row('src/renderer/src/features/files'))}); const tree = document.querySelector('[data-testid="v3-files-tree"]'); if (el && tree) tree.scrollTop += el.getBoundingClientRect().top - tree.getBoundingClientRect().top - 120; return true })()`)
  await sleep(800)
  await variants('files-01-tree', { narrow: false })
  report.audit.files = await S.audit('[data-testid="v3-files"]')
  const fileRow = row('src/renderer/src/features/files/FilesPane.tsx')
  report.hover.push(['files-02-hover-row', await S.hover(fileRow, 700)])
  await S.clip('files-02-hover-row', '[data-testid="v3-files-tree"]', 0)
  await S.unhover()
  await ev(`document.querySelector(${JSON.stringify(row('src/renderer/src/features/files/FileBreadcrumbs.tsx'))})?.focus()`)
  await S.key('ArrowDown')
  report.focus.push(['files-02-focus-row', await ev(`document.activeElement?.getAttribute('data-tree-path') ?? null`)])
  await S.clip('files-02-focus-row', '[data-testid="v3-files-tree"]', 0)
  await S.theme('light')
  await S.clip('files-02-focus-row-light', '[data-testid="v3-files-tree"]', 0)
  await S.theme('dark')
  await modClick(row('src/renderer/src/features/files/files-model.ts'), 2)
  await modClick(row('src/renderer/src/features/files/files-search.ts'), 2)
  await modClick(row('src/renderer/src/features/files/files-text.ts'), 2)
  report.files.selected = await ev(`document.querySelectorAll('[data-tree-path][data-selected="1"]').length`)
  await S.unhover()
  await S.clip('files-02-multiselect', '[data-testid="v3-files-tree"]', 0)
  await rightClick(row('src/renderer/src/features/files/files-text.ts'))
  report.files.menuMulti = await ev(`document.querySelector('[data-testid="v3-files-menu"]')?.getAttribute('aria-label') ?? null`)
  await S.shot('files-03-menu-multi-dark')
  await S.key('Escape')
  await sleep(400)
  await rightClick(row('src/renderer/src/features/files/FilesRowMenu.tsx'))
  report.files.selectedAfterRightClick = await ev(`[...document.querySelectorAll('[data-tree-path][data-selected="1"]')].map((n) => n.getAttribute('data-tree-path'))`)
  await S.clip('files-03-menu-target-tree', '[data-testid="v3-files-tree"]', 0)
  report.files.menuSingle = await ev(`[...document.querySelectorAll('[data-testid="v3-files-menu"] [role="menuitem"]')].map((n) => n.textContent.trim())`)
  await S.shot('files-03-menu-dark')
  await S.clip('files-03-menu-zoom', '[data-testid="v3-files-menu"]', 8)
  await S.hover('[data-testid="v3-files-menu"] [role="menuitem"]', 900, 1)
  await S.shot('files-03-menu-copy-sub-dark')
  await S.theme('light')
  await sleep(300)
  await S.shot('files-03-menu-copy-sub-light')
  await S.theme('dark')
  await S.key('Escape')
  await S.key('Escape')
  await sleep(400)
  if (await ev(`!!document.querySelector('[data-testid="v3-files-preview"]:not([hidden])')`)) log('单击打开了预览')

  await setQuery('button')
  report.files.nameSearch = await resultsDone()
  await sleep(600)
  await variants('files-04-search-name', { narrow: false })
  report.hover.push(['files-04-search-hover', await S.hover('.v3-files-result', 700, 2)])
  await S.clip('files-04-search-hover', '[data-testid="v3-files-search-results"]', 0)
  await S.unhover()
  await S.click(filter, 300)
  await S.key('ArrowDown')
  report.focus.push(['files-04-search-focus', await ev(`document.activeElement?.getAttribute('data-testid') ?? null`)])
  await S.clip('files-04-search-focus', '[data-testid="v3-files-search-results"]', 0)
  await setQuery('')
  await sleep(500)
  const busyPause = await S.pauseAt('if (result.error?.code === "superseded") {', async () => {
    await ev(`(() => { const el = document.querySelector(${JSON.stringify(filter)}); el.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'filesrow'); el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  })
  report.files.searchBusyPaused = busyPause?.paused ?? false
  if (busyPause?.paused) {
    await S.shotPaused('files-04-search-busy-dark')
  }
  await busyPause?.resume()
  check('文件：搜索中状态拍到', report.files.searchBusyPaused)
  report.files.searchBusyAfter = await ev(`document.querySelector('[data-testid="v3-files-search-results"]')?.getAttribute('aria-busy') ?? 'no-results'`)
  await resultsDone()
  await setQuery('?useFilesSearch')
  report.files.contentSearch = await resultsDone()
  await sleep(800)
  await variants('files-04-search-content', { narrow: false })
  await setQuery('zzqqxxnomatch')
  await resultsDone()
  await sleep(500)
  await S.clip('files-04-search-empty', panel, 0)
  report.hover.push(['files-04-search-empty-hover', await S.hover('[data-testid="v3-files-search-contents"]', 600)])
  await S.clip('files-04-search-empty-hover', panel, 0)
  await S.unhover()
  await setQuery('?')
  await resultsDone()
  await sleep(400)
  await S.clip('files-04-search-hint', panel, 0)
  await setQuery('?(')
  await S.click('[data-testid="v3-files-search-regexp"]', 300)
  await resultsDone()
  await sleep(600)
  await S.clip('files-04-search-pattern', panel, 0)
  await S.click('[data-testid="v3-files-search-regexp"]', 300)
  await setQuery('')
  await sleep(600)

  await bringRow('src/renderer/src/features/files/FilesPane.tsx')
  await S.click(fileRow, 1500)
  report.files.preview = await until(`!!document.querySelector('[data-testid="v3-files-preview"]:not([hidden])')`, 10000, 100)
  await S.unhover()
  await sleep(1200)
  await variants('files-05-preview', { narrow: false })
  if (await ev(`!!document.querySelector('[data-testid="v3-files-crumb-fold"]')`)) {
    await S.click('[data-testid="v3-files-crumb-fold"]', 700)
    await S.shot('files-05-preview-crumb-fold')
    await S.key('Escape')
    await sleep(300)
  }
  const narrowWidth = await ev(`window.__yanRightPanel.getState().width`)
  if (!(await ev(`!!document.querySelector('[data-testid="v3-files-crumb-browse"]')`))) {
    await ev(`(window.__yanRightPanel.getState().setWidth(883), true)`)
    await sleep(900)
    report.files.browseWidth = 883
  }
  if (await ev(`!!document.querySelector('[data-testid="v3-files-crumb-browse"]')`)) {
    await S.click('[data-testid="v3-files-crumb-browse"]', 900)
    report.files.browseMenu = await ev(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((n) => n.textContent.trim()).slice(0, 8)`)
    await S.shot('files-05-preview-crumb-browse')
    await S.key('Escape')
    await sleep(300)
  } else log('浏览子文件夹按钮未出现')
  await ev(`(window.__yanRightPanel.getState().setWidth(${narrowWidth}), true)`)
  await sleep(600)
  report.files.crumbs = await ev(`[...document.querySelectorAll('[data-testid="v3-files-crumbs"] .v3-files-crumb')].map((n) => n.textContent)`)
  await S.narrow()
  await S.shot('files-05-preview-narrow')
  await S.wide()
  await sleep(600)
  await openFiles()
  report.files.treeAfterResize = await ev(`document.querySelector(${JSON.stringify(row('src'))})?.getAttribute('aria-expanded') ?? null`)
  await S.narrow()
  await openFiles()
  await sleep(600)
  await S.shot('files-01-tree-narrow')
  if (await ev(`!!document.querySelector(${JSON.stringify(filter)})`)) {
    await setQuery('button')
    await resultsDone()
    await sleep(600)
    await S.shot('files-04-search-name-narrow')
    await setQuery('')
  }
  await S.wide()
  await sleep(600)

  await newSession(fx.empty)
  await openFiles()
  report.files.empty = await until(`!!document.querySelector('[data-testid="v3-files-empty"]')`, 10000, 100)
  await sleep(600)
  await variants('files-06-empty', { narrow: false })

  const loadingPause = await S.pauseAt('type: "loadOk"', async () => { await newSession(fx.many); await openFiles() }, { lineOffset: -1 })
  report.files.loadingPaused = loadingPause?.paused ?? false
  if (loadingPause?.paused) {
    await S.shotPaused('files-07-loading-dark')
  }
  await loadingPause?.resume()
  check('文件：加载状态拍到', report.files.loadingPaused)
  await until(`s.session?.cwd === ${JSON.stringify(fx.many)}`, 8000)
  await until(`document.querySelectorAll('[data-tree-path]').length > 10`, 15000, 100)
  await sleep(600)
  await S.clip('files-08-many-top', panel, 0)
  await ev(`(() => { const el = document.querySelector('[data-testid="v3-files-tree"]'); if (el) el.scrollTop = el.scrollHeight; return true })()`)
  await sleep(800)
  report.files.partialRow = await ev(`!!document.querySelector('[data-testid="v3-files-state-root"], .v3-files-staterow')`)
  await S.clip('files-08-many-bottom', panel, 0)
  await S.theme('light')
  await S.clip('files-08-many-bottom-light', panel, 0)
  await S.theme('dark')

  const denied = spawnSync('icacls', [fx.gone, '/deny', `${process.env.USERNAME}:(RD)`], { encoding: 'utf8' })
  report.files.denied = denied.status
  let errored = false
  try {
    await newSession(fx.gone)
    await openFiles()
    errored = await until(`!!document.querySelector('[data-testid="v3-files-error"]')`, 10000, 100)
  } catch (error) {
    log('读失败会话', String(error))
  }
  report.files.error = errored
  check('文件：读失败状态出现', errored)
  await sleep(600)
  await variants('files-09-error', { narrow: false })
  report.hover.push(['files-09-error-hover-retry', await S.hover('[data-testid="v3-files-error"] button', 700)])
  await S.clip('files-09-error-hover-retry', panel, 0)
  await S.unhover()
  await ev(`document.querySelector('[data-testid="v3-files-error"] button')?.focus()`)
  await S.key('Tab', { shift: true })
  await S.key('Tab')
  report.focus.push(['files-09-error-focus-retry', await ev(`document.activeElement?.textContent ?? null`)])
  await S.clip('files-09-error-focus-retry', panel, 0)
  await ev('document.activeElement?.blur?.()')
  spawnSync('icacls', [fx.gone, '/remove:d', process.env.USERNAME], { encoding: 'utf8' })

  const lockedDir = join(fx.partial, 'locked-dir')
  report.files.subDenied = spawnSync('icacls', [lockedDir, '/deny', `${process.env.USERNAME}:(RD)`], { encoding: 'utf8' }).status
  try {
    await newSession(fx.partial)
    await openFiles()
    await until(`!!document.querySelector(${JSON.stringify(row('locked-dir'))})`, 10000, 100)
    await sleep(400)
    await S.click(row('locked-dir'), 300)
    report.files.subError = await until(`!!document.querySelector('[data-testid="v3-files-state-locked-dir"]')`, 8000, 100)
    report.files.subErrorText = await ev(`document.querySelector('[data-testid="v3-files-state-locked-dir"]')?.textContent ?? null`)
    await S.unhover()
    await sleep(500)
    await S.clip('files-10-subdir-error-panel', panel, 0)
    await S.theme('light')
    await S.clip('files-10-subdir-error-light', panel, 0)
    await S.theme('dark')
  } catch (error) {
    log('子目录读失败', String(error))
  }
  spawnSync('icacls', [lockedDir, '/remove:d', process.env.USERNAME], { encoding: 'utf8' })
  check('文件：子目录读失败行出现', !!report.files.subError)

  await ev(`(window.__yanStore.setState({ peekedSessionId: 'ui-polish-no-cwd', peekedPath: 'C:/ui-polish-no-cwd.jsonl' }), true)`)
  report.files.none = await until(`!!document.querySelector('[data-testid="v3-files-invalid"]')`, 8000, 100)
  await sleep(500)
  if (report.files.none) {
    await S.clip('files-11-no-cwd-panel', panel, 0)
    await S.theme('light')
    await S.clip('files-11-no-cwd-light', panel, 0)
    await S.theme('dark')
  }
  await ev(`(window.__yanStore.setState({ peekedSessionId: null, peekedPath: null }), true)`)
  check('文件：无工作目录状态出现', report.files.none)
}

function makePdf(pages) {
  const objects = []
  const kids = pages.map((_, index) => `${3 + index * 2} 0 R`).join(' ')
  objects.push('<< /Type /Catalog /Pages 2 0 R >>')
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`)
  const font = 3 + pages.length * 2
  pages.forEach((lines, index) => {
    const body = lines.map((line, row) => `BT /F1 ${row === 0 ? 22 : 12} Tf 72 ${760 - row * 26} Td (${line}) Tj ET`).join('\n')
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${4 + index * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`)
    objects.push(`<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`)
  })
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let out = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out))
    out += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(out)
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return out
}

function makePreviewFixtures(base, repo) {
  mkdirSync(join(base, 'docs'), { recursive: true })
  const files = {
    code: join(base, 'docs', 'files-model.ts'),
    markdown: join(base, 'README.md'),
    image: join(base, 'docs', 'screenshot.png'),
    photo: join(base, 'docs', 'blossom.webp'),
    pdf: join(base, 'docs', 'report.pdf'),
    html: join(base, 'docs', 'landing.html'),
    binary: join(base, 'docs', 'data.bin'),
    archive: join(base, 'docs', 'bundle.zip'),
    locked: join(base, 'docs', 'locked.txt'),
    missing: join(base, 'docs', 'deleted-file.ts'),
    large: join(base, 'docs', 'server.log')
  }
  copyFileSync(join(repo, 'src/renderer/src/features/files/files-model.ts'), files.code)
  writeFileSync(files.markdown, '# 预览测试\n\n这是一段 **Markdown** 正文，用来看阅读模式的排版。\n\n- 列表第一项\n- 列表第二项，带 `inline code`\n\n```ts\nexport const answer = 42\n```\n\n| 列 | 值 |\n| --- | --- |\n| a | 1 |\n| b | 2 |\n')
  copyFileSync(join(repo, '.tmp/ui-polish/files-round-1/after/files-01-tree-dark.png'), files.image)
  copyFileSync(join(repo, 'src/renderer/src/assets/wallpapers/blossom.webp'), files.photo)
  writeFileSync(files.pdf, makePdf([['Inkstone preview test', 'Page one of a generated PDF.', 'Second line of body text.'], ['Page two', 'More text on the second page.']]))
  writeFileSync(files.html, '<!doctype html><html><head><meta charset="utf-8"><title>Landing</title><style>body{font-family:system-ui;margin:0;padding:32px;background:#f6f3ee;color:#222}h1{font-size:28px}button{padding:8px 16px;border-radius:8px;border:0;background:#c2410c;color:#fff}</style></head><body><h1>Landing page</h1><p>A small HTML file for the canvas preview.</p><button>Get started</button></body></html>\n')
  const bytes = Buffer.alloc(48 * 1024)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 131 + 7) & 0xff
  writeFileSync(files.binary, bytes)
  writeFileSync(files.archive, Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]))
  writeFileSync(files.locked, 'secret\n')
  const line = (i) => `2026-11-15T10:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z INFO request ${i} handled in ${(i * 7) % 300}ms path=/api/items/${i}\n`
  let big = ''
  for (let i = 0; i < 60000; i++) big += line(i)
  writeFileSync(files.large, big)
  return files
}

async function previewTarget({ kit: S, ev, sleep, until, check, log, report, newSession, runDir }) {
  report.preview = {}
  const repo = process.cwd()
  const base = join(runDir, 'preview-fixtures')
  const fx = makePreviewFixtures(base, repo)
  const panel = '[data-testid="rp-column-0"]'
  const slash = (path) => path.replaceAll('\\', '/')
  const settle = () => until(`!!document.querySelector('[data-testid="v3-preview"]') && !document.querySelector('[data-testid="v3-preview-loading"], [data-testid="v3-preview-pdf-loading"]')`, 15000, 100)
  const open = async (path, wait = 1200) => {
    const target = slash(path)
    await ev(`(() => { const rp = window.__yanRightPanel.getState(); rp.open({ id: ${JSON.stringify('file:' + target)}, kind: 'file', path: ${JSON.stringify(target)} }); rp.setOpen(true); return true })()`)
    const ok = await settle()
    await S.unhover()
    await sleep(wait)
    return ok
  }
  const variants = async (name, { light = true, full = true } = {}) => {
    if (full) await S.shot(`${name}-dark`)
    await S.clip(`${name}-panel`, panel, 0)
    if (light) { await S.theme('light'); await S.clip(`${name}-light`, panel, 0); await S.theme('dark') }
  }
  const visible = (testid) => ev(`!!document.querySelector('[data-testid="${testid}"]')`)
  const states = async () => ev(`[...document.querySelectorAll('[data-testid^="v3-preview-"], [data-testid^="v3-code-"], [data-testid^="v3-pdf-"], [data-testid^="v3-html-"], [data-testid^="v3-canvas-"]')].filter((n) => n.getBoundingClientRect().width > 0).map((n) => n.getAttribute('data-testid')).filter((v, i, a) => a.indexOf(v) === i).slice(0, 30)`)
  const width = await ev(`window.__yanRightPanel.getState().width`)
  report.preview.panelWidth = width

  await newSession(base)
  report.preview.code = await open(fx.code)
  report.preview.codeStates = await states()
  await variants('preview-01-code')
  report.audit.preview = await S.audit('[data-testid="v3-preview"]')
  report.hover.push(['preview-01-code-hover-line', await S.hover('[data-testid="v3-code-view"] .v3-code-line', 700, 6)])
  report.preview.commentButton = await ev(`(() => { const el = document.querySelector('[data-testid="v3-code-view"] .v3-code-line:hover .v3-code-comment'); return el ? { label: el.getAttribute('aria-label'), opacity: getComputedStyle(el).opacity } : null })()`)
  await S.clip('preview-01-code-hover-line', panel, 0)
  await S.unhover()
  await ev(`(window.__yanRightPanel.getState().setWidth(883), true)`)
  await sleep(900)
  await S.unhover()
  await S.clip('preview-01-code-wide', panel, 0)
  await ev(`(window.__yanRightPanel.getState().setWidth(${width}), true)`)
  await sleep(900)

  report.preview.markdown = await open(fx.markdown)
  report.preview.markdownStates = await states()
  await variants('preview-02-markdown')

  report.preview.image = await open(fx.image, 1500)
  report.preview.imageStates = await states()
  await variants('preview-03-image')
  report.preview.photo = await open(fx.photo, 1500)
  await S.clip('preview-03-photo-panel', panel, 0)

  report.preview.pdf = await open(fx.pdf, 2500)
  await until(`!!document.querySelector('[data-testid="v3-pdf-page"]')`, 15000, 100)
  await sleep(1200)
  report.preview.pdfStates = await states()
  await variants('preview-04-pdf')

  report.preview.html = await open(fx.html, 2500)
  report.preview.htmlStates = await states()
  report.preview.canvasOn = await visible('v3-html-canvas')
  await variants('preview-05-html')
  if (await visible('v3-preview-canvas-toggle')) {
    await S.click('[data-testid="v3-preview-canvas-toggle"]', 2500)
    await S.unhover()
    report.preview.htmlToggledStates = await states()
    await variants(`preview-05-html-${report.preview.canvasOn ? 'frame' : 'canvas'}`, { light: false })
    await ev(`(window.__yanRightPanel.getState().setWidth(883), true)`)
    await sleep(1500)
    await S.unhover()
    await S.clip(`preview-05-html-${report.preview.canvasOn ? 'frame' : 'canvas'}-wide`, panel, 0)
    await ev(`(window.__yanRightPanel.getState().setWidth(${width}), true)`)
    await sleep(900)
    await S.click('[data-testid="v3-preview-canvas-toggle"]', 1500)
  }

  report.preview.binary = await open(fx.binary)
  report.preview.binaryStates = await states()
  await variants('preview-06-binary')
  report.hover.push(['preview-06-binary-hover-open', await S.hover('[data-testid="v3-preview-binary"] button', 700)])
  await S.clip('preview-06-binary-hover-open', panel, 0)
  await S.unhover()
  await open(fx.archive)
  await S.clip('preview-06-archive-panel', panel, 0)

  const denied = spawnSync('icacls', [fx.locked, '/deny', `${process.env.USERNAME}:(R)`], { encoding: 'utf8' })
  report.preview.lockDenied = denied.status
  report.preview.locked = await open(fx.locked)
  report.preview.lockedStates = await states()
  await variants('preview-07-unreadable')
  spawnSync('icacls', [fx.locked, '/remove:d', process.env.USERNAME], { encoding: 'utf8' })
  report.preview.missing = await open(fx.missing)
  report.preview.missingStates = await states()
  await variants('preview-07-missing', { full: false })

  report.preview.large = await open(fx.large, 2000)
  report.preview.largeStates = await states()
  report.preview.largeAlign = await ev(`(() => { const textLeft = (el) => { if (!el) return null; const range = document.createRange(); range.selectNodeContents(el); const rects = [...range.getClientRects()]; return rects.length ? Math.round(rects[0].left * 10) / 10 : null }; const note = [...document.querySelectorAll('[data-testid="v3-code-capped"]')].find((n) => n.getBoundingClientRect().width > 0); const crumb = [...document.querySelectorAll('[data-testid="v3-preview-pathbar"] .v3-files-crumb')].find((n) => n.getBoundingClientRect().width > 0); return { note: textLeft(note), crumb: textLeft(crumb), bg: note ? getComputedStyle(note).backgroundColor : null } })()`)
  await variants('preview-08-large')
  report.preview.largeScrolled = await ev(`(() => { const el = [...document.querySelectorAll('.v3-code-scroller')].find((n) => n.getBoundingClientRect().width > 0); if (el) el.scrollTop = el.scrollHeight; return el ? { top: Math.round(el.scrollTop), height: el.scrollHeight } : null })()`)
  await sleep(900)
  await S.clip('preview-08-large-bottom', panel, 0)
  report.preview.condensedAlign = await ev(`(() => { const vis = (sel) => [...document.querySelectorAll(sel)].find((n) => n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().height > 0); const textLeft = (el) => { if (!el) return null; const range = document.createRange(); range.selectNodeContents(el); const rects = [...range.getClientRects()].filter((r) => r.width > 0); return rects.length ? Math.round(rects[0].left * 10) / 10 : null }; const nums = [...document.querySelectorAll('.v3-code-number')].filter((n) => n.getBoundingClientRect().height > 0); const widest = nums.reduce((a, n) => (n.textContent.length > (a?.textContent.length ?? 0) ? n : a), null); return { condensed: !!document.querySelector('[data-testid="v3-preview-pathbar"] .ui-condense[data-condensed]'), compact: textLeft(vis('[data-testid="v3-preview-pathbar"] .v3-preview-pathname[data-compact]')), note: textLeft(vis('[data-testid="v3-code-capped"]')), number: textLeft(widest), gutter: vis('.v3-code-gutter') ? Math.round(vis('.v3-code-gutter').getBoundingClientRect().left * 10) / 10 : null } })()`)

  await ev(`(window.__yanRightPanel.getState().setWidth(360), true)`)
  await sleep(900)
  for (const [name, path] of [['code', fx.code], ['pdf', fx.pdf], ['html', fx.html], ['binary', fx.binary], ['missing', fx.missing], ['large', fx.large]]) {
    await open(path, name === 'pdf' || name === 'html' ? 2500 : 1200)
    await S.clip(`preview-09-w360-${name}`, panel, 0)
  }
  spawnSync('icacls', [fx.locked, '/deny', `${process.env.USERNAME}:(R)`], { encoding: 'utf8' })
  await open(fx.locked)
  await S.clip('preview-09-w360-unreadable', panel, 0)
  spawnSync('icacls', [fx.locked, '/remove:d', process.env.USERNAME], { encoding: 'utf8' })
  await ev(`(window.__yanRightPanel.getState().setWidth(${width}), true)`)
  await sleep(900)
  report.preview.emptyStates = await ev(`(() => { window.__yanRightPanel.getState().closeAll?.(); return true })()`)
  await sleep(600)
  check('预览：代码、图片、PDF、二进制都打开了', !!(report.preview.code && report.preview.image && report.preview.pdf && report.preview.binary))
}

async function browserFinalTarget({ kit: S, ev, until, sleep, log, check, report }) {
  report.browserFinal = {}
  const R = report.browserFinal
  const servers = []
  const urls = []
  for (const [title, bg, fg] of PAGES.slice(0, 8)) {
    const server = pageServer(title, bg, fg)
    servers.push(server)
    urls.push(`http://127.0.0.1:${await listen(server)}/`)
  }
  for (let i = 0; i < 12; i++) {
    const server = pageServer(`额外服务 ${i + 1}`, '#ffffff', '#111111')
    servers.push(server)
    await listen(server)
  }
  const slow = createServer((_req, res) => { setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>slow</title>slow') }, 20000) })
  servers.push(slow)
  const slowUrl = `http://127.0.0.1:${await listen(slow)}/slow-first-load`
  const probe = createServer()
  const deadPort = await listen(probe)
  await new Promise((done) => probe.close(done))
  const deadUrl = `http://127.0.0.1:${deadPort}/`
  const left = (selector) => ev(`[...document.querySelectorAll(${JSON.stringify(selector)})].filter((n) => n.getBoundingClientRect().width > 0).slice(0, 3).map((n) => Math.round(n.getBoundingClientRect().left * 10) / 10)`)
  try {
    R.width = await ev('window.__yanRightPanel.getState().width')
    await ev(`(() => { const rp = window.__yanRightPanel.getState(); rp.open({ id: 'browser', kind: 'browser' }); rp.setOpen(true); return true })()`)
    await until(`!!document.querySelector('[data-testid="browser-pane-not-open"], [data-testid="browser-pane"]')`, 15000)
    await until(`document.querySelectorAll('[data-testid="browser-local-servers"][data-ready="1"] [data-testid="browser-local-server-row"]').length >= 16`, 20000, 200)
    await sleep(800)
    R.gateList = await ev(`(() => { const list = document.querySelector('[data-testid="browser-local-servers-list"]'); return list ? { more: list.dataset.more ?? null, scroll: list.scrollHeight, client: list.clientHeight } : null })()`)
    check('收尾 B4：空状态服务列表溢出时有渐隐', R.gateList?.more === '1', R.gateList)
    const importPause = await S.pauseAt('window.yan.browser.loginImportStatus(importId)', () => S.setHookState('[data-testid="browser-pane-not-open"]', [false, null, 'waiting', null], 1, 'ui-polish-import'))
    R.importPaused = importPause?.paused ?? false
    if (importPause?.paused) await S.shotPaused('bf-01-import-waiting-dark')
    await importPause?.resume()
    await sleep(600)
    await S.clip('bf-01-gate-servers', '[data-testid="browser-local-servers"]', 8)
    R.gateLeft = { title: await left('[data-testid="browser-pane-not-open"] .v3-local-servers__title'), icon: await left('[data-testid="browser-pane-not-open"] [data-testid="browser-local-server-row"] .ui-rail-row__lead') }

    await S.click('[data-testid="browser-pane-open"]', 1500)
    await until(`!!document.querySelector('[data-testid="browser-start-page"]')`, 15000)
    await sleep(600)
    void ev(`window.yan.browser.navigate(${JSON.stringify(slowUrl)})`)
    R.loading = await until('s.browserState.loading === true', 8000, 20)
    await sleep(400)
    await ev(`document.querySelector('[data-testid="browser-pane-stop"]')?.focus()`)
    await S.key('Tab', { shift: true })
    await S.key('Tab')
    await sleep(900)
    R.stopTooltip = await ev(`(() => { const tip = document.querySelector('[role="tooltip"]'); const btn = document.querySelector('[data-testid="browser-pane-stop"]'); if (!tip || !btn) return null; const t = tip.getBoundingClientRect(); const b = btn.getBoundingClientRect(); return { text: tip.textContent, tipRight: Math.round(t.right), btnLeft: Math.round(b.left), tipTop: Math.round(t.top), btnTop: Math.round(b.top) } })()`)
    await S.shot('bf-02-stop-tooltip-dark')
    await S.clip('bf-02-stop-tooltip-toolbar', '.v3-browser__main', 0)
    await S.click('[data-testid="browser-pane-stop"]', 300)
    R.stopped = await until('s.browserState.loading === false', 5000, 20)
    await sleep(800)
    await S.unhover()
    R.addressAfterStop = await ev(`(() => { const el = document.querySelector('[data-testid="browser-pane-address"] input, input[data-testid="browser-pane-address"]'); return el ? el.value : null })()`)
    R.stateUrlAfterStop = await ev('window.__yanStore.getState().browserState.url')
    check('收尾 B3：停止首次加载后地址栏保留请求的网址', R.addressAfterStop === slowUrl, R)
    await ev('document.activeElement?.blur?.()')
    await S.clip('bf-03-stopped-toolbar', '.v3-browser__main', 0)

    await ev(`window.yan.browser.navigate(${JSON.stringify(deadUrl)})`)
    await until('!!s.browserState.loadError', 15000)
    await sleep(900)
    R.deadPort = await ev(`({ title: document.querySelector('[data-testid="browser-pane-error-title"]')?.textContent ?? null, reason: document.querySelector('[data-testid="browser-pane-error-reason"]')?.textContent ?? null, titleLines: (() => { const el = document.querySelector('[data-testid="browser-pane-error-title"]'); if (!el) return null; return Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight || '20')) })() })`)
    R.addressAfterDead = await ev(`document.querySelector('input[data-testid="browser-pane-address"]')?.value ?? null`)
    check('定稿 BF-1：停止后补回的网址不粘住，后续非地址栏导航时地址栏跟随新网址', R.addressAfterDead === deadUrl, { address: R.addressAfterDead, deadUrl })
    await ev(`window.yan.browser.navigate(${JSON.stringify(urls[1])})`)
    await until('!s.browserState.loading && !s.browserState.loadError', 15000)
    await sleep(600)
    R.addressAfterNext = await ev(`document.querySelector('input[data-testid="browser-pane-address"]')?.value ?? null`)
    check('定稿 BF-1：再导航到正常网页，地址栏也跟随', R.addressAfterNext === urls[1], { address: R.addressAfterNext, url: urls[1] })
    await S.clip('bf-04b-next-page-toolbar', '.v3-browser__toolbar', 0)
    await ev(`window.yan.browser.navigate(${JSON.stringify(deadUrl)})`)
    await until('!!s.browserState.loadError', 15000)
    await sleep(600)
    check('收尾：错误条标题只写「打不开该页面」，原因另起一行', /端口没有服务在监听|nothing is listening/.test(R.deadPort.reason ?? '') && !/监听|listening/.test(R.deadPort.title ?? ''), R.deadPort)
    await S.shot('bf-04-dead-port-dark')
    await S.clip('bf-04-dead-port-status', '[data-testid="browser-pane-status"]', 0)
    await S.theme('light')
    await S.clip('bf-04-dead-port-status-light', '[data-testid="browser-pane-status"]', 0)
    await S.theme('dark')

    await ev(`window.yan.browser.navigate(${JSON.stringify(urls[0])})`)
    await until('!s.browserState.loading && !s.browserState.loadError', 15000)
    for (const url of urls.slice(1)) {
      await ev(`window.yan.browser.newTab(${JSON.stringify(url)})`)
      await sleep(250)
    }
    await until(`(s.browserState.tabs ?? []).length >= ${urls.length}`, 20000)
    await ev(`window.__yanRightPanel.getState().setWidth(${WIDE_PANEL})`)
    await sleep(1200)
    const pinned = await ev(`document.querySelector('[data-testid="browser-pane-tabs-toggle"]')?.getAttribute('aria-pressed')`)
    if (pinned !== 'true') await S.click('[data-testid="browser-pane-tabs-toggle"]', 900)
    await S.unhover()
    await until(`!!document.querySelector('.v3-browser__tabcol [data-testid="browser-local-servers"][data-ready="1"]')`, 15000, 100)
    await sleep(800)
    await S.clip('bf-05-tabcol', '.v3-browser__tabcol', 0)
    R.tabcolLeft = { title: await left('.v3-browser__tabcol-title'), tabMark: await left('.v3-browser__tablist .ui-rail-row__lead'), serversTitle: await left('.v3-browser__tabcol .v3-local-servers__title'), serverIcon: await left('.v3-browser__tabcol [data-testid="browser-local-server-row"] .ui-rail-row__lead') }
    await S.click('[data-testid="browser-pane-viewport-menu"]', 700)
    await S.click('[data-testid="browser-pane-layout-horizontal"]', 1200)
    await S.unhover()
    await S.click('[data-testid="browser-pane-servers-menu"]', 600)
    await until(`!!document.querySelector('.v3-browser__servers-pop [data-testid="browser-local-servers"][data-ready="1"]')`, 15000, 100)
    await sleep(600)
    await S.clip('bf-06-servers-popover', '.v3-browser__servers-pop', 4)
    R.popLeft = { title: await left('.v3-browser__servers-pop .v3-local-servers__title'), icon: await left('.v3-browser__servers-pop [data-testid="browser-local-server-row"] .ui-rail-row__lead') }
    await S.key('Escape')
    await until(`!document.querySelector('.v3-browser__servers-pop')`, 5000, 50)
    await sleep(400)
    await ev(`(() => { const strip = document.querySelector('[data-testid="browser-pane-htabs"]'); if (strip) strip.scrollLeft = strip.scrollWidth; return true })()`)
    await sleep(300)
    await ev(`(() => { const strip = document.querySelector('[data-testid="browser-pane-htabs"]'); const tabs = [...strip.querySelectorAll('[role="tab"]')]; tabs[2]?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); return true })()`)
    await sleep(500)
    R.htabs = await ev(`(() => { const strip = document.querySelector('[data-testid="browser-pane-htabs"]'); const tab = strip.querySelectorAll('.ui-ptab')[2]; const s = strip.getBoundingClientRect(); const t = tab.getBoundingClientRect(); const icon = tab.querySelector('.ui-ptab__close').getBoundingClientRect(); return { stripLeft: Math.round(s.left), tabLeft: Math.round(t.left), iconLeft: Math.round(icon.left), scrollLeft: Math.round(strip.scrollLeft) } })()`)
    check('收尾 B1：滚入后标签图标完整可见', R.htabs.iconLeft >= R.htabs.stripLeft, R.htabs)
    await S.hover('[data-testid="browser-pane-htabs"] .ui-ptab', 300, 2)
    await S.clip('bf-07-htabs-scrolled-hover', '.v3-browser__tabrow', 0)
    await S.unhover()
    await S.clip('bf-07-htabs-scrolled', '.v3-browser__tabrow', 0)
    await ev(`document.querySelector('[data-testid="browser-pane-htabs"] [role="tab"][aria-selected="true"]')?.focus()`)
    await S.key('Home')
    await sleep(600)
    R.htabsHome = await ev(`(() => { const strip = document.querySelector('[data-testid="browser-pane-htabs"]'); const tab = strip.querySelector('.ui-ptab'); const s = strip.getBoundingClientRect(); const icon = tab.querySelector('.ui-ptab__close').getBoundingClientRect(); return { stripLeft: Math.round(s.left), iconLeft: Math.round(icon.left), scrollLeft: Math.round(strip.scrollLeft) } })()`)
    await S.clip('bf-07-htabs-home-focus', '.v3-browser__tabrow', 0)
    await ev('document.activeElement?.blur?.()')
    await S.click('[data-testid="browser-pane-viewport-menu"]', 700)
    await S.click('[data-testid="browser-pane-layout-vertical"]', 1000)
    if (pinned !== 'true') await S.click('[data-testid="browser-pane-tabs-toggle"]', 600)
    await ev(`window.__yanRightPanel.getState().setWidth(${R.width})`)
    await sleep(1000)
  } finally {
    for (const server of servers) try { server?.close() } catch {}
  }
}

function makeBranchFixtures(base) {
  const run = (cwd, args) => spawnSync('git', ['-c', 'user.name=ui-polish', '-c', 'user.email=ui-polish@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' })
  const commit = (dir, message) => { run(dir, ['add', '-A']); run(dir, ['commit', '-q', '-m', message]) }
  const init = (name) => {
    const dir = join(base, name)
    mkdirSync(dir, { recursive: true })
    run(dir, ['init', '-q', '-b', 'main'])
    return dir
  }
  const single = init('single-repo')
  writeFileSync(join(single, 'README.md'), '# single\n')
  commit(single, 'init')

  const origin = init('origin-src')
  writeFileSync(join(origin, 'config.ts'), "export const mode = 'main'\n")
  writeFileSync(join(origin, 'README.md'), '# many\n')
  commit(origin, 'init')
  const remoteOnly = ['release/2026.11-hotfix-for-very-long-branch-names-in-the-picker', 'origin-only/docs', 'origin-only/中文分支名']
  for (const name of remoteOnly) { run(origin, ['branch', name]) }
  const bare = join(base, 'origin.git')
  run(base, ['clone', '-q', '--bare', origin, bare])
  const many = join(base, 'many-repo')
  run(base, ['clone', '-q', bare, many])
  const locals = []
  for (let i = 0; i < 36; i++) locals.push(i % 6 === 0 ? `feature/ui-polish-${String(i).padStart(2, '0')}-a-really-long-branch-name-that-should-be-truncated-nicely` : `${['feature', 'fix', 'chore', 'exp'][i % 4]}/task-${String(i).padStart(2, '0')}`)
  for (const name of locals) run(many, ['branch', name])
  run(many, ['checkout', '-q', '-b', 'feature/conflict'])
  writeFileSync(join(many, 'config.ts'), "export const mode = 'conflict'\n")
  commit(many, 'conflict branch')
  run(many, ['checkout', '-q', 'main'])
  run(many, ['branch', 'feature/same-config'])
  run(many, ['worktree', 'add', '-q', join(base, 'many-worktree'), 'chore/task-02'])
  writeFileSync(join(many, 'config.ts'), "export const mode = 'dirty-local-edit'\n")

  const detached = init('detached-repo')
  writeFileSync(join(detached, 'a.ts'), 'a\n')
  commit(detached, 'one')
  writeFileSync(join(detached, 'a.ts'), 'b\n')
  commit(detached, 'two')
  run(detached, ['branch', 'feature/detached-base'])
  run(detached, ['checkout', '-q', '--detach', 'HEAD~1'])
  return { single, many, detached, locals, remoteOnly }
}

async function branchesTarget({ kit: S, ev, sleep, until, check, log, report, newSession }) {
  report.branches = {}
  const R = report.branches
  const fx = makeBranchFixtures(mkdtempSync(join(tmpdir(), 'inkstone-ui-branches-')))
  R.fixtures = fx.single.replace(/[\\/]single-repo$/, '')
  check('分支：夹具不在当前仓库里', !R.fixtures.toLowerCase().startsWith(process.cwd().toLowerCase()), R.fixtures)
  const panel = '[data-testid="rp-column-0"]'
  const bar = '[data-testid="v3-sessionbar"]'
  const picker = '[data-testid="git-branch-picker"]'
  const width = await ev('window.__yanRightPanel.getState().width')
  R.panelWidth = width
  const openChanges = async () => {
    await ev(`(() => { const rp = window.__yanRightPanel.getState(); rp.open({ id: 'changes', kind: 'changes' }); rp.setOpen(true); return true })()`)
    await until(`!!document.querySelector('.changes-pane')`, 15000, 100)
    await until(`!document.querySelector('.changes-pane .ui-spinner') && !!document.querySelector('[data-testid="changes-branch"]')`, 15000, 150)
    await sleep(1200)
    await S.unhover()
  }
  const go = async (dir) => { await newSession(dir); await openChanges() }
  const openPicker = async () => {
    await S.click('[data-testid="changes-branch"]', 600)
    await until(`!!document.querySelector('${picker} [role="menu"], ${picker} form')`, 10000, 150)
    await sleep(500)
  }
  const closePicker = async () => {
    for (let i = 0; i < 3 && (await ev(`!!document.querySelector('${picker}')`)); i++) await S.key('Escape', { waitMs: 400 })
  }
  const pickerInfo = () => ev(`(() => { const p = document.querySelector('${picker}'); if (!p) return null; const r = p.getBoundingClientRect(); const items = [...p.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]')]; const clipped = items.filter((n) => { const t = n.querySelector('[class*="label"], span'); return t && t.scrollWidth > t.clientWidth + 1 }).length; return { rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], vw: innerWidth, vh: innerHeight, items: items.length, disabled: items.filter((n) => n.getAttribute('aria-disabled') === 'true').map((n) => n.innerText.replace(/\\s+/g, ' ').slice(0, 120)), clipped, text: p.innerText.replace(/\\s+/g, ' ').slice(0, 900), head: document.querySelector('[data-testid="changes-branch"]')?.innerText ?? null } })()`)
  const shotPicker = async (name) => {
    await S.unhover()
    await S.shot(`${name}-dark`)
    await S.clip(`${name}-pop`, picker, 16)
  }
  const clickItem = (text) => ev(`(() => { const p = document.querySelector('${picker}'); const n = [...(p?.querySelectorAll('[role^="menuitem"]') ?? [])].find((x) => x.innerText.includes(${JSON.stringify(text)})); if (!n) return false; n.scrollIntoView({ block: 'center' }); n.click(); return true })()`)
  const typeInto = async (selector, text) => {
    const ok = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); if ('select' in el) el.select(); return document.activeElement === el })()`)
    if (!ok) return false
    await S.key('Backspace', { waitMs: 100 })
    await S.typeText(text, 400)
    return true
  }

  await go(fx.single)
  R.singleHead = await ev(`document.querySelector('[data-testid="changes-branch"]')?.innerText ?? null`)
  await openPicker()
  R.single = await pickerInfo()
  await shotPicker('branches-01-single')
  await closePicker()

  await go(fx.many)
  R.manyHead = await ev(`(() => { const b = document.querySelector('[data-testid="changes-branch"]'); const r = b?.getBoundingClientRect(); const label = b?.querySelector('.changes-pane__clip'); return { text: b?.innerText ?? null, width: r ? Math.round(r.width) : null, clipped: label ? label.scrollWidth > label.clientWidth : null, count: document.querySelector('.changes-pane__count')?.offsetWidth ?? null, title: document.querySelector('.changes-pane__title')?.clientWidth ?? null, container: document.querySelector('.changes-pane__title')?.closest('.rp-sub-title')?.clientWidth ?? null } })()`)
  await S.clip('branches-02-many-head', panel, 0)
  await openPicker()
  R.many = await pickerInfo()
  await shotPicker('branches-02-many')
  await S.theme('light'); await sleep(400); await S.clip('branches-02-many-pop-light', picker, 16); await S.theme('dark'); await sleep(300)
  report.hover.push(['branches-02-busy-hover', await S.hover(`${picker} [role^="menuitem"][aria-disabled="true"]`, 1200, 0)])
  await S.clip('branches-02-busy-hover', picker, 16)
  await S.unhover()
  await ev(`(() => { const m = document.querySelector('${picker} [role="menu"]'); if (!m) return false; const s = [m, ...m.querySelectorAll('*')].find((n) => n.scrollHeight > n.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(n).overflowY)) || m.parentElement; s.scrollTop = s.scrollHeight; return true })()`)
  await sleep(500)
  await S.clip('branches-03-remote-pop', picker, 16)
  R.remote = await pickerInfo()
  await typeInto(`${picker} input`, 'release')
  await sleep(600)
  R.search = await pickerInfo()
  await S.clip('branches-04-search-pop', picker, 16)
  await typeInto(`${picker} input`, 'zzz-none')
  await sleep(600)
  R.searchEmpty = await pickerInfo()
  await S.clip('branches-04-search-empty-pop', picker, 16)
  await typeInto(`${picker} input`, '')
  await sleep(300)

  await clickItem('新建分支')
  await until(`!!document.querySelector('${picker} form')`, 5000, 150)
  await sleep(400)
  R.createDefault = await pickerInfo()
  await S.clip('branches-05-create-pop', picker, 16)
  for (const [shot, name] of [['branches-05-create-exists', 'main'], ['branches-05-create-dots', 'bad..name'], ['branches-05-create-space', 'has space'], ['branches-05-create-dash', '-leading']]) {
    await typeInto(`[data-testid="git-branch-name"] input`, name)
    await sleep(500)
    R[shot] = await pickerInfo()
    await S.clip(`${shot}-pop`, picker, 16)
  }
  await closePicker()

  await openPicker()
  R.switchConflictClicked = await clickItem('feature/conflict')
  R.switchFailed = await until(`!!document.querySelector('${picker} .gitflow-branch__failure, ${picker} [role="alert"]')`, 15000, 200)
  await sleep(600)
  R.switchFailure = await pickerInfo()
  await shotPicker('branches-06-switch-failed')
  await S.theme('light'); await sleep(400); await S.clip('branches-06-switch-failed-pop-light', picker, 16); await S.theme('dark'); await sleep(300)
  check('分支：切换失败拍到', R.switchFailed, R.switchFailure?.text?.slice(0, 200))
  R.showFilesButton = await ev(`!!document.querySelector('${picker} [data-testid="git-failure-show-files"]')`)
  if (R.showFilesButton) {
    await S.click(`${picker} [data-testid="git-failure-show-files"]`, 1200)
    R.showFilesResult = await ev(`(() => ({ pickerOpen: !!document.querySelector('${picker}'), active: document.querySelector('.changes-pane [aria-current="true"], .changes-pane [data-active="1"], .changes-pane [aria-selected="true"]')?.innerText?.trim().slice(0, 80) ?? null }))()`)
    await S.unhover()
    await S.clip('branches-06-show-files-panel', panel, 0)
  }
  await closePicker()

  await openPicker()
  const switchAt = Date.now()
  R.switchDirtyClicked = await clickItem('feature/same-config')
  R.headUpdated = await until(`(document.querySelector('[data-testid="changes-branch"]')?.innerText ?? '').includes('same-config')`, 10000, 100)
  R.headUpdatedMs = Date.now() - switchAt
  await sleep(300)
  R.afterDirtySwitch = { picker: await pickerInfo(), toast: await ev(`[...document.querySelectorAll('[role="status"], [role="alert"]')].map((n) => n.innerText.trim()).filter(Boolean).slice(0, 4)`), head: await ev(`document.querySelector('[data-testid="changes-branch"]')?.innerText ?? null`) }
  await S.shot('branches-07-dirty-switched-dark')
  await S.clip('branches-07-dirty-switched-panel', panel, 0)
  await closePicker()

  await ev(`(window.__yanRightPanel.getState().setOpen(false), true)`)
  await sleep(1200)
  if (await ev(`!!document.querySelector(${JSON.stringify(bar)})`)) {
    await ev(`document.querySelector('[data-testid="wb-rail-branch"]')?.scrollIntoView({ block: 'center' })`)
    await sleep(300)
    await S.clip('branches-08-rail-many', bar, 0)
    R.railMany = await ev(`document.querySelector('[data-testid="wb-rail-branch"]')?.innerText ?? null`)
  } else R.railMany = 'no-bar'
  await ev(`(window.__yanRightPanel.getState().setOpen(true), true)`)
  await sleep(800)

  await go(fx.detached)
  R.detachedHead = await ev(`(() => { const b = document.querySelector('[data-testid="changes-branch"]'); const r = b?.getBoundingClientRect(); const label = b?.querySelector('.changes-pane__clip'); return { text: b?.innerText ?? null, width: r ? Math.round(r.width) : null, clipped: label ? label.scrollWidth > label.clientWidth : null } })()`)
  await S.clip('branches-09-detached-head', panel, 0)
  await openPicker()
  R.detached = await pickerInfo()
  await shotPicker('branches-09-detached')
  await clickItem('新建分支')
  await sleep(600)
  R.detachedCreate = await pickerInfo()
  await S.clip('branches-09-detached-create-pop', picker, 16)
  await closePicker()
  await ev(`(window.__yanRightPanel.getState().setOpen(false), true)`)
  await sleep(1200)
  if (await ev(`!!document.querySelector(${JSON.stringify(bar)})`)) {
    await S.clip('branches-09-rail-detached', bar, 0)
    R.railDetached = await ev(`document.querySelector('[data-testid="wb-rail-branch"]')?.innerText ?? null`)
  }
  await ev(`(window.__yanRightPanel.getState().setOpen(true), true)`)
  await sleep(800)

  const other = width === 869 ? 360 : 869
  await ev(`(window.__yanRightPanel.getState().setWidth(${other}), true)`)
  await sleep(1000)
  await go(fx.many)
  await openPicker()
  R.manyOther = await pickerInfo()
  await shotPicker(`branches-10-many-w${other}`)
  await closePicker()
  await ev(`(window.__yanRightPanel.getState().setWidth(${width}), true)`)
  await sleep(800)
}

function makeChangesFixtures(base, repo) {
  const run = (cwd, args) => spawnSync('git', ['-c', 'user.name=ui-polish', '-c', 'user.email=ui-polish@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' })
  const init = (name) => {
    const dir = join(base, name)
    mkdirSync(dir, { recursive: true })
    run(dir, ['init', '-q', '-b', 'main'])
    return dir
  }
  const commit = (dir, message) => { run(dir, ['add', '-A']); run(dir, ['commit', '-q', '-m', message]) }
  const lines = (n, tag) => Array.from({ length: n }, (_, i) => `export const value${i} = '${tag}-${i}'`).join('\n') + '\n'
  const plain = join(base, 'not-a-repo')
  mkdirSync(plain, { recursive: true })
  writeFileSync(join(plain, 'notes.md'), '# notes\n')

  const clean = init('clean-repo')
  writeFileSync(join(clean, 'README.md'), '# clean\n')
  commit(clean, 'init')

  const mixed = init('mixed-repo')
  mkdirSync(join(mixed, 'src', 'features', 'settings'), { recursive: true })
  mkdirSync(join(mixed, 'docs'), { recursive: true })
  writeFileSync(join(mixed, 'src', 'app.ts'), lines(60, 'app'))
  writeFileSync(join(mixed, 'src', 'features', 'settings', 'SettingsPanelWithAVeryLongComponentName.tsx'), lines(40, 'settings'))
  writeFileSync(join(mixed, 'src', 'old-name.ts'), lines(30, 'rename'))
  writeFileSync(join(mixed, 'docs', 'guide.md'), '# Guide\n\nSome text.\n')
  writeFileSync(join(mixed, 'remove-me.txt'), 'bye\n')
  commit(mixed, 'init')
  const app = lines(60, 'app').split('\n')
  app.splice(10, 3, "export const changed = 'yes'", "export const another = 'line'")
  app.splice(40, 0, '// 新增一行中文注释，看看 diff 里的中文排版', "export const added = 'new'")
  writeFileSync(join(mixed, 'src', 'app.ts'), app.join('\n'))
  writeFileSync(join(mixed, 'src', 'features', 'settings', 'SettingsPanelWithAVeryLongComponentName.tsx'), lines(40, 'settings').replace("'settings-5'", "'settings-five'"))
  run(mixed, ['mv', 'src/old-name.ts', 'src/new-name.ts'])
  run(mixed, ['rm', '-q', 'remove-me.txt'])
  writeFileSync(join(mixed, 'docs', 'new-page.md'), '# 新页面\n\n这是新加的文档。\n')
  run(mixed, ['add', 'docs/new-page.md'])
  writeFileSync(join(mixed, 'untracked.log'), 'temp\n')

  const many = init('many-repo')
  for (let i = 0; i < 400; i++) {
    const dir = join(many, 'pkg', `module-${String(Math.floor(i / 20)).padStart(2, '0')}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `file-${String(i).padStart(3, '0')}.ts`), lines(8, `m${i}`))
  }
  commit(many, 'init')
  for (let i = 0; i < 400; i++) {
    const file = join(many, 'pkg', `module-${String(Math.floor(i / 20)).padStart(2, '0')}`, `file-${String(i).padStart(3, '0')}.ts`)
    writeFileSync(file, lines(8, `m${i}`).replace(`'m${i}-3'`, `'m${i}-three'`))
  }

  const long = init('long-repo')
  writeFileSync(join(long, 'generated.ts'), lines(4000, 'old'))
  commit(long, 'init')
  writeFileSync(join(long, 'generated.ts'), lines(4000, 'new'))

  const conflict = init('conflict-repo')
  writeFileSync(join(conflict, 'config.ts'), "export const mode = 'base'\nexport const level = 1\n")
  commit(conflict, 'init')
  run(conflict, ['checkout', '-q', '-b', 'feature'])
  writeFileSync(join(conflict, 'config.ts'), "export const mode = 'feature'\nexport const level = 2\n")
  commit(conflict, 'feature')
  run(conflict, ['checkout', '-q', 'main'])
  writeFileSync(join(conflict, 'config.ts'), "export const mode = 'main'\nexport const level = 3\n")
  commit(conflict, 'main change')
  run(conflict, ['merge', 'feature'])

  const binary = init('binary-repo')
  copyFileSync(join(repo, 'resources/bot-icons/claude-rest.png'), join(binary, 'icon.png'))
  writeFileSync(join(binary, 'data.bin'), Buffer.from([0, 1, 2, 3, 255, 254]))
  writeFileSync(join(binary, 'README.md'), '# bin\n')
  commit(binary, 'init')
  copyFileSync(join(repo, 'resources/bot-icons/claude-done.png'), join(binary, 'icon.png'))
  writeFileSync(join(binary, 'data.bin'), Buffer.from([9, 8, 7, 6, 5, 0, 0, 1]))
  copyFileSync(join(repo, 'resources/bot-icons/codex-ask.png'), join(binary, 'new-icon.png'))
  writeFileSync(join(binary, 'README.md'), '# bin\n\nchanged\n')

  const broken = init('broken-index-repo')
  writeFileSync(join(broken, 'a.ts'), 'a\n')
  commit(broken, 'init')
  writeFileSync(join(broken, 'a.ts'), 'b\n')
  writeFileSync(join(broken, '.git', 'index'), 'this is not an index file')

  const headless = init('broken-head-repo')
  writeFileSync(join(headless, 'a.ts'), 'a\n')
  commit(headless, 'init')
  writeFileSync(join(headless, '.git', 'HEAD'), 'garbage\n')

  return { plain, clean, mixed, many, long, conflict, binary, broken, headless }
}

async function changesTarget({ kit: S, ev, sleep, until, check, log, report, newSession, runDir }) {
  report.changes = {}
  const R = report.changes
  const fx = makeChangesFixtures(mkdtempSync(join(tmpdir(), 'inkstone-ui-changes-')), process.cwd())
  R.fixtures = fx.plain.replace(/[\\/]not-a-repo$/, '')
  const panel = '[data-testid="rp-column-0"]'
  const width = await ev('window.__yanRightPanel.getState().width')
  R.panelWidth = width
  const openChanges = async () => {
    await ev(`(() => { const rp = window.__yanRightPanel.getState(); rp.open({ id: 'changes', kind: 'changes' }); rp.setOpen(true); return true })()`)
    return until(`!!document.querySelector('.changes-pane')`, 15000, 100)
  }
  const settle = async (ms = 1500) => {
    await until(`!document.querySelector('.changes-pane .ui-notice [aria-busy="true"], .changes-pane .ui-spinner')`, 15000, 150)
    await sleep(ms)
    await S.unhover()
  }
  const variants = async (name, { light = true, full = true } = {}) => {
    if (full) await S.shot(`${name}-dark`)
    await S.clip(`${name}-panel`, panel, 0)
    if (light) { await S.theme('light'); await S.clip(`${name}-light`, panel, 0); await S.theme('dark') }
  }
  const visibleText = () => ev(`(() => { const el = document.querySelector('.changes-pane'); return el ? el.innerText.slice(0, 400) : null })()`)
  const testids = () => ev(`[...document.querySelectorAll('.changes-pane [data-testid]')].filter((n) => n.getBoundingClientRect().width > 0).map((n) => n.getAttribute('data-testid')).filter((v, i, a) => a.indexOf(v) === i).slice(0, 40)`)
  const scrollPane = (to) => ev(`(() => { const els = [...document.querySelectorAll('.changes-pane *')].filter((n) => n.scrollHeight > n.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(n).overflowY)); const el = els.sort((a, b) => b.clientHeight - a.clientHeight)[0]; if (!el) return null; el.scrollTop = ${to === 'end' ? 'el.scrollHeight' : to}; return { cls: el.className.slice(0, 60), top: Math.round(el.scrollTop), height: el.scrollHeight } })()`)

  const go = async (dir) => { await newSession(dir); return openChanges() }
  check('改动：夹具不在当前仓库里', !fx.plain.toLowerCase().startsWith(process.cwd().toLowerCase()), fx.plain)
  check('改动：面板打开', await go(fx.plain))
  await settle()
  R.plain = await visibleText()
  await variants('changes-00-not-repo', { full: false })

  await go(fx.clean)
  await settle()
  R.clean = await visibleText()
  await variants('changes-01-clean', { full: false })

  const loadingPause = await S.pauseAt('rememberSnapshot(cacheKey, entry)', async () => { await go(fx.mixed) }, { lineOffset: -1 })
  R.loadingPaused = loadingPause?.paused ?? false
  if (loadingPause?.paused) await S.shotPaused('changes-02-loading-dark')
  await loadingPause?.resume()
  check('改动：加载状态拍到', R.loadingPaused)

  await settle(2500)
  R.mixed = await testids()
  R.mixedText = await visibleText()
  await variants('changes-03-mixed')
  report.audit.changes = await S.audit('.changes-pane')
  R.cjk = await ev(`(() => { const hosts = [...document.querySelectorAll('.changes-pane *')].filter((n) => n.shadowRoot); let node = null; for (const h of hosts) { const w = document.createTreeWalker(h.shadowRoot, NodeFilter.SHOW_TEXT); let t; while ((t = w.nextNode())) { if (/新页面/.test(t.data)) { node = t; break } } if (node) break } if (!node) return { found: false, hosts: hosts.length }; const el = node.parentElement; const cs = getComputedStyle(el); const i = node.data.indexOf('新'); const adv = []; for (let k = 0; k < 3; k++) { const r = document.createRange(); r.setStart(node, i + k); r.setEnd(node, i + k + 1); adv.push(Math.round(r.getBoundingClientRect().width * 100) / 100) } const fs = parseFloat(cs.fontSize); const probe = (family) => { const s = document.createElement('span'); s.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-size:' + cs.fontSize + ';font-family:' + family; s.textContent = '新页面'; document.body.appendChild(s); const w = s.getBoundingClientRect().width; s.textContent = 'abc'; const a = s.getBoundingClientRect().width; s.remove(); return { cjk3: Math.round(w * 100) / 100, latin3: Math.round(a * 100) / 100 } }; return { found: true, tag: el.tagName, fontFamily: cs.fontFamily, fontSize: fs, letterSpacing: cs.letterSpacing, wordSpacing: cs.wordSpacing, features: cs.fontFeatureSettings, eastAsian: cs.fontVariantEastAsian, kerning: cs.fontKerning, advances: adv, ratio: Math.round(adv[0] / fs * 1000) / 1000, inDoc: probe(cs.fontFamily), yahei: probe('"Microsoft YaHei UI"'), mapleLoaded: document.fonts.check(cs.fontSize + ' "Maple Mono CN"', '新'), fontMono: getComputedStyle(document.documentElement).getPropertyValue('--font-mono') } })()`)
  report.hover.push(['changes-03-hover-row', await S.hover('.changes-file__head button', 700, 2)])
  await S.clip('changes-03-hover-row', panel, 0)
  await S.unhover()
  await ev(`document.querySelectorAll('.changes-file__head button')[1]?.focus()`)
  await S.key('Tab', { shift: true })
  await S.key('Tab')
  report.focus.push(['changes-03-focus-row', await ev(`document.activeElement?.textContent?.slice(0, 40) ?? null`)])
  await S.clip('changes-03-focus-row', panel, 0)
  await ev('document.activeElement?.blur?.()')
  await scrollPane('end')
  await sleep(600)
  await S.clip('changes-03-mixed-end', panel, 0)
  await scrollPane(0)
  if (await ev(`!!document.querySelector('[data-testid="changes-branch"]')`)) {
    await S.click('[data-testid="changes-branch"]', 1000)
    R.branchPicker = await ev(`!!document.querySelector('[data-testid="git-branch-picker"]')`)
    await S.shot('changes-04-branch-picker-dark')
    if (await ev(`!!document.querySelector('[data-testid="git-branch-create"]')`)) {
      await S.click('[data-testid="git-branch-create"]', 700)
      await S.shot('changes-04-branch-create-dark')
    }
    await S.key('Escape')
    await S.key('Escape')
    await sleep(500)
  }
  await ev(`(window.__yanRightPanel.getState().setWidth(360), true)`)
  await sleep(1200)
  await S.unhover()
  await S.clip('changes-03-mixed-w360', panel, 0)
  R.scopeNarrow = await ev(`(() => { const b = document.querySelector('.changes-pane__scope'); if (!b) return null; const icon = b.querySelector(':scope > .ui-btn__icon'); return { icon: !!icon && getComputedStyle(icon).display !== 'none', label: b.getAttribute('aria-label') } })()`)
  report.hover.push(['changes-03-w360-scope-tip', await S.hover('.changes-pane__scope', 1400, 0)])
  await S.clip('changes-03-w360-scope-tip', panel, 0)
  R.scopeTip = await ev(`(() => { const tip = [...document.querySelectorAll('[role="tooltip"]')].find((n) => n.getBoundingClientRect().width > 0); if (!tip) return null; const r = tip.getBoundingClientRect(); return { text: tip.innerText.slice(0, 200), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), vw: innerWidth } })()`)
  await S.shot('changes-03-w360-scope-tip-full')
  await S.unhover()
  await ev(`(window.__yanRightPanel.getState().setWidth(${width}), true)`)
  await sleep(1000)

  await go(fx.many)
  await settle(3000)
  R.many = await visibleText()
  R.manyBanner = await ev(`document.querySelector('.changes-pane__banner')?.textContent ?? null`)
  await variants('changes-05-many', { light: false })
  R.manyScroll = await scrollPane(4000)
  await sleep(800)
  await S.clip('changes-05-many-scrolled', panel, 0)

  await go(fx.long)
  await settle(3000)
  R.long = await visibleText()
  R.longBanner = await ev(`document.querySelector('.changes-pane__banner')?.textContent ?? null`)
  await variants('changes-06-long-diff', { light: false })
  R.longScroll = await scrollPane(6000)
  await sleep(900)
  await S.clip('changes-06-long-diff-scrolled', panel, 0)

  await go(fx.conflict)
  await settle(2000)
  R.conflict = await visibleText()
  await variants('changes-07-conflict')
  await ev(`(() => { const el = document.querySelector('[data-testid="git-commit-message"] textarea, textarea[data-testid="git-commit-message"]'); if (!el) return false; el.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, '合并 feature'); el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await sleep(500)
  R.conflictCommit = await ev(`({ disabled: document.querySelector('[data-testid="git-primary"]')?.hasAttribute('disabled') || document.querySelector('[data-testid="git-primary"]')?.getAttribute('aria-disabled') === 'true' || document.querySelector('[data-testid="git-primary"]')?.hasAttribute('data-disabled'), reason: document.querySelector('[data-testid="git-primary-reason"]')?.textContent ?? null })`)
  await S.clip('changes-07-conflict-commit', '[data-testid="git-commit-panel"]', 4)
  await ev('document.activeElement?.blur?.()')

  await go(fx.binary)
  await settle(2000)
  R.binary = await testids()
  if (await ev(`!!document.querySelector('[data-testid="changes-binary-group"] button')`)) {
    await S.click('[data-testid="changes-binary-group"] button', 1200)
    await S.unhover()
  }
  await variants('changes-08-binary')

  await go(fx.broken)
  await settle(2000)
  R.broken = await visibleText()
  R.brokenRetry = await ev(`!!document.querySelector('[data-testid="changes-git-error"] button')`)
  await variants('changes-09-git-failure-index')
  await go(fx.headless)
  await settle(2000)
  R.headless = await visibleText()
  R.headlessRetry = await ev(`!!document.querySelector('[data-testid="changes-git-error"] button')`)
  await variants('changes-09-git-failure-head', { full: false })
}

async function terminalTarget({ kit: S, ev, sleep, until, check, log, report, newSession, turn, cdp }) {
  report.terminal = {}
  const R = report.terminal
  const dir = mkdtempSync(join(tmpdir(), 'inkstone-ui-term-'))
  writeFileSync(join(dir, 'README.md'), '# terminal fixture\n')
  mkdirSync(join(dir, 'logs'))
  writeFileSync(join(dir, 'logs', 'app.log'), 'x'.repeat(4096))
  R.fixture = dir
  check('终端：夹具不在当前仓库里', !dir.toLowerCase().startsWith(process.cwd().toLowerCase()), dir)
  const panel = '[data-testid="rp-column-0"]'
  const bar = '[data-testid="v3-sessionbar"]'
  const width = await ev('window.__yanRightPanel.getState().width')
  R.panelWidth = width
  const openTerm = async () => {
    await ev(`(() => { const rp = window.__yanRightPanel.getState(); rp.open({ id: 'terminal', kind: 'terminal' }); rp.setOpen(true); return true })()`)
    return until(`!!document.querySelector('[data-testid="terminal-pane"]')`, 15000, 100)
  }
  const ready = async (ms = 2500) => {
    await until(`!!document.querySelector('[data-testid="terminal-pane"] .xterm') && !document.querySelector('[data-testid="terminal-busy"]')`, 20000, 150)
    await sleep(ms)
    await S.unhover()
  }
  const variants = async (name, { light = true, full = true, target = panel } = {}) => {
    if (full) await S.shot(`${name}-dark`)
    await S.clip(`${name}-panel`, target, 0)
    if (light) { await S.theme('light'); await sleep(400); await S.clip(`${name}-light`, target, 0); await S.theme('dark'); await sleep(300) }
  }
  const paneInfo = () => ev(`(() => { const p = document.querySelector('[data-testid="terminal-pane"]'); if (!p) return null; const tabs = [...p.querySelectorAll('[data-testid^="terminal-tab-"]')].map((t) => ({ label: t.innerText.replace(/\\s+/g, ' ').trim().slice(0, 60), agent: t.getAttribute('data-agent') === '1', title: (t.getAttribute('title') || t.querySelector('[title]')?.getAttribute('title') || '').slice(0, 120) })); const ids = [...p.querySelectorAll('[data-testid]')].filter((n) => n.getBoundingClientRect().width > 0).map((n) => n.getAttribute('data-testid')).filter((v, i, a) => a.indexOf(v) === i && !v.startsWith('terminal-tab-') && !v.startsWith('terminal-host-')); const head = p.closest('[data-testid="rp-column-0"]')?.querySelector('.rp-sub-title, .term-pane-bar'); return { tabs, ids, head: head ? head.innerText.replace(/\\s+/g, ' ').trim().slice(0, 200) : null, notes: [...p.querySelectorAll('.term-pane-note, .term-pane-exited, .term-pane-badge')].map((n) => n.innerText.trim()) } })()`)
  const focusTerm = () => ev(`(() => { const host = document.querySelector('[data-testid^="terminal-host-"][data-active="1"]'); const ta = host?.querySelector('textarea'); ta?.focus(); return document.activeElement === ta })()`)
  const typeLine = async (line, waitMs = 1500) => {
    if (!(await focusTerm())) return false
    await S.typeText(line, 200)
    await S.key('Enter', { waitMs })
    return true
  }
  const wheel = async (deltaY) => {
    const r = await ev(`(() => { const host = document.querySelector('[data-testid^="terminal-host-"][data-active="1"]'); if (!host) return null; const b = host.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })()`)
    if (!r) return false
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: r.x, y: r.y, deltaX: 0, deltaY })
    await sleep(600)
    return true
  }

  await newSession(dir)
  check('终端：面板打开', await openTerm())
  await ready()
  R.single = await paneInfo()
  R.edges = await ev(`(() => { const p = document.querySelector('[data-testid="terminal-pane"]'); const col = p?.closest('[data-testid="rp-column-0"]'); const host = p?.querySelector('[data-testid^="terminal-host-"][data-active="1"]'); const screen = host?.querySelector('.xterm-screen'); const tab = col?.querySelector('[data-testid="terminal-tabs"] .ui-ptab'); const tabIcon = tab?.querySelector('svg'); const bar = col?.querySelector('.term-tabbar'); const head = col?.querySelector('.rp-sub-title, .rp-tab, [role="tab"]'); const headIcon = head?.querySelector('svg'); const L = (n) => n ? Math.round(n.getBoundingClientRect().left * 10) / 10 : null; return { column: L(col), screen: L(screen), bar: L(bar), tab: L(tab), tabIcon: L(tabIcon), head: L(head), headIcon: L(headIcon), xtermPad: host?.querySelector('.xterm') ? getComputedStyle(host.querySelector('.xterm')).paddingLeft : null, bg: getComputedStyle(p).backgroundColor, viewportBg: host?.querySelector('.xterm-viewport') ? getComputedStyle(host.querySelector('.xterm-viewport')).backgroundColor : null } })()`)
  await variants('terminal-01-single')

  await ev(`document.querySelector('[data-testid="terminal-tabs"] [data-panel-tab-close]')?.click()`)
  R.emptyShown = await until(`!!document.querySelector('[data-testid="terminal-empty"]')`, 8000, 150)
  if (R.emptyShown) {
    const closing = await ev(`!!document.querySelector('[data-testid="terminal-close-dialog"]')`)
    if (closing) await S.click('[data-testid="terminal-close-confirm"]', 800)
    await sleep(600)
    await S.unhover()
    R.empty = await paneInfo()
    await variants('terminal-00-empty', { full: false })
    await S.click('[data-testid="terminal-new-empty"]', 800)
    await ready()
  }
  check('终端：空状态拍到', R.emptyShown)

  R.typed = await typeLine(`1..400 | ForEach-Object { "line $_ " + ('.' * 70) }; Write-Output ('long-line-' + ('x' * 300))`, 3500)
  await S.unhover()
  await variants('terminal-02-long-output')
  R.wheel = await wheel(-1500)
  await S.clip('terminal-02-scrolled-up', panel, 0)
  await ev(`(() => { const host = document.querySelector('[data-testid^="terminal-host-"][data-active="1"]'); host?.querySelector('textarea')?.blur(); return true })()`)
  await S.clip('terminal-02-scrolled-up-blur', panel, 0)
  await wheel(4000)

  await S.click('[data-testid="terminal-new"]', 800)
  await ready(1500)
  await S.click('[data-testid="terminal-new"]', 800)
  await ready(2500)
  R.exitTyped = await typeLine('exit 7', 2500)
  await sleep(1000)
  await S.unhover()
  R.multi = await paneInfo()
  await variants('terminal-03-multi-exited')
  report.hover.push(['terminal-03-tab-hover', await S.hover('[data-testid^="terminal-tab-"]', 1200, 0)])
  await S.clip('terminal-03-tab-hover', panel, 0)
  await S.unhover()

  const res = await turn('TERMJOBS 后台任务', { timeout: 120000 })
  R.fakeRequests = res?.requests ?? null
  check('终端：后台任务由假模型发起', (res?.requests ?? 0) > 0, res)
  const openTasks = `(() => { const b = document.querySelector(${JSON.stringify(bar)}); if (!b) return 'no-bar'; if (b.querySelector('[data-testid="wb-bg-tasks"]')) return 'open'; const button = [...b.querySelectorAll('button')].find((n) => /后台任务|Background tasks/.test(n.textContent || '')); if (!button) return 'no-section'; button.click(); return 'clicked' })()`
  const showTasks = async () => {
    await ev(`(window.__yanRightPanel.getState().setOpen(false), true)`)
    await sleep(900)
    let opened = ''
    for (let i = 0; i < 15 && opened !== 'open' && opened !== 'no-bar'; i++) {
      opened = await ev(openTasks)
      if (opened !== 'open') await sleep(250)
    }
    await sleep(800)
    await S.unhover()
    return opened
  }
  await sleep(3000)
  R.bgOpened = await showTasks()
  R.sessionBar = await ev(`!!document.querySelector(${JSON.stringify(bar)})`)
  check('终端：后台任务列表打开', R.bgOpened === 'open', R.bgOpened)
  R.bgRunning = await ev(`document.querySelector('[data-testid="wb-bg-tasks"]')?.innerText ?? null`)
  await variants('terminal-05-bg-running', { target: bar })
  report.hover.push(['terminal-05-bg-row-hover', await S.hover('[data-testid="wb-bg-running"] [data-testid="wb-bg-open"]', 900, 1)])
  await S.clip('terminal-05-bg-row-hover', bar, 0)
  report.hover.push(['terminal-05-bg-stop-hover', await S.hover('[data-testid="wb-bg-stop"]', 1200, 0)])
  await S.clip('terminal-05-bg-stop-hover', bar, 0)
  await S.unhover()
  await sleep(22000)
  await openTerm()
  await sleep(1500)
  await S.unhover()
  R.agent = await paneInfo()
  R.activeVisible = await ev(`(() => { const list = document.querySelector('[data-testid="terminal-tabs"]'); const a = list?.querySelector('.ui-ptab[data-active="1"]'); if (!list || !a) return null; const l = list.getBoundingClientRect(); const r = a.getBoundingClientRect(); return { listLeft: Math.round(l.left), listRight: Math.round(l.right), tabLeft: Math.round(r.left), tabRight: Math.round(r.right) } })()`)
  await variants('terminal-04-agent-tabs')
  report.hover.push(['terminal-04-agent-tab-hover', await S.hover('[data-testid^="terminal-tab-"][data-agent="1"]', 1200, 0)])
  await S.clip('terminal-04-agent-tab-hover', panel, 0)
  await S.unhover()
  await ev(`(window.__yanRightPanel.getState().setWidth(360), true)`)
  await sleep(1200)
  R.narrow = await paneInfo()
  R.activeVisibleNarrow = await ev(`(() => { const list = document.querySelector('[data-testid="terminal-tabs"]'); const a = list?.querySelector('.ui-ptab[data-active="1"]'); if (!list || !a) return null; const l = list.getBoundingClientRect(); const r = a.getBoundingClientRect(); return { listLeft: Math.round(l.left), listRight: Math.round(l.right), tabLeft: Math.round(r.left), tabRight: Math.round(r.right) } })()`)
  await S.clip('terminal-04-w360', panel, 0)
  const tabsState = () => ev(`(() => { const list = document.querySelector('[data-testid="terminal-tabs"]'); const a = list?.querySelector('.ui-ptab[data-active="1"]'); if (!list || !a) return null; const l = list.getBoundingClientRect(); const r = a.getBoundingClientRect(); return { scrollLeft: Math.round(list.scrollLeft), max: list.scrollWidth - list.clientWidth, activeInView: r.left >= l.left - 1 && r.right <= l.right + 1, listWidth: Math.round(l.width), tabWidth: Math.round(r.width), label: a.innerText.trim().slice(0, 80) } })()`)
  const userTabs = await ev(`[...document.querySelectorAll('[data-testid="terminal-tabs"] [data-testid^="terminal-tab-"]:not([data-agent="1"])')].map((n) => n.getAttribute('data-testid'))`)
  for (const id of userTabs ?? []) {
    await ev(`(document.querySelector('[data-testid="${id}"] .ui-ptab__label')?.click(), true)`)
    await sleep(900)
    if (!(await ev(`!!document.querySelector('[data-testid="terminal-exited"]')`))) break
  }
  R.wheelBefore = await tabsState()
  const listBox = await ev(`(() => { const b = document.querySelector('[data-testid="terminal-tabs"]')?.getBoundingClientRect(); return b ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null })()`)
  if (listBox && R.wheelBefore) {
    const delta = R.wheelBefore.scrollLeft > R.wheelBefore.max / 2 ? -600 : 600
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: listBox.x, y: listBox.y, deltaX: 0, deltaY: delta })
    await sleep(600)
    R.wheelAfter = await tabsState()
    R.wheelMenu = await ev(`(() => { const a = document.querySelector('[data-testid="terminal-tabs"] .ui-ptab[data-active="1"]'); if (!a) return false; const b = a.getBoundingClientRect(); a.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 4, clientY: b.top + 4, button: 2 })); return true })()`)
    await sleep(900)
    R.wheelMenuShown = await ev(`!![...document.querySelectorAll('[role="menu"]')].find((n) => n.getBoundingClientRect().width > 0)`)
    R.wheelRerender = await tabsState()
    await S.clip('terminal-04-w360-wheel-kept', panel, 0)
    await S.key('Escape', { waitMs: 500 })
    check('终端：滚轮翻开标签后重渲染不拉回', !!R.wheelAfter && R.wheelAfter.scrollLeft !== R.wheelBefore.scrollLeft && R.wheelMenuShown && R.wheelRerender?.scrollLeft === R.wheelAfter.scrollLeft, { before: R.wheelBefore, after: R.wheelAfter, menu: R.wheelMenuShown, rerender: R.wheelRerender })
  }
  await ev(`(window.__yanRightPanel.getState().setWidth(${width}), true)`)
  await sleep(1000)

  const runningTab = await ev(`(() => { const tabs = [...document.querySelectorAll('[data-testid^="terminal-tab-"][data-agent="1"]')]; const t = tabs.find((n) => /dev/.test(n.innerText)) || tabs[0]; const b = t?.querySelector('[data-panel-tab-close]'); if (!b) return false; b.click(); return true })()`)
  R.closeDialog = runningTab ? await until(`!!document.querySelector('[data-testid="terminal-close-dialog"]')`, 5000, 150) : false
  if (R.closeDialog) {
    await sleep(500)
    await S.shot('terminal-07-close-confirm-dark')
    R.closeDialogText = await ev(`document.querySelector('[data-testid="terminal-close-dialog"]')?.innerText?.slice(0, 400) ?? null`)
    R.closeTitleChar = await ev(`(() => { const d = document.querySelector('[data-testid="terminal-close-dialog"]'); const h = d?.querySelector('h1,h2,h3,[class*="title"]'); const s = (h?.textContent ?? '').trim(); const last = s.slice(-1); const range = document.createRange(); const node = [...(h?.childNodes ?? [])].find((n) => n.nodeType === 3 && n.textContent.includes(last)); if (node) { const i = node.textContent.lastIndexOf(last); range.setStart(node, i); range.setEnd(node, i + 1) } return { text: s, code: last ? last.codePointAt(0).toString(16) : null, width: node ? Math.round(range.getBoundingClientRect().width * 10) / 10 : null, fontSize: h ? getComputedStyle(h).fontSize : null } })()`)
    await S.click('[data-testid="terminal-close-cancel"]', 600)
  }

  R.bgOpenedLater = await showTasks()
  if (await ev(`(() => { const b = document.querySelector('[data-testid="wb-bg-finished-toggle"]'); if (!b) return false; b.scrollIntoView({ block: 'center' }); return true })()`)) {
    await sleep(400)
    if ((await ev(`document.querySelector('[data-testid="wb-bg-finished-toggle"]')?.getAttribute('aria-expanded')`)) !== 'true') await S.click('[data-testid="wb-bg-finished-toggle"]', 800)
    await ev(`document.querySelector('[data-testid="wb-bg-finished"]')?.scrollIntoView({ block: 'end' })`)
    await sleep(400)
    await S.unhover()
  }
  R.bgAll = await ev(`(() => { const root = document.querySelector('[data-testid="wb-bg-tasks"]'); if (!root) return null; return [...root.querySelectorAll('[data-testid="wb-bg-row"]')].map((row) => ({ state: row.getAttribute('data-state'), job: row.getAttribute('data-job-state'), text: row.innerText.replace(/\\s+/g, ' ').trim().slice(0, 140) })) })()`)
  await variants('terminal-05-bg-finished', { target: bar })
  await ev(`(() => { const b = document.querySelector(${JSON.stringify(bar)}); const s = [...(b?.querySelectorAll('*') ?? [])].filter((n) => n.scrollHeight > n.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(n).overflowY)).sort((a, c) => c.clientHeight - a.clientHeight)[0]; if (s) s.scrollTop = s.scrollHeight; return !!s })()`)
  await sleep(500)
  await S.clip('terminal-05-bg-finished-end', bar, 0)
  report.audit.terminalBg = await S.audit('[data-testid="wb-bg-tasks"]')

  await newSession(dir)
  await sleep(1500)
  await ev(`(window.__yanRightPanel.getState().setOpen(false), true)`)
  await sleep(900)
  R.bgNone = await ev(`(() => { const b = document.querySelector(${JSON.stringify(bar)}); return b ? { tasks: !!b.querySelector('[data-testid="wb-bg-tasks"]'), text: b.innerText.replace(/\\s+/g, ' ').slice(0, 300) } : null })()`)
  if (R.bgNone) await S.clip('terminal-06-bg-none', bar, 0)
  else await S.shot('terminal-06-bg-none-dark')
  await ev(`(window.__yanRightPanel.getState().setOpen(true), true)`)
  await sleep(800)
}

async function tabgapTarget({ kit: S, ev, sleep, until, check, log, report, newSession, cdp }) {
  report.tabgap = {}
  const R = report.tabgap
  const dir = mkdtempSync(join(tmpdir(), 'inkstone-ui-tabgap-'))
  for (const name of ['alpha-notes.md', 'beta-service.ts', 'gamma-config.json']) writeFileSync(join(dir, name), `${name}\n`)
  check('标签间距：夹具不在当前仓库里', !dir.toLowerCase().startsWith(process.cwd().toLowerCase()), dir)
  const panel = '[data-testid="rp-column-0"]'
  const original = await ev('window.__yanRightPanel.getState().width')
  R.userWidth = original
  const setWidth = async (w) => { await ev(`(window.__yanRightPanel.getState().setWidth(${w}), true)`); await sleep(1000); await S.unhover() }
  const measure = (listSel, plusSel) => ev(`(() => { const list = document.querySelector(${JSON.stringify(listSel)}); if (!list) return null; const tabs = [...list.querySelectorAll('.ui-ptab')]; const last = tabs[tabs.length - 1]; const active = list.querySelector('.ui-ptab[data-active="1"]'); const plus = ${plusSel ? `document.querySelector(${JSON.stringify(plusSel)})` : 'null'}; const l = list.getBoundingClientRect(); const lr = last?.getBoundingClientRect(); const ar = active?.getBoundingClientRect(); const pr = plus?.getBoundingClientRect(); const gap = getComputedStyle(list.parentElement).columnGap; return { tabs: tabs.length, listWidth: Math.round(l.width), scrollWidth: list.scrollWidth, tabWidths: tabs.map((t) => Math.round(t.getBoundingClientRect().width)), cap: list.style.getPropertyValue('--ptab-max') || null, lastToListEnd: lr ? Math.round((l.right - lr.right) * 10) / 10 : null, lastToPlus: lr && pr ? Math.round((pr.left - lr.right) * 10) / 10 : null, parentGap: gap, activeInView: ar ? ar.left >= l.left - 1 && ar.right <= l.right + 1 : null, activeWidth: ar ? Math.round(ar.width) : null } })()`)
  const pair = async (name, listSel, plusSel, clipSel) => {
    const out = {}
    for (const w of [869, 360]) {
      await setWidth(w)
      out[w] = await measure(listSel, plusSel)
      await S.clip(`${name}-w${w}`, clipSel, 0)
    }
    return out
  }

  await newSession(dir)
  await ev(`(() => { const rp = window.__yanRightPanel.getState(); rp.open({ id: 'terminal', kind: 'terminal' }); rp.setOpen(true); return true })()`)
  await until(`!!document.querySelector('[data-testid="terminal-pane"] .xterm')`, 20000, 150)
  await sleep(2000)
  R.term1 = await pair('tabgap-01-terminal-1', '[data-testid="terminal-tabs"]', '.term-tab-new', '.term-tabbar')
  await setWidth(869)
  await S.click('[data-testid="terminal-new"]', 1200)
  await S.click('[data-testid="terminal-new"]', 1500)
  await S.unhover()
  R.term3 = await pair('tabgap-02-terminal-3', '[data-testid="terminal-tabs"]', '.term-tab-new', '.term-tabbar')
  const keyTab = await ev(`(() => { const a = document.querySelector('[data-testid="terminal-tabs"] .ui-ptab[data-active="1"] .ui-ptab__label'); a?.focus(); return document.activeElement === a })()`)
  if (keyTab) {
    await S.key('ArrowLeft', { waitMs: 400 })
    await S.key('ArrowLeft', { waitMs: 1200 })
    R.keyAfter = await measure('[data-testid="terminal-tabs"]', '.term-tab-new')
    await ev(`(() => { const list = document.querySelector('[data-testid="terminal-tabs"]'); const a = list.querySelector('.ui-ptab[data-active="1"]'); list.scrollLeft = a.offsetLeft > list.scrollWidth / 2 ? 0 : list.scrollWidth; return true })()`)
    await sleep(300)
    R.keyHidden = await measure('[data-testid="terminal-tabs"]', '.term-tab-new')
    await setWidth(372)
    R.keyRevealed = await measure('[data-testid="terminal-tabs"]', '.term-tab-new')
    await S.clip('tabgap-03-terminal-key-reveal-w372', '.term-tabbar', 0)
    check('标签间距：键盘切换后不算用户滚动，栏宽变化时仍会滚回当前标签', R.keyAfter?.activeInView === true && R.keyRevealed?.activeInView === true, { after: R.keyAfter, hidden: R.keyHidden, revealed: R.keyRevealed })
  }
  check('标签间距：终端 869 宽「+」紧跟最后一个标签', [R.term1[869], R.term3[869]].every((m) => m && m.lastToPlus !== null && m.lastToPlus <= 8 && !m.cap), { one: R.term1[869], three: R.term3[869] })
  check('标签间距：终端 360 宽单标签收缩到可用宽度', !!R.term1[360] && R.term1[360].activeInView === true && R.term1[360].activeWidth <= R.term1[360].listWidth, R.term1[360])

  await setWidth(869)
  await ev(`(() => { const rp = window.__yanRightPanel.getState(); rp.open({ id: 'browser', kind: 'browser' }); rp.setOpen(true); return true })()`)
  await until(`!!document.querySelector('[data-testid="browser-pane-not-open"], [data-testid="browser-pane"]')`, 15000)
  if (await ev(`!!document.querySelector('[data-testid="browser-pane-open"]')`)) await S.click('[data-testid="browser-pane-open"]', 1500)
  await until(`!!document.querySelector('[data-testid="browser-start-page"], [data-testid="browser-pane-viewport-menu"]')`, 15000)
  await sleep(800)
  if (!(await ev(`!!document.querySelector('[data-testid="browser-pane-htabs"]')`))) {
    await S.click('[data-testid="browser-pane-viewport-menu"]', 700)
    await S.click('[data-testid="browser-pane-layout-horizontal"]', 1200)
  }
  R.browserHorizontal = await until(`!!document.querySelector('[data-testid="browser-pane-htabs"]')`, 5000, 100)
  await S.unhover()
  if (R.browserHorizontal) {
    R.browser1 = await pair('tabgap-04-browser-1', '[data-testid="browser-pane-htabs"]', '[data-testid="browser-pane-new-tab"]', '.v3-browser__tabrow')
    await setWidth(869)
    await S.click('[data-testid="browser-pane-new-tab"]', 1200)
    await S.click('[data-testid="browser-pane-new-tab"]', 1500)
    await S.unhover()
    R.browser3 = await pair('tabgap-05-browser-3', '[data-testid="browser-pane-htabs"]', '[data-testid="browser-pane-new-tab"]', '.v3-browser__tabrow')
    check('标签间距：浏览器 869 宽「+」紧跟最后一个标签', [R.browser1[869], R.browser3[869]].every((m) => m && m.lastToPlus !== null && m.lastToPlus <= 8 && !m.cap), { one: R.browser1[869], three: R.browser3[869] })
  }
  check('标签间距：浏览器横排标签打开', R.browserHorizontal)

  await setWidth(869)
  await ev(`(() => { const rp = window.__yanRightPanel.getState(); rp.open({ id: 'files', kind: 'files' }); rp.setOpen(true); return true })()`)
  R.filesTree = await until(`!!document.querySelector('[data-testid="v3-files-row-alpha-notes.md"]')`, 15000, 100)
  const files = ['alpha-notes.md', 'beta-service.ts', 'gamma-config.json']
  const openFile = async (name) => {
    await ev(`(() => { const row = document.querySelector('[data-testid="v3-files-row-${name}"]'); row?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 })); return !!row })()`)
    await until(`!!document.querySelector('[data-testid="v3-preview"]')`, 15000, 100)
    await sleep(900)
  }
  await openFile(files[0])
  await openFile(files[1])
  await openFile(files[2])
  await S.unhover()
  R.preview3 = await pair('tabgap-07-preview-3', '[data-testid="v3-preview-tabs"] .ui-ptabs', null, '.v3-preview-tabbar')
  check('标签间距：预览 869 宽标签条不留多余空白', [R.preview3[869]].every((m) => m && m.tabs === 3 && m.lastToListEnd !== null && m.lastToListEnd <= 2 && !m.cap), { three: R.preview3[869], narrow: R.preview3[360] })
  await setWidth(original)
}

async function logsTarget({ kit: S, ev, sleep, until, check, report, newSession }) {
  report.logs = {}
  const R = report.logs
  const dir = mkdtempSync(join(tmpdir(), 'inkstone-ui-logs-'))
  writeFileSync(join(dir, 'README.md'), '# logs fixture\n')
  const panel = '[data-testid="rp-column-0"]'
  const width = await ev('window.__yanRightPanel.getState().width')
  R.panelWidth = width
  const variants = async (name, { light = true, full = true } = {}) => {
    await S.unhover()
    if (full) await S.shot(`${name}-dark`)
    await S.clip(`${name}-panel`, panel, 0)
    if (light) { await S.theme('light'); await sleep(400); await S.clip(`${name}-light`, panel, 0); await S.theme('dark'); await sleep(300) }
  }
  const info = () => ev(`(() => { const root = document.querySelector('[data-testid="v3-wb-logs"], [data-testid="v3-wb-logs-empty"]'); if (!root) return null; const r = root.getBoundingClientRect(); const body = root.querySelector('[data-testid="v3-wb-logs-body"]'); const bar = root.querySelector('.wb-logs-bar'); const kids = bar ? [...bar.children].map((n) => { const b = n.getBoundingClientRect(); return { cls: n.className.split(' ')[0], w: Math.round(b.width), h: Math.round(b.height), text: n.innerText?.trim().slice(0, 40) } }) : []; return { testid: root.getAttribute('data-testid'), text: root.innerText.replace(/\\s+/g, ' ').slice(0, 300), top: Math.round(r.top), height: Math.round(r.height), body: body ? { h: body.clientHeight, sh: body.scrollHeight, top: body.scrollTop, w: body.clientWidth, sw: body.scrollWidth } : null, bar: kids } })()`)
  const setLogs = (logs, statuses) => ev(`(window.__yanStore.setState({ logs: ${JSON.stringify(logs)}, statuses: ${JSON.stringify(statuses)} }), true)`)
  const openLogs = async () => {
    await ev(`(() => { const rp = window.__yanRightPanel.getState(); rp.open({ id: 'logs', kind: 'logs' }); rp.setOpen(true); return true })()`)
    return until(`!!document.querySelector('[data-testid="v3-wb-logs"], [data-testid="v3-wb-logs-empty"]')`, 15000, 100)
  }

  await newSession(dir)
  await setLogs([], {})
  check('日志：面板打开', await openLogs())
  await sleep(800)
  R.empty = await info()
  await variants('logs-00-empty')

  await setLogs([], { 'git-sync': '已同步 3 分钟前', 'lint-watch': '运行中 · 0 错误', 'very-long-extension-status-key-name': '一段很长的扩展状态文字，用来看窄栏下键和值怎么排布，会不会挤在一起或者被截断' })
  R.statusShown = await until(`!!document.querySelector('[data-testid="v3-wb-logs-status"]')`, 5000, 100)
  await sleep(600)
  R.statusStillShown = await ev(`!!document.querySelector('[data-testid="v3-wb-logs-status"]')`)
  R.statusOnly = await info()
  await variants('logs-01-status-only', { light: false })

  const now = Date.now()
  const stamp = (i) => new Date(now - (260 - i) * 7000).toISOString().slice(11, 19)
  const lines = Array.from({ length: 200 }, (_, i) => {
    if (i % 37 === 5) return `[${stamp(i)}] 错误：扩展 lint-watch 抛出异常 Error: ENOENT: no such file or directory, open 'C:\\\\Users\\\\demo\\\\project\\\\.eslintrc.json'`
    if (i % 23 === 3) return `[${stamp(i)}] [pi] tool_call bash {"command":"npm run test -- --reporter=verbose --coverage --watch=false","cwd":"C:/Users/demo/project/packages/very-long-package-name/src"}`
    if (i % 41 === 7) return `[${stamp(i)}] TypeError: Cannot read properties of undefined (reading 'cwd')`
    if (i % 43 === 9) return `[${stamp(i)}] [error] extension git-sync exited with code 1`
    if (i % 29 === 13) return `[${stamp(i)}] [warn] slow response from provider`
    if (i % 31 === 17) return `[${stamp(i)}] info: retry after error: timeout (recovered)`
    if (i % 11 === 0) return `[${stamp(i)}] warn: 模型响应较慢，已等待 ${(i % 9) + 3} 秒`
    return `[${stamp(i)}] info: session event #${i} message_update delta=${(i * 37) % 997}`
  })
  R.stickSamples = await ev(`new Promise((done) => { window.__yanStore.setState({ logs: ${JSON.stringify(lines)}, statuses: { 'git-sync': '已同步 3 分钟前', 'lint-watch': '运行中 · 2 错误' } }); const out = []; let n = 0; const tick = () => { const x = document.querySelector('[data-testid="v3-wb-logs-body"]'); out.push(x ? Math.round(x.scrollHeight - x.scrollTop - x.clientHeight) + '/' + x.clientHeight + '/' + x.scrollHeight : 'none'); if (++n < 16) setTimeout(tick, 50); else done(out.join(' ')) }; tick() })`)
  await sleep(800)
  R.many = await info()
  await variants('logs-02-many')
  R.openedAtBottom = !!R.many?.body && R.many.body.sh - R.many.body.top - R.many.body.h < 8
  await ev(`(window.__yanStore.setState((s) => ({ logs: [...s.logs, '[append] info: new line A', '[append] info: new line B'].slice(-200) })), true)`)
  await sleep(500)
  R.appendFollow = await info()
  R.appendFollowed = !!R.appendFollow?.body && R.appendFollow.body.sh - R.appendFollow.body.top - R.appendFollow.body.h < 8
  const bodyBox = await ev(`(() => { const b = document.querySelector('[data-testid="v3-wb-logs-body"]')?.getBoundingClientRect(); return b ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null })()`)
  if (bodyBox) await S.cdpCall('Input.dispatchMouseEvent', { type: 'mouseWheel', x: bodyBox.x, y: bodyBox.y, deltaX: 0, deltaY: -4000 })
  await sleep(700)
  const firstVisible = () => ev(`(() => { const b = document.querySelector('[data-testid="v3-wb-logs-body"]'); if (!b) return null; const top = b.getBoundingClientRect().top; const line = [...b.querySelectorAll('.wb-logs-line')].find((n) => n.getBoundingClientRect().bottom > top + 1); return line ? { seq: line.dataset.seq, offset: Math.round((line.getBoundingClientRect().top - top) * 10) / 10, text: line.textContent.slice(0, 40) } : null })()`)
  R.anchorBefore = await firstVisible()
  for (const tag of ['C', 'D', 'E']) {
    await ev(`(window.__yanStore.setState((s) => ({ logs: [...s.logs, '[append] info: new line ${tag}'].slice(-200) })), true)`)
    await sleep(300)
  }
  await sleep(300)
  R.appendKept = await info()
  R.anchorAfter = await firstVisible()
  check('日志：打开时停在最新一行，新日志跟随；上翻后满 200 行从顶部删行，最前可见行不变', R.openedAtBottom && R.appendFollowed && !!R.anchorBefore && R.anchorBefore.seq === R.anchorAfter?.seq && Math.abs(R.anchorBefore.offset - R.anchorAfter.offset) <= 2, { many: R.many?.body, follow: R.appendFollow?.body, before: R.anchorBefore, after: R.anchorAfter, kept: R.appendKept?.body })
  await S.clip('logs-02-many-scrolled-up', panel, 0)
  await ev(`(() => { const b = document.querySelector('[data-testid="v3-wb-logs-body"]'); if (b) b.scrollTop = b.scrollHeight; return !!b })()`)
  await sleep(400)
  R.manyBottom = await info()
  await S.clip('logs-02-many-bottom', panel, 0)
  report.hover.push(['logs-02-copy-hover', await S.hover('[data-testid="v3-wb-logs-copy"]', 1200)])
  await S.clip('logs-02-copy-hover', panel, 0)
  await S.unhover()

  await S.click('[data-testid="v3-wb-logs-filter"]', 300)
  await S.typeText('错误', 400)
  await sleep(600)
  R.filtered = await info()
  await variants('logs-03-filtered', { light: false })
  await S.key('Escape', { waitMs: 300 })
  for (const [word, name] of [['rror', 'logs-03b-filter-error'], ['warn', 'logs-03c-filter-warn']]) {
    await S.click('[data-testid="v3-wb-logs-filter"]', 300)
    await S.typeText(word, 400)
    await sleep(600)
    R[name] = await ev(`[...document.querySelectorAll('.wb-logs-line')].slice(0, 30).map((n) => (n.dataset.tone || '-') + ' ' + n.textContent.slice(11, 60))`)
    await variants(name)
    await S.key('Escape', { waitMs: 300 })
  }
  await S.click('[data-testid="v3-wb-logs-filter"]', 300)
  await S.typeText('zzz-no-such-line', 400)
  await sleep(600)
  R.noMatch = await info()
  await variants('logs-04-no-match')
  await S.key('Escape', { waitMs: 300 })
  await ev('document.activeElement?.blur?.()')

  await setLogs(lines.slice(0, 6), {})
  await sleep(600)
  R.few = await info()
  await variants('logs-05-few', { light: false })

  const filterBox = await ev(`(() => { const el = document.querySelector('[data-testid="v3-wb-logs-filter"]'); el?.focus(); return document.activeElement === el })()`)
  if (filterBox) {
    await S.key('Tab', { waitMs: 300 })
    R.focusAfterTab = await ev(`document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName`)
    await S.clip('logs-06-focus-copy', panel, 0)
    await S.key('Tab', { waitMs: 300 })
    R.focusBody = await ev(`(() => { const el = document.activeElement; return { id: el?.getAttribute('data-testid') ?? el?.tagName, outline: el ? getComputedStyle(el).outlineStyle + ' ' + getComputedStyle(el).outlineWidth : null, shadow: el ? getComputedStyle(el).boxShadow.slice(0, 80) : null } })()`)
    await S.clip('logs-06-focus-body', panel, 0)
    await ev('document.activeElement?.blur?.()')
  }

  await setLogs(lines, { 'git-sync': '已同步 3 分钟前', 'lint-watch': '运行中 · 2 错误' })
  const other = width === 360 ? 869 : 360
  await ev(`(window.__yanRightPanel.getState().setWidth(${other}), true)`)
  await sleep(1200)
  R.otherWidth = { width: other, info: await info() }
  await variants(`logs-07-w${other}`, { light: false, full: true })
  await ev(`(window.__yanRightPanel.getState().setWidth(${width}), true)`)
  await sleep(900)
  report.audit.logs = await S.audit('[data-testid="v3-wb-logs"]')
  await setLogs([], {})
}

async function deviceTarget({ kit: S, ev, sleep, until, check, log, report, box }) {
  report.device = {}
  const R = report.device
  const build = mkdtempSync(join(tmpdir(), 'inkstone-ui-device-'))
  const fake = buildFakeAdb(build)
  R.fake = { ok: fake.ok, csc: fake.csc, ffmpeg: fake.ffmpeg }
  R.avdHome = box?.home ? join(box.home, '.android', 'avd') : null
  if (R.avdHome) {
    mkdirSync(R.avdHome, { recursive: true })
    for (const name of ['Pixel_8_API_35', 'Medium_Phone_API_36']) writeFileSync(join(R.avdHome, `${name}.ini`), '')
  }
  check('设备：AVD 夹具在隔离 home 里', !!R.avdHome && R.avdHome.toLowerCase().includes('debug'), R.avdHome)
  check('设备：假 adb 与画面夹具就绪（csc、ffmpeg）', fake.ok, R.fake)
  check('设备：SDK 目录是隔离实例的', !!box?.androidSdk && box.androidSdk.toLowerCase().includes('debug'), box?.androidSdk)
  if (!fake.ok || !box?.androidSdk) return
  const tools = join(box.androidSdk, 'platform-tools')
  const panel = '[data-testid="rp-column-0"]'
  const width = await ev('window.__yanRightPanel.getState().width')
  R.panelWidth = width
  const variants = async (name, { light = true, full = true } = {}) => {
    await S.unhover()
    if (full) await S.shot(`${name}-dark`)
    await S.clip(`${name}-panel`, panel, 0)
    if (light) { await S.theme('light'); await sleep(400); await S.clip(`${name}-light`, panel, 0); await S.theme('dark'); await sleep(300) }
  }
  const info = () => ev(`(() => { const root = document.querySelector('[data-testid="device-pane"]'); if (!root) return null; const canvas = root.querySelector('canvas'); const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] }; return { text: root.innerText.replace(/\\s+/g, ' ').slice(0, 300), ids: [...root.querySelectorAll('[data-testid]')].map((n) => n.getAttribute('data-testid')), canvas: canvas && !canvas.hidden ? { w: canvas.width, h: canvas.height, box: box(canvas) } : null, screen: box(root.querySelector('.device-pane__screen')), bars: [...root.querySelectorAll('.device-pane__bar')].map(box), error: root.querySelector('.device-pane__error')?.innerText ?? null, buttons: [...root.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().width > 0).map((b) => b.getAttribute('aria-label') || b.innerText.trim()).slice(0, 20), head: document.querySelector(${JSON.stringify(panel)})?.querySelector('.rp-sub-title, [data-pane-title]')?.innerText ?? null } })()`)
  const setDevices = (lines) => writeFileSync(join(tools, 'devices.txt'), lines.map((line) => `${line}\r\n`).join(''))
  const waitText = (needle, ms = 9000) => until(`(document.querySelector('[data-testid="device-pane"]')?.innerText ?? '').includes(${JSON.stringify(needle)})`, ms, 150)

  await ev(`(() => { const rp = window.__yanRightPanel.getState(); rp.open({ id: 'device', kind: 'device' }); rp.setOpen(true); return true })()`)
  check('设备：面板打开', await until(`!!document.querySelector('[data-testid="device-pane"]')`, 15000, 100))
  R.noAdbShown = await until(`!!document.querySelector('[data-testid="device-pane-no-adb"]')`, 8000, 100)
  await sleep(600)
  R.noAdb = await info()
  await variants('device-00-no-adb')

  mkdirSync(tools, { recursive: true })
  setDevices([])
  copyFileSync(fake.adb, join(tools, 'adb.exe'))
  R.noDeviceShown = await until(`!!document.querySelector('[data-testid="device-pane-empty"]')`, 9000, 150)
  await sleep(500)
  R.noDevice = await info()
  await variants('device-01-no-device')
  report.hover.push(['device-01-boot-hover', await S.hover('[data-testid="device-pane-empty"] button', 900, 0)])
  await S.clip('device-01-boot-hover', panel, 0)
  await S.unhover()

  const bootClicked = await ev(`(() => { const b = document.querySelector('[data-testid="device-pane-empty"] button'); if (!b) return false; b.click(); return true })()`)
  R.bootClicked = bootClicked
  if (bootClicked) {
    R.bootErrorShown = await until(`!!document.querySelector('[data-testid="device-pane"] .device-pane__error')`, 8000, 100)
    await sleep(400)
    R.bootError = await info()
    await variants('device-02-boot-failed', { light: false })
    await sleep(4500)
    R.bootErrorAfterPoll = await ev(`!!document.querySelector('[data-testid="device-pane-action-error"], [data-testid="device-pane"] .device-pane__error')`)
    check('设备：启动失败的提示不会在下一次轮询时消失', R.bootErrorAfterPoll, R.bootErrorAfterPoll)
  }

  if (bootClicked) {
    mkdirSync(join(box.androidSdk, 'emulator'), { recursive: true })
    copyFileSync(fake.adb, join(box.androidSdk, 'emulator', 'emulator.exe'))
    await sleep(3500)
    const again = await ev(`(() => { const b = document.querySelector('[data-testid="device-pane-empty"] .device-pane__avds button'); if (!b) return false; b.click(); return true })()`)
    R.bootAgainClicked = again
    if (again) {
      R.bootStartingShown = await until(`(document.querySelector('[data-testid="device-pane"]')?.innerText ?? '').includes('模拟器正在启动')`, 6000, 100)
      await sleep(600)
      await variants('device-02b-boot-waiting', { light: false })
      R.bootTimeoutShown = await until(`(document.querySelector('[data-testid="device-pane-action-error"]')?.innerText ?? '').includes('秒内就绪')`, 75000, 500)
      await sleep(500)
      R.bootTimeout = await info()
      check('设备：模拟器启动后超时没出现，给出说明与设置入口', R.bootTimeoutShown, R.bootTimeout?.error)
      await variants('device-02c-boot-timeout')
      const third = await ev(`(() => { const b = document.querySelector('[data-testid="device-pane-empty"] .device-pane__avds button'); if (!b) return false; b.click(); return true })()`)
      R.bootOfflineClicked = third
      if (third) {
        setDevices(['emulator-5554          offline transport_id:9'])
        R.bootOfflineTimeoutShown = await until(`(document.querySelector('[data-testid="device-pane-action-error"]')?.innerText ?? '').includes('秒内就绪')`, 75000, 500)
        await sleep(500)
        R.bootOfflineTimeout = await info()
        R.bootOfflineStillStarting = await ev(`(document.querySelector('[data-testid="device-pane"]')?.innerText ?? '').includes('模拟器正在启动')`)
        R.bootOfflineStuck = await ev(`(document.querySelector('[data-testid="device-pane-empty"]')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 200)`)
        check('设备：超时后离线模拟器显示为离线', /emulator-5554/.test(R.bootOfflineStuck ?? '') && /离线/.test(R.bootOfflineStuck ?? ''), R.bootOfflineStuck)
        check('设备：模拟器一直离线时也会超时，并且不再显示正在启动', R.bootOfflineTimeoutShown && !R.bootOfflineStillStarting, R.bootOfflineTimeout?.error)
        await variants('device-02d-boot-offline-timeout', { light: false })
        setDevices([])
      }
    }
  }

  setDevices(['R58N1234ABC          unauthorized usb:1-1 transport_id:2'])
  R.unauthorizedShown = await waitText('R58N1234ABC')
  await sleep(500)
  R.unauthorized = await info()
  await variants('device-03-unauthorized')

  setDevices(['emulator-5554          offline transport_id:3'])
  R.startingShown = await waitText('模拟器正在启动')
  await sleep(500)
  R.starting = await info()
  await variants('device-04-starting', { light: false })

  setDevices(['emulator-5554          device product:sdk_gphone64 model:Pixel_8 device:emu64 transport_id:3'])
  R.connectingShown = await until(`!!document.querySelector('[data-testid="device-pane"] .device-pane__hint')`, 9000, 150)
  await sleep(500)
  R.connecting = await info()
  await variants('device-05-connecting', { light: false })
  R.frameSlowShown = await until(`!!document.querySelector('[data-testid="device-pane-frame-slow"]')`, 20000, 300)
  await sleep(400)
  R.frameSlow = await info()
  await variants('device-05b-frame-slow', { light: false })

  copyFileSync(fake.screenSource, join(tools, 'screen.h264'))
  R.liveShown = await until(`(() => { const c = document.querySelector('[data-testid="device-pane"] canvas'); return !!c && !c.hidden })()`, 15000, 150)
  await sleep(800)
  R.live = await info()
  await variants('device-06-live')
  report.hover.push(['device-06-home-hover', await S.hover('[data-testid="device-pane"] .device-pane__bar--bottom button', 1100, 1)])
  await S.clip('device-06-home-hover', panel, 0)
  await S.unhover()

  const typed = await ev(`(() => { const input = document.querySelector('[data-testid="device-pane"] .device-pane__type input'); if (!input) return false; input.focus(); return document.activeElement === input })()`)
  if (typed) {
    const enter = async () => {
      const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }
      await S.cdpCall('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: '\r', unmodifiedText: '\r' })
      await S.cdpCall('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
      await sleep(1200)
    }
    await S.typeText('hello', 300)
    await enter()
    R.asciiCleared = await ev(`document.querySelector('[data-testid="device-pane"] .device-pane__type input')?.value ?? null`)
    await S.typeText('你好', 300)
    await enter()
    R.textError = await info()
    await sleep(4000)
    R.textErrorAfterPoll = await info()
    check('设备：英文输入后清空，中文输入给出说明且轮询后仍在', R.asciiCleared === '' && !!R.textErrorAfterPoll?.error, { cleared: R.asciiCleared, error: R.textErrorAfterPoll?.error })
    await variants('device-07-text-error', { light: false })
    await ev('document.activeElement?.blur?.()')
  }

  setDevices(['emulator-5554          device product:sdk_gphone64 model:Pixel_8 device:emu64 transport_id:3', 'R58N1234ABC          device product:dm3q model:SM_S9180 device:dm3q transport_id:4'])
  R.twoShown = await until(`!!document.querySelector('[data-testid="device-pane"] .device-pane__select, ${panel} .device-pane__select')`, 9000, 150)
  await sleep(4000)
  R.two = await info()
  R.select = await ev(`(() => { const s = document.querySelector('.device-pane__select'); if (!s) return null; const r = s.getBoundingClientRect(); const v = s.querySelector('.ui-select__value, [data-slot="value"], button'); return { box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], text: s.innerText.trim(), clipped: v ? v.scrollWidth > v.clientWidth : null } })()`)
  await variants('device-08-two-devices', { light: false })
  if (await S.click('.device-pane__select button', 800)) {
    await S.shot('device-08-select-open-dark')
    await S.key('Escape', { waitMs: 400 })
  }

  const other = width === 360 ? 869 : 360
  await ev(`(window.__yanRightPanel.getState().setWidth(${other}), true)`)
  await sleep(1500)
  R.otherWidth = { width: other, info: await info(), select: await ev(`document.querySelector('.device-pane__select')?.innerText?.trim() ?? null`) }
  await variants(`device-09-w${other}`, { light: false })
  await ev(`(window.__yanRightPanel.getState().setWidth(${width}), true)`)
  await sleep(1000)
  report.audit.device = await S.audit('[data-testid="device-pane"]')

  setDevices([])
  await sleep(4000)
  R.goneAfter = await info()
}

async function quotaTarget({ kit: S, ev, sleep, until, check, log, report, newSession, turn, box }) {
  report.quota = {}
  const R = report.quota
  const file = box.quotaFixture
  if (!check('额度：实例带假额度文件（--quota）', !!file && existsSync(file), file ?? null)) return
  const dir = mkdtempSync(join(tmpdir(), 'inkstone-ui-quota-'))
  writeFileSync(join(dir, 'README.md'), '# quota fixture\n')
  R.fixture = dir
  check('额度：夹具不在当前仓库里', !dir.toLowerCase().startsWith(process.cwd().toLowerCase()), dir)
  const panel = '[data-testid="rp-column-0"]'
  const bar = '[data-testid="v3-sessionbar"]'
  const width = await ev('window.__yanRightPanel.getState().width')
  const MIN = 60_000
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR
  const win = (id, label, used, durationMs, leftMs, extra = {}) => ({ id, label, used, total: 100, durationMs, resetAt: Date.now() + leftMs, ...extra })
  const card = (key, extra) => ({ key, source: 'yan', provider: 'fake', name: 'Fake', checkedAt: Date.now(), status: 'ok', windows: [], ...extra })
  const main = (fiveHour, week, extra = {}) => card('debug:fake', { email: 'demo@example.com', plan: 'max', active: true, windows: [win('five_hour', '5 小时', fiveHour, 5 * HOUR, extra.fiveLeft ?? 3 * HOUR + 12 * MIN, fiveHour >= 100 ? { exceeded: true } : {}), win('seven_day', '本周', week, 7 * DAY, extra.weekLeft ?? 4 * DAY + 3 * HOUR, week >= 100 ? { exceeded: true } : {})], ...(extra.card ?? {}) })
  const alt = (fiveHour, week) => card('debug:fake-alt', { name: 'Fake', label: '备用', email: 'backup-account-with-a-long-name@example.com', plan: 'plus', switchable: true, windows: [win('five_hour', '5 小时', fiveHour, 5 * HOUR, 4 * HOUR + 30 * MIN), win('seven_day', '本周', week, 7 * DAY, 6 * DAY)] })
  const states = () => ({
    none: [],
    single: [main(23, 11)],
    multi: [main(46, 31), alt(4, 62), card('debug:other', { provider: 'anthropic', name: 'Claude', email: 'me@example.com', plan: 'max', windows: [win('five_hour', '5 小时', 71, 5 * HOUR, 2 * HOUR), win('seven_day', '本周', 18, 7 * DAY, 5 * DAY)] })],
    near: [main(88, 93, { fiveLeft: 25 * MIN, weekLeft: 20 * HOUR }), alt(12, 40)],
    exhausted: [main(100, 76, { fiveLeft: 40 * MIN, weekLeft: 2 * DAY + 5 * HOUR, card: { status: 'limited' } }), alt(12, 40)],
    error: [main(23, 11), card('debug:fake-err', { label: '备用', email: 'backup@example.com', status: 'error', error: 'HTTP 503：额度服务暂时不可用，稍后再试' }), card('debug:fake-exp', { label: '旧号', email: 'old@example.com', status: 'expired', hint: '登录已过期，请在 设置 → 模型 重新登录' })],
    stale: [card('debug:fake', { email: 'demo@example.com', plan: 'max', active: true, status: 'error', error: '网络超时' })]
  })
  const openQuota = async () => {
    await ev(`(() => { const rp = window.__yanRightPanel.getState(); rp.open({ id: 'quota', kind: 'quota' }); rp.setOpen(true); return true })()`)
    return until(`!!document.querySelector('[data-testid="v3-wb-quota"]')`, 15000, 100)
  }
  const paneInfo = () => ev(`(() => { const el = document.querySelector('[data-testid="v3-wb-quota"]'); if (!el) return null; return { text: el.innerText.replace(/\\s+/g, ' ').trim().slice(0, 700), cards: [...el.querySelectorAll('.wb-quota-card')].map((c) => ({ id: c.getAttribute('data-testid'), wins: [...c.querySelectorAll('.wb-quota-win')].map((w) => w.getAttribute('data-tone') + ':' + w.innerText.replace(/\\s+/g, ' ').trim()) })), empty: !!el.querySelector('[data-testid="v3-wb-quota-empty"]'), spinner: !!el.querySelector('.ui-spinner') } })()`)
  const barInfo = () => ev(`(() => { const q = document.querySelector('[data-testid="wb-ov-quota"]'); return q ? q.innerText.replace(/\\s+/g, ' ').trim().slice(0, 400) : null })()`)
  const load = async (name) => {
    writeFileSync(file, JSON.stringify(states()[name]))
    await ev(`document.querySelector('[data-testid="v3-wb-quota-refresh"]')?.click()`)
    await sleep(400)
    await until(`!document.querySelector('[data-testid="v3-wb-quota"] .ui-spinner') && !document.querySelector('[data-testid="v3-wb-quota-refresh"]')?.hasAttribute('disabled')`, 15000, 150)
    await sleep(700)
    await S.unhover()
  }
  const variants = async (name, { light = true, full = true, target = panel } = {}) => {
    if (full) await S.shot(`${name}-dark`)
    await S.clip(`${name}-panel`, target, 0)
    if (light) { await S.theme('light'); await sleep(400); await S.clip(`${name}-light`, target, 0); await S.theme('dark'); await sleep(300) }
  }
  const barClip = async (name) => {
    await ev(`(window.__yanRightPanel.getState().setOpen(false), true)`)
    await sleep(1200)
    await ev(`document.querySelector('[data-testid="wb-ov-quota"]')?.scrollIntoView({ block: 'center' })`)
    await sleep(400)
    await S.unhover()
    const info = await barInfo()
    if (await ev(`!!document.querySelector(${JSON.stringify(bar)})`)) await S.clip(name, bar, 0)
    else await S.shot(`${name}-full`)
    await openQuota()
    await sleep(500)
    return info
  }

  await newSession(dir)
  const first = await turn('你好', { timeout: 60000 })
  R.firstTurn = first?.requests ?? null
  writeFileSync(file, JSON.stringify(states().none))
  check('额度：面板打开', await openQuota())
  R.loading = await paneInfo()
  await S.clip('quota-00-loading', panel, 0)
  await sleep(800)
  const order = [['quota-01-none', 'none'], ['quota-02-single', 'single'], ['quota-03-multi', 'multi'], ['quota-04-near', 'near'], ['quota-05-exhausted', 'exhausted'], ['quota-06-error', 'error'], ['quota-07-stale', 'stale']]
  for (const [shot, name] of order) {
    await load(name)
    R[name] = await paneInfo()
    await variants(shot, { full: name !== 'error' })
    if (name === 'stale') R.liveStalePatched = await ev(`(() => { const st = window.__yanLiveQuota.getState(); const key = Object.keys(st.entries).find((k) => st.entries[k]?.snapshot?.windows?.length); if (!key) return null; const e = st.entries[key]; window.__yanLiveQuota.setState({ entries: { ...st.entries, [key]: { ...e, snapshot: { ...e.snapshot, staleError: '网络超时' } } } }); return key })()`)
    if (name === 'stale') {
      await turn('额度过期刷新', { timeout: 60000 })
      await ev(`(window.__yanRightPanel.getState().setOpen(false), true)`)
      R.staleOverviewShown = await until(`!!document.querySelector('[data-testid="wb-ov-quota-stale"][data-error]')`, 15000, 200)
      check('额度：概览里出现读取失败的过期行', R.staleOverviewShown)
    }
    if (['none', 'single', 'near', 'exhausted', 'stale'].includes(name)) R[`${name}Bar`] = await barClip(`${shot}-bar`)
    if (name === 'multi') {
      report.hover.push(['quota-03-switch-hover', await S.hover('[data-testid="v3-wb-quota-switch"]', 1200, 0)])
      await S.clip('quota-03-switch-hover', panel, 0)
      report.hover.push(['quota-03-win-hover', await S.hover('.wb-quota-win', 1200, 0)])
      await S.clip('quota-03-win-hover', panel, 0)
      await S.unhover()
    }
    if (name === 'multi' || name === 'exhausted' || name === 'error') {
      await ev(`(window.__yanRightPanel.getState().setWidth(360), true)`)
      await sleep(1200)
      await S.unhover()
      await S.clip(`${shot}-w360`, panel, 0)
      await ev(`(window.__yanRightPanel.getState().setWidth(${width}), true)`)
      await sleep(900)
    }
  }
  report.audit.quota = await S.audit('[data-testid="v3-wb-quota"]')

  await load('exhausted')
  await ev(`(window.__yanRightPanel.getState().setOpen(false), true)`)
  await sleep(800)
  await turn('FAILQUOTA 额度用完', { timeout: 90000 })
  R.errorCard = await until(`!!document.querySelector('[data-testid="v3-error-card"]')`, 20000, 200)
  await sleep(800)
  R.errorText = await ev(`document.querySelector('[data-testid="v3-error-card"]')?.innerText?.replace(/\\s+/g, ' ').slice(0, 400) ?? null`)
  R.errorActions = await ev(`[...document.querySelectorAll('[data-testid="v3-error-card"] [data-testid^="v3-error-"]')].map((n) => n.getAttribute('data-testid'))`)
  await ev(`document.querySelector('[data-testid="v3-error-card"]')?.scrollIntoView({ block: 'center' })`)
  await sleep(500)
  await S.unhover()
  await S.shot('quota-08-error-card-dark')
  if (R.errorCard) await S.clip('quota-08-error-card', '[data-testid="v3-error-card"]', 24)
  const waited = await ev(`(() => { const b = document.querySelector('[data-testid="v3-error-wait"]'); if (!b) return false; b.click(); return true })()`)
  R.waitClicked = waited
  R.resumeShown = await until(`!!document.querySelector('[data-testid="quota-resume-bar"]')`, 8000, 200)
  if (!R.resumeShown) {
    await ev(`(() => { const s = window.__yanStore.getState(); window.__yanStore.setState({ quotaResume: { sessionId: s.session?.sessionId, provider: 'fake', armedAt: Date.now(), resetAt: Date.now() + 40 * 60000 } }); return true })()`)
    R.resumeInjected = true
    R.resumeShown = await until(`!!document.querySelector('[data-testid="quota-resume-bar"]')`, 8000, 200)
  }
  check('额度：等待额度恢复的提示出现', R.resumeShown, { waited, injected: !!R.resumeInjected })
  R.resumeState = await ev(`window.__yanStore.getState().quotaResume ?? null`)
  R.resumeText = await ev(`document.querySelector('[data-testid="quota-resume-bar"]')?.innerText?.replace(/\\s+/g, ' ').slice(0, 300) ?? null`)
  await ev(`document.querySelector('[data-testid="quota-resume-bar"]')?.scrollIntoView({ block: 'center' })`)
  await sleep(600)
  await S.unhover()
  await S.shot('quota-09-resume-dark')
  if (R.resumeShown) {
    await S.clip('quota-09-resume', '[data-testid="quota-resume-bar"]', 24)
    await S.theme('light'); await sleep(400)
    await S.clip('quota-09-resume-light', '[data-testid="quota-resume-bar"]', 24)
    await S.theme('dark'); await sleep(300)
  }
  R.resumeBar = await barClip('quota-09-resume-bar')
  await ev(`(() => { window.__yanStore.getState().cancelQuotaResume?.(); return true })()`)
  writeFileSync(file, JSON.stringify(states().single))
  await ev(`(window.__yanRightPanel.getState().setWidth(${width}), true)`)
  await sleep(600)
}

async function contextTarget({ kit: S, ev, sleep, until, check, log, report, newSession, turn, fake }) {
  report.context = {}
  const R = report.context
  const dir = mkdtempSync(join(tmpdir(), 'inkstone-ui-ctx-'))
  const rule = (i) => `- 规则 ${i}：修改前先读相关源码与调用链，保持改动最小；keep changes minimal and run the matching tests (rule ${i}).`
  writeFileSync(join(dir, 'AGENTS.md'), `# 项目约定\n\n${Array.from({ length: 900 }, (_, i) => rule(i + 1)).join('\n')}\n`)
  for (let i = 1; i <= 30; i++) {
    const name = `fixture-skill-${String(i).padStart(2, '0')}`
    mkdirSync(join(dir, '.pi', 'skills', name), { recursive: true })
    writeFileSync(join(dir, '.pi', 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: 示例技能 ${i}，用来测试上下文面板里很多技能时的显示；fixture skill ${i} used to fill the skills list with a reasonably long description.\n---\n\n# ${name}\n\n只用于截图。\n`)
  }
  R.fixture = dir
  check('上下文：夹具不在当前仓库里', !dir.toLowerCase().startsWith(process.cwd().toLowerCase()), dir)
  const panel = '[data-testid="rp-column-0"]'
  const bar = '[data-testid="v3-sessionbar"]'
  const width = await ev('window.__yanRightPanel.getState().width')
  const originalLimit = await ev('window.__yanStore.getState().settings?.autoCompactTokens ?? null')
  R.originalLimit = originalLimit
  const openCtx = async () => {
    await ev(`(() => { const rp = window.__yanRightPanel.getState(); rp.open({ id: 'context', kind: 'context' }); rp.setOpen(true); return true })()`)
    return until(`!!document.querySelector('[data-testid="v3-wb-context"]')`, 15000, 100)
  }
  const variants = async (name, { light = true, full = true, target = panel } = {}) => {
    await S.unhover()
    if (full) await S.shot(`${name}-dark`)
    await S.clip(`${name}-panel`, target, 0)
    if (light) { await S.theme('light'); await sleep(400); await S.clip(`${name}-light`, target, 0); await S.theme('dark'); await sleep(300) }
  }
  const paneText = () => ev(`(() => { const el = document.querySelector('[data-testid="v3-wb-context"]'); if (!el) return null; return { tokens: el.querySelector('[data-testid="v3-wb-ctx-tokens"]')?.textContent ?? null, distance: el.querySelector('[data-testid="v3-wb-ctx-distance"]')?.textContent ?? null, tone: el.querySelector('.wb-ctxw')?.getAttribute('data-tone') ?? null, compaction: el.querySelector('[data-testid="v3-wb-ctx-compaction"]')?.textContent ?? null, history: el.querySelector('[data-testid="v3-wb-ctx-history"]')?.innerText ?? null, sources: [...el.querySelectorAll('[data-testid^="v3-wb-ctx-source-"]')].map((n) => n.getAttribute('data-testid').slice(18) + ':' + (n.querySelector('.wb-ctx-source-count')?.textContent ?? '')), compactDisabled: el.querySelector('[data-testid="v3-wb-ctx-compact"]')?.hasAttribute('disabled') || el.querySelector('[data-testid="v3-wb-ctx-compact"]')?.hasAttribute('data-disabled'), limitNote: el.querySelector('[data-testid="v3-wb-ctx-limit-note"]')?.textContent ?? null, figure: el.querySelector('.wb-ctxw-figure')?.innerText?.replace(/\\s+/g, ' ') ?? null } })()`)
  const scrollPane = (selector) => ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollIntoView({ block: 'start' }); return true })()`)
  const barClip = async (name) => {
    await ev(`(window.__yanRightPanel.getState().setOpen(false), true)`)
    await sleep(900)
    await S.unhover()
    if (await ev(`!!document.querySelector(${JSON.stringify(bar)})`)) await S.clip(name, bar, 0)
    else await S.shot(`${name}-full`)
    await ev(`(window.__yanRightPanel.getState().setOpen(true), true)`)
    await sleep(700)
  }
  const markerClip = async (name) => {
    const found = await ev(`(() => { const el = [...document.querySelectorAll('[data-testid="v3-compaction-marker"]')].at(-1); if (!el) return false; el.scrollIntoView({ block: 'center' }); return true })()`)
    if (!found) return false
    await sleep(500)
    await S.clip(name, '.v3-compaction', 24)
    return true
  }

  await newSession(dir)
  check('上下文：面板打开', await openCtx())
  await ev(`window.__yanStore.getState().patchSettings({ autoCompactTokens: 100000 })`)
  await sleep(2500)
  R.empty = await paneText()
  await variants('context-00-empty')

  const res = await turn('先打个招呼。', { timeout: 60000 })
  check('上下文：请求发到假模型', (res?.requests ?? 0) > 0, res)
  await sleep(2000)
  R.low = await paneText()
  await variants('context-01-low')
  await barClip('context-01-sessionbar')
  if (await S.click('[data-testid="composer-context-meter"]', 900)) {
    R.meterPopover = await ev(`document.querySelector('[data-testid="composer-context-popover"]')?.innerText ?? null`)
    await S.shot('context-01-meter-popover-dark')
    await S.key('Escape')
  }

  for (const [name, tokens] of [['context-02-mid', 50000], ['context-03-high', 80000], ['context-04-near', 96000]]) {
    await turn(`USAGEIN=${tokens} 回一句。`, { timeout: 60000 })
    await sleep(2000)
    R[name] = await paneText()
    await variants(name, { light: name !== 'context-02-mid' })
  }
  await ev(`(window.__yanRightPanel.getState().setWidth(360), true)`)
  await sleep(1200)
  await S.clip('context-04-w360', panel, 0)
  await ev(`(window.__yanRightPanel.getState().setWidth(${width}), true)`)
  await sleep(900)
  await barClip('context-04-sessionbar')

  process.env.YAN_FAKE_SUMMARY_DELAY_MS = '9000'
  const padding = '填充上下文，无关内容。'.repeat(16000)
  const big = turn(`USAGEIN=120000 ${padding}\n收到后只回一句话。`, { timeout: 240000 })
  R.compactingSeen = await until('!!s.session?.isCompacting', 120000, 100)
  if (R.compactingSeen) {
    await sleep(1200)
    R.compacting = await paneText()
    await variants('context-05-compacting', { light: false })
    await markerClip('context-05-marker-running')
  }
  await big
  R.compactedDone = await until('!!s.session?.lastCompaction && !s.session?.isCompacting', 120000, 200)
  delete process.env.YAN_FAKE_SUMMARY_DELAY_MS
  check('上下文：拍到压缩中', R.compactingSeen)
  await sleep(2500)
  R.after = await paneText()
  R.lastCompaction = await ev('window.__yanStore.getState().session?.lastCompaction ?? null')
  await variants('context-06-after')
  await markerClip('context-06-marker-done')
  await barClip('context-06-sessionbar')

  await turn(`USAGEIN=40000 继续补充细节。${'补充说明。'.repeat(12000)}`, { timeout: 120000 })
  await sleep(1000)
  process.env.YAN_FAKE_SUMMARY_FAIL = '1'
  await S.click('[data-testid="v3-wb-ctx-compact"]', 500)
  R.failedSeen = await until(`s.session?.lastCompaction?.status === 'failed' && !s.session?.isCompacting`, 90000, 200)
  delete process.env.YAN_FAKE_SUMMARY_FAIL
  check('上下文：拍到压缩失败', R.failedSeen, await ev('window.__yanStore.getState().session?.lastCompaction ?? null'))
  await sleep(1500)
  R.failed = await paneText()
  R.failedCompaction = await ev('window.__yanStore.getState().session?.lastCompaction ?? null')
  await variants('context-07-failed')
  await markerClip('context-07-marker-failed')
  if (await ev(`(() => { const el = document.querySelector('[data-testid="v3-wb-ctx-compaction"]'); if (!el) return false; el.scrollIntoView({ block: 'center' }); return true })()`)) {
    await sleep(500)
    await S.unhover()
    await S.clip('context-07-failed-history', panel, 0)
    await S.theme('light'); await sleep(400)
    await S.clip('context-07-failed-history-light', panel, 0)
    await S.theme('dark'); await sleep(300)
  }
  report.hover.push(['context-07-failed-tip', await S.hover('[data-testid="v3-wb-ctx-compaction"]', 1500, 0)])
  await S.clip('context-07-failed-tip', panel, 0)
  await S.unhover()

  await scrollPane('[data-testid="v3-wb-ctx-sources"]')
  await sleep(600)
  R.sources = await paneText()
  await S.clip('context-08-sources', panel, 0)
  await ev(`(() => { for (const b of document.querySelectorAll('[data-testid="v3-wb-ctx-sources"] .wb-ctx-more')) b.click(); return true })()`)
  await sleep(800)
  await scrollPane('[data-testid="v3-wb-ctx-source-skills"]')
  await sleep(500)
  await S.clip('context-08-sources-expanded', panel, 0)
  await ev(`(window.__yanRightPanel.getState().setWidth(360), true)`)
  await sleep(1200)
  await S.clip('context-08-w360-sources', panel, 0)
  await ev(`(window.__yanRightPanel.getState().setWidth(${width}), true)`)
  await sleep(900)
  report.audit.context = await S.audit('[data-testid="v3-wb-context"]')
  await ev(`window.__yanStore.getState().patchSettings({ autoCompactTokens: ${originalLimit === null ? 'undefined' : originalLimit} })`)
}

async function prsTarget({ kit: S, ev, sleep, until, check, log, report, box }) {
  report.prs = {}
  const R = report.prs
  const demo = box?.demo
  if (!check('PR：演示仓库就绪（--demo）', !!demo?.stateFile, demo?.stateFile ?? null)) return
  const stateFile = demo.stateFile
  const controlFile = `${stateFile}.control.json`
  const original = readFileSync(stateFile, 'utf8')
  const control = (value) => writeFileSync(controlFile, JSON.stringify(value ?? {}))
  const locked = async (fn) => { const lock = `${stateFile}.lock`; const end = Date.now() + 15000; for (;;) { try { mkdirSync(lock); break } catch (error) { if (error.code !== 'EEXIST' || Date.now() > end) throw error; await sleep(30) } } try { fn() } finally { rmSync(lock, { recursive: true, force: true }) } }
  const editState = (fn) => locked(() => { const s = JSON.parse(readFileSync(stateFile, 'utf8')); fn(s); writeFileSync(stateFile, JSON.stringify(s, null, 2)) })
  const restoreState = () => locked(() => writeFileSync(stateFile, original))
  control({})
  const panel = '[data-testid="rp-column-0"]'
  const width = await ev('window.__yanRightPanel.getState().width')
  R.panelWidth = width
  const variants = async (name, { light = true, full = true } = {}) => {
    await S.unhover()
    if (full) await S.shot(`${name}-dark`)
    await S.clip(`${name}-panel`, panel, 0)
    if (light) { await S.theme('light'); await sleep(400); await S.clip(`${name}-light`, panel, 0); await S.theme('dark'); await sleep(300) }
  }
  const info = (selector = '[data-testid="v3-wb-pulls"]') => ev(`(() => { const root = document.querySelector(${JSON.stringify(selector)}); if (!root) return null; const r = root.getBoundingClientRect(); const over = [...root.querySelectorAll('*')].filter((n) => { const b = n.getBoundingClientRect(); return b.width > 0 && (b.right > r.right + 1 || b.left < r.left - 1) }).map((n) => (n.getAttribute('data-testid') || n.className || n.tagName).toString().slice(0, 50)).slice(0, 8); return { text: root.innerText.replace(/\\s+/g, ' ').slice(0, 400), rows: root.querySelectorAll('.gh-pr-row').length, width: Math.round(r.width), overflow: over, ids: [...root.querySelectorAll('[data-testid]')].map((n) => n.getAttribute('data-testid')).filter((id) => !/row-|conflict-|file-/.test(id)).slice(0, 40) } })()`)
  const refresh = async () => { await S.click('[data-testid="gh-pr-refresh"], [data-testid="gh-pr-hint-refresh"]', 300) }
  const kbd = async (selector, name, { shift = true } = {}) => {
    const ok = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); return true })()`)
    if (!ok) { log('找不到焦点目标', selector); return null }
    await S.key('Tab')
    if (shift) await S.key('Tab', { shift: true })
    const active = await ev(`(() => { const el = document.activeElement; return { id: el?.getAttribute('data-testid') ?? el?.getAttribute('aria-label') ?? el?.tagName, outline: el ? getComputedStyle(el).outlineStyle + ' ' + getComputedStyle(el).outlineWidth : null } })()`)
    await S.clip(name, panel, 0)
    return active
  }
  const openList = async () => {
    await ev(`(() => { const rp = window.__yanRightPanel.getState(); rp.open({ id: 'pullRequests', kind: 'pullRequests' }); rp.setOpen(true); return true })()`)
    return until(`!!document.querySelector('[data-testid="v3-wb-pulls"]')`, 15000, 100)
  }
  const openDetail = async (number) => {
    await ev(`(() => { const rp = window.__yanRightPanel.getState(); rp.open({ id: 'pr:${number}', kind: 'pullRequest', number: ${number} }); rp.setOpen(true); return true })()`)
    return until(`!!document.querySelector('[data-testid="gh-pr-detail-${number}"]')`, 15000, 100)
  }
  const detailReady = (number) => until(`!!document.querySelector('[data-testid="gh-pr-detail-${number}"] [data-testid="gh-pr-state"]') && !document.querySelector('[data-testid="gh-pr-detail-${number}"] [data-testid="gh-pr-detail-skeleton"]')`, 20000, 100)

  const session = demo.sessions[0]
  await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(session.file)})`)
  check('PR：切到演示会话', await until(`s.session?.cwd === ${JSON.stringify(demo.project)}`, 20000, 100), demo.project)
  await sleep(1500)

  control({ delayMs: 6000, delayOp: 'pr.list' })
  check('PR：列表面板打开', await openList())
  R.skeletonSeen = await until(`!!document.querySelector('[data-testid="gh-pr-list-skeleton"]')`, 8000, 50)
  await sleep(200)
  R.loading = await info()
  await variants('prs-00-loading', { light: false })
  control({})
  R.listShown = await until(`document.querySelectorAll('.gh-pr-row').length > 0`, 20000, 100)
  await sleep(800)
  R.normal = await info()
  await variants('prs-01-list')
  R.searchHint = await ev(`document.querySelector('.gh-pr-search .ui-search__box')?.getAttribute('title') ?? null`)
  check('PR：搜索框悬停说明写出可搜字段', !!R.searchHint && R.searchHint.includes('分支'), R.searchHint)
  report.hover.push(['prs-01-row-hover', await S.hover('[data-testid="gh-pr-row-102"]', 900)])
  await S.clip('prs-01-row-hover', panel, 0)
  await S.unhover()
  report.focus.push(['prs-01-row-focus', await kbd('[data-testid="gh-pr-row-101"]', 'prs-01-row-focus')])
  report.focus.push(['prs-01-search-focus', await kbd('.gh-pr-search input', 'prs-01-search-focus', { shift: false })])
  await ev('document.activeElement?.blur?.()')
  if (await S.click('[data-testid="gh-pr-filter-open"]', 1200)) {
    R.filterPanel = await info('[data-testid="gh-pr-filter-panel"]')
    await S.shot('prs-02-filter-dark')
    await S.theme('light'); await sleep(400); await S.shot('prs-02-filter-light'); await S.theme('dark'); await sleep(300)
    await S.key('Escape', { waitMs: 400 })
  }
  if (await S.click('[data-testid="gh-pr-sort"] button', 700)) {
    await S.shot('prs-02-sort-dark')
    await S.key('Escape', { waitMs: 400 })
  }
  await S.click('[data-testid="gh-pr-tab-all"]', 300)
  await until(`document.querySelectorAll('.gh-pr-row').length >= 9`, 15000, 100)
  await sleep(600)
  R.all = await info()
  await variants('prs-03-all', { light: false })
  await S.click('[data-testid="gh-pr-tab-open"]', 300)
  await sleep(800)

  const longTitles = ['修复额度页在窄窗下的换行问题，并补充深浅两套主题下的对照截图与键盘焦点说明', 'Refactor the reconciliation pipeline so that every stage reports structured progress events with retries', '文档：补充离线演示仓库的使用说明', 'chore(deps): bump very-long-dependency-name-for-testing-truncation from 1.2.3 to 1.3.0', '会话分支树：离开时总结开关在窄栏下的排布']
  await editState((s) => {
    const base = s.prs.filter((p) => p.state === 'OPEN')
    for (let i = 0; i < 36; i++) {
      const from = base[i % base.length]
      const number = 200 + i
      s.prs.push({ ...JSON.parse(JSON.stringify(from)), number, title: `${longTitles[i % longTitles.length]} (#${i + 1})`, updatedAt: new Date(Date.now() - (i * 37 + 3) * 60000).toISOString(), url: `${s.repo.url}/pull/${number}` })
    }
    s.nextNumber = 300
  })
  await refresh()
  R.manyShown = await until(`document.querySelectorAll('.gh-pr-row').length >= 30`, 20000, 100)
  await sleep(800)
  R.many = await info()
  await variants('prs-04-many')
  await ev(`(() => { const el = document.querySelector('[data-testid="gh-pr-load-more"]'); el?.scrollIntoView({ block: 'end' }); return !!el })()`)
  await sleep(500)
  await S.clip('prs-04-many-bottom', panel, 0)
  await ev(`(() => { const el = document.querySelector('.gh-pr-pane'); if (el) el.scrollTop = 0; const list = document.querySelector('.gh-pr-list'); if (list) list.scrollTop = 0; return true })()`)

  await S.click('.gh-pr-search input', 300)
  await S.typeText('zzz-no-such-pr', 600)
  await sleep(500)
  R.searchEmpty = await info()
  await variants('prs-05-search-empty', { light: false })
  await ev(`(() => { const el = document.querySelector('.gh-pr-search input'); el?.focus(); return true })()`)
  await S.key('Escape', { waitMs: 400 })
  await ev('document.activeElement?.blur?.()')

  await editState((s) => { s.prs = s.prs.filter((p) => p.state !== 'OPEN') })
  await refresh()
  await until(`document.querySelectorAll('.gh-pr-row').length === 0 && !document.querySelector('[data-testid="gh-pr-list-skeleton"]')`, 15000, 100)
  await sleep(1200)
  R.empty = await info()
  await variants('prs-06-empty')
  await restoreState()

  control({ failure: 'pr.list:timeout' })
  await refresh()
  R.listErrorShown = await until(`!!document.querySelector('[data-testid="gh-pr-list-error"]')`, 15000, 100)
  await sleep(600)
  R.listError = await info()
  await variants('prs-07-list-error')

  control({ failure: 'auth.status:auth' })
  await refresh()
  R.signedOutShown = await until(`!!document.querySelector('[data-testid="gh-pr-hint"]')`, 15000, 100)
  await sleep(600)
  R.signedOut = await info()
  await variants('prs-08-signed-out')
  report.focus.push(['prs-08-refresh-focus', await kbd('[data-testid="gh-pr-hint-refresh"]', 'prs-08-refresh-focus')])
  await ev('document.activeElement?.blur?.()')

  control({ failure: 'repo.view:norepo' })
  await refresh()
  await sleep(2500)
  R.notRepo = await info()
  await variants('prs-09-not-repo', { light: false })

  control({ failure: 'api.GET:forbidden' })
  await refresh()
  await sleep(2500)
  R.forbiddenStatus = await info()

  control({})
  await refresh()
  await until(`document.querySelectorAll('.gh-pr-row').length > 0`, 20000, 100)
  await sleep(800)

  control({ delayMs: 6000, delayOp: 'pr.view' })
  check('PR：详情打开', await openDetail(108))
  R.detailSkeleton = await until(`!!document.querySelector('[data-testid="gh-pr-detail-skeleton"]')`, 8000, 50)
  await sleep(200)
  await variants('prs-10-detail-loading', { light: false })
  control({})
  R.detailReady = await detailReady(108)
  await sleep(1000)
  R.detail = await info('[data-testid="gh-pr-detail-108"]')
  await variants('prs-11-detail-summary')
  report.focus.push(['prs-11-detail-merge-focus', await kbd('[data-testid="gh-pr-merge"]', 'prs-11-detail-merge-focus')])
  report.hover.push(['prs-11-checks-hover', await S.hover('[data-testid="gh-pr-checks-line"]', 900)])
  await S.clip('prs-11-checks-hover', panel, 0)
  await S.unhover()
  if (await S.click('[data-testid="gh-pr-checks-line"]', 900)) {
    R.checkStates = await ev(`[...document.querySelectorAll('.gh-pr-check__state')].map((n) => n.textContent + '|' + (n.getAttribute('title') ?? ''))`)
    check('PR：检查浮层显示中文状态，原词在 title', Array.isArray(R.checkStates) && R.checkStates.length > 0 && R.checkStates.every((s) => !/^[A-Z_]+\|/.test(s)), R.checkStates)
    await S.shot('prs-11-checks-pop-dark')
    await S.theme('light'); await sleep(400); await S.shot('prs-11-checks-pop-light'); await S.theme('dark'); await sleep(300)
    await S.key('Escape', { waitMs: 400 })
  }
  if (await S.click('[data-testid="gh-pr-agent"]', 900)) { await S.shot('prs-11-agent-menu-dark'); await S.key('Escape', { waitMs: 400 }) }
  await ev(`(() => { const el = document.querySelector('[data-testid="gh-pr-detail-108"] .gh-prd__body:not([hidden])'); if (el) el.scrollTop = 600; return !!el })()`)
  await sleep(900)
  R.condensed = await ev(`document.querySelector('[data-testid="gh-pr-detail-108"]')?.getAttribute('data-condensed') ?? null`)
  await S.clip('prs-11-detail-scrolled', panel, 0)
  await ev(`(() => { const el = document.querySelector('[data-testid="gh-pr-detail-108"] .gh-prd__body:not([hidden])'); if (el) el.scrollTop = 0; return !!el })()`)
  await sleep(700)
  await S.click('[data-testid="gh-pr-tab-timeline"]', 900)
  R.timeline = await info('[data-testid="gh-pr-detail-108"]')
  await variants('prs-12-detail-timeline', { light: false })
  await S.click('[data-testid="gh-pr-tab-code"]', 900)
  await ev(`(() => { const b = document.querySelector('[data-testid^="gh-pr-file-toggle-"]'); b?.click(); return !!b })()`)
  await sleep(1500)
  R.code = await info('[data-testid="gh-pr-detail-108"]')
  await variants('prs-13-detail-code')
  report.focus.push(['prs-13-file-focus', await kbd('[data-testid^="gh-pr-file-toggle-"]', 'prs-13-file-focus')])
  await ev('document.activeElement?.blur?.()')
  await S.click('[data-testid="gh-pr-tab-summary"]', 600)

  check('PR：#109 详情', await openDetail(109))
  await detailReady(109)
  await sleep(1200)
  R.long = await info('[data-testid="gh-pr-detail-109"]')
  await variants('prs-14-detail-long', { light: false })
  await S.click('[data-testid="gh-pr-tab-code"]', 1200)
  R.longCode = await info('[data-testid="gh-pr-detail-109"]')
  await variants('prs-14-detail-long-code', { light: false })
  await S.click('[data-testid="gh-pr-tab-summary"]', 600)

  check('PR：#105 冲突', await openDetail(105))
  await detailReady(105)
  await sleep(1200)
  R.conflict = await info('[data-testid="gh-pr-detail-105"]')
  await variants('prs-15-detail-conflict')
  R.tabFit = await ev(`(() => { const vp = document.querySelector('[data-testid="rp"] [data-right-panel-tab-list] [data-slot="scroll-area-viewport"]'); const a = vp?.querySelector('[data-tab-id][data-active-tab="true"]'); if (!vp || !a) return { vp: !!vp, a: !!a, chips: document.querySelectorAll('[data-testid="rp"] [data-tab-id]').length, activeAttr: [...document.querySelectorAll('[data-testid="rp"] [data-tab-id]')].map((n) => n.getAttribute('data-active-tab')) }; const v = vp.getBoundingClientRect(); const r = a.getBoundingClientRect(); const kids = [...a.querySelectorAll('*')].map((n) => { const b = n.getBoundingClientRect(); return (String(n.className).slice(0, 30)) + ':' + Math.round(b.left - v.left) + '-' + Math.round(b.right - v.left) }).slice(0, 8); return { id: a.getAttribute('data-tab-id'), vl: Math.round(v.left), vw: Math.round(v.width), cw: vp.clientWidth, sw: vp.scrollWidth, sl: Math.round(vp.scrollLeft), fade: vp.hasAttribute('data-fade'), left: Math.round(r.left - v.left), right: Math.round(r.right - v.left), kids } })()`)
  check('PR：详情页当前标签完整可见', !!R.tabFit && R.tabFit.right <= R.tabFit.vw + 1 && R.tabFit.left >= -1, R.tabFit)
  check('PR：#102 检查失败', await openDetail(102))
  await detailReady(102)
  await sleep(1200)
  R.failing = await info('[data-testid="gh-pr-detail-102"]')
  await variants('prs-16-detail-failing', { light: false })
  check('PR：#106 已合并', await openDetail(106))
  await detailReady(106)
  await sleep(1200)
  R.merged = await info('[data-testid="gh-pr-detail-106"]')
  await variants('prs-17-detail-merged', { light: false })

  control({ failure: 'pr.view:forbidden' })
  check('PR：#104 详情失败', await openDetail(104))
  await until(`!!document.querySelector('[data-testid="gh-pr-detail-error"]')`, 15000, 100)
  await sleep(800)
  R.detailError = await info('[data-testid="gh-pr-detail-104"]')
  await variants('prs-18-detail-error')
  control({ failure: 'pr.diff:timeout' })
  check('PR：#103 diff 失败', await openDetail(103))
  await detailReady(103)
  await S.click('[data-testid="gh-pr-tab-code"]', 1200)
  R.diffError = await info('[data-testid="gh-pr-detail-103"]')
  await variants('prs-19-diff-error')
  report.focus.push(['prs-19-diff-retry-focus', await kbd('[data-testid="gh-pr-diff-retry"]', 'prs-19-diff-retry-focus')])
  control({})
  R.diffRetryClicked = await S.click('[data-testid="gh-pr-diff-retry"]', 300)
  R.diffRetryRecovered = await until(`!document.querySelector('[data-testid="gh-pr-diff-error"]') && document.querySelectorAll('[data-testid="gh-pr-detail-103"] .gh-pr-file').length > 0`, 15000, 150)
  check('PR：diff 失败后只重读 diff 就能恢复', R.diffRetryClicked && R.diffRetryRecovered)
  await sleep(600)
  await variants('prs-19b-diff-retried', { light: false })
  await S.click('[data-testid="gh-pr-tab-summary"]', 600)

  await openList()
  await sleep(800)
  if (await S.click('[data-testid="gh-pr-create-open"]', 1500)) {
    R.create = await info('[data-testid="gh-pr-create"]')
    await S.shot('prs-20-create-dark')
    await S.theme('light'); await sleep(400); await S.shot('prs-20-create-light'); await S.theme('dark'); await sleep(300)
    await S.key('Escape', { waitMs: 500 })
  }

  const other = width < 600 ? 869 : 360
  await ev(`(window.__yanRightPanel.getState().setWidth(${other}), true)`)
  await sleep(1200)
  R.otherList = await info()
  await variants(`prs-21-w${other}-list`, { light: false })
  await openDetail(108)
  await detailReady(108)
  await sleep(1000)
  R.otherDetail = await info('[data-testid="gh-pr-detail-108"]')
  await variants(`prs-21-w${other}-detail`, { light: false })
  await ev(`(window.__yanRightPanel.getState().setWidth(${width}), true)`)
  await sleep(900)
  report.audit.prsDetail = await S.audit('[data-testid="gh-pr-detail-108"]')
  await openList()
  await sleep(600)
  report.audit.prs = await S.audit('[data-testid="v3-wb-pulls"]')
  await restoreState()
  control({})
}

async function subagentsTarget({ kit: S, ev, sleep, until, check, log, report, newSession, turn }) {
  report.subagents = {}
  const R = report.subagents
  const dir = mkdtempSync(join(tmpdir(), 'inkstone-ui-sub-'))
  writeFileSync(join(dir, 'README.md'), '# subagent fixture\n')
  const git = (...args) => spawnSync('git', ['-c', 'user.name=Inkstone Debug', '-c', 'user.email=debug@inkstone.invalid', ...args], { cwd: dir, stdio: 'ignore', windowsHide: true })
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'fixture')
  R.fixture = dir
  check('子代理：夹具不在当前仓库里', !dir.toLowerCase().startsWith(process.cwd().toLowerCase()), dir)
  const panel = '[data-testid="rp-column-0"]'
  const width = await ev('window.__yanRightPanel.getState().width')
  R.panelWidth = width
  const originalMode = await ev('window.__yanStore.getState().settings?.permissionMode ?? null')
  const variants = async (name, { light = true, full = true } = {}) => {
    await S.unhover()
    if (full) await S.shot(`${name}-dark`)
    await S.clip(`${name}-panel`, panel, 0)
    if (light) { await S.theme('light'); await sleep(400); await S.clip(`${name}-light`, panel, 0); await S.theme('dark'); await sleep(300) }
  }
  const info = () => ev(`(() => { const root = document.querySelector('[data-testid="v3-subagent-pane"], [data-testid="v3-subagent-pane-missing"]'); if (!root) return null; const col = document.querySelector(${JSON.stringify(panel)}); const r = (col || root).getBoundingClientRect(); const over = [...(col || root).querySelectorAll('*')].filter((n) => { const b = n.getBoundingClientRect(); return b.width > 0 && b.right > r.right + 1 }).map((n) => (n.getAttribute('data-testid') || String(n.className) || n.tagName).slice(0, 50)).slice(0, 8); const head = col?.querySelector('[data-testid="v3-subagent-pane-head"]'); const clipped = head ? [...head.querySelectorAll('span')].filter((n) => n.scrollWidth > n.clientWidth + 1).map((n) => n.className) : []; const scroll = root.querySelector('.sa-pane-scroll'); return { state: root.getAttribute('data-state'), head: head?.innerText?.replace(/\\s+/g, ' ') ?? null, clipped, text: root.innerText.replace(/\\s+/g, ' ').slice(0, 300), overflow: over, scroll: scroll ? { h: scroll.clientHeight, sh: scroll.scrollHeight, top: Math.round(scroll.scrollTop) } : null, foot: root.querySelector('[data-testid="v3-subagent-pane-foot"]')?.innerText?.replace(/\\s+/g, ' ').slice(0, 160) ?? null, tools: [...(col?.querySelectorAll('button') ?? [])].filter((b) => b.closest('[data-testid="v3-subagent-pane"]') === null && b.getBoundingClientRect().width > 0).map((b) => b.getAttribute('aria-label') || b.innerText.trim()).slice(0, 12) } })()`)
  const openPane = async (id) => {
    await ev(`(() => { const rp = window.__yanRightPanel.getState(); rp.open({ id: 'subagent:${id}', kind: 'subagent', runId: '${id}' }); rp.setOpen(true); return true })()`)
    await until(`!!document.querySelector('[data-testid="v3-subagent-pane"], [data-testid="v3-subagent-pane-missing"]')`, 10000, 100)
    await sleep(900)
  }
  const runs = (filter) => ev(`(window.__yanStore.getState().subagents ?? []).filter((a) => ${filter}).map((a) => ({ id: a.id, status: a.status, task: a.task }))`)
  const kbd = async (selector, name) => {
    const ok = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); return true })()`)
    if (!ok) { log('找不到焦点目标', selector); return null }
    await S.key('Tab')
    await S.key('Tab', { shift: true })
    const active = await ev(`document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName`)
    await S.clip(name, panel, 0)
    return active
  }

  await newSession(dir)
  await ev(`window.__yanStore.getState().patchSettings({ permissionMode: 'all' })`)
  await openPane('sub-missing0')
  R.missing = await info()
  await variants('sub-00-missing', { light: false })

  await turn('SUBAGENTS2 THENREST 派两个子代理', { timeout: 120000 })
  R.runningSeen = await until(`(s.subagents ?? []).filter((a) => a.status === 'running').length >= 2`, 60000, 200)
  check('子代理：两个在运行', R.runningSeen)
  const first = (await runs(`a.status === 'running'`))[0]
  R.first = first
  if (first) {
    await openPane(first.id)
    await sleep(2500)
    R.running = await info()
    await variants('sub-01-running')
    report.hover.push(['sub-01-stop-hover', await S.hover('[data-testid="v3-subagent-stop"]', 900)])
    await S.clip('sub-01-stop-hover', panel, 0)
    await S.unhover()
    report.focus.push(['sub-01-stop-focus', await kbd('[data-testid="v3-subagent-stop"]', 'sub-01-stop-focus')])
    report.focus.push(['sub-01-next-focus', await kbd('[data-testid="v3-subagent-pane-next"]', 'sub-01-next-focus')])
    await ev('document.activeElement?.blur?.()')
    const scrollBox = await ev(`(() => { const b = document.querySelector('[data-testid="v3-subagent-pane"] .sa-pane-scroll')?.getBoundingClientRect(); return b ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null })()`)
    if (scrollBox) await S.cdpCall('Input.dispatchMouseEvent', { type: 'mouseWheel', x: scrollBox.x, y: scrollBox.y, deltaX: 0, deltaY: -1500 })
    await sleep(2500)
    R.scrolledUp = await info()
    await S.clip('sub-01-running-scrolled-up', panel, 0)
    R.doneSeen = await until(`(s.subagents ?? []).some((a) => a.id === ${JSON.stringify(first.id)} && a.status !== 'running' && a.status !== 'starting')`, 240000, 500)
    await sleep(1500)
    await ev(`(() => { const el = document.querySelector('[data-testid="v3-subagent-pane"] .sa-pane-scroll'); if (el) el.scrollTop = el.scrollHeight; return !!el })()`)
    await sleep(800)
    R.done = await info()
    await variants('sub-02-done')
    await ev(`(() => { const el = document.querySelector('[data-testid="v3-subagent-pane"] .sa-pane-scroll'); if (el) el.scrollTop = 0; return !!el })()`)
    await sleep(600)
    await S.clip('sub-02-done-top', panel, 0)
    report.focus.push(['sub-02-composer-focus', await kbd('[data-testid="v3-subagent-pane-foot"] textarea', 'sub-02-composer-focus')])
    await ev('document.activeElement?.blur?.()')
  }
  await until(`(s.subagents ?? []).every((a) => a.status !== 'running' && a.status !== 'starting')`, 240000, 1000)

  await turn('SUBAGENTS1 SUBBAD THENREST 派一个会失败的子代理', { timeout: 120000 })
  R.failedSeen = await until(`(s.subagents ?? []).some((a) => a.task.includes('FAILNET') && a.status === 'error')`, 180000, 500)
  check('子代理：拍到失败', R.failedSeen)
  const failed = (await runs(`a.task.includes('FAILNET')`))[0]
  if (failed) {
    await openPane(failed.id)
    R.failed = await info()
    await variants('sub-03-failed')
    report.hover.push(['sub-03-dismiss-hover', await S.hover('[data-testid="v3-subagent-dismiss"]', 1200)])
    await S.clip('sub-03-dismiss-hover', panel, 0)
    await S.unhover()
  }

  await turn('SUBAGENTS1 SUBLONG THENREST 派一个长记录子代理', { timeout: 120000 })
  R.longSeen = await until(`(s.subagents ?? []).some((a) => a.task.includes('SUBLONG') && a.status === 'running')`, 60000, 300)
  const long = (await runs(`a.task.includes('SUBLONG')`))[0]
  if (long) {
    await openPane(long.id)
    await sleep(6000)
    R.long = await info()
    await variants('sub-04-long-running', { light: false })
    const other = width < 600 ? 869 : 360
    await ev(`(window.__yanRightPanel.getState().setWidth(${other}), true)`)
    await sleep(1500)
    R.otherWidth = { width: other, info: await info() }
    await variants(`sub-05-w${other}-long`, { light: false })
    if (first) {
      await openPane(first.id)
      R.otherDone = await info()
      await variants(`sub-05-w${other}-done`, { light: false })
    }
    await ev(`(window.__yanRightPanel.getState().setWidth(${width}), true)`)
    await sleep(900)
    await openPane(long.id)
    if (await S.click('[data-testid="v3-subagent-stop"]', 1500)) {
      await until(`(s.subagents ?? []).some((a) => a.id === ${JSON.stringify(long.id)} && a.status !== 'running')`, 30000, 300)
      await sleep(1000)
      R.stopped = await info()
      await variants('sub-06-stopped', { light: false })
    }
  }
  report.audit.subagents = await S.audit('[data-testid="v3-subagent-pane"]')
  await ev(`window.__yanStore.getState().patchSettings({ permissionMode: ${JSON.stringify(originalMode)} })`)
}

async function shellTarget({ kit: S, ev, sleep, until, check, log, report, newSession }) {
  report.shell = {}
  const R = report.shell
  const dir = mkdtempSync(join(tmpdir(), 'inkstone-ui-shell-'))
  writeFileSync(join(dir, 'README.md'), '# shell fixture\n')
  writeFileSync(join(dir, 'notes-with-a-rather-long-file-name-for-tabs.md'), '# notes\n')
  writeFileSync(join(dir, 'config.json'), '{"a":1}\n')
  const rp = '[data-testid="rp"]'
  const width = await ev('window.__yanRightPanel.getState().width')
  R.panelWidth = width
  const variants = async (name, { light = true, full = true, target = rp } = {}) => {
    await S.unhover()
    if (full) await S.shot(`${name}-dark`)
    await S.clip(`${name}-panel`, target, 0)
    if (light) { await S.theme('light'); await sleep(400); await S.clip(`${name}-light`, target, 0); await S.theme('dark'); await sleep(300) }
  }
  const info = () => ev(`(() => { const root = document.querySelector('[data-testid="rp"]'); if (!root) return null; const r = root.getBoundingClientRect(); const tabs = [...root.querySelectorAll('[role="tab"]')].map((t) => { const b = t.getBoundingClientRect(); return { text: t.innerText.trim().slice(0, 30), w: Math.round(b.width), visible: b.right <= r.right + 1 && b.left >= r.left - 1 && b.width > 0, selected: t.getAttribute('aria-selected') === 'true' } }); const over = [...root.querySelectorAll('*')].filter((n) => { const b = n.getBoundingClientRect(); return b.width > 0 && b.right > r.right + 1 && !n.closest('.t3-tab-strip__scroll') }).map((n) => (n.getAttribute('data-testid') || String(n.className) || n.tagName).slice(0, 50)).slice(0, 8); return { box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], columns: root.querySelectorAll('[data-rp-column]').length, tabs, overflow: over, all: !!root.querySelector('[data-testid="rp-all-tabs"]'), text: root.innerText.replace(/\\s+/g, ' ').slice(0, 240) } })()`)
  const api = (call) => ev(`(() => { const rp = window.__yanRightPanel.getState(); ${call}; return true })()`)
  const kbd = async (selector, name, target = rp) => {
    const ok = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); return true })()`)
    if (!ok) { log('找不到焦点目标', selector); return null }
    await S.key('Tab')
    await S.key('Tab', { shift: true })
    const active = await ev(`document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim().slice(0, 30)`)
    await S.clip(name, target, 0)
    return active
  }

  await newSession(dir)
  await api('rp.closeAll(); rp.setOpen(true)')
  check('外壳：启动器出现', await until(`!!document.querySelector('.t3-launcher__row')`, 10000, 100))
  await sleep(600)
  R.launcher = await info()
  R.launcherReasons = await ev(`[...document.querySelectorAll('.t3-launcher__reason')].map((n) => n.textContent)`)
  R.launcherOrder = await ev(`[...document.querySelectorAll('.t3-launcher__row')].map((n) => (n.classList.contains('t3-launcher__row--disabled') ? '-' : '+') + n.textContent.trim())`)
  await variants('shell-00-launcher')
  report.hover.push(['shell-00-launcher-hover', await S.hover('.t3-launcher__row', 900, 2)])
  await S.clip('shell-00-launcher-hover', rp, 0)
  await S.unhover()
  report.focus.push(['shell-00-launcher-focus', await kbd('button.t3-launcher__row', 'shell-00-launcher-focus')])
  await ev('document.activeElement?.blur?.()')

  for (const kind of ['files', 'changes', 'context', 'logs', 'quota', 'branch', 'pullRequests', 'device']) await api(`rp.open({ id: '${kind}', kind: '${kind}' })`)
  for (const name of ['README.md', 'notes-with-a-rather-long-file-name-for-tabs.md', 'config.json']) {
    const path = join(dir, name).replaceAll('\\', '/')
    await api(`rp.open({ id: 'file:${path}', kind: 'file', path: '${path}' })`)
  }
  await sleep(1500)
  R.many = await info()
  await variants('shell-01-many-tabs')
  await S.clip('shell-01-many-tabs-strip', '[data-right-panel-tabbar], .t3-rp-frame__tabbar', 0)
  const activeFit = () => ev(`(() => { const vp = document.querySelector('[data-testid="rp"] [data-right-panel-tab-list] [data-slot="scroll-area-viewport"]'); const a = vp?.querySelector('[data-tab-id][data-active-tab="true"]'); if (!vp || !a) return null; const v = vp.getBoundingClientRect(); const r = a.getBoundingClientRect(); const fade = vp.hasAttribute('data-fade') ? parseFloat(getComputedStyle(vp).scrollPaddingInlineStart) || 0 : 0; const startFade = vp.scrollLeft > 1 ? fade : 0; const endFade = vp.scrollLeft + vp.clientWidth < vp.scrollWidth - 1 ? fade : 0; return { id: a.getAttribute('data-tab-id'), left: Math.round(r.left - v.left), right: Math.round(v.right - r.right), fade, ok: r.left >= v.left + startFade - 1 && r.right <= v.right - endFade + 1 } })()`)
  const stripShot = async (name, id) => {
    await api(`rp.activate(${JSON.stringify(id)})`)
    await sleep(900)
    await S.unhover()
    const fit = await activeFit()
    R[name] = fit
    check(`外壳：当前标签完整可见（${name}）`, !!fit?.ok, fit)
    await S.clip(name, '[data-testid="rp-column-0"] .t3-tab-strip', 6)
  }
  const ids = await ev(`[...document.querySelectorAll('[data-testid="rp"] [data-tab-id]')].map((n) => n.getAttribute('data-tab-id'))`)
  R.tabIds = ids
  if (Array.isArray(ids) && ids.length > 2) {
    await stripShot('shell-01b-active-middle', ids[Math.floor(ids.length / 2)])
    await stripShot('shell-01c-active-last', ids[ids.length - 1])
    await stripShot('shell-01d-active-first', ids[0])
    await ev(`(window.__yanRightPanel.getState().setWidth(${width < 600 ? 869 : 360}), true)`)
    await sleep(1200)
    await stripShot('shell-01e-active-middle-alt', ids[Math.floor(ids.length / 2)])
    await stripShot('shell-01f-active-last-alt', ids[ids.length - 1])
    await ev(`(window.__yanRightPanel.getState().setWidth(${width}), true)`)
    await sleep(1200)
  }
  if (await S.click('[data-testid="rp-all-tabs"]', 900)) {
    R.allMenu = await ev(`[...document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemradio"]')].map((n) => n.textContent.trim().slice(0, 40)).slice(0, 20)`)
    await S.shot('shell-02-all-tabs-menu-dark')
    await S.key('Escape', { waitMs: 400 })
  }
  if (await S.click('[data-testid="rp-new-tab"]', 900)) {
    await S.shot('shell-03-add-menu-dark')
    await S.theme('light'); await sleep(400); await S.shot('shell-03-add-menu-light'); await S.theme('dark'); await sleep(300)
    await S.key('Escape', { waitMs: 400 })
  }
  R.contextMenu = await ev(`(() => { const a = document.querySelector('[data-testid="rp"] [role="tab"][aria-selected="true"]'); if (!a) return false; const b = a.getBoundingClientRect(); a.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 8, clientY: b.top + 8, button: 2 })); return true })()`)
  await sleep(700)
  await S.shot('shell-04-tab-menu-dark')
  await S.key('Escape', { waitMs: 400 })
  report.hover.push(['shell-05-tab-hover', await S.hover('[data-testid="rp"] [role="tab"]', 1200, 1)])
  await S.clip('shell-05-tab-hover', rp, 0)
  await S.unhover()
  report.focus.push(['shell-05-tab-focus', await kbd('[data-testid="rp"] [role="tab"][aria-selected="true"]', 'shell-05-tab-focus')])
  await ev('document.activeElement?.blur?.()')

  await api('rp.setMaximized(true)')
  await sleep(1200)
  R.maximized = await info()
  await variants('shell-06-maximized', { light: false })
  await api('rp.setMaximized(false)')
  await sleep(900)

  await api(`rp.activate('logs'); rp.split('logs')`)
  await sleep(1200)
  R.split2 = await info()
  await variants('shell-07-split2', { light: false })
  await ev(`(window.__yanRightPanel.getState().setWidth(869), true)`)
  await sleep(1200)
  R.split2wide = await info()
  await variants('shell-07-split2-w869')
  await api(`rp.activate('context'); rp.split('context')`)
  await sleep(1200)
  R.split3 = await info()
  await variants('shell-08-split3-w869', { light: false })
  report.focus.push(['shell-08-splitter-focus', await kbd('[data-testid="rp-column-splitter-1"]', 'shell-08-splitter-focus')])
  report.hover.push(['shell-08-close-column-hover', await S.hover('[data-testid="rp-close-column-1"]', 1200)])
  await S.clip('shell-08-close-column-hover', rp, 0)
  await S.unhover()
  await ev(`(window.__yanRightPanel.getState().setWidth(${width}), true)`)
  await sleep(1200)
  R.split3narrow = await info()
  await variants('shell-09-split3-user-width', { light: false })
  await api('rp.closeGroup(2)')
  await api('rp.closeGroup(1)')
  await sleep(900)

  await S.narrow()
  await sleep(1200)
  R.drawer = await info()
  await S.shot('shell-10-narrow-drawer-dark')
  await S.theme('light'); await sleep(400); await S.shot('shell-10-narrow-drawer-light'); await S.theme('dark'); await sleep(300)
  await api('rp.closeAll()')
  await sleep(800)
  R.drawerEmpty = await info()
  await S.shot('shell-11-narrow-launcher-dark')
  await S.wide()
  await sleep(1200)
  report.audit.shell = await S.audit('[data-testid="rp"]')
}

async function overviewTarget({ kit: S, ev, sleep, until, check, log, report, newSession, turn }) {
  report.overview = {}
  const R = report.overview
  const bar = '[data-testid="v3-sessionbar"]'
  const width = await ev('window.__yanRightPanel.getState().width')
  R.panelWidth = width
  const alt = width < 600 ? 869 : 360
  const branchName = 'feature/ui-polish-overview-branch-with-a-very-long-name'
  const dir = mkdtempSync(join(tmpdir(), 'inkstone-ui-ov-'))
  writeFileSync(join(dir, 'README.md'), '# overview fixture\n')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'app.ts'), 'export const value = 1\n')
  const git = (...args) => spawnSync('git', ['-c', 'user.name=Inkstone Debug', '-c', 'user.email=debug@inkstone.invalid', ...args], { cwd: dir, stdio: 'ignore', windowsHide: true })
  git('init', '-q', '-b', branchName); git('add', '-A'); git('commit', '-q', '-m', 'fixture')
  writeFileSync(join(dir, 'README.md'), '# overview fixture\n\nchanged\n')
  writeFileSync(join(dir, 'src', 'app.ts'), 'export const value = 2\nexport const other = 3\n')
  git('add', 'src/app.ts')
  writeFileSync(join(dir, 'TODO.md'), '- untracked\n')
  const plain = mkdtempSync(join(tmpdir(), 'inkstone-ui-ov-plain-'))
  writeFileSync(join(plain, 'notes.md'), '# plain\n')
  R.fixture = dir
  check('概览：夹具不在当前仓库里', !dir.toLowerCase().startsWith(process.cwd().toLowerCase()) && !plain.toLowerCase().startsWith(process.cwd().toLowerCase()), [dir, plain])
  const info = () => ev(`(() => { const b = document.querySelector(${JSON.stringify(bar)}); if (!b) return { present: false }; const r = b.getBoundingClientRect(); const over = [...b.querySelectorAll('*')].filter((n) => { const x = n.getBoundingClientRect(); return x.width > 0 && x.right > r.right + 1 && !n.closest('.wb-tile-expand[data-open="false"]') }).map((n) => (n.getAttribute('data-testid') || String(n.className) || n.tagName).slice(0, 50)).slice(0, 8); const clipped = [...b.querySelectorAll('.ui-rail-row__label, .wb-tile-title, .wb-tile-summary, .wb-env-sum-name')].filter((n) => n.getBoundingClientRect().width > 0 && n.scrollWidth > n.clientWidth + 1).map((n) => n.textContent.trim().slice(0, 40)); return { present: true, width: Math.round(r.width), height: Math.round(r.height), sections: [...b.querySelectorAll('[data-rail-section]')].map((s) => s.getAttribute('data-rail-section') + ':' + (s.getAttribute('data-folded') === '0' ? 'open' : 'fold')), overflow: over, clipped, text: b.innerText.replace(/\\s+/g, ' ').slice(0, 400) } })()`)
  const setPanel = async (open, w = width) => {
    await ev(`(() => { const rp = window.__yanRightPanel.getState(); rp.setWidth(${w}); rp.setOpen(${open}); return true })()`)
    await sleep(1300)
  }
  const barShot = async (name, { light = true, full = true } = {}) => {
    await S.unhover()
    if (full) await S.shot(`${name}-dark`)
    if (await ev(`!!document.querySelector(${JSON.stringify(bar)})`)) await S.clip(`${name}-bar`, bar, 0)
    if (light) {
      await S.theme('light'); await sleep(400)
      if (await ev(`!!document.querySelector(${JSON.stringify(bar)})`)) await S.clip(`${name}-light`, bar, 0)
      else await S.shot(`${name}-light-full`)
      await S.theme('dark'); await sleep(300)
    }
  }
  const fold = (open) => ev(`(() => { let n = 0; for (const tile of document.querySelectorAll(${JSON.stringify(bar)} + ' .wb-tile')) { if (!tile.querySelector('.wb-tile-expand')) continue; const isOpen = tile.getAttribute('data-folded') === '0'; if (isOpen !== ${open}) { tile.querySelector('.wb-tile-toggle')?.click(); n++ } } return n })()`)
  const scrollBar = (where) => ev(`(() => { const b = document.querySelector(${JSON.stringify(bar)}); if (!b) return null; const out = []; for (const n of [b, ...b.querySelectorAll('*')]) { if (n.scrollHeight > n.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(n).overflowY)) { n.scrollTop = ${where === 'bottom' ? 'n.scrollHeight' : '0'}; out.push(n.className) } } return out })()`)
  const kbd = async (selector, name) => {
    const ok = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); return true })()`)
    if (!ok) { log('找不到焦点目标', selector); return null }
    await S.key('Tab')
    await S.key('Tab', { shift: true })
    const active = await ev(`document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim().slice(0, 30)`)
    await S.clip(name, bar, 0)
    return active
  }

  await newSession(plain)
  await turn('你好', { timeout: 60000 })
  await setPanel(false)
  R.barPlainShown = await until(`!!document.querySelector(${JSON.stringify(bar)})`, 10000, 150)
  await sleep(800)
  R.plain = await info()
  await barShot('ov-00-plain')

  await newSession(dir)
  await turn('WRITES 产出文件行', { timeout: 60000 })
  const jobs = await turn('TERMJOBS 后台任务', { timeout: 120000 })
  R.jobsRequests = jobs?.requests ?? null
  await setPanel(false)
  R.barShown = await until(`!!document.querySelector(${JSON.stringify(bar)}) && !!document.querySelector('[data-testid="wb-rail-branch"], [data-testid="wb-rail-env-summary"]')`, 15000, 150)
  check('概览：会话栏出现', R.barShown)
  await sleep(1500)
  R.defaults = await info()
  await barShot('ov-01-default')
  R.expanded = await fold(true)
  await sleep(1200)
  R.open = await info()
  check('概览：展开后没有横向溢出', !!R.open?.present && R.open.overflow.length === 0, R.open?.overflow)
  await barShot('ov-02-expanded')
  R.scrolled = await scrollBar('bottom')
  await sleep(500)
  await barShot('ov-02-expanded-bottom', { full: false })
  await scrollBar('top')
  await sleep(400)

  R.branchRow = await until(`!!document.querySelector('[data-testid="wb-rail-branch"]')`, 6000, 150)
  check('概览：分支行出现（BR7）', R.branchRow)
  report.hover.push(['ov-03-branch-hover', await S.hover('[data-testid="wb-rail-branch"]', 900)])
  await S.clip('ov-03-branch-hover', '[data-testid="wb-rail-environment"]', 6)
  await S.unhover()
  report.focus.push(['ov-04-toggle-focus', await kbd('[data-testid="wb-rail-environment"] .wb-tile-toggle', 'ov-04-toggle-focus')])
  report.focus.push(['ov-04-branch-focus', await kbd('[data-testid="wb-rail-branch"]', 'ov-04-branch-focus')])
  await ev('document.activeElement?.blur?.()')
  R.sectionMenu = await ev(`(() => { const h = document.querySelector(${JSON.stringify(bar)} + ' .wb-tile-head'); if (!h) return false; const b = h.getBoundingClientRect(); h.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 20, clientY: b.top + 10, button: 2 })); return true })()`)
  await sleep(700)
  await S.shot('ov-05-section-menu-dark')
  await S.key('Escape', { waitMs: 400 })

  for (const [tag, w] of [['user', width], ['alt', alt]]) {
    await setPanel(true, w)
    const shown = await ev(`!!document.querySelector(${JSON.stringify(bar)}) && !!document.querySelector('[data-testid="wb-rail-branch"]')`)
    R[`br7-${tag}`] = { width: w, shownWithPanel: shown }
    if (!shown) await setPanel(false, w)
    R[`br7-${tag}`].info = await info()
    await S.unhover()
    await S.shot(`ov-06-br7-${tag}-w${w}-dark`)
    await S.clip(`ov-06-br7-${tag}-w${w}-env`, '[data-testid="wb-rail-environment"]', 6)
    if (await S.click('[data-testid="wb-rail-branch-menu"]', 900)) {
      await S.shot(`ov-06-br7-${tag}-w${w}-menu-dark`)
      await S.key('Escape', { waitMs: 400 })
    }
    if (await S.click('[data-testid="wb-rail-branch"]', 1200)) {
      await S.shot(`ov-06-br7-${tag}-w${w}-picker-dark`)
      if (tag === 'user') { await S.theme('light'); await sleep(400); await S.shot(`ov-06-br7-${tag}-w${w}-picker-light`); await S.theme('dark'); await sleep(300) }
      await S.key('Escape', { waitMs: 500 })
    }
  }
  await setPanel(false, width)

  R.collapsed = await fold(false)
  await sleep(1000)
  R.folded = await info()
  await barShot('ov-07-collapsed')
  await fold(true)
  await sleep(800)
  for (const [tag, keyName] of [['min', 'End'], ['max', 'Home']]) {
    const ok = await ev(`(() => { const el = document.querySelector('[data-testid="v3-tiles-resizer"] [role="separator"], [data-testid="v3-tiles-resizer"]'); if (!el) return false; el.focus(); return true })()`)
    if (!ok) continue
    await S.key(keyName, { waitMs: 900 })
    R[`tiles-${tag}`] = await info()
    await barShot(`ov-08-tiles-${tag}`, { light: tag === 'min' })
  }
  if (await ev(`(() => { const el = document.querySelector('[data-testid="v3-tiles-resizer"] [role="separator"], [data-testid="v3-tiles-resizer"]'); if (!el) return false; el.focus(); return true })()`)) await S.key('End', { waitMs: 900 })
  await ev('document.activeElement?.blur?.()')
  await fold(false)
  await sleep(800)
  const homeKey = 'yan:home-background'
  const savedHome = await ev(`localStorage.getItem(${JSON.stringify(homeKey)})`)
  const setHome = async (raw) => {
    await ev(`(() => { const k = ${JSON.stringify(homeKey)}; const v = ${JSON.stringify(raw)}; if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); window.dispatchEvent(new StorageEvent('storage', { key: k })); return true })()`)
    await sleep(1200)
  }
  R.sessionBarBg = await ev(`getComputedStyle(document.querySelector(${JSON.stringify(bar)})).backgroundColor`)
  for (const [tag, raw] of [['bg-on', savedHome ?? JSON.stringify({ mode: 'dither', image: 'builtin:blossom', effect: 'dither', tone: 'dark' })], ['bg-off', JSON.stringify({ mode: 'none' })]]) {
    await setHome(raw)
    await S.unhover()
    await S.shot(`ov-09-${tag}-dark`)
    await S.theme('light'); await sleep(500)
    R[`sessionBarBg-${tag}-light`] = await ev(`getComputedStyle(document.querySelector(${JSON.stringify(bar)})).backgroundColor`)
    await S.shot(`ov-09-${tag}-light`)
    await S.theme('dark'); await sleep(400)
  }
  await setHome(savedHome)
  await fold(true)
  await sleep(600)
  report.audit.overview = await S.audit(bar)
}

function makePng(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type, 'ascii'), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) { raw[y * (width * 3 + 1)] = 0; for (let x = 0; x < width; x++) { const o = y * (width * 3 + 1) + 1 + x * 3; raw[o] = Math.round(40 + 180 * x / width); raw[o + 1] = Math.round(90 + 100 * y / height); raw[o + 2] = 200 } }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlibDeflate(raw)), chunk('IEND', Buffer.alloc(0))])
}

function writeLibraryFixtures(root, sessions) {
  const now = Date.now()
  let tick = 0
  const groups = new Map()
  const add = (sessionKey, spec) => {
    const dir = join(root, sessionKey)
    mkdirSync(dir, { recursive: true })
    const id = `a${String(++tick).padStart(4, '0')}`
    const path = join(dir, `${id}-${spec.filename}`)
    if (spec.body != null) writeFileSync(path, spec.body)
    const bytes = spec.body == null ? 0 : Buffer.byteLength(spec.body)
    const item = { messageId: `m-${id}`, artifact: { id, sourceId: spec.sourceId ?? id, version: spec.version, filename: spec.filename, path, mediaType: spec.mediaType, kind: spec.kind, bytes, createdAt: now - (spec.ago ?? tick * 3600000), previewable: spec.previewable, description: spec.description } }
    if (!groups.has(sessionKey)) groups.set(sessionKey, [])
    groups.get(sessionKey).push(item)
  }
  const keyOf = (index) => (sessions[index] ? `s-${sessions[index].id}` : `s-orphan-${index}`)
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200"><rect width="320" height="200" fill="#1f3b5c"/><rect x="24" y="30" width="110" height="60" rx="8" fill="#4f8fd6"/><rect x="186" y="30" width="110" height="60" rx="8" fill="#d6894f"/><rect x="105" y="122" width="110" height="52" rx="8" fill="#5fb37a"/><path d="M79 90 L160 122 M241 90 L160 122" stroke="#e8eef5" stroke-width="3"/></svg>'
  const html = '<!doctype html><meta charset="utf-8"><title>Dashboard</title><body style="margin:0;font:14px system-ui;background:#f4f6fa;color:#1d2433"><header style="padding:16px 20px;background:#1d2433;color:#fff">Weekly dashboard</header><main style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;padding:16px"><div style="background:#fff;padding:16px;border-radius:8px">Revenue<br><b style="font-size:24px">$42k</b></div><div style="background:#fff;padding:16px;border-radius:8px">Users<br><b style="font-size:24px">1,284</b></div><div style="background:#fff;padding:16px;border-radius:8px">Churn<br><b style="font-size:24px">2.1%</b></div></main></body>'
  add(keyOf(0), { filename: 'weekly-dashboard.html', body: html, mediaType: 'text/html', kind: 'document', previewable: true, ago: 60000, description: '每周看板：收入、用户数与流失率三张卡片' })
  add(keyOf(0), { filename: 'architecture-diagram.svg', body: svg, mediaType: 'image/svg+xml', kind: 'svg', previewable: true, ago: 120000 })
  add(keyOf(1), { filename: 'gradient-cover.png', body: makePng(480, 300), mediaType: 'image/png', kind: 'image', previewable: true, ago: 180000 })
  add(keyOf(1), { filename: '季度销售报告-2026年第三季度-最终修订版-给管理层审阅用的超长文件名-附带区域拆分与同比环比分析.md', body: '# 季度销售报告\n\n- 华东 +12%\n- 华南 +8%\n', mediaType: 'text/markdown', kind: 'document', previewable: true, ago: 240000, description: '这是一段很长的说明文字，用来检查列表行里的说明在窄窗口下会不会把操作按钮挤出去，或者和元信息行发生重叠，需要单行省略' })
  add(keyOf(2), { filename: 'build-script.ts', sourceId: 'build-script', version: 1, body: 'export const v = 1\n', mediaType: 'text/typescript', kind: 'code', previewable: true, ago: 400000 })
  add(keyOf(2), { filename: 'build-script.ts', sourceId: 'build-script', version: 2, body: 'export const v = 2\nexport const w = 3\n', mediaType: 'text/typescript', kind: 'code', previewable: true, ago: 300000 })
  add(keyOf(2), { filename: 'dataset-export.zip', body: 'PK\u0003\u0004fixture', mediaType: 'application/zip', kind: 'binary', previewable: false, ago: 500000 })
  add(keyOf(2), { filename: 'missing-chart.png', body: null, mediaType: 'image/png', kind: 'image', previewable: true, ago: 600000, description: '原文件已被删除' })
  add('s-orphan-session', { filename: 'orphan-notes.txt', body: 'notes from a deleted session\n', mediaType: 'text/plain', kind: 'document', previewable: true, ago: 700000 })
  for (let i = 0; i < 24; i++) add(keyOf(i % 3), { filename: `report-${String(i + 1).padStart(2, '0')}.md`, body: `# report ${i + 1}\n`, mediaType: 'text/markdown', kind: 'document', previewable: true, ago: 800000 + i * 3600000 })
  for (const [key, items] of groups) writeFileSync(join(root, key, 'manifest.json'), JSON.stringify(items, null, 2))
  return { groups: groups.size, items: tick }
}

async function libraryTarget({ kit: S, ev, sleep, until, check, log, report, runDir }) {
  report.library = {}
  const R = report.library
  const page = '[data-testid="v3-artifact-library"]'
  const width = await ev('window.__yanRightPanel.getState().width')
  const info = () => ev(`(() => { const p = document.querySelector(${JSON.stringify(page)}); if (!p) return { present: false }; const r = p.getBoundingClientRect(); const over = [...p.querySelectorAll('*')].filter((n) => { const b = n.getBoundingClientRect(); return b.width > 0 && b.right > r.right + 1 }).map((n) => (n.getAttribute('data-testid') || String(n.className) || n.tagName).slice(0, 50)).slice(0, 8); const clipped = [...p.querySelectorAll('.artifact-library-name, .artifact-library-meta, .artifact-library-desc')].filter((n) => n.getBoundingClientRect().width > 0 && n.scrollWidth > n.clientWidth + 1).map((n) => n.textContent.trim().slice(0, 40)).slice(0, 8); return { present: true, box: [Math.round(r.left), Math.round(r.width)], rows: p.querySelectorAll('.artifact-library-row, .artifact-library-card').length, overflow: over, clipped, text: p.innerText.replace(/\\s+/g, ' ').slice(0, 300) } })()`)
  const go = async (hash) => { await ev(`(window.location.hash = ${JSON.stringify(hash)}, true)`); await sleep(900) }
  const both = async (name) => { await S.unhover(); await S.shot(`${name}-dark`); await S.theme('light'); await sleep(450); await S.shot(`${name}-light`); await S.theme('dark'); await sleep(300) }
  const kbd = async (selector, name, index = 0) => {
    const ok = await ev(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})][${index}]; if (!el) return false; el.focus(); return true })()`)
    if (!ok) { log('找不到焦点目标', selector); return null }
    await S.key('Tab')
    await S.key('Tab', { shift: true })
    const active = await ev(`document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim().slice(0, 40)`)
    await S.shot(name)
    return active
  }
  await ev(`(window.__yanRightPanel.getState().setOpen(false), true)`)
  await go('#/')
  await go('#/artifacts')
  check('产物库：页面出现', await until(`!!document.querySelector(${JSON.stringify(page)})`, 8000, 100))
  await until(`!document.querySelector('.artifact-library-note') || document.querySelector('.ui-empty')`, 6000, 100)
  R.empty = await info()
  await both('lib-00-empty')

  const sessions = await ev(`window.__yanStore.getState().sessions.slice(0, 3).map((s) => ({ id: s.id, title: s.title }))`)
  R.fixture = writeLibraryFixtures(join(runDir, 'yan', 'artifacts'), Array.isArray(sessions) ? sessions : [])
  await go('#/')
  await go('#/artifacts')
  check('产物库：夹具出现', await until(`document.querySelectorAll('.artifact-library-row, .artifact-library-card').length >= 20`, 20000, 150))
  R.userView = await ev(`document.querySelector(${JSON.stringify(page)})?.getAttribute('data-view')`)
  await S.click('[data-testid="v3-artifact-library-view-list"]', 900)
  await sleep(800)
  R.list = await info()
  check('产物库：列表没有横向溢出', !!R.list?.present && R.list.overflow.length === 0, R.list?.overflow)
  await both('lib-01-list')
  await ev(`(() => { const p = document.querySelector(${JSON.stringify(page)}); if (p) p.scrollTop = p.scrollHeight; return true })()`)
  await sleep(400)
  await S.shot('lib-01-list-bottom-dark')
  await ev(`(() => { const p = document.querySelector(${JSON.stringify(page)}); if (p) p.scrollTop = 0; return true })()`)
  await sleep(300)
  report.hover.push(['lib-02-row-hover', await S.hover('.artifact-library-row .artifact-library-name', 900, 1)])
  await S.shot('lib-02-row-hover')
  report.hover.push(['lib-02-action-hover', await S.hover('.artifact-library-row .artifact-library-actions .ui-icon-btn', 1200, 0)])
  await S.shot('lib-02-action-hover')
  await S.unhover()
  report.focus.push(['lib-03-name-focus', await kbd('.artifact-library-row .artifact-library-name', 'lib-03-name-focus', 1)])
  report.focus.push(['lib-03-action-focus', await kbd('.artifact-library-row .artifact-library-actions button', 'lib-03-action-focus', 0)])
  await ev('document.activeElement?.blur?.()')
  R.pinned = await S.click('.artifact-library-row:nth-child(5) .artifact-library-actions .ui-icon-btn', 700)
  await S.unhover()
  await sleep(400)
  R.afterPin = await info()
  await S.shot('lib-04-pinned-dark')
  if (await S.click('.artifact-library-search input', 400)) {
    await S.typeText('report-1', 700)
    R.search = await info()
    await S.shot('lib-05-search-dark')
    await ev(`(() => { const i = document.querySelector('.artifact-library-search input'); if (!i) return false; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'zzz-no-such-artifact'); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await sleep(600)
    R.noMatch = await info()
    await both('lib-06-no-match')
    await ev(`(() => { const i = document.querySelector('.artifact-library-search input'); if (!i) return false; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await sleep(500)
  }
  await ev('document.activeElement?.blur?.()')
  if (await S.click('[data-testid="v3-artifact-library-view-grid"]', 1500)) {
    await until(`!!document.querySelector('[data-testid="v3-artifact-library-grid"] img')`, 5000, 150)
    await sleep(2500)
    R.grid = await info()
    check('产物库：网格没有横向溢出', !!R.grid?.present && R.grid.overflow.length === 0, R.grid?.overflow)
    await both('lib-07-grid')
    report.hover.push(['lib-08-card-hover', await S.hover('.artifact-library-card', 900, 2)])
    await S.shot('lib-08-card-hover')
    await S.unhover()
    report.focus.push(['lib-08-thumb-focus', await kbd('.artifact-library-thumb-image', 'lib-08-thumb-focus', 0)])
    await ev('document.activeElement?.blur?.()')
  }
  await ev(`(window.__yanRightPanel.getState().setOpen(true), window.__yanRightPanel.getState().setWidth(${width}), true)`)
  await sleep(1200)
  R.gridWithPanel = await info()
  await S.shot(`lib-09-grid-panel-w${width}-dark`)
  await ev(`(window.__yanRightPanel.getState().setWidth(${width < 600 ? 869 : 360}), true)`)
  await sleep(1200)
  R.gridWithAlt = await info()
  await S.shot(`lib-09-grid-panel-w${width < 600 ? 869 : 360}-dark`)
  await S.click('[data-testid="v3-artifact-library-view-list"]', 900)
  await sleep(600)
  R.listWithAlt = await info()
  check('产物库：右栏打开时列表没有横向溢出', !!R.listWithAlt?.present && R.listWithAlt.overflow.length === 0, R.listWithAlt?.overflow)
  await S.shot(`lib-10-list-panel-w${width < 600 ? 869 : 360}-dark`)
  await ev(`(window.__yanRightPanel.getState().setWidth(${width}), window.__yanRightPanel.getState().setOpen(false), true)`)
  await sleep(900)
  await S.narrow()
  await sleep(1200)
  R.narrowList = await info()
  check('产物库：窄窗口列表没有横向溢出', !!R.narrowList?.present && R.narrowList.overflow.length === 0, R.narrowList?.overflow)
  await both('lib-11-narrow-list')
  await S.click('[data-testid="v3-artifact-library-view-grid"]', 1500)
  await sleep(1500)
  R.narrowGrid = await info()
  await S.shot('lib-12-narrow-grid-dark')
  await S.click(`[data-testid="v3-artifact-library-view-${R.userView === 'grid' ? 'grid' : 'list'}"]`, 600)
  await S.wide()
  await sleep(1200)
  report.audit.library = await S.audit(page)
  await go('#/')
}

async function usageTarget({ kit: S, ev, sleep, until, check, log, report }) {
  report.usage = {}
  const R = report.usage
  const page = '[data-testid="usage-details"]'
  const width = await ev('window.__yanRightPanel.getState().width')
  const info = () => ev(`(() => { const p = document.querySelector(${JSON.stringify(page)}); if (!p) return { present: false }; const r = p.getBoundingClientRect(); const over = [...p.querySelectorAll('*')].filter((n) => { const b = n.getBoundingClientRect(); return b.width > 0 && b.right > r.right + 1 }).map((n) => (n.getAttribute('data-testid') || String(n.className) || n.tagName).slice(0, 50)).slice(0, 8); const clipped = [...p.querySelectorAll('.usage-page-row-label span, .usage-page-totals dd, .usage-page-legend span')].filter((n) => n.getBoundingClientRect().width > 0 && n.scrollWidth > n.clientWidth + 1).map((n) => n.textContent.trim().slice(0, 40)).slice(0, 8); return { present: true, busy: p.getAttribute('aria-busy'), box: [Math.round(r.left), Math.round(r.width)], rows: p.querySelectorAll('.usage-page-row:not([data-head])').length, overflow: over, clipped, text: p.innerText.replace(/\\s+/g, ' ').slice(0, 300) } })()`)
  const both = async (name) => { await S.unhover(); await S.shot(`${name}-dark`); await S.theme('light'); await sleep(450); await S.shot(`${name}-light`); await S.theme('dark'); await sleep(300) }
  const scroll = (where) => ev(`(() => { const p = document.querySelector(${JSON.stringify(page)}); if (!p) return false; p.scrollTop = ${where === 'bottom' ? 'p.scrollHeight' : '0'}; return true })()`)
  const kbd = async (selector, name, index = 0) => {
    const ok = await ev(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})][${index}]; if (!el) return false; el.focus(); return true })()`)
    if (!ok) { log('找不到焦点目标', selector); return null }
    await S.key('Tab')
    await S.key('Tab', { shift: true })
    const active = await ev(`document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim().slice(0, 40)`)
    await S.shot(name)
    return active
  }
  await ev(`(window.__yanRightPanel.getState().setOpen(false), true)`)
  await ev(`(window.location.hash = '#/', true)`)
  await sleep(600)
  await ev(`(window.location.hash = '#/usage', true)`)
  R.loading = await info()
  await S.shot('usage-00-loading-dark')
  check('用量页：数据就绪', await until(`document.querySelector(${JSON.stringify(page)})?.getAttribute('aria-busy') === 'false'`, 90000, 100))
  await sleep(1200)
  R.all = await info()
  check('用量页：没有横向溢出', !!R.all?.present && R.all.overflow.length === 0, R.all?.overflow)
  await both('usage-01-all')
  await scroll('bottom')
  await sleep(400)
  await both('usage-02-all-bottom')
  await scroll('top')
  await sleep(300)
  report.hover.push(['usage-03-row-hover', await S.hover('.usage-page-row:not([data-head])', 900, 1)])
  await S.shot('usage-03-row-hover')
  report.hover.push(['usage-03-chart-hover', await S.hover('.usage-page-chart svg, .usage-page-chart .ui-area-chart', 900, 0)])
  await S.shot('usage-03-chart-hover')
  await S.unhover()
  report.focus.push(['usage-04-range-focus', await kbd('.usage-page-head .ui-seg__item input, .usage-page-head .ui-seg__item', 'usage-04-range-focus', 0)])
  await ev('document.activeElement?.blur?.()')
  await ev(`(() => { const items = document.querySelectorAll('.usage-page-head .ui-seg__item'); items[0]?.click(); return items.length })()`)
  await sleep(1500)
  R.d7 = await info()
  await both('usage-05-7d')
  await ev(`(() => { const items = document.querySelectorAll('.usage-page-controls .ui-seg__item'); items[1]?.click(); return items.length })()`)
  await sleep(900)
  await scroll('bottom')
  await sleep(300)
  R.d7day = await info()
  await S.shot('usage-06-7d-by-day-dark')
  await scroll('top')
  await ev(`(() => { const items = document.querySelectorAll('.usage-page-head .ui-seg__item'); items[2]?.click(); return true })()`)
  await sleep(1500)
  await scroll('bottom')
  await sleep(300)
  await S.shot('usage-07-all-by-day-dark')
  await ev(`(() => { const items = document.querySelectorAll('.usage-page-controls .ui-seg__item'); items[0]?.click(); return true })()`)
  await scroll('top')
  await sleep(600)
  await ev(`(window.__yanRightPanel.getState().setOpen(true), window.__yanRightPanel.getState().setWidth(${width}), true)`)
  await sleep(1200)
  R.withPanel = await info()
  await S.shot(`usage-08-panel-w${width}-dark`)
  await ev(`(window.__yanRightPanel.getState().setWidth(${width < 600 ? 869 : 360}), true)`)
  await sleep(1200)
  R.withAlt = await info()
  check('用量页：右栏打开时没有横向溢出', !!R.withAlt?.present && R.withAlt.overflow.length === 0, R.withAlt?.overflow)
  await S.shot(`usage-08-panel-w${width < 600 ? 869 : 360}-dark`)
  await ev(`(window.__yanRightPanel.getState().setWidth(${width}), window.__yanRightPanel.getState().setOpen(false), true)`)
  await sleep(900)
  await S.narrow()
  await sleep(1200)
  R.narrow = await info()
  check('用量页：窄窗口没有横向溢出', !!R.narrow?.present && R.narrow.overflow.length === 0, R.narrow?.overflow)
  await both('usage-09-narrow')
  await scroll('bottom')
  await sleep(300)
  await S.shot('usage-09-narrow-bottom-dark')
  await S.wide()
  await sleep(1200)
  report.audit.usage = await S.audit(page)
  await ev(`(window.location.hash = '#/', true)`)
}

async function treeTarget({ kit: S, ev, sleep, until, check, log, report, newSession, turn }) {
  report.tree = {}
  const R = report.tree
  const rp = '[data-testid="rp"]'
  const pane = '[data-testid="v3-wb-branch"]'
  const width = await ev('window.__yanRightPanel.getState().width')
  const alt = width < 600 ? 869 : 360
  R.panelWidth = width
  const dir = mkdtempSync(join(tmpdir(), 'inkstone-ui-tree-'))
  writeFileSync(join(dir, 'README.md'), '# tree fixture\n')
  const api = (call) => ev(`(() => { const rp = window.__yanRightPanel.getState(); ${call}; return true })()`)
  const info = () => ev(`(() => { const p = document.querySelector(${JSON.stringify(pane)}); if (!p) return { present: false }; const r = p.getBoundingClientRect(); const over = [...p.querySelectorAll('*')].filter((n) => { const b = n.getBoundingClientRect(); return b.width > 0 && b.right > r.right + 1 && !n.closest('svg') }).map((n) => (n.getAttribute('data-testid') || String(n.className) || n.tagName).slice(0, 50)).slice(0, 8); const clipped = [...p.querySelectorAll('.branch-graph__text, .branch-foot__hint, .branch-note, .branch-label')].filter((n) => n.getBoundingClientRect().width > 0 && n.scrollWidth > n.clientWidth + 1).map((n) => n.textContent.trim().slice(0, 40)).slice(0, 8); const graph = p.querySelector('.branch-graph__lines'); return { present: true, box: [Math.round(r.left), Math.round(r.width), Math.round(r.height)], state: p.querySelector('[data-testid^="branch-tree"]')?.getAttribute('data-testid'), rows: p.querySelectorAll('[data-entry-id]').length, lanes: graph ? Math.round(graph.getBoundingClientRect().width) : 0, overflow: over, clipped, text: p.innerText.replace(/\\s+/g, ' ').slice(0, 300) } })()`)
  const variants = async (name, { light = true, full = true } = {}) => {
    await S.unhover()
    if (full) await S.shot(`${name}-dark`)
    await S.clip(`${name}-panel`, rp, 0)
    if (light) { await S.theme('light'); await sleep(400); await S.clip(`${name}-light`, rp, 0); await S.theme('dark'); await sleep(300) }
  }
  const openPane = async () => {
    await api("rp.setOpen(true); rp.open({ id: 'branch', kind: 'branch' }); rp.activate('branch')")
    await until(`!!document.querySelector(${JSON.stringify(pane)})`, 8000, 100)
    await until(`!document.querySelector('[data-testid="branch-tree-loading"]')`, 10000, 100)
    await sleep(700)
  }
  const refresh = async () => { await S.click('[data-testid="branch-refresh"]', 300); await until(`!document.querySelector('[data-testid="branch-tree-loading"]')`, 10000, 100); await sleep(700) }
  const selectRow = async (kind, index) => {
    const text = await ev(`(() => { const rows = [...document.querySelectorAll(${JSON.stringify(pane)} + ' .branch-graph__row[data-kind="${kind}"]')]; const row = rows[${index}]; if (!row) return null; row.scrollIntoView({ block: 'nearest' }); return row.textContent.trim().slice(0, 40) })()`)
    if (text) await S.click(`${pane} .branch-graph__row[data-kind="${kind}"]`, 300, index)
    await S.unhover()
    return text
  }
  const navigateTo = async (index) => {
    R[`select-${index}`] = await selectRow('user', index)
    await sleep(400)
    await S.click('[data-testid="branch-navigate"]', 300)
    return until(`!!document.querySelector('[data-testid="branch-notice"], [data-testid="branch-error"]')`, 15000, 100)
  }
  const kbd = async (selector, name) => {
    const ok = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); return true })()`)
    if (!ok) { log('找不到焦点目标', selector); return null }
    await S.key('Tab')
    await S.key('Tab', { shift: true })
    const active = await ev(`document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim().slice(0, 30)`)
    await S.clip(name, rp, 0)
    return active
  }

  await newSession(dir)
  await api('rp.closeAll()')
  await openPane()
  R.fresh = await info()
  await variants('tree-00-new-session')

  await turn('第一轮：帮我列一下这个项目要做的事', { timeout: 60000 })
  await turn('第二轮：先做登录页，表单要有校验和错误提示', { timeout: 60000 })
  await turn('第三轮：再加一个忘记密码的入口', { timeout: 60000 })
  await refresh()
  R.linear = await info()
  await variants('tree-01-linear')

  R.nav1 = await navigateTo(0)
  await sleep(600)
  R.navigated = await info()
  await variants('tree-02-navigated', { light: false })
  await turn('分叉 A：换个思路，先做注册流程，这一句故意写得很长很长，用来看分支行的文字在窄栏里怎么省略', { timeout: 60000 })
  await refresh()
  R.nav2 = await navigateTo(1)
  await sleep(600)
  await turn('分叉 B：登录页改用第三方登录', { timeout: 60000 })
  await turn('分叉 B 继续：加上微信和 GitHub', { timeout: 60000 })
  await refresh()
  R.forked = await info()
  check('分支树：出现多条分支', (R.forked?.lanes ?? 0) > 30, R.forked)
  check('分支树：没有横向溢出', !!R.forked?.present && R.forked.overflow.length === 0, R.forked?.overflow)
  await variants('tree-03-forked')

  report.hover.push(['tree-04-row-hover', await S.hover(`${pane} .branch-graph__row[data-kind="user"]`, 900, 1)])
  await S.clip('tree-04-row-hover', rp, 0)
  await S.unhover()
  report.focus.push(['tree-05-row-focus', await kbd(`${pane} .branch-graph__row[data-selected]`, 'tree-05-row-focus')])
  await S.key('ArrowUp', { waitMs: 300 })
  await S.key('ArrowUp', { waitMs: 300 })
  await S.clip('tree-05-row-arrow', rp, 0)
  report.focus.push(['tree-05-switch-focus', await kbd('[data-testid="branch-summarize"] input', 'tree-05-switch-focus')])
  await ev('document.activeElement?.blur?.()')

  R.bookRow = await selectRow('user', 2)
  await sleep(400)
  if (await S.click('[data-testid="branch-bookmark"]', 700)) {
    await S.typeText('登录方案一', 400)
    await S.shot('tree-06-bookmark-pop-dark')
    await S.click('[data-testid="branch-bookmark-save"]', 1200)
    R.bookmarked = await info()
    await variants('tree-06-bookmarked', { light: false })
  }

  await S.click('[data-testid="branch-summarize"]', 500)
  R.summarizeOn = await ev(`document.querySelector('[data-testid="branch-summarize"] input')?.checked ?? null`)
  await S.unhover()
  await variants('tree-07-summarize-on')
  await S.click('[data-testid="branch-summarize"]', 500)

  await turn('LONGTEXT 运行中看看分支树', { timeout: 90000, during: async () => { await sleep(1200); R.busy = await info(); await variants('tree-08-busy', { light: false }) } })
  await refresh()

  await api(`rp.setWidth(${alt})`)
  await sleep(1200)
  R.alt = await info()
  await variants(`tree-09-w${alt}`)
  await api(`rp.setWidth(${width})`)
  await sleep(1000)

  R.bashStarted = await ev(`(() => { void window.__yanStore.getState().runBash('sleep 12'); return true })()`)
  R.bashBusy = await until(`!!document.querySelector('[data-testid="branch-navigate"][data-disabled], [data-testid="branch-navigate"]:disabled')`, 6000, 100)
  await sleep(500)
  R.bash = await info()
  check('分支树：输入框命令运行时提前禁用并说明', /命令还在运行/.test(R.bash?.text ?? ''), R.bash?.text)
  await variants('tree-12-bash-busy')
  await until(`!document.querySelector('[data-testid="branch-navigate"][data-disabled], [data-testid="branch-navigate"]:disabled')`, 30000, 200)
  await refresh()
  R.navFork = await navigateTo(0)
  await sleep(800)
  await selectRow('user', 0)
  if (await S.click('[data-testid="branch-bookmark"]', 700)) {
    await S.typeText('分叉点书签', 400)
    await S.click('[data-testid="branch-bookmark-save"]', 1500)
    R.forkBookmark = await info()
    R.forkLeafRow = await ev(`(() => { const dots = [...document.querySelectorAll('.branch-graph__dot[data-leaf]')]; const rows = [...document.querySelectorAll('.branch-graph__row')]; return { leafDots: dots.length, rows: rows.length, current: rows.find((row) => /当前|Current/.test(row.textContent))?.textContent.trim().slice(0, 30) ?? null } })()`)
    check('分支树：分叉点加书签不多出书签行', !/书签 ·/.test(R.forkBookmark?.text ?? '') && R.forkLeafRow?.leafDots === 1 && /第一轮/.test(R.forkLeafRow?.current ?? ''), R.forkLeafRow)
    await variants('tree-13-bookmark-at-fork', { light: false })
  }

  R.failInjected = await ev(`(() => { const el = document.querySelector('[data-testid="branch-tree"]'); if (!el) return 'no-tree'; const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$')); let fiber = key ? el[key] : null; while (fiber) { let hook = fiber.memoizedState; while (hook && typeof hook === 'object' && 'next' in hook) { const value = hook.memoizedState; if (value && typeof value === 'object' && value.phase === 'ready' && hook.queue && typeof hook.queue.dispatch === 'function') { hook.queue.dispatch({ phase: 'error', error: '会话已切换，请重新打开操作面板' }); return 'ok' } hook = hook.next } fiber = fiber.return } return 'no-hook' })()`)
  if (R.failInjected === 'ok') {
    R.errorShown = await until(`!!document.querySelector('[data-testid="branch-tree-error"]')`, 10000, 100)
    check('分支树：错误态出现', R.errorShown)
    R.error = await info()
    await variants('tree-11-error')
    report.focus.push(['tree-11-retry-focus', await kbd('[data-testid="branch-retry"]', 'tree-11-retry-focus')])
    await S.click('[data-testid="branch-retry"]', 300)
    R.recovered = await until(`!!document.querySelector('[data-testid="branch-tree"]')`, 10000, 100)
    check('分支树：重试后恢复', R.recovered)
    await sleep(600)
  }

  const big = await ev(`(() => { const list = window.__yanStore.getState().sessions.filter((s) => !s.parentSession).sort((a, b) => b.messageCount - a.messageCount); return list[0] ? { path: list[0].path, count: list[0].messageCount } : null })()`)
  R.big = big
  if (big) {
    await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(big.path)})`)
    await until(`window.__yanStore.getState().session?.sessionFile === ${JSON.stringify(big.path)}`, 20000, 150)
    await sleep(1500)
    await openPane()
    await until(`!!document.querySelector('[data-testid="branch-tree"], [data-testid="branch-tree-error"]')`, 20000, 150)
    await sleep(1200)
    R.many = await info()
    check('分支树：长会话没有横向溢出', !!R.many?.present && R.many.overflow.length === 0, R.many?.overflow)
    await variants('tree-10-many')
    await ev(`(() => { const g = document.querySelector(${JSON.stringify(pane)} + ' .branch-graph'); if (g) g.scrollTop = 0; return true })()`)
    await sleep(400)
    await S.clip('tree-10-many-top', rp, 0)
  }
  report.audit.tree = await S.audit(pane)
}

const SETTINGS_PAGES = [
  ['appearance', 'v3-settings-nav-appearance'],
  ['session', 'v3-settings-nav-session'],
  ['notifications', 'v3-settings-nav-notifications'],
  ['security', 'v3-settings-nav-security'],
  ['shortcuts', 'v3-settings-nav-shortcuts'],
  ['models', 'v3-settings-nav-models'],
  ['caps-skills', 'caps-tab-skills'],
  ['caps-mcp', 'caps-tab-mcp'],
  ['caps-tools', 'caps-tab-tools'],
  ['caps-market', 'caps-tab-market'],
  ['code', 'v3-settings-nav-code'],
  ['devices', 'v3-settings-nav-devices'],
  ['data', 'v3-settings-nav-data'],
  ['about', 'v3-settings-nav-about']
]

async function settingsBatch2({ S, ev, sleep, until, check, report, newSession, go, into, both, keyCombo, scrollTo, modal, R }) {
  await go('v3-settings-nav-shortcuts')
  await into('[data-testid="v3-shortcut-newSession"]')
  R.shortcutRecord = await S.click('[data-testid="v3-shortcut-record-newSession"]', 600)
  await S.unhover()
  await both('settings-60-shortcuts-recording')
  await keyCombo('b', 'KeyB', 66, 2)
  R.shortcutConflict = await ev(`document.querySelector('[data-testid="v3-shortcut-notice-newSession"]')?.textContent ?? null`)
  await both('settings-61-shortcuts-conflict')
  await keyCombo('n', 'KeyN', 78, 3)
  await sleep(600)
  R.shortcutModified = await ev(`document.querySelector('[data-testid="v3-shortcut-newSession"]')?.getAttribute('data-modified') ?? null`)
  await both('settings-62-shortcuts-modified')
  report.hover.push(['settings-shortcut-reset-hover', await S.hover('[data-testid="v3-shortcut-reset-newSession"]', 1200)])
  await S.clip('settings-62-shortcuts-reset-hover-dark', modal, 0)
  await S.unhover()
  await scrollTo(0)
  await sleep(300)
  await S.clip('settings-63-shortcuts-top-modified-dark', modal, 0)
  await ev(`window.__yanStore.getState().patchSettings({ shortcutOverrides: {} })`)
  await sleep(500)

  await go('v3-settings-nav-models')
  await sleep(1200)
  await ev(`(() => { for (const b of document.querySelectorAll('.ui-settings__content .settings-fold__toggle[aria-expanded="false"]')) b.click(); return true })()`)
  await sleep(1200)
  if (await into('[data-testid="ms-custom-add"]')) {
    await S.click('[data-testid="ms-custom-add"]', 900)
    await S.unhover()
    await into('[data-testid="ms-custom-form"]')
    await both('settings-64-models-custom-form')
  }
  if (await into('[data-testid^="ms-local-launch-row-"]')) await both('settings-65-models-local-launch')
  report.hover.push(['settings-models-row-hover', await S.hover('[data-testid^="ms-local-launch-detect-"]', 900)])
  await S.clip('settings-65-models-local-launch-hover-dark', modal, 0)
  await S.unhover()

  await go('caps-tab-mcp')
  await sleep(1200)
  if (await S.click('[data-testid="mcp-add"]', 900)) {
    await S.unhover()
    await both('settings-66-mcp-add-form')
    await S.click('[data-testid="mcp-add"]', 600)
  }
  await go('caps-tab-tools')
  await sleep(1200)
  if (await S.click('[data-testid="cap-computer-use-more"]', 900)) {
    await S.shot('settings-67-tools-cu-menu-dark')
    await S.key('Escape')
  }
  await S.unhover()

  const dir = mkdtempSync(join(tmpdir(), 'inkstone-ui-skills-'))
  writeFileSync(join(dir, 'README.md'), '# skills fixture\n')
  const names = ['pdf-report-writer', 'release-notes', 'a-very-long-skill-name-that-should-truncate-in-the-settings-list-nicely', 'code-review', 'data-cleanup', '中文技能示例', 'screenshot-diff', 'translate-docs', 'sql-helper', 'ui-polish']
  for (const name of names) {
    mkdirSync(join(dir, '.pi', 'skills', name), { recursive: true })
    writeFileSync(join(dir, '.pi', 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: 示例技能 ${name}，用来看设置页技能列表很多条时的显示；fixture skill with a reasonably long description for layout checks.\n---\n\n# ${name}\n`)
  }
  check('设置：技能夹具不在仓库里', !dir.toLowerCase().startsWith(process.cwd().toLowerCase()), dir)
  const trustBefore = await ev(`window.yan.piNativeSettings().then((r) => r.settings?.defaultProjectTrust ?? null)`)
  R.skillsTrust = await ev(`window.yan.setPiNativeSettings({ defaultProjectTrust: 'always' }).then((r) => r.ok)`)
  await ev(`(window.__yanStore.getState().closeSettings(), true)`)
  await sleep(600)
  await newSession(dir)
  await sleep(2500)
  await ev(`(window.__yanStore.getState().openSettings(), true)`)
  await until(`!!document.querySelector('.ui-settings')`, 15000, 100)
  await go('caps-tab-skills')
  await S.click('[data-testid="caps-skills-reload"]', 2500)
  await S.unhover()
  R.skillsMany = await ev(`[...document.querySelectorAll('[data-testid="caps-skill"]')].length`)
  await both('settings-68-skills-many')
  await scrollTo(99999)
  await sleep(400)
  await S.clip('settings-68-skills-many-end-dark', modal, 0)
  report.hover.push(['settings-skill-hover', await S.hover('[data-testid="caps-skill"]', 900)])
  await S.clip('settings-68-skills-hover-dark', modal, 0)
  await S.unhover()
  R.skillsTrustRestore = await ev(`window.yan.setPiNativeSettings({ defaultProjectTrust: ${trustBefore ? JSON.stringify(trustBefore) : 'undefined'} }).then((r) => r.ok)`)
}

function fiberHook(ev) {
  return (selector, finder, value, mode = 'dispatch') => ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return 'no-element'
    const key = Object.keys(el).find((name) => name.startsWith('__reactFiber$'))
    const finder = ${finder}
    for (let fiber = el[key]; fiber; fiber = fiber.return) {
      const hooks = []
      for (let h = fiber.memoizedState; h && typeof h === 'object' && 'next' in h; h = h.next) hooks.push(h)
      if (!hooks.length) continue
      let index = -1
      try { index = finder(hooks.map((h) => h.memoizedState)) } catch {}
      if (typeof index !== 'number' || index < 0) continue
      const hook = hooks[index]
      if (${JSON.stringify(mode)} === 'call') { hook.memoizedState[0](${JSON.stringify(value)}); return 'ok' }
      if (!hook.queue?.dispatch) return 'no-dispatch'
      hook.queue.dispatch(${JSON.stringify(value)})
      return 'ok'
    }
    return 'no-hook'
  })()`)
}

async function settingsReview2({ S, ev, sleep, report, go, into, scrollTo, modal, R }) {
  const fh = fiberHook(ev)
  R.e2 = {}
  const log = (name, value) => { R.e2[name] = value; return value }
  const now = Date.now()
  const day = 86_400_000
  const freezeTimers = (on) => ev(on ? `(window.__uiPolishSI = window.__uiPolishSI || window.setInterval, window.setInterval = () => 0, true)` : `(window.__uiPolishSI && (window.setInterval = window.__uiPolishSI), true)`)
  const setLang = (lang) => ev(`window.__yanStore.getState().patchSettings({ lang: ${JSON.stringify(lang)} }).then(() => document.documentElement.lang)`)
  const openAdvanced = () => ev(`(() => { let n = 0; for (const b of document.querySelectorAll('.ui-settings__content .settings-advanced > button[aria-expanded="false"]')) { b.click(); n++ } return n })()`)
  const shotBoth = async (name, prep, selector) => {
    for (const mode of ['dark', 'light']) {
      if (mode === 'light') await S.theme('light')
      if (prep) log(`${name}-${mode}`, await prep())
      await sleep(500)
      if (selector) await into(selector)
      await S.unhover()
      await S.clip(`${name}-${mode}`, modal, 0)
    }
    await S.theme('dark')
  }
  const testIdWith = (prefix, text) => ev(`(() => { const el = [...document.querySelectorAll('.caps-entry[data-testid^="${prefix}"]')].find((n) => n.innerText.includes(${JSON.stringify(text)})); return el ? el.getAttribute('data-testid') : null })()`)

  const petStatus = { installed: true, version: '0.3.7', running: true, autoStart: true, model: null, installDir: 'C:\\Users\\demo\\AppData\\Local\\Inkstone\\plugins\\dsh-pet', edges: { state: 'failed', done: 3, total: 12, message: 'ffmpeg exited with code 1' }, log: ['[pet] starting dsh-pet 0.3.7', '[pet] loaded 12 animations', '[pet] bridge connected on 127.0.0.1:48211', '[pet] edges: ffmpeg exited with code 1'] }
  const mcStatus = { installed: true, configured: true, conflict: false, skill: true, pluginDir: 'C:\\Users\\demo\\.pi\\agent\\extensions\\minecraft', installedVersion: '0.1.0', latestVersion: '0.1.1' }
  const pkgs = Array.from({ length: 6 }, (_, i) => ({ name: i === 1 ? '@some-very-long-scope-name/pi-extension-with-an-extremely-long-package-name' : `pi-demo-package-${i + 1}`, version: `1.${i}.0`, publisher: `author${i}`, description: i % 2 ? '给 pi 增加一个示例能力，用来检查搜索结果的显示。' : 'Example pi package with a fairly long description for layout checks.', source: `npm:pi-demo-package-${i + 1}`, npmUrl: 'https://www.npmjs.com/', homepage: 'https://example.com/' }))
  const svc = (key, title, extra = {}) => ({ key, name: key, title, backend: 'native', owner: 'pi', scope: 'global', enabled: true, inherited: false, overridden: false, transport: 'stdio', source: 'C:\\Users\\demo\\.pi\\agent\\mcp.json', connection: 'npx -y @modelcontextprotocol/server-filesystem C:\\work', ...extra })
  const mcpSnapshot = { context: 'ui-polish', revision: 'r1', project: null, projectTrusted: false, errors: [], busy: false, nativeConfigChanged: false, projectServices: [], global: [
    svc('filesystem', 'filesystem'),
    svc('github-issues-and-pull-requests-long-name', 'github-issues-and-pull-requests-long-name', { backend: 'host', owner: 'inkstone', transport: 'http', connection: 'https://mcp.example.com/github', enabled: false }),
    svc('playwright', 'playwright', { conflict: true })
  ] }
  const listing = (n) => ({ ok: true, agentDir: 'C:\\Users\\demo\\.pi\\agent', userSettings: '', projectSettings: '', entries: Array.from({ length: n }, (_, i) => ({ source: `npm:pi-ext-${i + 1}`, scope: i % 3 === 2 ? 'project' : 'user', name: i === 1 ? '@some-very-long-scope-name/pi-extension-with-an-extremely-long-package-name' : `pi-ext-${i + 1}`, version: `0.${i + 1}.0`, description: 'Example extension for layout checks.', repository: 'https://github.com/example/pi-ext', license: 'MIT', installed: i !== 3, path: null })) })
  const voiceStatus = (download) => ({ hardware: { cpuModel: 'AMD Ryzen 9 7950X 16-Core Processor', threads: 32, totalMemoryMB: 65_536, freeMemoryMB: 30_100, cpuLoad: 0.21, gpu: 'NVIDIA GeForce RTX 4080' }, candidates: [
    { spec: { id: 'base', tier: 'light', file: 'ggml-base.bin', approxBytes: 148_000_000, approxMemoryMB: 388, minThreads: 2, minFreeMemoryMB: 600 }, recommended: false, strain: null, installed: true },
    { spec: { id: 'small', tier: 'balanced', file: 'ggml-small.bin', approxBytes: 488_000_000, approxMemoryMB: 852, minThreads: 4, minFreeMemoryMB: 1200 }, recommended: true, strain: null, installed: false },
    { spec: { id: 'large-v3', tier: 'quality', file: 'ggml-large-v3.bin', approxBytes: 3_100_000_000, approxMemoryMB: 3900, minThreads: 8, minFreeMemoryMB: 5000 }, recommended: false, strain: '内存和 CPU 都可能吃紧，转写会慢。', installed: false }
  ], binary: { path: 'C:\\Users\\demo\\AppData\\Local\\Inkstone\\voice\\whisper.cpp\\bin\\whisper-cli.exe', source: 'custom' }, backend: 'cuda', model: { label: 'base', path: 'C:\\Users\\demo\\voice\\ggml-base.bin', catalogId: 'base' }, language: 'auto', ready: true, storageDir: 'C:\\Users\\demo\\AppData\\Local\\Inkstone\\voice', download })
  const voiceFinder = `(s) => s.findIndex((v, i) => (v === null || (v && typeof v === 'object' && 'candidates' in v)) && (s[i + 1] === null || (s[i + 1] && typeof s[i + 1] === 'object' && 'planId' in s[i + 1])) && typeof s[i + 2] === 'string' && typeof s[i + 3] === 'boolean')`
  const voicePlanFinder = `(s) => { const i = (${voiceFinder})(s); return i < 0 ? -1 : i + 1 }`
  const voicePlan = { planId: 'p1', target: { kind: 'model', id: 'small' }, label: 'ggml-small.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin', bytes: 488_000_000, sizeKnown: true, destination: 'C:\\Users\\demo\\AppData\\Local\\Inkstone\\voice\\models' }
  const savedSettings = await ev(`JSON.stringify(window.__yanStore.getState().settings?.voiceInput ?? null)`)
  const setVoiceSaved = () => ev(`(() => { const s = window.__yanStore.getState(); window.__yanStore.setState({ settings: { ...s.settings, voiceInput: { ...(s.settings?.voiceInput ?? {}), binaryPath: 'C:\\\\tools\\\\whisper\\\\whisper-cli.exe' } } }); return true })()`)
  const android = (install) => ({ sdkRoot: 'C:\\Users\\demo\\AppData\\Local\\Android\\Sdk', sdkSource: 'managed', avds: ['Pixel_8_API_35', 'Medium_Tablet_API_34'], install, components: [
    { id: 'platformTools', state: 'installed', path: 'C:\\Users\\demo\\AppData\\Local\\Android\\Sdk\\platform-tools' },
    { id: 'emulator', state: 'missing' },
    { id: 'systemImage', state: 'missing' },
    { id: 'jdk', state: 'installed', path: 'C:\\Users\\demo\\AppData\\Local\\Inkstone\\jdk-21' },
    { id: 'accel', state: 'unknown', detail: 'needs-emulator' }
  ] })
  const androidFinder = `(s) => s.findIndex((v, i) => (v === null || (v && typeof v === 'object' && 'components' in v)) && typeof s[i + 1] === 'string')`

  const marketStates = async () => {
    const comfy = await testIdWith('caps-market-', 'ComfyUI')
    const out = {}
    if (comfy) out.comfy = await fh(`[data-testid="${comfy}"]`, `(s) => s.findIndex((v, i) => typeof v === 'boolean' && Array.isArray(s[i + 1]) && typeof s[i + 1][0] === 'function' && typeof s[i + 2] === 'boolean' && typeof s[i + 3] === 'string') + 1 || -1`, true, 'call')
    out.pet = await fh('[data-testid="caps-market-desktop-pet"]', `(s) => s.findIndex((v, i) => (v === null || (v && typeof v === 'object' && 'edges' in v)) && Array.isArray(s[i + 1]) && typeof s[i + 2] === 'string')`, petStatus)
    out.mc = await fh('[data-testid="caps-market-minecraft"]', `(s) => s.findIndex((v, i) => (v === null || (v && typeof v === 'object' && 'pluginDir' in v)) && typeof s[i + 1] === 'string' && (s[i + 2] === null || typeof s[i + 2] === 'object'))`, mcStatus)
    return out
  }
  const marketErrors = async () => ({
    mcNote: await fh('[data-testid="caps-market-minecraft"]', `(s) => { const i = s.findIndex((v, j) => v && typeof v === 'object' && 'pluginDir' in v && typeof s[j + 1] === 'string'); return i < 0 ? -1 : i + 2 }`, { kind: 'err', text: '安装失败：无法写入 extensions 目录（EPERM）。' }),
    petLog: await fh('[data-testid="caps-market-desktop-pet"]', `(s) => { const i = s.findIndex((v) => v && typeof v === 'object' && 'edges' in v); return i < 0 ? -1 : i + 4 }`, true)
  })
  const marketResults = () => fh('[data-testid="caps-market-search-btn"]', `(s) => { const i = s.findIndex((v, j) => typeof v === 'string' && typeof s[j + 1] === 'string' && typeof s[j + 2] === 'number' && (s[j + 3] === null || (s[j + 3] && typeof s[j + 3] === 'object')) && typeof s[j + 4] === 'boolean'); return i < 0 ? -1 : i + 3 }`, { ok: true, entries: pkgs, total: 6 })
  const mcpInject = async () => ({
    snapshot: await fh('[data-testid="mcp-add"]', `(s) => s.findIndex((v, i) => s[i + 2] === 'global' && typeof s[i + 3] === 'boolean' && typeof s[i + 4] === 'string')`, mcpSnapshot)
  })
  const mcpDetails = () => ev(`(() => { const b = document.querySelector('[data-testid="mcp-service"] button[aria-expanded="false"]'); b?.click(); return !!b })()`)
  const pkgInject = (n) => fh('[data-setting-id="caps-extensions"]', `(s) => s.findIndex((v, i) => s[i + 1] === '' && s[i + 3] === 'install')`, listing(n))
  const voiceInstalled = async (on) => {
    const id = await testIdWith('caps-market-', on ? '语音' : '语音') || await testIdWith('caps-market-', 'Voice')
    if (!id) return 'no-voice-row'
    return fh(`[data-testid="${id}"]`, `(s) => s.findIndex((v, i) => typeof v === 'boolean' && Array.isArray(s[i + 1]) && typeof s[i + 1][0] === 'function' && typeof s[i + 2] === 'boolean' && typeof s[i + 3] === 'string') + 1 || -1`, on, 'call')
  }

  const originalLang = await ev(`window.__yanStore.getState().settings?.lang ?? 'zh-CN'`)
  await go('caps-tab-market')
  await sleep(2000)
  await freezeTimers(true)

  const e2Pick = (process.env.UI_POLISH_E2_WIDTHS || 'w700,w880,wide').split(',')
  const e2Widths = [[700, 'w700'], [880, 'w880'], [0, 'wide']].filter(([, label]) => e2Pick.includes(label))
  for (const [width, label] of e2Widths) {
    if (width) await S.narrow(width, 960)
    for (const lang of label === 'w700' ? ['zh-CN', 'en-US'] : label === 'w880' ? ['en-US'] : ['zh-CN']) {
      log(`lang-${label}-${lang}`, await setLang(lang))
      log(`content-${label}`, await ev(`(() => { const c = document.querySelector('.ui-settings__content'); if (!c) return null; const s = getComputedStyle(c); return Math.round(c.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight)) })()`))
      await sleep(600)
      const tag = label !== 'wide' ? `r2b-e1-${label}-${lang === 'zh-CN' ? 'zh' : 'en'}` : 'r2b-e2'
      const shoot = async (name, prep, selector) => {
        if (label === 'w880' && name !== 'market-installed' && name !== 'tools-voice-setup') return
        if (label !== 'wide') {
          if (prep) log(`${tag}-${name}`, await prep())
          await sleep(500)
          if (selector) await into(selector)
          await S.unhover()
          await S.clip(`${tag}-${name}-dark`, modal, 0)
          if (lang === 'zh-CN') {
            await S.theme('light')
            if (prep) await prep()
            await sleep(500)
            if (selector) await into(selector)
            await S.clip(`${tag}-${name}-light`, modal, 0)
            await S.theme('dark')
          }
        } else await shotBoth(`${tag}-${name}`, prep, selector)
      }

      await go('caps-tab-market')
      await sleep(1500)
      await shoot('market-installed', marketStates, '[data-testid="caps-market-desktop-pet"]')
      if (label === 'wide') await shoot('market-errors', async () => [await marketStates(), await marketErrors()], '[data-testid="caps-market-minecraft"]')
      await shoot('market-results', marketResults, '[data-testid="caps-market-results"]')
      log(`voiceOn-${label}-${lang}`, await voiceInstalled(true))

      await go('caps-tab-mcp')
      await sleep(1800)
      await shoot('mcp-services', mcpInject, '[data-testid="mcp-services"]')
      if (label === 'wide') await shoot('mcp-details', async () => [await mcpInject(), await sleep(300), await mcpDetails(), await fh('[data-testid="mcp-add"]', `(s) => { const i = s.findIndex((v, j) => s[j + 2] === 'global' && typeof s[j + 3] === 'boolean' && typeof s[j + 4] === 'string'); return i < 0 ? -1 : i + 4 }`, '保存失败：mcp.json 被其他程序占用，稍后重试。')], '[data-testid="mcp-services"]')
      if (label === 'wide') {
        await openAdvanced()
        await sleep(900)
        await shoot('mcp-legacy', async () => [
          await fh('[data-setting-id="caps-mcp-native-status"]', `(s) => s.findIndex((v, i) => (v === null || (v && typeof v === 'object' && 'servers' in v)) && (s[i + 1] === null || typeof s[i + 1] === 'string'))`, { skills: [], configWarning: false, nativeMcpAvailable: true, servers: [
            { id: 'legacy-filesystem', title: 'legacy-filesystem', transport: 'stdio', enabled: true, effect: 'write', projectScoped: false, status: 'ready', toolCount: 14, ownedBy: 'inkstone' },
            { id: 'remote-search-with-a-long-server-identifier', title: 'remote-search-with-a-long-server-identifier', transport: 'http', enabled: true, effect: 'read', projectScoped: true, endpointOrigin: 'https://search.example.com', status: 'needs-auth', toolCount: null, ownedBy: 'inkstone' },
            { id: 'old-tool', title: 'old-tool', transport: 'stdio', enabled: false, effect: 'external-action', projectScoped: false, status: 'error', toolCount: 0, ownedBy: 'inkstone' }
          ] })
        ], '[data-setting-id="caps-mcp-native-status"]')
      }

      await go('caps-tab-tools')
      await sleep(1800)
      await openAdvanced()
      await sleep(900)
      await shoot('tools-search', async () => [
        await fh('[data-testid="cap-search-api"]', `(s) => s.findIndex((v, i) => (v === null || (v && typeof v === 'object' && 'providers' in v)) && Array.isArray(s[i + 1]))`, { configured: true, hintDismissed: false, deepseekModelKey: true, providers: { tavily: { configured: true, source: 'file' }, brave: { configured: true, source: 'env' }, firecrawl: { configured: false }, context7: { configured: false } } }),
        await ev(`(() => { const b = document.querySelector('[data-testid="cap-search-api-add-firecrawl"]'); b?.click(); return !!b })()`),
        await sleep(300),
        await fh('[data-testid="cap-search-api-firecrawl"]', `(s) => s.findIndex((v, i) => typeof v === 'string' && typeof s[i + 1] === 'string' && typeof s[i + 2] === 'boolean' && s[i + 3] === true)`, 'fc-1234567890abcdef'),
        await fh('[data-testid="cap-search-api-firecrawl"]', `(s) => s.findIndex((v, i) => typeof s[i - 1] === 'string' && typeof v === 'string' && typeof s[i + 1] === 'boolean' && s[i + 2] === true)`, '保存失败：Key 格式不对（应以 fc- 开头）。'),
        await ev(`document.activeElement?.blur?.()`)
      ], '[data-testid="cap-search-api"]')
      await shoot('tools-android', () => fh('[data-testid="settings-android"]', androidFinder, android({ queue: ['emulator', 'systemImage'], current: 'systemImage', phase: 'download', received: 820_000_000, total: 1_900_000_000, done: ['emulator'], state: 'running' })), '[data-testid="settings-android"]')
      if (label === 'wide') await shoot('tools-android-failed', () => fh('[data-testid="settings-android"]', androidFinder, android({ queue: ['emulator'], current: null, phase: 'idle', received: 0, total: 0, done: [], state: 'failed', error: 'sdkmanager exited with code 1：网络超时。' })), '[data-testid="settings-android"]')
      await shoot('tools-voice', async () => [await setVoiceSaved(), await fh('[data-testid="settings-voice"]', voiceFinder, voiceStatus({ planId: 'p0', label: 'ggml-small.bin', received: 210_000_000, total: 488_000_000, state: 'running' })), await fh('[data-testid="settings-voice"]', voicePlanFinder, voicePlan)], '[data-testid="settings-voice"]')
      await shoot('tools-voice-setup', async () => [await setVoiceSaved(), await fh('[data-testid="settings-voice"]', voiceFinder, voiceStatus(null)), await fh('[data-testid="settings-voice"]', voicePlanFinder, voicePlan)], '[data-testid="settings-voice-setup"]')

      await go('caps-tab-skills')
      await sleep(1800)
      await shoot('packages', async () => [await pkgInject(5), await ev(`(() => { const b = document.querySelector('[data-testid="caps-pkg-detail"]'); b?.click(); return !!b })()`)], '[data-setting-id="caps-extensions"]')
      if (label === 'wide') {
        await shoot('packages-failed', async () => [await pkgInject(2), await fh('[data-setting-id="caps-extensions"]', `(s) => s.findIndex((v, i) => s[i + 1] === 'install' && s[i - 1] === '')`, { ok: false, error: 'npm ERR! code ETARGET No matching version found for pi-ext-2@^9.0.0', detail: 'npm ERR! code ETARGET\nnpm ERR! notarget No matching version found for pi-ext-2@^9.0.0.' })], '[data-setting-id="caps-extensions"]')
        const skillSnap = { servers: [], configWarning: false, skills: [
          { id: 's1', title: 'draft-release-notes', description: '本会话里刚写的技能', origin: 'session', location: 'C:\\tmp\\s1\\SKILL.md' },
          { id: 's2', title: 'a-session-skill-with-a-really-long-name-for-layout-checks', description: '', origin: 'session', location: 'C:\\tmp\\s2\\SKILL.md' },
          { id: 'u1', title: 'pdf-report-writer', description: 'PDF 报告', origin: 'user', acquired: true, sourceUrl: 'https://github.com/example/skills/tree/main/pdf-report-writer', location: 'C:\\Users\\demo\\.agents\\skills\\pdf-report-writer\\SKILL.md', enabled: true, manage: { scope: 'yan', dir: 'C:\\Users\\demo\\.agents\\skills\\pdf-report-writer' } },
          { id: 'u2', title: 'code-review', description: '', origin: 'user', location: 'C:\\Users\\demo\\.agents\\skills\\code-review\\SKILL.md', enabled: false, manage: { scope: 'pi', dir: 'C:\\Users\\demo\\.pi\\agent\\skills\\code-review' } },
          { id: 'b1', title: 'artifact', description: '', origin: 'bundled', location: 'C:\\Program Files\\Inkstone\\resources\\skills\\artifact\\SKILL.md' }
        ] }
        await shoot('skills-session', () => fh('[data-testid="caps-skills-reload"]', `(s) => s.findIndex((v, i) => (v === null || (v && typeof v === 'object' && 'skills' in v)) && typeof s[i + 1] === 'boolean')`, skillSnap), '[data-testid="caps-skills-reload"]')
        const prompts = async () => {
          const sample = await ev(`JSON.stringify((window.__yanStore.getState().commands ?? [])[0] ?? null)`)
          const base = JSON.parse(sample || 'null') ?? {}
          const list = ['review-pr', 'summarize-changes-with-a-very-long-prompt-template-name', 'translate'].map((name, i) => ({ ...base, name, source: 'prompt', description: i === 1 ? '把这次改动整理成中文提交说明，列出文件和风险。' : 'Prompt template for layout checks', location: i === 2 ? 'project' : 'user', usage: i === 0 ? '<pr-number>' : undefined, hiddenInMenu: i === 2 }))
          await ev(`(() => { const s = window.__yanStore.getState(); if (!window.__uiPolishCommands) window.__uiPolishCommands = s.commands; window.__yanStore.setState({ commands: [...(s.commands ?? []).filter((c) => c.source !== 'prompt'), ...${JSON.stringify(list)}] }); return true })()`)
          await sleep(200)
          return fh('[data-testid="caps-prompts-reload"]', `(s) => s.findIndex((v, i) => (v === null || (v && typeof v === 'object' && 'user' in v)) && (s[i + 1] === null || typeof s[i + 1] === 'string') && typeof s[i + 2] === 'string' && typeof s[i + 3] === 'boolean')`, { user: 'C:\\Users\\demo\\.pi\\agent\\prompts', project: 'C:\\work\\a-project-with-a-long-folder-name-for-layout\\.pi\\prompts' })
        }
        await shoot('prompts', prompts, '[data-testid="caps-prompts-reload"]')
        await ev(`(() => { if (window.__uiPolishCommands) window.__yanStore.setState({ commands: window.__uiPolishCommands }); delete window.__uiPolishCommands; return true })()`)
      }
    }
    if (width) await S.wide()
  }
  await setLang(originalLang)
  await freezeTimers(false)
  await ev(`(() => { const s = window.__yanStore.getState(); window.__yanStore.setState({ settings: { ...s.settings, voiceInput: ${savedSettings} ?? undefined } }); return true })()`)
  await go('caps-tab-market')
  await sleep(1500)
  log('voiceOff', await voiceInstalled(false))
  await scrollTo(0)
}

async function settingsBatch3({ S, ev, sleep, until, check, report, go, into, scrollTo, modal, R }) {
  const hook = async (selector, test, value, offset = 0) => {
    let result = 'no-hook'
    let thawed = false
    for (let attempt = 0; attempt < 50; attempt++) {
      result = await hookOnce(selector, test, value, offset)
      if (result !== 'no-hook' && result !== 'no-element') break
      if (attempt === 3 && frozen) {
        thawed = true
        await ev(`(delete document.visibilityState, document.dispatchEvent(new Event('visibilitychange')), true)`)
      }
      await sleep(300)
    }
    if (thawed) await freeze(true)
    return result
  }
  let frozen = false
  const hookOnce = (selector, test, value, offset = 0) => ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return 'no-element'
    const key = Object.keys(el).find((name) => name.startsWith('__reactFiber$'))
    const test = ${test}
    for (let fiber = el[key]; fiber; fiber = fiber.return) {
      for (const copy of [fiber, fiber.alternate]) {
        if (!copy) continue
        const hooks = []
        for (let h = copy.memoizedState; h && typeof h === 'object' && 'next' in h; h = h.next) hooks.push(h)
        for (let i = 0; i < hooks.length; i++) {
          let ok = false
          try { ok = !!hooks[i].queue && !!test(hooks[i].memoizedState) } catch {}
          if (!ok) continue
          const target = hooks[i + ${offset}]
          if (!target?.queue?.dispatch) return 'no-target'
          target.queue.dispatch(${JSON.stringify(value)})
          return 'ok'
        }
      }
    }
    return 'no-hook'
  })()`)
  const freeze = (on) => (frozen = on, ev(on ? `(Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }), true)` : `(delete document.visibilityState, document.visibilityState)`))
  const twice = async (name, prep, selector) => {
    R.b3[name] = []
    for (const mode of ['dark', 'light']) {
      if (mode === 'light') await S.theme('light')
      if (prep) R.b3[name].push(await prep())
      await sleep(450)
      if (selector) await into(selector)
      await S.unhover()
      await S.clip(`${name}-${mode}`, modal, 0)
    }
    await S.theme('dark')
  }
  const hoverShot = async (name, selector) => {
    await into(selector)
    report.hover.push([name, await S.hover(selector, 700)])
    await S.clip(`${name}-dark`, modal, 0)
    await S.theme('light')
    report.hover.push([`${name}-light`, await S.hover(selector, 700)])
    await S.clip(`${name}-light`, modal, 0)
    await S.theme('dark')
    await S.unhover()
  }
  const focusShot = async (name, _start, presses) => {
    await ev(`(() => {
      const c = document.querySelector('.ui-settings__content')
      if (!c) return false
      const top = c.getBoundingClientRect().top
      const list = [...c.querySelectorAll('button:not([disabled]), input:not([disabled]), a[href], [tabindex="0"], [role="switch"]')]
      const first = list.find((n) => { const b = n.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.top >= top }) ?? list[0]
      if (!first) return false
      first.setAttribute('data-ui-polish-first', '1')
      return true
    })()`)
    report.focus.push([name, await S.focusThenTab('[data-ui-polish-first]', { presses: Math.max(1, presses - 1) })])
    await ev(`document.querySelector('[data-ui-polish-first]')?.removeAttribute('data-ui-polish-first')`)
    await ev(`document.activeElement?.scrollIntoView?.({ block: 'center' })`)
    await sleep(300)
    await S.clip(`${name}-dark`, modal, 0)
    await S.theme('light')
    await S.clip(`${name}-light`, modal, 0)
    await S.theme('dark')
    await ev(`document.activeElement?.blur?.()`)
    await S.unhover()
  }
  R.b3 = {}
  const now = Date.now()

  await go('caps-tab-market')
  await sleep(1800)
  await freeze(true)
  const pkgs = Array.from({ length: 12 }, (_, i) => ({
    name: i === 2 ? '@some-very-long-scope-name/pi-extension-with-an-extremely-long-package-name-for-layout' : `pi-demo-package-${i + 1}`,
    version: `1.${i}.0`,
    publisher: i % 3 === 0 ? '社区作者' : `author${i}`,
    description: i % 2 ? '给 pi 增加一个示例能力，用来检查插件市场搜索结果在条目很多、说明很长时的显示与截断效果。' : 'Example pi package with a fairly long description to check truncation in the market list.',
    source: `npm:pi-demo-package-${i + 1}`,
    npmUrl: 'https://www.npmjs.com/',
    homepage: i % 4 === 1 ? undefined : 'https://example.com/'
  }))
  const marketInput = '[data-testid="caps-market-search"] input'
  await ev(`(() => { const i = document.querySelector(${JSON.stringify(marketInput)}) || document.querySelector('[data-testid="caps-market-search"]'); i?.focus(); return !!i })()`)
  await S.typeText('zzqx-no-such-package-ui-polish', 300)
  await ev(`document.activeElement?.blur?.()`)
  const loading = async () => {
    const a = await hook('[data-testid="caps-market-search-btn"]', `(v) => typeof v === 'string' && v.startsWith('zzqx')`, 'zzqx-no-such-package-ui-polish', 1)
    const b = await hook('[data-testid="caps-market-search-btn"]', `(v) => typeof v === 'string' && v.startsWith('zzqx')`, true, 4)
    return [a, b]
  }
  await twice('r3-market-01-search-loading', loading, '[data-testid="caps-market-search"]')
  const setCatalog = (value) => async () => {
    await hook('[data-testid="caps-market-search-btn"]', `(v) => typeof v === 'string' && v.startsWith('zzqx')`, false, 4)
    return hook('[data-testid="caps-market-search-btn"]', `(v) => typeof v === 'string' && v.startsWith('zzqx')`, value, 3)
  }
  await twice('r3-market-02-search-results', setCatalog({ ok: true, entries: pkgs, total: 57 }), '[data-testid="caps-market-search"]')
  await into('.caps-pager')
  await S.clip('r3-market-02-search-results-pager-dark', modal, 0)
  await hoverShot('r3-market-03-result-hover', '[data-testid="caps-market-choose"]')
  await twice('r3-market-04-search-empty', setCatalog({ ok: true, entries: [], total: 0 }), '[data-testid="caps-market-search"]')
  await twice('r3-market-05-search-error', setCatalog({ ok: false, entries: [], total: 0, error: 'fetch failed: getaddrinfo ENOTFOUND registry.npmjs.org（网络不可用或被代理拦截）' }), '[data-testid="caps-market-search"]')
  await setCatalog({ ok: true, entries: pkgs, total: 57 })()
  await sleep(400)
  R.b3.choose = await S.click('[data-testid="caps-market-choose"]', 700)
  await S.unhover()
  const pkgResult = async () => hook('[data-testid="caps-pkg-source"]', `(v) => v === 'install'`, { ok: false, error: 'npm ERR! code E404 404 Not Found - GET https://registry.npmjs.org/pi-demo-package-1 - Not found', detail: 'npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/pi-demo-package-1\nnpm ERR! 404 \nnpm ERR! 404  \'pi-demo-package-1@latest\' is not in this registry.\nnpm ERR! A complete log of this run can be found in: C:\\Users\\demo\\AppData\\Local\\npm-cache\\_logs\\debug-0.log' }, -1)
  await twice('r3-market-06-chosen-and-failed', pkgResult, '[data-testid="caps-pkg-source"]')
  await hoverShot('r3-market-07-plugin-hover', '[data-testid="caps-market-inkstone"] .caps-entry button')
  await focusShot('r3-market-08-focus', '[data-testid="caps-market-catalog-refresh"]', 3)
  await freeze(false)

  await go('v3-settings-nav-code')
  await sleep(2200)
  await freeze(true)
  const isAccount = `(v) => v && typeof v === 'object' && 'installed' in v && !('pluginDir' in v)`
  R.b3.githubSettled = await until(`!document.querySelector('[data-testid="v3-github-refresh"]')?.hasAttribute('data-pending') && !/正在检测|Checking/.test(document.querySelector('[data-testid="v3-github-status"]')?.textContent ?? '')`, 40000, 300)
  R.b3.githubProbe = await ev(`(() => {
    const el = document.querySelector('[data-testid="v3-github-refresh"]')
    if (!el) return 'no-element'
    const key = Object.keys(el).find((name) => name.startsWith('__reactFiber$'))
    const out = []
    for (let fiber = el[key], depth = 0; fiber && depth < 40; fiber = fiber.return, depth++) {
      const states = []
      for (let h = fiber.memoizedState; h && typeof h === 'object' && 'next' in h; h = h.next) states.push(h.queue ? (h.memoizedState === null ? 'null' : typeof h.memoizedState === 'object' ? 'obj:' + Object.keys(h.memoizedState).slice(0, 4).join('|') : typeof h.memoizedState) : '-')
      if (states.some((s) => s !== '-')) out.push([depth, typeof fiber.type === 'function' ? fiber.type.name : String(fiber.type), states.slice(0, 6).join(',')])
    }
    return out.slice(0, 12)
  })()`)
  await twice('r3-code-01-github-authed', () => hook('[data-testid="v3-github-refresh"]', isAccount, { installed: true, authed: true, login: 'a-rather-long-github-login-name-for-layout' }))
  await twice('r3-code-02-github-missing', () => hook('[data-testid="v3-github-refresh"]', isAccount, { installed: false, authed: false }))
  await twice('r3-code-03-github-checking', () => hook('[data-testid="v3-github-refresh"]', isAccount, true, 1))
  await hook('[data-testid="v3-github-refresh"]', isAccount, false, 1)
  const gitStore = (value) => ev(`(window.__yanStore.setState({ gitInstall: ${JSON.stringify(value)} }), true)`)
  const isTools = `(v) => v && typeof v === 'object' && 'git' in v && 'bash' in v && 'platform' in v`
  const isRuntime = `(v) => v && typeof v === 'object' && 'downloadSize' in v && 'supported' in v`
  const original = await ev(`JSON.stringify(window.__yanStore.getState().gitInstall ?? { phase: 'idle' })`)
  await twice('r3-code-04-git-missing', () => hook('[data-testid="cap-git-runtime"]', isTools, { platform: 'win32', git: { ok: false, reason: 'missing' }, bash: { ok: false, reason: 'missing' } }), '[data-testid="cap-git-runtime"]')
  await gitStore({ phase: 'downloading', received: 27_400_000, total: 60_027_568 })
  await sleep(600)
  await twice('r3-code-05-git-downloading', null, '[data-testid="cap-git-runtime"]')
  await gitStore({ phase: 'error', message: '下载失败：连接 github.com 超时，已改用镜像仍失败（ETIMEDOUT）。请检查网络或代理后重试。' })
  await sleep(1500)
  await twice('r3-code-06-git-error', () => hook('[data-testid="cap-git-runtime"]', isTools, { platform: 'win32', git: { ok: false, reason: 'missing' }, bash: { ok: false, reason: 'missing' } }), '[data-testid="cap-git-runtime"]')
  await gitStore(JSON.parse(original))
  await sleep(1500)
  await twice('r3-code-07-git-managed', async () => [
    await hook('[data-testid="cap-git-runtime"]', isRuntime, { supported: true, systemGit: false, systemBash: false, managedInstalled: true, managedVersion: '2.56.0.2', installing: false, downloadSize: 60_027_568 }),
    await hook('[data-testid="cap-git-runtime"]', isTools, { platform: 'win32', git: { ok: true, managed: true }, bash: { ok: true, managed: true } })
  ], '[data-testid="cap-git-runtime"]')
  await hoverShot('r3-code-08-hover', '[data-testid="v3-github-clone-dir-choose"]')
  await focusShot('r3-code-09-focus', '[data-testid="settings-search"] input', 4)
  await freeze(false)

  await go('v3-settings-nav-devices')
  await sleep(2000)
  await freeze(true)
  const isStatus = `(v) => v && typeof v === 'object' && 'devices' in v && 'running' in v`
  const savedRemote = await ev(`JSON.stringify(window.__yanStore.getState().settings?.remoteAccess ?? null)`)
  const setSaved = (patch) => ev(`(() => { const s = window.__yanStore.getState(); const base = s.settings?.remoteAccess ?? {}; window.__yanStore.setState({ settings: { ...s.settings, remoteAccess: { ...base, ...${JSON.stringify(patch)} } } }); return true })()`)
  const day = 86_400_000
  const devices = [
    { id: 'd1', name: 'Pixel 8 Pro', kind: 'phone', createdAt: now - 30 * day, lastSeenAt: now - 120_000, encrypted: true, revokedAt: null, tunnelClientId: 'r1' },
    { id: 'd2', name: '小米 14 Ultra（工作机）', kind: 'phone', createdAt: now - 12 * day, lastSeenAt: now - 3 * day, encrypted: false, revokedAt: null },
    { id: 'd3', name: 'office-desktop-with-a-really-long-hostname.corp.example.com', kind: 'peer', createdAt: now - 60 * day, lastSeenAt: now - 7 * day, revokedAt: null },
    { id: 'd4', name: 'iPad Air', kind: 'phone', createdAt: now - 4 * day, lastSeenAt: null, encrypted: true, revokedAt: null },
    { id: 'd5', name: 'Galaxy S21', kind: 'phone', createdAt: now - 200 * day, lastSeenAt: now - 90 * day, encrypted: true, revokedAt: now - 80 * day },
    { id: 'd6', name: '旧手机', kind: 'phone', createdAt: now - 300 * day, lastSeenAt: now - 250 * day, encrypted: false, revokedAt: now - 240 * day }
  ]
  const relayClients = [
    { id: 'r1', name: 'Pixel 8 Pro', kind: 'phone', addedAt: now - 30 * day, lastSeenAt: now - 60_000, revokedAt: null, online: true },
    { id: 'r2', name: 'Hermes agent', kind: 'agent', addedAt: now - 2 * day, lastSeenAt: now - 600_000, revokedAt: null, online: false }
  ]
  const base = { enabled: true, hostFingerprint: 'SHA256:4f9c 1a2b 77de 0c3f 9e21 5b6a', running: true, host: '100.88.12.34', port: 8787, addresses: [{ kind: 'tailscale', address: '100.88.12.34' }, { kind: 'lan', address: '192.168.1.23' }, { kind: 'lan', address: '10.0.0.8' }, { kind: 'loopback', address: '127.0.0.1' }], pairing: null, devices, error: null, relay: { enabled: true, url: 'https://relay.example.com', connected: true, detail: null, clients: relayClients, pairing: null } }
  const devicesPrep = (status, saved) => async () => {
    if (saved) await setSaved(saved)
    await sleep(150)
    return hook('[data-testid="v3-devices-settings"] [data-testid="v3-devices-enable"]', isStatus, status)
  }
  await twice('r3-devices-01-many', devicesPrep(base, { enabled: true, bind: 'tailscale', relay: { enabled: true, url: 'https://relay.example.com' } }))
  await twice('r3-devices-02-list', devicesPrep(base, { enabled: true, bind: 'tailscale', relay: { enabled: true, url: 'https://relay.example.com' } }), '[data-testid="v3-device-list"]')
  await hoverShot('r3-devices-03-revoke-hover', '[data-testid="v3-device"] button')
  await twice('r3-devices-04-pairing', devicesPrep({ ...base, pairing: { code: '482913', expiresAt: now + 10 * 60_000 } }, { enabled: true, bind: 'tailscale' }), '[data-testid="v3-devices-pairing"]')
  await twice('r3-devices-05-relay-pairing', devicesPrep({ ...base, relay: { ...base.relay, pairing: { kind: 'phone', link: 'https://relay.example.com/pair#k=AbCdEf0123456789&h=demo', expiresAt: now + 10 * 60_000 } } }, { enabled: true, bind: 'tailscale', relay: { enabled: true, url: 'https://relay.example.com' } }), '[data-testid="v3-relay-pairing"]')
  await twice('r3-devices-06-start-error', devicesPrep({ ...base, running: false, devices: [], relay: { ...base.relay, clients: [], connected: false, detail: '连接中继失败：403 Forbidden（令牌无效）' }, error: 'listen EADDRINUSE: address already in use 0.0.0.0:8787' }, { enabled: true, bind: '192.168.1.23', relay: { enabled: true, url: 'https://relay.example.com' } }))
  await twice('r3-devices-07-lan-select', devicesPrep(base, { enabled: true, bind: '192.168.1.23', relay: { enabled: false, url: '' } }), '[data-testid="v3-devices-bind"]')
  await focusShot('r3-devices-08-focus', '[data-testid="settings-search"] input', 3)
  await ev(`(() => { const s = window.__yanStore.getState(); window.__yanStore.setState({ settings: { ...s.settings, remoteAccess: ${savedRemote} ?? s.settings?.remoteAccess } }); return true })()`)
  await freeze(false)
  await go('v3-settings-nav-appearance')

  await go('v3-settings-nav-data')
  await sleep(1500)
  await freeze(true)
  await ev(`(() => { for (const b of document.querySelectorAll('.ui-settings__content .settings-advanced > button[aria-expanded="false"]')) b.click(); return true })()`)
  await sleep(900)
  const isInfo = `(v) => v && typeof v === 'object' && 'realDir' in v && 'movable' in v`
  const dataSel = '[data-testid="v3-data-backup-create"]'
  const realInfo = { agentDir: 'D:\\InkstoneData\\pi-agent', realDir: 'C:\\Users\\demo\\.pi\\agent', relocated: true, movable: true, bytes: 2_634_000_000, pendingTarget: 'E:\\Backups\\Inkstone\\a-long-folder-name-for-layout-checks\\pi-agent', strandedBackup: 'C:\\Users\\demo\\.pi\\agent.moving-backup-20261101', lastResult: { ok: false, at: now - day, from: 'C:\\Users\\demo\\.pi\\agent', to: 'D:\\InkstoneData', error: 'EPERM: operation not permitted, rename (文件被占用)' } }
  await twice('r3-data-01-storage-errors', () => hook(dataSel, isInfo, realInfo), '[data-setting-id="data-location"]')
  await twice('r3-data-02-move-target', async () => [
    await hook(dataSel, isInfo, { ...realInfo, relocated: false, pendingTarget: undefined, strandedBackup: undefined, lastResult: undefined }),
    await hook(dataSel, isInfo, 'D:\\InkstoneData\\a-very-long-target-folder-name-to-check-wrapping', 1)
  ], '[data-setting-id="data-move"]')
  await twice('r3-data-03-backup-summary', () => hook(dataSel, isInfo, { action: 'create', value: { files: 12_843, bytes: 412_000_000, path: 'C:\\Users\\demo\\Documents\\Inkstone\\backups\\inkstone-backup-2026-11-16T05-40-12.zip' } }, 3), '[data-setting-id="data-backup-create"]')
  await twice('r3-data-04-backup-error', async () => [
    await hook(dataSel, isInfo, null, 3),
    await hook(dataSel, isInfo, { scope: 'backup', tone: 'fail', text: '备份失败：目标磁盘空间不足（需要 412 MB，可用 120 MB）。' }, 4)
  ], '[data-setting-id="data-backup-create"]')
  await hook(dataSel, isInfo, null, 4)
  await hoverShot('r3-data-05-hover', '[data-testid="v3-data-backup-verify"]')
  await focusShot('r3-data-06-focus', '[data-testid="settings-search"] input', 3)
  await twice('r3-data-07-loading', () => hook(dataSel, isInfo, null), '[data-setting-id="data-location"]')
  await freeze(false)
  await go('v3-settings-nav-appearance')

  await go('v3-settings-nav-about')
  await sleep(1500)
  await freeze(true)
  const isUpdate = `(v) => v && typeof v === 'object' && 'phase' in v && 'automatic' in v`
  const upd = { current: '0.15.4', automatic: true, packaged: true, releaseUrl: 'https://github.com/Yu-DaTouX/Inkstone/releases' }
  const aboutSel = '[data-testid="v3-about-update-check"]'
  await twice('r3-about-01-available', () => hook(aboutSel, isUpdate, { ...upd, phase: 'available', latest: '0.15.5' }))
  await twice('r3-about-02-downloading', () => hook(aboutSel, isUpdate, { ...upd, phase: 'downloading', latest: '0.15.5', percent: 42 }))
  await twice('r3-about-03-downloaded', () => hook(aboutSel, isUpdate, { ...upd, phase: 'downloaded', latest: '0.15.5', percent: 100 }))
  await twice('r3-about-04-error', async () => [
    await hook(aboutSel, isUpdate, { ...upd, phase: 'error', error: 'net::ERR_CONNECTION_RESET（github.com）' }),
    await hook(aboutSel, isUpdate, '检查更新失败：net::ERR_CONNECTION_RESET', 3)
  ])
  await hook(aboutSel, isUpdate, '', 3)
  await twice('r3-about-05-manual', () => hook(aboutSel, isUpdate, { ...upd, phase: 'manual', latest: '0.15.5', packaged: false }))
  const piInfo = await ev(`JSON.stringify(window.__yanStore.getState().piInfo ?? null)`)
  await twice('r3-about-06-pi-error', () => ev(`(() => { const p = window.__yanStore.getState().piInfo ?? {}; window.__yanStore.setState({ piInfo: { ...p, error: 'spawn C:\\\\Users\\\\demo\\\\AppData\\\\Roaming\\\\npm\\\\pi.cmd ENOENT：找不到 pi，可在终端运行 npm i -g @mariozechner/pi-coding-agent' } }); return true })()`), '[data-setting-id="about-pi-redetect"]')
  await ev(`(window.__yanStore.setState({ piInfo: ${piInfo} }), true)`)
  await hoverShot('r3-about-07-hover', '[data-testid="v3-about-repo"]')
  await focusShot('r3-about-08-focus', '[data-testid="settings-search"] input', 3)
  await freeze(false)
  await scrollTo(0)
}

async function settingsLayoutProbe({ S, ev, sleep, go, R }) {
  R.probe = {}
  const collect = () => ev(`(() => {
    const c = document.querySelector('.ui-settings__content')
    if (!c) return null
    const top = c.getBoundingClientRect().top - c.scrollTop
    const out = []
    const path = (n) => { const parts = []; for (let e = n; e && e !== c && parts.length < 3; e = e.parentElement) parts.unshift((e.getAttribute('data-testid') || e.getAttribute('data-setting-id') || [...e.classList].filter((k) => !k.startsWith('ui-')).slice(0, 2).join('.') || e.tagName.toLowerCase())); return parts.join(' > ') }
    for (const n of c.querySelectorAll('*')) {
      const s = getComputedStyle(n)
      const b = n.getBoundingClientRect()
      if (!b.width || !b.height) continue
      const card = s.boxShadow !== 'none' && s.backgroundColor !== 'rgba(0, 0, 0, 0)' && parseFloat(s.borderTopLeftRadius) >= 8
      const head = n.tagName === 'H3'
      if (!card && !head) continue
      out.push([path(n), Math.round(b.left), Math.round(b.top - top), Math.round(b.width), Math.round(b.height), card ? [s.borderTopLeftRadius, s.backgroundColor, s.boxShadow.slice(0, 60), s.padding].join(' ') : [s.color, s.fontSize, s.fontWeight, s.lineHeight].join(' ')])
    }
    return out
  })()`)
  const expand = () => ev(`(() => { let n = 0; for (const b of document.querySelectorAll('.ui-settings__content .settings-advanced > button[aria-expanded="false"], .ui-settings__content .settings-fold__toggle[aria-expanded="false"]')) { b.click(); n++ } return n })()`)
  for (const [width, label] of [[0, 'wide'], [880, 'w880'], [700, 'w700'], [560, 'w560']]) {
    if (width) await S.narrow(width, 960)
    for (const [name, id] of SETTINGS_PAGES) {
      await go(id)
      await sleep(name === 'models' || name.startsWith('caps') || name === 'code' ? 1500 : 500)
      if (await expand()) await sleep(1200)
      R.probe[`${name}-${label}`] = await collect()
    }
    if (width) await S.wide()
  }
}

async function settingsRelayConnecting({ S, ev, sleep, go, into, modal, R }) {
  R.relay = {}
  await go('v3-settings-nav-devices')
  await sleep(2000)
  await ev(`(Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }), true)`)
  const savedRemote = await ev(`JSON.stringify(window.__yanStore.getState().settings?.remoteAccess ?? null)`)
  const setSaved = () => ev(`(() => { const s = window.__yanStore.getState(); const base = s.settings?.remoteAccess ?? {}; window.__yanStore.setState({ settings: { ...s.settings, remoteAccess: { ...base, enabled: true, bind: 'tailscale', relay: { enabled: true, url: 'https://relay.example.com' } } } }); return true })()`)
  const status = { enabled: true, hostFingerprint: 'SHA256:4f9c 1a2b 77de 0c3f 9e21 5b6a', running: true, host: '100.88.12.34', port: 8787, addresses: [{ kind: 'tailscale', address: '100.88.12.34' }], pairing: null, devices: [], error: null, relay: { enabled: true, url: 'https://relay.example.com', connected: false, detail: '正在连接中继…', clients: [], pairing: null } }
  const inject = () => ev(`(() => {
    const el = document.querySelector('[data-testid="v3-devices-enable"]')
    if (!el) return 'no-element'
    const key = Object.keys(el).find((name) => name.startsWith('__reactFiber$'))
    for (let fiber = el[key]; fiber; fiber = fiber.return) {
      for (const copy of [fiber, fiber.alternate]) {
        if (!copy) continue
        for (let h = copy.memoizedState; h && typeof h === 'object' && 'next' in h; h = h.next) {
          const v = h.memoizedState
          if (h.queue?.dispatch && v && typeof v === 'object' && 'devices' in v && 'running' in v) { h.queue.dispatch(${JSON.stringify(status)}); return 'ok' }
        }
      }
    }
    return 'no-hook'
  })()`)
  for (const mode of ['dark', 'light']) {
    if (mode === 'light') await S.theme('light')
    await setSaved()
    await sleep(300)
    R.relay[mode] = await inject()
    await sleep(500)
    await into('[data-testid="v3-relay-enable"]')
    R.relay[`${mode}-text`] = await ev(`(() => { const row = document.querySelector('[data-setting-id="devices-relay"]'); return row ? row.innerText.replace(/\\s+/g, ' ').slice(0, 200) + ' | alert=' + !!row.querySelector('[role="alert"]') : null })()`)
    await S.unhover()
    await S.clip(`r3c-relay-connecting-${mode}`, modal, 0)
  }
  await S.theme('dark')
  await ev(`(() => { const s = window.__yanStore.getState(); window.__yanStore.setState({ settings: { ...s.settings, remoteAccess: ${savedRemote} ?? s.settings?.remoteAccess } }); return true })()`)
  await ev(`(delete document.visibilityState, true)`)
}

async function settingsBatch3Wrap({ S, ev, sleep, go, into, scrollTo, modal, R }) {
  R.r3w = {}
  const hook = async (selector, test, value) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await ev(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return 'no-element'
        const key = Object.keys(el).find((name) => name.startsWith('__reactFiber$'))
        const test = ${test}
        for (let fiber = el[key]; fiber; fiber = fiber.return) {
          for (let h = fiber.memoizedState; h && typeof h === 'object' && 'next' in h; h = h.next) {
            let ok = false
            try { ok = !!h.queue && !!test(h.memoizedState) } catch {}
            if (ok) { h.queue.dispatch(${JSON.stringify(value)}); return 'ok' }
          }
        }
        return 'no-hook'
      })()`)
      if (result === 'ok') return result
      await sleep(300)
    }
    return 'no-hook'
  }
  const isTools = `(v) => v && typeof v === 'object' && 'git' in v && 'bash' in v && 'platform' in v`
  const isRuntime = `(v) => v && typeof v === 'object' && 'downloadSize' in v && 'supported' in v`
  const missing = { platform: 'win32', git: { ok: false, reason: 'missing' }, bash: { ok: false, reason: 'missing' } }
  const gitStore = (value) => ev(`(window.__yanStore.setState({ gitInstall: ${JSON.stringify(value)} }), true)`)
  const originalGit = await ev(`JSON.stringify(window.__yanStore.getState().gitInstall ?? { phase: 'idle' })`)
  const originalLang = await ev(`window.__yanStore.getState().settings?.lang ?? 'zh-CN'`)
  const setLang = (lang) => ev(`window.__yanStore.getState().patchSettings({ lang: ${JSON.stringify(lang)} }).then(() => document.documentElement.lang)`)
  const shot = async (name, prep, selector) => {
    for (const mode of ['dark', 'light']) {
      if (mode === 'light') await S.theme('light')
      if (prep) R.r3w[`${name}-${mode}`] = await prep()
      await sleep(500)
      if (selector) await into(selector)
      await S.unhover()
      await S.clip(`${name}-${mode}`, modal, 0)
    }
    await S.theme('dark')
  }
  for (const [width, label, lang] of [[0, 'wide', 'en-US'], [880, 'w880', 'en-US'], [700, 'w700', 'zh-CN']]) {
    if (width) await S.narrow(width, 960)
    R.r3w[`lang-${label}`] = await setLang(lang)
    await sleep(600)
    const tag = `r3w-${label}-${lang === 'en-US' ? 'en' : 'zh'}`
    await go('v3-settings-nav-code')
    await sleep(2000)
    R.r3w[`content-${label}`] = await ev(`(() => { const c = document.querySelector('.ui-settings__content'); if (!c) return null; const s = getComputedStyle(c); return Math.round(c.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight)) })()`)
    await shot(`${tag}-git-missing`, () => hook('[data-testid="cap-git-runtime"]', isTools, missing), '[data-testid="cap-git-runtime"]')
    await gitStore({ phase: 'error', message: 'Download failed: timed out connecting to github.com; the mirror failed too (ETIMEDOUT). Check your network or proxy and retry.' })
    await sleep(1500)
    await shot(`${tag}-git-error`, () => hook('[data-testid="cap-git-runtime"]', isTools, missing), '[data-testid="cap-git-runtime"]')
    await gitStore(JSON.parse(originalGit))
    await sleep(1500)
    await shot(`${tag}-git-managed`, async () => [
      await hook('[data-testid="cap-git-runtime"]', isRuntime, { supported: true, systemGit: false, systemBash: false, managedInstalled: true, managedVersion: '2.56.0.2', installing: false, downloadSize: 60_027_568 }),
      await hook('[data-testid="cap-git-runtime"]', isTools, { platform: 'win32', git: { ok: true, managed: true }, bash: { ok: true, managed: true } })
    ], '[data-testid="cap-git-runtime"]')
    R.r3w[`${tag}-git-clipped`] = await ev(`[...document.querySelectorAll('.caps-entry > .caps-meta, .caps-entry .caps-name')].filter((n) => n.scrollWidth > n.clientWidth + 1).map((n) => n.textContent.slice(0, 60))`)
    await go('caps-tab-mcp')
    await sleep(1800)
    await ev(`(() => { for (const b of document.querySelectorAll('.ui-settings__content .settings-advanced > button[aria-expanded="false"]')) b.click(); return true })()`)
    await sleep(900)
    await shot(`${tag}-mcp-app-refresh`, null, '[data-testid="v3-mcp-app-refresh"]')
    R.r3w[`${tag}-meta-clipped`] = await ev(`[...document.querySelectorAll('.caps-entry > .caps-meta')].filter((n) => n.scrollWidth > n.clientWidth + 1).map((n) => n.textContent.slice(0, 60))`)
    if (width) await S.wide()
  }
  await setLang(originalLang)
  await scrollTo(0)
}

async function settingsBatch3Extra({ S, ev, sleep, go, into, scrollTo, modal, R }) {
  R.r3x = {}
  const twice = async (name, prep, selector) => {
    for (const mode of ['dark', 'light']) {
      if (mode === 'light') await S.theme('light')
      if (prep) R.r3x[`${name}-${mode}`] = await prep()
      await sleep(450)
      if (selector) await into(selector)
      await S.unhover()
      await S.clip(`${name}-${mode}`, modal, 0)
    }
    await S.theme('dark')
  }
  const click = (selector) => ev(`(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (!b) return false; b.click(); return true })()`)

  await go('v3-settings-nav-shortcuts')
  await sleep(800)
  await twice('r3x-shortcuts-top', () => scrollTo(0))
  await twice('r3x-shortcuts-split', null, '[data-testid^="v3-shortcut-split"]')
  R.r3x.keyEdges = await ev(`(() => { const out = []; for (const row of document.querySelectorAll('.settings-shortcut')) { const fixed = row.querySelector('.settings-shortcut-fixed-keys'); const btn = row.querySelector('button[data-testid^="v3-shortcut-record"]'); const kbd = btn?.querySelector('.ui-kbd:last-child'); const el = fixed ?? btn; if (!el) continue; const b = el.getBoundingClientRect(); const k = (fixed ?? kbd)?.querySelector?.('.ui-kbd:last-child')?.getBoundingClientRect?.() ?? kbd?.getBoundingClientRect(); out.push([row.getAttribute('data-testid'), fixed ? 'fixed' : 'button', Math.round(b.right), k ? Math.round(k.right) : null]) } return out.slice(0, 40) })()`)

  await go('v3-settings-nav-appearance')
  await sleep(800)
  R.r3x.sliders = await ev(`[...document.querySelectorAll('.ui-settings__content input[type="range"]')].map((n) => [n.closest('.ui-slider')?.getAttribute('aria-label') ?? n.getAttribute('aria-label') ?? n.closest('[aria-label]')?.getAttribute('aria-label'), n.getAttribute('aria-valuetext'), n.value])`)

  for (const [query, tag] of [['模型', 'models'], ['重试', 'retry']]) {
    for (const mode of ['dark', 'light']) {
      if (mode === 'light') await S.theme('light')
      await ev(`(() => { const i = document.querySelector('[data-testid="settings-search"] input'); i?.focus(); return !!i })()`)
      await S.typeText(query, 200)
      await sleep(700)
      R.r3x[`search-${tag}-${mode}`] = await ev(`[...document.querySelectorAll('.ui-settings-search__result')].map((n) => (n.hasAttribute('data-highlighted') ? '*' : '') + n.getAttribute('data-kind') + ':' + n.innerText.replace(/\\s+/g, ' ').trim()).slice(0, 20)`)
      await S.clip(`r3x-search-${tag}-${mode}`, modal, 0)
      await S.key('Escape')
      await sleep(300)
    }
    await S.theme('dark')
  }

  await go('caps-tab-mcp')
  await sleep(1800)
  R.r3x.mcpAdd = await click('[data-testid="mcp-add"]')
  await sleep(600)
  await click('[data-testid="mcp-form-advanced"]')
  await sleep(600)
  await twice('r3x-mcp-form', null, '[data-testid="mcp-service-form"]')
  R.r3x.mcpFormEdges = await ev(`(() => { const f = document.querySelector('[data-testid="mcp-service-form"]'); if (!f) return null; const r = (el) => el ? Math.round(el.getBoundingClientRect().left) : null; return { form: r(f), field: r(f.querySelector('.ui-field')), advanced: r(f.querySelector('.settings-advanced > button')), chevron: r(f.querySelector('.settings-advanced > button svg')), seg: [...f.querySelectorAll('.ui-seg')].map((s) => [s.getAttribute('aria-label'), s.getAttribute('aria-labelledby')]) } })()`)
  await ev(`(() => { const b = [...document.querySelectorAll('[data-testid="mcp-service-form"] .caps-actions button')][0]; b?.click(); return !!b })()`)
  await sleep(500)
  await ev(`(() => { for (const b of document.querySelectorAll('.ui-settings__content .settings-advanced > button[aria-expanded="false"]')) b.click(); return true })()`)
  await sleep(900)
  await twice('r3x-mcp-app-refresh', null, '[data-testid="v3-mcp-app-refresh"]')

  await go('v3-settings-nav-models')
  await sleep(1800)
  await click('[data-setting-id="models-image-generation"] .settings-fold__toggle[aria-expanded="false"]')
  await sleep(900)
  await click('[data-testid="ms-image-toggle-codex"]')
  await sleep(600)
  await twice('r3x-image-codex', null, '[data-testid="ms-image-codex"]')
  R.r3x.local = await ev(`document.querySelectorAll('[data-testid^="ms-local-launch-row-"]').length`)
  if (R.r3x.local) await twice('r3x-local-launch', null, '[data-testid^="ms-local-launch-row-"]')

  await go('v3-settings-nav-security')
  await sleep(800)
  R.r3x.mono = await ev(`(async () => {
    const fam = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim()
    try { await document.fonts.load('13px "Maple Mono CN"', '示例') } catch {}
    const g = document.createElement('canvas').getContext('2d')
    const m = (font, text) => { g.font = font; return Math.round(g.measureText(text).width * 100) / 100 }
    return { fam, mapleLoaded: document.fonts.check('13px "Maple Mono CN"', '示'), maple: { latin: m('13px "Maple Mono CN"', 'M'), cjk: m('13px "Maple Mono CN"', '示') }, stack: { latin: m('13px ' + fam, 'M'), cjk: m('13px ' + fam, '示') }, yahei: { cjk: m('13px "Microsoft YaHei UI"', '示') } }
  })()`)
  await scrollTo(0)
}

async function settingsTarget({ kit: S, ev, cdp, sleep, until, check, report, newSession }) {
  report.settings = { pages: {}, audit: {}, contrast: {} }
  const R = report.settings
  const modal = '.ui-settings-modal'
  const only = String(process.env.UI_POLISH_SETTINGS_PAGES || '').split(',').map((item) => item.trim()).filter(Boolean)
  const pages = only.length ? SETTINGS_PAGES.filter(([name]) => only.includes(name)) : SETTINGS_PAGES
  const extraEnv = process.env.UI_POLISH_SETTINGS_EXTRA ?? 'root,b1,b2,narrow'
  const extra = extraEnv !== '0'
  const sets = new Set(extraEnv.split(',').map((item) => item.trim()))
  const narrowPages = String(process.env.UI_POLISH_SETTINGS_NARROW || 'appearance,session,notifications,security,models,devices').split(',').map((item) => item.trim())
  const keyCombo = async (key, code, vk, modifiers) => {
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers })
    await sleep(500)
  }
  const into = async (selector) => {
    const ok = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollIntoView({ block: 'center' }); return true })()`)
    await sleep(350)
    return ok
  }
  const both = async (name) => {
    await S.clip(`${name}-dark`, modal, 0)
    await S.theme('light')
    await S.clip(`${name}-light`, modal, 0)
    await S.theme('dark')
  }
  const open = async () => {
    await ev(`(window.__yanStore.getState().openSettings(), true)`)
    return until(`!!document.querySelector('.ui-settings')`, 15000, 100)
  }
  const go = async (id) => {
    const ok = await ev(`(() => { const b = document.querySelector('[data-testid="${id}"]'); if (!b) return false; b.click(); return true })()`)
    await sleep(900)
    await ev(`document.activeElement?.blur?.()`)
    await S.unhover()
    return ok
  }
  const scrollTo = (top) => ev(`(() => { const c = document.querySelector('.ui-settings__content'); if (!c) return null; c.scrollTop = ${top}; return [c.scrollTop, c.scrollHeight, c.clientHeight] })()`)
  const pagesOf = async (name) => {
    const first = await scrollTo(0)
    await sleep(350)
    await S.clip(name, modal, 0)
    if (!first) return 1
    const step = first[2] - 80
    let prev = 0
    let n = 1
    while (n < 8) {
      const now = await scrollTo(n * step)
      if (!now || now[0] <= prev + 1) break
      prev = now[0]
      await sleep(350)
      n += 1
      await S.clip(`${name}-p${n}`, modal, 0)
    }
    await scrollTo(0)
    return n
  }
  const expandAll = async () => ev(`(() => { let n = 0; for (const b of document.querySelectorAll('.ui-settings__content .settings-advanced > button[aria-expanded="false"], .ui-settings__content .settings-fold__toggle[aria-expanded="false"]')) { b.click(); n++ } return n })()`)
  const pageInfo = () => ev(`(() => { const c = document.querySelector('.ui-settings__content'); if (!c) return null; return { overflowX: c.scrollWidth - c.clientWidth, height: c.scrollHeight, client: c.clientHeight, text: c.innerText.replace(/\\s+/g, ' ').slice(0, 1200) } })()`)
  const contrast = () => S.textAudit ? S.textAudit('.ui-settings-modal') : null

  if (process.env.UI_POLISH_SETTINGS_SHELL === '1') {
    const wasOpen = await ev(`!!document.querySelector('[data-testid="rp-column-0"]')`)
    await ev(`(() => { const rp = window.__yanRightPanel.getState(); rp.open({ id: 'context', kind: 'context' }); rp.setOpen(true); return true })()`)
    await sleep(1200)
    await S.unhover()
    await S.shot('settings-00-shell-rightpanel-dark')
    await S.theme('light')
    await S.shot('settings-00-shell-rightpanel-light')
    await S.theme('dark')
    if (wasOpen === false) await ev(`(window.__yanRightPanel.getState().setOpen(false), true)`)
    await sleep(600)
  }
  check('设置：打开', await open())
  await sleep(800)
  await S.shot('settings-00-open-dark')
  for (const [name, id] of pages) {
    const index = SETTINGS_PAGES.findIndex(([page]) => page === name) + 1
    const tag = `settings-${String(index).padStart(2, '0')}-${name}`
    if (!check(`设置：切到 ${name}`, await go(id))) continue
    await sleep(name === 'models' || name.startsWith('caps') || name === 'code' ? 1500 : 400)
    const info = await pageInfo()
    const count = await pagesOf(`${tag}-dark`)
    const lowDark = await contrast()
    R.contrast[`${name}-dark`] = Array.isArray(lowDark) ? lowDark.filter((item) => item.ratio < 4.5).slice(0, 30) : null
    const expanded = await expandAll()
    if (expanded > 0) {
      await sleep(1500)
      await pagesOf(`${tag}-open-dark`)
    }
    await S.theme('light')
    await sleep(300)
    await pagesOf(`${tag}-light`)
    R.audit[name] = await S.audit('.ui-settings__content')
    const low = await contrast()
    R.contrast[name] = Array.isArray(low) ? low.filter((item) => item.ratio < 4.5).slice(0, 30) : null
    await S.theme('dark')
    R.pages[name] = { count, expanded, info }
  }
  if (!extra) return

  if (sets.has('root')) {
  await go('v3-settings-nav-appearance')
  report.hover.push(['settings-nav-hover', await S.hover('[data-testid="v3-settings-nav-security"]', 600)])
  await S.clip('settings-20-nav-hover-dark', modal, 0)
  await S.theme('light')
  report.hover.push(['settings-nav-hover-light', await S.hover('[data-testid="v3-settings-nav-security"]', 600)])
  await S.clip('settings-20-nav-hover-light', modal, 0)
  await S.theme('dark')
  await S.unhover()
  report.focus.push(['settings-nav-focus', await S.focusThenTab('[data-testid="settings-search"] input', { presses: 1 })])
  await S.key('ArrowDown')
  await S.key('ArrowDown')
  report.focus.push(['settings-nav-arrow', await ev(`document.activeElement?.getAttribute('data-testid') ?? null`)])
  await S.clip('settings-21-nav-focus-dark', modal, 0)
  await S.theme('light')
  await S.clip('settings-21-nav-focus-light', modal, 0)
  await S.theme('dark')
  await ev(`(() => { const c = document.querySelector('.ui-settings__content'); const f = c?.querySelector('button, [role="radio"], input, [role="switch"], [tabindex="0"]'); f?.focus(); return !!f })()`)
  await S.key('Tab')
  await S.key('Tab')
  report.focus.push(['settings-content-focus', await ev(`(document.activeElement?.getAttribute('data-testid') || document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName || '').slice(0, 60)`)])
  await S.clip('settings-22-content-focus-dark', modal, 0)
  await S.theme('light')
  await S.clip('settings-22-content-focus-light', modal, 0)
  await S.theme('dark')
  await ev(`document.activeElement?.blur?.()`)

  const search = async (text, name) => {
    await ev(`(() => { const i = document.querySelector('[data-testid="settings-search"] input'); i.focus(); return true })()`)
    await ev(`(() => { const i = document.querySelector('[data-testid="settings-search"] input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await S.typeText(text, 600)
    R[name] = await ev(`[...document.querySelectorAll('.ui-settings-search__result')].map((n) => n.getAttribute('data-kind') + ':' + n.innerText.replace(/\\s+/g, ' ').trim()).slice(0, 30)`)
    await S.clip(`${name}-dark`, modal, 0)
    await S.theme('light')
    await S.clip(`${name}-light`, modal, 0)
    await S.theme('dark')
  }
  await search('字体', 'settings-30-search-font')
  await search('模型', 'settings-31-search-many')
  await S.key('ArrowDown')
  await S.key('ArrowDown')
  await S.key('ArrowDown')
  await S.clip('settings-31-search-many-arrow-dark', modal, 0)
  await search('zzqx', 'settings-32-search-empty')
  await search('重试', 'settings-33-search-retry')
  await S.key('Enter', { waitMs: 2200 })
  R.revealFocus = await ev(`document.activeElement?.getAttribute('data-setting-id') ?? null`)
  await S.clip('settings-34-search-revealed-dark', modal, 0)
  await ev(`document.activeElement?.blur?.()`)
  }

  if (sets.has('b1')) {
  await go('v3-settings-nav-appearance')
  await ev(`window.__yanStore.getState().patchSettings({ fontUi: 'custom', fontUiCustom: '' })`)
  await sleep(700)
  await ev(`(() => { const i = document.querySelector('.settings-font-field input'); i?.focus(); return !!i })()`)
  await S.typeText('Bad;{Font}', 500)
  await ev(`document.querySelector('[data-setting-id="appearance-font-read"]')?.scrollIntoView({ block: 'center' })`)
  await sleep(300)
  await S.clip('settings-40-appearance-font-invalid-dark', modal, 0)
  await S.theme('light')
  await S.clip('settings-40-appearance-font-invalid-light', modal, 0)
  await S.theme('dark')
  await ev(`document.activeElement?.blur?.()`)
  await ev(`window.__yanStore.getState().patchSettings({ fontUi: 'sans', fontUiCustom: '' })`)
  await sleep(500)

  await go('v3-settings-nav-notifications')
  const sound = await ev(`JSON.stringify(window.__yanStore.getState().settings?.sound ?? null)`)
  await ev(`(() => { const s = window.__yanStore.getState(); return s.patchSettings({ sound: { ...(s.settings?.sound ?? {}), enabled: false } }).then(() => true) })()`)
  await sleep(700)
  await S.clip('settings-41-notifications-off-dark', modal, 0)
  await S.theme('light')
  await S.clip('settings-41-notifications-off-light', modal, 0)
  await S.theme('dark')
  await ev(`window.__yanStore.getState().patchSettings({ sound: ${sound} ?? undefined })`)
  await sleep(500)

  await go('v3-settings-nav-security')
  const roots = await ev(`JSON.stringify(window.__yanStore.getState().settings?.guardAllowRoots ?? [])`)
  const many = ['C:\\Users\\demo\\projects\\a-very-long-project-name-for-layout-checks\\packages\\renderer\\src\\features', 'D:\\work\\砚-示例项目\\资料', 'E:\\data', ...Array.from({ length: 6 }, (_, i) => `C:\\Users\\demo\\code\\repo-${i + 1}`)]
  const setRoots = (list) => ev(`(() => { const s = window.__yanStore.getState(); window.__yanStore.setState({ settings: { ...s.settings, guardAllowRoots: ${list} } }); return true })()`)
  await setRoots(JSON.stringify(many))
  await sleep(800)
  await ev(`document.querySelector('[data-setting-id="security-allow-roots"]')?.scrollIntoView({ block: 'center' })`)
  await sleep(300)
  await S.clip('settings-42-security-roots-dark', modal, 0)
  await S.theme('light')
  await setRoots(JSON.stringify(many))
  await sleep(800)
  await ev(`document.querySelector('[data-setting-id="security-allow-roots"]')?.scrollIntoView({ block: 'center' })`)
  await sleep(300)
  await S.clip('settings-42-security-roots-light', modal, 0)
  await S.theme('dark')
  await setRoots(JSON.stringify(many))
  await sleep(800)
  await ev(`document.querySelector('[data-setting-id="security-allow-roots"]')?.scrollIntoView({ block: 'center' })`)
  await sleep(300)
  report.hover.push(['settings-security-root-hover', await S.hover('.settings-root button', 600)])
  await S.clip('settings-42-security-roots-hover-dark', modal, 0)
  await S.unhover()
  await setRoots(roots)
  await sleep(500)

  await ev(`(() => { const s = window.__yanStore.getState(); window.__yanStore.setState({ settings: null }); window.__uiPolishSettings = s.settings; return true })()`)
  await sleep(300)
  await S.clip('settings-43-loading-dark', modal, 0)
  await ev(`(() => { window.__yanStore.setState({ settings: window.__uiPolishSettings }); return true })()`)
  await sleep(600)
  }

  if (sets.has('b2')) await settingsBatch2({ S, ev, sleep, until, check, report, newSession, go, into, both, keyCombo, scrollTo, modal, R })

  if (sets.has('e2')) await settingsReview2({ S, ev, sleep, report, go, into, scrollTo, modal, R })

  if (sets.has('b3')) await settingsBatch3({ S, ev, sleep, until, check, report, go, into, scrollTo, modal, R })

  if (sets.has('r3x')) await settingsBatch3Extra({ S, ev, sleep, go, into, scrollTo, modal, R })

  if (sets.has('r3w')) await settingsBatch3Wrap({ S, ev, sleep, go, into, scrollTo, modal, R })

  if (sets.has('relay')) await settingsRelayConnecting({ S, ev, sleep, go, into, modal, R })

  if (sets.has('probe')) await settingsLayoutProbe({ S, ev, sleep, go, R })

  if (sets.has('sr1')) {
    R.sr1 = {}
    for (const [width, label] of [[1781, 'wide'], [880, 'w880'], [700, 'w700']]) {
      if (label !== 'wide') await S.narrow(width, 960)
      for (const [page, nav, sid] of [['appearance', 'v3-settings-nav-appearance', 'appearance-stream-width'], ['notifications', 'v3-settings-nav-notifications', 'notifications-volume']]) {
        await go(nav)
        await sleep(600)
        await into(`[data-setting-id="${sid}"]`)
        R.sr1[`${page}-${label}`] = await ev(`(() => { const row = document.querySelector('[data-setting-id="${sid}"]'); const c = document.querySelector('.ui-settings__content'); if (!row || !c) return null; const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)] }; return { content: Math.round(c.clientWidth - parseFloat(getComputedStyle(c).paddingLeft) - parseFloat(getComputedStyle(c).paddingRight)), row: r(row), label: r(row.querySelector('.ui-setting-row__label')), slider: r(row.querySelector('.settings-range__slider')), value: r(row.querySelector('.settings-range__value')), reset: r(row.querySelector('.settings-range__reset')) } })()`)
        if (label === 'wide') continue
        await S.shot(`settings-70-${label}-${page}-slider-dark`)
        await S.theme('light')
        await S.shot(`settings-70-${label}-${page}-slider-light`)
        await S.theme('dark')
      }
      if (label !== 'wide') await S.wide()
    }
  }

  if (sets.has('narrow')) for (const [width, label] of [[880, 'w880'], [700, 'w700']]) {
    await S.narrow(width, 960)
    for (const [name, id] of SETTINGS_PAGES.filter(([page]) => narrowPages.includes(page))) {
      await go(id)
      await sleep(500)
      R.audit[`${name}-${label}`] = await S.audit('.ui-settings__content')
      await S.shot(`settings-5${label === 'w880' ? 0 : 1}-${label}-${name}-dark`)
      if (process.env.UI_POLISH_SETTINGS_NARROW_LIGHT === '1') {
        await S.theme('light')
        await S.shot(`settings-5${label === 'w880' ? 0 : 1}-${label}-${name}-light`)
        await S.theme('dark')
      }
    }
    await S.theme('light')
    await S.shot(`settings-5${label === 'w880' ? 0 : 1}-${label}-${SETTINGS_PAGES.filter(([page]) => narrowPages.includes(page)).at(-1)?.[0] ?? 'devices'}-light`)
    await S.theme('dark')
    await S.wide()
  }
  await ev(`(window.__yanStore.getState().closeSettings(), true)`)
  await sleep(500)
}

const TARGETS = { tree: treeTarget, library: libraryTarget, usage: usageTarget, overview: overviewTarget, shell: shellTarget, subagents: subagentsTarget, prs: prsTarget, device: deviceTarget, logs: logsTarget, tabgap: tabgapTarget, branches: branchesTarget, quota: quotaTarget, context: contextTarget, terminal: terminalTarget, changes: changesTarget, browserfinal: browserFinalTarget, browser: browserTarget, buttons: buttonsTarget, rail: railTarget, files: filesTarget, preview: previewTarget, settings: settingsTarget }

export default async function run(ctx) {
  const { cdp, until, sleep, log, check, report } = ctx
  const out = process.env.UI_POLISH_OUT || ctx.out || join(ctx.runDir, 'shots')
  const kit = shotKit(cdp, out)
  const ev = kit.ev
  report.focus = []
  report.hover = []
  report.audit = {}
  const friction = listFrictionShots().find((item) => item.viewport && item.viewport.width >= 1600 && item.sessionId)
  const opened = friction ? await openFrictionSession(cdp, until, friction.sessionId) : null
  log('会话', opened ?? '（沿用启动时的会话）')
  report.layout = await measureUi(cdp)
  check('窗口最大化到 1600 以上宽', report.layout.viewport[0] >= 1600, report.layout)
  const wanted = String(process.env.UI_POLISH_TARGETS || 'browser').split(',').map((item) => item.trim()).filter(Boolean)
  const forcedWidths = Object.fromEntries(String(process.env.UI_POLISH_PANEL_WIDTH || '').split(',').map((item) => item.split(':')).filter((pair) => pair.length === 2).map(([key, value]) => [key.trim(), Number(value)]))
  report.forcedWidths = {}
  for (const name of wanted) {
    const target = TARGETS[name]
    if (!check(`目标 ${name} 存在`, !!target)) continue
    const original = forcedWidths[name] ? await ev('window.__yanRightPanel.getState().width') : null
    if (forcedWidths[name]) {
      await ev(`(window.__yanRightPanel.getState().setWidth(${forcedWidths[name]}), true)`)
      await sleep(900)
      report.forcedWidths[name] = { user: original, used: await ev('window.__yanRightPanel.getState().width') }
    }
    await target({ ...ctx, kit, ev })
    if (original) {
      await ev(`(window.__yanRightPanel.getState().setWidth(${original}), true)`)
      await sleep(600)
    }
  }
  await kit.theme('dark')
  writeFileSync(join(out, 'shots.json'), JSON.stringify({ files: kit.files.map((file) => file.slice(out.length + 1)), focus: report.focus, hover: report.hover, missed: kit.missed, gateJump: report.gateJump, narrowServers: report.narrowServers, proxyFailure: report.proxyFailure, contrast: report.contrast, importWaiting: report.importWaiting, stop: report.stop, collapsedServers: report.collapsedServers, horizontalHover: report.horizontalHover, buttons: report.buttons, rail: report.rail, files: report.files, preview: report.preview, browserFinal: report.browserFinal, changes: report.changes, terminal: report.terminal, context: report.context, quota: report.quota, branches: report.branches, tabgap: report.tabgap, logs: report.logs, device: report.device, prs: report.prs, subagents: report.subagents, shell: report.shell, overview: report.overview, library: report.library, usage: report.usage, tree: report.tree, settings: report.settings, forcedWidths: report.forcedWidths, fonts: report.fonts, audit: report.audit, layout: report.layout }, null, 2))
  check('截图数量', kit.files.length > 0, kit.files.length)
}
