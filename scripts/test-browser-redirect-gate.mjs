import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ELECTRON_STUB = `
export const app = {
  getPath: () => process.env.YAN_DATA_DIR || (process.env.TEMP || '/tmp') + '/inkstone-browser-stub',
  getLocale: () => 'zh-CN',
  isPackaged: false,
  on() {},
  whenReady: async () => {}
}
export const shell = { openExternal: async () => {}, showItemInFolder() {} }
export class BrowserWindow {
  static getAllWindows() { return globalThis.__browserWindows ?? [] }
}
export class Menu {}
export class View {}
export class MenuItem {}
export class WebContentsView {
  constructor() {
    this.webContents = globalThis.__fakeWebContents()
    this.children = []
  }
  setBackgroundColor() {}
  setVisible() {}
  setBounds() {}
  getBounds() { return { x: 0, y: 0, width: 0, height: 0 } }
  setBorderRadius() {}
}
`

const buildDir = join('.tmp', 'full-audit-1022', 'S4')
await mkdir(buildDir, { recursive: true })
const dir = await mkdtemp(join(buildDir, 'browser-redirect-'))

const created = []
let nextId = 0
function fakeContents() {
  const handlers = new Map()
  const contents = {
    id: (nextId += 1),
    url: 'about:blank',
    requests: [],
    prevented: false,
    debugger: { on() {}, isAttached: () => false, attach() {}, detach() {}, sendCommand: async () => ({}) },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
    },
    emit(event, ...args) {
      for (const handler of handlers.get(event) ?? []) handler({ preventDefault: () => (contents.prevented = true) }, ...args)
    },
    setZoomMode() {},
    setZoomFactor() {},
    setWindowOpenHandler() {},
    insertCSS: async () => {},
    session: {
      on() {},
      setPermissionRequestHandler() {},
      setPermissionCheckHandler() {},
      webRequest: { onBeforeRequest() {} }
    },
    async loadURL(url) {
      contents.requests.push(url)
      for (const target of globalThis.__redirects.get(url) ?? []) contents.emit('will-redirect', target)
      if (contents.prevented) return
      const landing = (globalThis.__redirects.get(url) ?? []).at(-1) ?? url
      contents.url = landing
      contents.emit('did-navigate', landing)
      contents.emit('did-stop-loading')
    },
    getURL: () => contents.url,
    canGoBack: () => false,
    canGoForward: () => false,
    isDestroyed: () => false
  }
  created.push(contents)
  return contents
}

globalThis.__fakeWebContents = fakeContents
globalThis.__redirects = new Map()

const window = {
  contentView: {
    children: [],
    addChildView(view) {
      this.children.push(view)
    },
    removeChildView(view) {
      this.children = this.children.filter((child) => child !== view)
    }
  },
  webContents: fakeContents(),
  isDestroyed: () => false,
  getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 })
}
globalThis.__browserWindows = [window]

try {
  const outfile = join(dir, 'browser.mjs')
  await build({
    stdin: {
      contents: "export { BrowserController } from './src/main/browser'",
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    plugins: [
      {
        name: 'electron-stub',
        setup(builder) {
          builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }))
          builder.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({ contents: ELECTRON_STUB, loader: 'js' }))
        }
      }
    ]
  })
  const { BrowserController } = await import(pathToFileURL(outfile).href)

  const gateCalls = []
  const gate = {
    ready: async () => {},
    peek: (_tabId, url) => {
      gateCalls.push(['peek', url])
      return 'ask'
    },
    check: async (_tabId, url) => {
      gateCalls.push(['check', url])
      return 'allow'
    },
    sites: () => [],
    addSite: () => ({ result: 'ok', list: [] }),
    removeSite: () => ({ removed: false, list: [] }),
    clearSites: () => [],
    forgetSession: () => {}
  }
  const pushes = []
  const controller = new BrowserController(() => window, (message) => pushes.push(message), () => gate)

  const start = 'https://github.com/milvus-io/milvus/releases/latest'
  const landing = 'https://github.com/milvus-io/milvus/releases/tag/v3.0.3'
  globalThis.__redirects.set(start, [landing])

  await controller.open(start)
  const page = created.at(-1)
  assert.equal(page.prevented, false, 'agent 发起的导航及其 302 不再被闸门拦下')
  assert.deepEqual(gateCalls, [], 'agent 发起导航时不询问站点闸门')
  assert.equal(controller.getState().url, landing, '打开后回执/状态是最终落地地址')
  assert.equal(controller.getState().title, '', '标题仍由页面事件更新')
  assert.ok(page.requests[0] === start, '只发起一次导航（没有审批后重发）', page.requests)

  page.prevented = false
  gateCalls.length = 0
  page.emit('will-navigate', 'https://example.com/clicked')
  assert.equal(page.prevented, false, '页面自己发起的普通跳转不再询问站点闸门')
  assert.deepEqual(gateCalls, [], '页面发起跳转也不触发站点闸门')

  page.emit('did-stop-loading')
  page.emit('will-redirect', 'https://example.com/redirected')
  assert.equal(page.prevented, false, '停载后的普通跳转同样放行')

  for (const url of ['file:///C:/Windows/win.ini', 'http://169.254.169.254/latest/meta-data/']) {
    page.prevented = false
    page.emit('will-navigate', url)
    assert.equal(page.prevented, true, `页面发起的不安全跳转仍被拦下：${url}`)
  }
  assert.deepEqual(gateCalls, [], '拦截不安全跳转不经过站点闸门')

  console.log('test-browser-redirect-gate: 全部通过')
} finally {
  await rm(dir, { recursive: true, force: true })
}
