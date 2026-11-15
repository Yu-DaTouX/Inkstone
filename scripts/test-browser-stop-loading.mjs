import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import ts from 'typescript'
import { fillMissingExports } from './lib/stub-exports.mjs'

const require = createRequire(import.meta.url)
const dir = await mkdtemp(join(tmpdir(), 'inkstone-browser-stop-'))
let passed = 0
const failures = []
async function check(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`) }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack ?? error}`) }
}

try {
  const source = await readFile('src/main/browser.ts', 'utf8')
  const ast = ts.createSourceFile('browser.ts', source, ts.ScriptTarget.Latest, true)
  let stopMethod = null
  for (const node of ast.statements) {
    if (!ts.isClassDeclaration(node)) continue
    for (const member of node.members) {
      if (ts.isMethodDeclaration(member) && member.name.getText(ast) === 'stop') stopMethod = member.getText(ast)
    }
  }
  assert.ok(stopMethod, 'BrowserController 有 stop 方法')
  const js = ts.transpileModule(`class Harness { ${stopMethod} }\nmodule.exports = Harness`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const harnessFile = join(dir, 'harness.cjs')
  await writeFile(harnessFile, js)
  const Harness = require(harnessFile)

  const make = ({ tab, external, mode } = {}) => {
    const h = new Harness()
    h.external = external ?? null
    h.activeMode = mode ?? 'internal'
    h.activeTab = () => tab ?? null
    return h
  }
  const tabWith = (destroyed = false) => {
    const calls = []
    return { calls, tab: { view: { webContents: { isDestroyed: () => destroyed, stop: () => calls.push('stop'), reload: () => calls.push('reload') } } } }
  }

  await check('内置标签：调用 webContents.stop，不刷新', async () => {
    const { calls, tab } = tabWith()
    const result = await make({ tab }).stop()
    assert.deepEqual(result, { ok: true })
    assert.deepEqual(calls, ['stop'])
  })
  await check('没有标签：没东西可停，不抛错', async () => {
    assert.deepEqual(await make().stop(), { ok: true })
  })
  await check('标签已销毁：不调用 stop', async () => {
    const { calls, tab } = tabWith(true)
    assert.deepEqual(await make({ tab }).stop(), { ok: true })
    assert.deepEqual(calls, [])
  })
  await check('外部 Chrome：发 Page.stopLoading', async () => {
    const sent = []
    const { calls, tab } = tabWith()
    const result = await make({ tab, mode: 'external', external: { cdp: { send: async (name, params) => { sent.push([name, params]) } } } }).stop()
    assert.deepEqual(result, { ok: true })
    assert.deepEqual(sent, [['Page.stopLoading', {}]])
    assert.deepEqual(calls, [], '外部模式不碰内置标签')
  })
  await check('外部 Chrome 失败：返回错误信息', async () => {
    const result = await make({ mode: 'external', external: { cdp: { send: async () => { throw new Error('cdp gone') } } } }).stop()
    assert.deepEqual(result, { ok: false, error: 'cdp gone' })
  })

  const ipcFile = join(dir, 'browser-ipc.cjs')
  await build({ entryPoints: ['src/main/ipc/browser-ipc.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: ipcFile, logLevel: 'silent' })
  const { registerBrowserIpc } = require(ipcFile)
  const handlers = new Map()
  const scopedCalls = []
  const controller = {
    userSession: (sessionId) => {
      scopedCalls.push(['session', sessionId])
      return { stop: async () => { scopedCalls.push(['stop', sessionId]); return { ok: true } } }
    }
  }
  registerBrowserIpc({ rawHandle: (channel, fn) => handlers.set(channel, fn) }, () => controller)
  await check('主进程注册 yan:browser:stop 并按会话转给 stop()', async () => {
    assert.ok(handlers.has('yan:browser:stop'))
    assert.deepEqual(await handlers.get('yan:browser:stop')({}, 'sid-1'), { ok: true })
    assert.deepEqual(scopedCalls, [['session', 'sid-1'], ['stop', 'sid-1']])
  })
  await check('浏览器未初始化时返回失败', async () => {
    const empty = new Map()
    registerBrowserIpc({ rawHandle: (channel, fn) => empty.set(channel, fn) }, () => null)
    const result = await empty.get('yan:browser:stop')({}, undefined)
    assert.equal(result.ok, false)
  })

  await check('契约与 preload 都有 stop', async () => {
    const ipc = await readFile('src/shared/ipc.ts', 'utf8')
    const preload = await readFile('src/preload/index.ts', 'utf8')
    const channels = await readFile('src/shared/ipc-channels.ts', 'utf8')
    assert.match(channels, /'yan:browser:stop': Contract<B\['browser'\]\['stop'\]>/)
    assert.match(ipc, /\n\s+stop\(sessionId\?: string\): Promise<\{ ok: boolean; error\?: string \}>/)
    assert.match(preload, /stop: \(sessionId\) => invoke\('yan:browser:stop', sessionId\)/)
  })

  const ui = `
import React from 'react'
export function IconButton(props) {
  globalThis.__buttons[props['data-testid']] = props
  return <button aria-label={props['aria-label']} data-testid={props['data-testid']}>{props.children}</button>
}
export function Button(props) { return <button data-testid={props['data-testid']}>{props.children}</button> }
export function EmptyState(props) { return <div>{props.title}{props.action}</div> }
export function Notice(props) { return <div>{props.children}</div> }
export function PanelTabList(props) { return <div>{props.children}</div> }
export function PanelTab(props) { return <div>{props.label}</div> }
export function CloseButton() { return <button /> }
export function InputGroup(props) { return <div>{props.children}</div> }
export function InputGroupAddon(props) { return <div>{props.children}</div> }
export function InputGroupInput(props) { return <input data-testid={props['data-testid']} /> }
export function MiddleTruncate(props) { return <span>{props.value}</span> }
export function Spinner() { return <span data-spinner="1" /> }
export function SiteIcon() { return <span /> }
export function RailRow(props) { return <li>{props.label}</li> }
export function TextField(props) { return <div>{props.children}</div> }
`
  const stubs = new Map(Object.entries({
    'src/renderer/src/ui/index.ts': ui,
    'src/renderer/src/state/store.ts': 'export const useStore = (selector) => selector(globalThis.__store)',
    'src/renderer/src/state/resource-owners.ts': 'export const resourceOwner = () => "session-a"; export const claimResource = () => "session-a"; export const releaseResource = () => {}',
    'src/renderer/src/i18n/index.tsx': 'export const useT = () => (key) => key; export const useI18n = () => ({ lang: "zh-CN" })',
    'src/renderer/src/features/browser/use-browser-surface.ts': 'export const useBrowserBoundsSync = () => true; export const useBrowserSurfaceActive = () => {}; export const useBrowserOverlayBlocker = () => {}'
  }).map(([path, contents]) => [resolve(process.cwd(), path), contents]))
  const paneFile = join(dir, 'pane.cjs')
  await build({
    stdin: { contents: "export { BrowserPane } from './src/renderer/src/features/browser/BrowserPane'; export { renderToStaticMarkup } from 'react-dom/server'; export { createElement } from 'react'", resolveDir: process.cwd(), loader: 'tsx' },
    outfile: paneFile, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent',
    plugins: [{
      name: 'stop-fixtures',
      setup(builder) {
        builder.onResolve({ filter: /^\./ }, (args) => {
          for (const extension of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
            const path = resolve(args.resolveDir, args.path + extension)
            if (stubs.has(path)) return { path, namespace: 'fixture' }
          }
        })
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ contents: fillMissingExports(args.path, stubs.get(args.path)), loader: 'tsx', resolveDir: process.cwd() }))
      }
    }]
  })
  const { BrowserPane, renderToStaticMarkup, createElement } = require(paneFile)
  const calls = []
  globalThis.window = { yan: { browser: { stop: async () => { calls.push('stop'); return { ok: true } }, reload: async () => { calls.push('reload'); return { ok: true } } } } }
  const render = (loading) => {
    globalThis.__buttons = {}
    globalThis.__store = { browserState: { open: true, url: 'https://example.com/', loading, activeTabId: 'a', tabs: [{ id: 'a', title: 'A', url: 'https://example.com/' }] }, openBrowser: () => {} }
    return renderToStaticMarkup(createElement(BrowserPane, { owner: { key: 'session-a', active: true } }))
  }
  await check('加载中：刷新按钮换成「停止」，点了调用 stop', async () => {
    const html = render(true)
    assert.match(html, /data-testid="browser-pane-stop"/)
    assert.doesNotMatch(html, /data-testid="browser-pane-reload"/)
    const button = globalThis.__buttons['browser-pane-stop']
    assert.equal(button['aria-label'], 'browser.stop')
    assert.equal(button.tooltip, 'browser.stop')
    button.onPress()
    assert.deepEqual(calls, ['stop'])
  })
  await check('加载完：恢复「刷新」，点了调用 reload', async () => {
    calls.length = 0
    const html = render(false)
    assert.match(html, /data-testid="browser-pane-reload"/)
    assert.doesNotMatch(html, /data-testid="browser-pane-stop"/)
    globalThis.__buttons['browser-pane-reload'].onPress()
    assert.deepEqual(calls, ['reload'])
  })
  await check('中英文案都有 browser.stop', async () => {
    const zh = JSON.parse(await readFile('src/renderer/src/i18n/zh-CN.json', 'utf8'))
    const en = JSON.parse(await readFile('src/renderer/src/i18n/en-US.json', 'utf8'))
    assert.equal(zh['browser.stop'], '停止')
    assert.equal(en['browser.stop'], 'Stop')
  })
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
