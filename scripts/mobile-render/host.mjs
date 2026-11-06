import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { parseHTML } from 'linkedom'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const rootRequire = createRequire(join(root, 'package.json'))

export const env = (globalThis.__rnEnv ??= {
  window: { width: 390, height: 844 },
  scheme: 'light',
  alerts: [],
  opened: [],
  shared: [],
  keyboardVisible: false,
  listeners: new Map(),
  nativeModules: {},
  platform: 'android'
})

const marks = new Map()
env.nativeModules.InkstoneMobileDevice ??= {
  info: async () => ({ name: '测试手机', model: 'fake' }),
  readMarks: async (scope) => marks.get(scope) ?? '{}',
  writeMarks: async (scope, json) => { marks.set(scope, json) },
  pickImages: async () => null
}

const dom = parseHTML('<!doctype html><html><head></head><body><div id="root"></div></body></html>')
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  SVGElement: dom.SVGElement ?? dom.Element,
  IS_REACT_ACT_ENVIRONMENT: true
})
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true })
dom.window.navigator ??= globalThis.navigator
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.__DEV__ = true

class FakeXhr {
  static HEADERS_RECEIVED = 2
  static LOADING = 3
  static DONE = 4
  readyState = 0
  status = 0
  responseText = ''
  headers = {}
  open(method, url) { this.method = method; this.url = url }
  setRequestHeader(key, value) { this.headers[key] = value }
  send() {
    this.req = http.request(this.url, { method: this.method, headers: this.headers }, (res) => {
      this.status = res.statusCode
      this.readyState = 2
      this.onreadystatechange?.()
      res.setEncoding('utf8')
      res.on('data', (chunk) => { this.responseText += chunk; this.readyState = 3; this.onreadystatechange?.() })
      res.on('end', () => { this.readyState = 4; this.onreadystatechange?.() })
      res.on('error', () => { this.readyState = 4; this.onreadystatechange?.() })
    })
    this.req.on('error', () => this.onerror?.())
    this.req.end()
  }
  abort() { this.aborted = true; this.req?.destroy() }
}
globalThis.XMLHttpRequest = FakeXhr

const reactDir = join(root, 'node_modules')
const plugin = {
  name: 'mobile-render-aliases',
  setup(b) {
    const stub = (name) => join(here, name)
    b.onResolve({ filter: /^react-native$/ }, () => ({ path: stub('rn.jsx') }))
    b.onResolve({ filter: /^react-native-safe-area-context$/ }, () => ({ path: stub('misc.jsx') }))
    b.onResolve({ filter: /^react-native-svg$/ }, () => ({ path: stub('misc.jsx') }))
    b.onResolve({ filter: /^react-native-keychain$/ }, () => ({ path: stub('misc.jsx') }))
    b.onResolve({ filter: /^react-native-webview$/ }, () => ({ path: stub('misc.jsx') }))
    b.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, (args) => ({ path: rootRequire.resolve(args.path) }))
  }
}

let cached
export async function loadApp() {
  if (cached) return cached
  const result = await build({
    stdin: {
      contents: `
        export { default as App } from './src/App'
        export { RemoteProvider } from './src/state'
        export { DetailPane } from './src/components/DetailPane'
        export { ModelPicker } from './src/components/ModelPicker'
        export { BranchSheet } from './src/components/BranchSheet'
        export { RenameSheet } from './src/components/RenameSheet'
        export { RemoteClient, pair } from './src/api/client'
        export { setUiLang } from '../src/shared/ui-lang'
        export { createRoot } from 'react-dom/client'
        export { act, createElement } from 'react'
      `,
      resolveDir: join(root, 'mobile'),
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'silent',
    jsx: 'automatic',
    loader: { '.js': 'jsx', '.png': 'dataurl', '.webp': 'dataurl', '.jpg': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"development"', __DEV__: 'true' },
    plugins: [plugin],
    nodePaths: [join(root, 'mobile', 'node_modules')]
  })
  const file = join(root, 'out', 'test', 'mobile-render-bundle.mjs')
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, result.outputFiles[0].text)
  cached = await import(pathToFileURL(file).href)
  return cached
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function createHarness(lib) {
  const { act, createRoot, createElement } = lib
  let root
  let host
  const mount = async (element) => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => { root.render(element) })
  }
  const unmount = async () => {
    if (root) await act(async () => { root.unmount() })
    host?.remove()
    root = undefined
  }
  const settle = async (ms = 30) => { await act(async () => { await sleep(ms) }) }
  const waitFor = async (predicate, what, timeout = 4000) => {
    const end = Date.now() + timeout
    for (;;) {
      await settle(20)
      let value
      try { value = predicate() } catch { value = false }
      if (value) return value
      if (Date.now() > end) throw new Error(`等待超时：${what}`)
    }
  }
  const all = (selector) => [...document.querySelectorAll(selector)].filter((n) => !n.closest('[data-hidden]'))
  const byLabel = (label) => all('[aria-label]').filter((n) => n.getAttribute('aria-label') === label)
  const matchLabel = (re) => all('[aria-label]').filter((n) => re.test(n.getAttribute('aria-label')))
  const text = () => (host ? [...host.querySelectorAll('[data-rn="Text"]')].filter((n) => !n.closest('[data-hidden]') && !n.parentElement?.closest('[data-rn="Text"]')).map((n) => n.textContent).join('\n') : '')
  const has = (needle) => text().includes(needle)
  const press = async (node) => {
    if (!node) throw new Error('找不到可点按的元素')
    const props = node.__props
    if (!props?.onPress) throw new Error(`元素没有 onPress：${node.getAttribute('aria-label')}`)
    if (props.disabled) return false
    await act(async () => { await props.onPress() })
    await settle(10)
    return true
  }
  const pressLabel = async (label) => {
    const nodes = typeof label === 'string' ? byLabel(label) : matchLabel(label)
    if (!nodes.length) throw new Error(`找不到标签：${label}`)
    return press(nodes[0])
  }
  const pressables = () => all('[data-rn="Pressable"]')
  const byText = (needle) => {
    const hits = pressables().filter((n) => n.textContent.includes(needle))
    return hits.filter((n) => !hits.some((other) => other !== n && n.contains(other)))
  }
  const pressText = async (needle) => {
    const hits = byText(needle)
    if (!hits.length) throw new Error(`找不到含文字的可点元素：${needle}`)
    return press(hits[0])
  }
  const longPress = async (node) => { await act(async () => { await node.__props.onLongPress() }); await settle(10) }
  const typeInto = async (node, value) => { await act(async () => { node.__props.onChangeText(value) }); await settle(10) }
  const inputs = () => all('[data-rn="TextInput"]')
  const alertButton = async (label) => {
    const last = env.alerts.at(-1)
    const button = last?.buttons.find((b) => b.text === label)
    if (!button) throw new Error(`弹窗没有按钮 ${label}`)
    await act(async () => { await button.onPress?.() })
    await settle(30)
  }
  return { mount, unmount, settle, waitFor, all, byLabel, matchLabel, text, has, press, pressLabel, pressables, byText, pressText, longPress, typeInto, inputs, alertButton, act, createElement, get host() { return host } }
}

export const marksSet = (scope, json) => { marks.set(scope, json) }
