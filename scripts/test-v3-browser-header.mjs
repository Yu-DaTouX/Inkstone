import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

const ui = `
import React from 'react'
export function IconButton(props) {
  globalThis.__browserButtons[props['data-testid']] = props
  return <button aria-label={props['aria-label']} data-testid={props['data-testid']} disabled={props.isDisabled}>{props.children}</button>
}
export function Button(props) { globalThis.__browserButtons[props['data-testid']] = props; return <button data-testid={props['data-testid']}>{props.children}</button> }
export function EmptyState(props) { return <div role="status">{props.title}{props.action}</div> }
export function Notice(props) { return <div>{props.children}{props.action}</div> }
export function Tabs(props) {
  globalThis.__browserTabs = props
  return <div className={props.className} data-ui="tabs">{props.children}</div>
}
export function TabList(props) { return <div role="tablist" aria-label={props['aria-label']}>{props.children}</div> }
export function Tab(props) {
  globalThis.__browserTabItems[props.id] = props
  return <div role="tab">{props.children}</div>
}
export function TextField(props) { return <div className={props.className}>{props.children}</div> }
export function Input(props) { return <input className={props.className} aria-label={props['aria-label']} data-testid={props['data-testid']} /> }
`
const stubs = new Map(Object.entries({
  'src/renderer/src/ui/index.ts': ui,
  'src/renderer/src/state/store.ts': 'export const useStore = (selector) => selector(globalThis.__browserStore)',
  'src/renderer/src/state/resource-owners.ts': `
export const resourceOwner = (resource) => globalThis.__browserOwners[resource];
export const claimResource = (resource, key) => { globalThis.__browserOwners[resource] = globalThis.__browserOwners[resource] ?? key; return globalThis.__browserOwners[resource]; };
export const releaseResource = (resource) => { delete globalThis.__browserOwners[resource]; };
`,
  'src/renderer/src/i18n/index.tsx': 'export const useT = () => (key) => key; export const useI18n = () => ({ lang: "zh-CN" })',
  'src/renderer/src/features/workbench/pane-chrome.tsx': `
export const usePaneChrome = () => globalThis.__browserChrome
export function PaneTitle({ children }) { globalThis.__browserTitle = children; return null }
`,
  'src/renderer/src/features/browser/use-browser-surface.ts': 'export const useBrowserBoundsSync = () => true; export const useBrowserSurfaceActive = () => {}; export const useBrowserOverlayBlocker = () => {}',
}).map(([path, contents]) => [resolve(path), contents]))

const dir = await mkdtemp(join(tmpdir(), 'inkstone-browser-header-'))
try {
  const outfile = join(dir, 'browser-header.cjs')
  await build({
    stdin: {
      contents: "export { BrowserPane } from './src/renderer/src/features/browser/BrowserPane'; export { renderToStaticMarkup } from 'react-dom/server'; export { createElement } from 'react'",
      resolveDir: process.cwd(),
      loader: 'tsx'
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    logLevel: 'silent',
    plugins: [{
      name: 'browser-header-fixtures',
      setup(builder) {
        builder.onResolve({ filter: /^\./ }, (args) => {
          for (const extension of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
            const path = resolve(args.resolveDir, args.path + extension)
            if (stubs.has(path)) return { path, namespace: 'fixture' }
          }
        })
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ contents: stubs.get(args.path), loader: 'tsx', resolveDir: process.cwd() }))
      }
    }]
  })
  const { BrowserPane, renderToStaticMarkup, createElement } = createRequire(import.meta.url)(outfile)
  const calls = []
  globalThis.window = { yan: { browser: {
    newTab: () => calls.push('new'),
    switchTab: (id) => calls.push(`switch:${id}`),
    closeTab: (id) => calls.push(`close:${id}`),
    startLoginImport: async () => { calls.push('import'); return { id: 'fixture' } }
  } } }
  globalThis.__browserStore = {
    browserState: {
      open: true,
      url: 'https://example.com/',
      activeTabId: 'tab-a',
      tabs: [{ id: 'tab-a', title: 'Example' }, { id: 'tab-b', title: 'Second' }]
    },
    openBrowser: () => {}
  }
  globalThis.__browserOwners = { browser: 'session-a' }
  const owner = { key: 'session-a', active: true }
  function render(chrome, props = {}) {
    globalThis.__browserChrome = chrome
    globalThis.__browserTitle = null
    globalThis.__browserButtons = {}
    globalThis.__browserTabItems = {}
    return renderToStaticMarkup(createElement(BrowserPane, { owner, ...props }))
  }

  const body = render({ title: {} })
  assert.ok(globalThis.__browserTitle, '工作区标签栏挂到现有标题槽')
  assert.doesNotMatch(body, /data-ui="tabs"/, '正文不再额外占一行标签栏')
  assert.match(body, /browser-pane-address/, '地址栏保留在第二行')
  assert.match(body, /browser-pane-back/, '保留后退')
  assert.match(body, /browser-pane-forward/, '保留前进')
  assert.match(body, /browser-pane-reload/, '保留刷新')
  assert.match(body, /browser-pane-open-external/, '保留外部打开')
  assert.doesNotMatch(body, /browser-pane-allowed-sites/, '浏览器面板不再有放行站点入口')

  const header = renderToStaticMarkup(globalThis.__browserTitle)
  assert.match(header, /v3-browser__tabsrow--chrome/)
  assert.match(header, /Example/)
  assert.match(header, /Second/)
  assert.match(header, /browser-pane-new-tab/)
  globalThis.__browserButtons['browser-pane-new-tab'].onPress()
  globalThis.__browserTabs.onSelectionChange('tab-b')
  globalThis.__browserTabItems['tab-a'].onClose()
  assert.deepEqual(calls, ['new', 'switch:tab-b', 'close:tab-a'], '合并顶栏后新增、切换、关闭标签照常工作')

  const standalone = render(null)
  assert.match(standalone, /data-ui="tabs"/, '无标题槽的容器保留内联标签栏')
  assert.doesNotMatch(standalone, /browser-pane-allowed-sites/, '无面板菜单时也没有放行站点入口')
  const mounting = render({ title: null })
  assert.match(mounting, /data-ui="tabs"/, '标题槽挂载前不丢失标签栏')
  const drivingOwner = { ...owner, sessionId: 'sid-a' }
  globalThis.__browserOwners = { browser: 'old-key' }
  globalThis.__browserStore.browserState = { ...globalThis.__browserStore.browserState, agentSessionId: 'sid-a' }
  const driving = render({ title: {} }, { owner: drivingOwner })
  assert.match(driving, /browser-pane-address/, 'agent 正在本条会话里用浏览器时，即使归属键过期也显示网页，不说「归另一条会话」')
  assert.doesNotMatch(driving, /browser-pane-foreign/, '不再误判成别的会话占用')

  globalThis.__browserStore.browserState = { ...globalThis.__browserStore.browserState, agentSessionId: 'sid-b' }
  const otherDriven = render({ title: {} }, { owner: drivingOwner })
  assert.match(otherDriven, /browser-pane-foreign/, '别的会话在驱动时不抢过来，仍提示归另一条会话')

  globalThis.__browserStore.browserState = { ...globalThis.__browserStore.browserState, agentSessionId: undefined }
  globalThis.__browserOwners = { browser: 'sid-a' }
  const adoptedBySessionId = render({ title: {} }, { owner: drivingOwner })
  assert.match(adoptedBySessionId, /browser-pane-address/, '归属键存成了会话 id 时也能对上本条会话')

  globalThis.__browserOwners = { browser: 'session-a' }
  globalThis.__browserStore.browserState = { open: false, url: '', title: '', tabs: [] }
  const gate = render({ title: {} })
  assert.match(gate, /browser-pane-import/, '未打开时提供一键导入入口')
  assert.equal((gate.match(/data-testid="browser-pane-import"/g) ?? []).length, 1, '只提供一个导入按钮')
  assert.doesNotMatch(gate, /radiogroup|import-profiles|配对码/, '没有档案选择或手填配对码')
  globalThis.__browserButtons['browser-pane-import'].onPress()
  await Promise.resolve()
  assert.equal(calls.filter(call => call === 'import').length, 1, '点击一次直接启动导入')
  globalThis.__browserStore.browserState = {
    open: true,
    url: 'https://example.com/',
    activeTabId: 'tab-a',
    tabs: [{ id: 'tab-a', title: 'Example' }, { id: 'tab-b', title: 'Second' }]
  }

  globalThis.__browserOwners = { browser: 'session-a' }
  const inactive = render({ title: {} }, { owner: { ...owner, active: false } })
  assert.match(inactive, /browser-pane-inactive/)
  assert.equal(globalThis.__browserTitle, null, '非活动会话不注册可操作标签栏')
  console.log('test-v3-browser-header: 全部通过')
} finally {
  await rm(dir, { recursive: true, force: true })
}
