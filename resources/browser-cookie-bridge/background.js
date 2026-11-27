if (typeof importScripts === 'function') importScripts('page.js')

const api = globalThis.browser ?? globalThis.chrome
const HOST_NAME = 'app.inkstone.browser_bridge'
const BRIDGE_REVISION = 4
const REF_ATTR = 'data-yan-ref'
const OBSERVE_LIMIT = 800
const LOAD_TIMEOUT_MS = 30000
const RETRY_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000]

api.action.onClicked.addListener(() => {
  void api.tabs.create({ url: api.runtime.getURL('import.html') })
})

const browserKind = () => {
  const ua = navigator.userAgent
  if (/Firefox\//.test(ua)) return 'firefox'
  if (/Edg\//.test(ua)) return 'edge'
  return 'chrome'
}

const browserVersion = () => {
  const ua = navigator.userAgent
  return (ua.match(/Firefox\/([\d.]+)/) ?? ua.match(/Edg\/([\d.]+)/) ?? ua.match(/Chrome\/([\d.]+)/) ?? [])[1] ?? ''
}

class BridgeError extends Error {
  constructor(code, message, extra) {
    super(message)
    this.code = code
    this.extra = extra
  }
}

const frameKeys = new Map()

function keyOf(index) {
  let n = index + 1
  let out = ''
  while (n > 0) {
    n -= 1
    out = String.fromCharCode(97 + (n % 26)) + out
    n = Math.floor(n / 26)
  }
  return out
}

function frameKey(tabId, frameId) {
  let keys = frameKeys.get(tabId)
  if (!keys) {
    keys = new Map([[0, 'a']])
    frameKeys.set(tabId, keys)
  }
  if (!keys.has(frameId)) keys.set(frameId, keyOf(keys.size))
  return keys.get(frameId)
}

function frameOfRef(tabId, ref) {
  const prefix = /^([a-z]+)\d+$/.exec(String(ref ?? ''))?.[1]
  if (!prefix) throw new BridgeError('STALE_ELEMENT', `元素引用 ${ref} 无效`)
  for (const [frameId, key] of frameKeys.get(tabId) ?? []) if (key === prefix) return frameId
  throw new BridgeError('STALE_ELEMENT', `元素引用 ${ref} 所在的框架已不存在`)
}

async function inject(tabId, frameIds, func, args = []) {
  const results = await api.scripting.executeScript({ target: { tabId, frameIds }, func, args })
  return results ?? []
}

async function injectOne(tabId, frameId, func, args = []) {
  const [result] = await inject(tabId, [frameId], func, args)
  return result?.result
}

async function frames(tabId) {
  return (await api.webNavigation.getAllFrames({ tabId })) ?? [{ frameId: 0, parentFrameId: -1, url: '' }]
}

async function frameOffsets(tabId, list) {
  const offsets = new Map([[0, { x: 0, y: 0 }]])
  const byParent = new Map()
  for (const frame of list) {
    if (frame.frameId === 0) continue
    if (!byParent.has(frame.parentFrameId)) byParent.set(frame.parentFrameId, [])
    byParent.get(frame.parentFrameId).push(frame)
  }
  const resolve = async (parentId) => {
    const children = byParent.get(parentId)
    if (!children?.length || !offsets.has(parentId)) return
    let slots = []
    try { slots = (await injectOne(tabId, parentId, yanFrameOffsets)) ?? [] } catch {}
    const used = new Set()
    const base = offsets.get(parentId)
    for (const child of children) {
      const url = String(child.url ?? '').split('#')[0]
      const index = slots.findIndex((slot, i) => !used.has(i) && slot.src && url.startsWith(slot.src.split('#')[0]))
      if (index < 0) continue
      used.add(index)
      offsets.set(child.frameId, { x: base.x + slots[index].x, y: base.y + slots[index].y })
      await resolve(child.frameId)
    }
  }
  await resolve(0)
  return offsets
}

async function observe(tabId, limit = OBSERVE_LIMIT) {
  const list = await frames(tabId)
  const offsets = list.length > 1 ? await frameOffsets(tabId, list) : new Map([[0, { x: 0, y: 0 }]])
  const page = { url: '', title: '', text: '', elements: [], viewport: undefined, frameCount: list.length, observedFrameCount: 0 }
  for (const frame of list) {
    const offset = offsets.get(frame.frameId)
    if (!offset) continue
    let result
    try { result = await injectOne(tabId, frame.frameId, yanObserve, [REF_ATTR, frameKey(tabId, frame.frameId), Math.max(1, limit - page.elements.length)]) } catch { continue }
    if (!result) continue
    page.observedFrameCount += 1
    if (frame.frameId === 0) {
      page.url = result.url
      page.title = result.title
      page.text = result.text
      page.viewport = result.viewport
    }
    for (const element of result.elements) {
      const box = [element.box[0] + offset.x, element.box[1] + offset.y, element.box[2], element.box[3]]
      page.elements.push({ ...element, box, ...(frame.frameId !== 0 ? { frameId: String(frame.frameId), frameUrl: result.url } : {}) })
    }
    if (page.elements.length >= limit) break
  }
  return page
}

async function point(tabId, ref) {
  const frameId = frameOfRef(tabId, ref)
  const local = await injectOne(tabId, frameId, yanPoint, [REF_ATTR, ref])
  if (!local || local.error) throw new BridgeError('STALE_ELEMENT', `元素 ${ref} 已不在页面上`)
  if (frameId === 0) return local
  const offsets = await frameOffsets(tabId, await frames(tabId))
  const offset = offsets.get(frameId)
  if (!offset) throw new BridgeError('FRAME_OFFSET', `无法定位元素 ${ref} 所在框架的位置`)
  return { ...local, x: local.x + offset.x, y: local.y + offset.y }
}

async function onRef(tabId, ref, func, args) {
  const result = await injectOne(tabId, frameOfRef(tabId, ref), func, [REF_ATTR, ref, ...args])
  if (result?.error === 'stale' || result == null) throw new BridgeError('STALE_ELEMENT', `元素 ${ref} 已不在页面上`)
  return result
}

async function press(tabId, key) {
  const results = await inject(tabId, (await frames(tabId)).map((frame) => frame.frameId), yanPress, [key, false])
  if (results.some((item) => item?.result?.ok)) return { ok: true }
  return injectOne(tabId, 0, yanPress, [key, true])
}

function tabInfo(tab) {
  return { tabId: tab.id, windowId: tab.windowId, url: tab.url ?? tab.pendingUrl ?? '', title: tab.title ?? '', status: tab.status ?? '', active: !!tab.active, incognito: !!tab.incognito }
}

async function waitLoad(tabId, timeoutMs = LOAD_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  await new Promise((resolve) => setTimeout(resolve, 150))
  while (Date.now() < deadline) {
    const tab = await api.tabs.get(tabId)
    if (tab.status === 'complete') return tabInfo(tab)
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return tabInfo(await api.tabs.get(tabId))
}

const groups = new Map()

async function groupTab(tab) {
  if (typeof api.tabs.group !== 'function' || !api.tabGroups) return
  try {
    const known = groups.get(tab.windowId)
    if (known !== undefined) {
      try {
        await api.tabs.group({ groupId: known, tabIds: [tab.id] })
        return
      } catch {
        groups.delete(tab.windowId)
      }
    }
    const groupId = await api.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } })
    groups.set(tab.windowId, groupId)
    await api.tabGroups.update(groupId, { title: '砚', color: 'blue' })
  } catch {}
}

async function hasDebugger() {
  if (!api.debugger) return false
  try { return await api.permissions.contains({ permissions: ['debugger'] }) } catch { return false }
}

const attached = new Set()

async function cdp(tabId, method, params) {
  if (!(await hasDebugger())) throw new BridgeError('DEBUGGER_UNAVAILABLE', '扩展没有调试权限')
  if (!attached.has(tabId)) {
    try {
      await api.debugger.attach({ tabId }, '1.3')
    } catch (error) {
      if (!/already attached/i.test(String(error?.message ?? error))) throw error
    }
    attached.add(tabId)
  }
  return (await api.debugger.sendCommand({ tabId }, method, params ?? {})) ?? {}
}

api.debugger?.onDetach.addListener((source) => attached.delete(source.tabId))

async function screenshot(tabId) {
  if (attached.has(tabId) || (await hasDebugger())) {
    try {
      const shot = await cdp(tabId, 'Page.captureScreenshot', { format: 'png' })
      if (shot?.data) return { data: shot.data }
    } catch {}
  }
  const tab = await api.tabs.get(tabId)
  if (!tab.active) {
    await api.tabs.update(tabId, { active: true })
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const url = await api.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
  return { data: url.slice(url.indexOf(',') + 1) }
}

let fallbackInstanceId = ''
let instanceIdPromise = null

function getInstanceId() {
  if (!instanceIdPromise) {
    instanceIdPromise = (async () => {
      const storage = api.storage?.session
      if (storage) {
        try {
          const saved = await storage.get('yanBridgeInstanceId')
          if (typeof saved?.yanBridgeInstanceId === 'string' && saved.yanBridgeInstanceId) return saved.yanBridgeInstanceId
          const created = crypto.randomUUID()
          await storage.set({ yanBridgeInstanceId: created })
          return created
        } catch {}
      }
      if (!fallbackInstanceId) fallbackInstanceId = crypto.randomUUID()
      return fallbackInstanceId
    })()
  }
  return instanceIdPromise
}

async function hello() {
  const manifest = api.runtime.getManifest()
  return { extensionId: api.runtime.id, instanceId: await getInstanceId(), version: manifest.version, revision: BRIDGE_REVISION, browser: browserKind(), browserVersion: browserVersion(), debugger: await hasDebugger() }
}

async function handle(cmd, args) {
  const tabId = Number(args.tabId)
  switch (cmd) {
    case 'hello': return hello()
    case 'runtime.reload': {
      setTimeout(() => api.runtime.reload(), 200)
      return true
    }
    case 'tab.create': {
      const tab = await api.tabs.create({ url: args.url || 'about:blank', active: args.active !== false })
      await groupTab(tab)
      return args.url ? waitLoad(tab.id) : tabInfo(tab)
    }
    case 'tab.info': {
      try { return tabInfo(await api.tabs.get(tabId)) } catch { return null }
    }
    case 'tab.current': {
      const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true })
      return tab ? tabInfo(tab) : null
    }
    case 'tab.navigate': {
      await api.tabs.update(tabId, { url: args.url })
      return waitLoad(tabId)
    }
    case 'tab.back': {
      await api.tabs.goBack(tabId)
      return waitLoad(tabId)
    }
    case 'tab.forward': {
      await api.tabs.goForward(tabId)
      return waitLoad(tabId)
    }
    case 'tab.reload': {
      await api.tabs.reload(tabId)
      return waitLoad(tabId)
    }
    case 'tab.wait': return waitLoad(tabId, Number(args.timeoutMs) || LOAD_TIMEOUT_MS)
    case 'tab.activate': {
      const tab = await api.tabs.update(tabId, { active: true })
      return tabInfo(tab)
    }
    case 'tab.close': {
      await api.tabs.remove(tabId)
      return true
    }
    case 'page.observe': return observe(tabId, Number(args.limit) || OBSERVE_LIMIT)
    case 'page.scope': {
      const refs = await injectOne(tabId, frameOfRef(tabId, args.ref), yanScope, [REF_ATTR, args.ref])
      if (!refs) throw new BridgeError('STALE_ELEMENT', `元素 ${args.ref} 已不在页面上`)
      return refs
    }
    case 'page.point': return point(tabId, args.ref)
    case 'page.click': return onRef(tabId, args.ref, yanClick, [])
    case 'page.focus': return onRef(tabId, args.ref, yanFocus, [])
    case 'page.type': return onRef(tabId, args.ref, yanType, [String(args.text ?? '')])
    case 'page.select': return onRef(tabId, args.ref, yanSelect, [String(args.value ?? '')])
    case 'page.readValue': return injectOne(tabId, frameOfRef(tabId, args.ref), yanReadValue, [REF_ATTR, args.ref])
    case 'page.press': return press(tabId, String(args.key ?? ''))
    case 'page.scroll': return injectOne(tabId, 0, yanScroll, [Number(args.dx) || 0, Number(args.dy) || 0])
    case 'page.text': return injectOne(tabId, 0, yanText)
    case 'page.visibility': return injectOne(tabId, 0, yanVisibility)
    case 'page.cursor': return injectOne(tabId, 0, yanCursor, [String(args.label ?? ''), args.point ?? null, args.tap !== false, String(args.style ?? ''), String(args.markup ?? ''), Array.isArray(args.kinds) ? args.kinds.map(String) : []])
    case 'page.screenshot': return screenshot(tabId)
    case 'cdp': return cdp(tabId, String(args.method), args.params)
    case 'cdp.detach': {
      if (attached.has(tabId)) {
        attached.delete(tabId)
        try { await api.debugger.detach({ tabId }) } catch {}
      }
      return true
    }
    default: throw new BridgeError('UNKNOWN_COMMAND', `未知命令 ${cmd}`)
  }
}

let port = null
let connected = false
let attempt = 0
let retryTimer = null
let lastError = ''

function post(message) {
  try { port?.postMessage(message) } catch {}
}

function scheduleRetry() {
  clearTimeout(retryTimer)
  retryTimer = setTimeout(connect, RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)])
  attempt += 1
}

function connect() {
  if (port) return
  clearTimeout(retryTimer)
  let current
  try {
    current = api.runtime.connectNative(HOST_NAME)
  } catch (error) {
    lastError = String(error?.message ?? error)
    scheduleRetry()
    return
  }
  port = current
  current.onMessage.addListener(async (message) => {
    if (message?.event === 'ready') {
      connected = true
      attempt = 0
      post({ event: 'hello', ...(await hello()) })
      return
    }
    const { id, cmd, args } = message ?? {}
    if (id === undefined) return
    try {
      post({ id, ok: true, result: await handle(String(cmd), args ?? {}) })
    } catch (error) {
      post({ id, ok: false, code: error?.code ?? 'EXTENSION_ERROR', error: String(error?.message ?? error), ...(error?.extra ? { extra: error.extra } : {}) })
    }
  })
  current.onDisconnect.addListener(() => {
    lastError = String(api.runtime.lastError?.message ?? current.error?.message ?? '')
    if (port === current) port = null
    connected = false
    scheduleRetry()
  })
}

api.tabs.onRemoved.addListener((tabId) => {
  frameKeys.delete(tabId)
  attached.delete(tabId)
  if (connected) post({ event: 'tabRemoved', tabId })
})

api.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) frameKeys.delete(details.tabId)
})

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'yan-bridge-status') return false
  if (message.reconnect && !port) {
    attempt = 0
    connect()
  }
  void hasDebugger().then((debuggerGranted) => sendResponse({ connected, lastError, browser: browserKind(), debugger: debuggerGranted, debuggerSupported: !!api.debugger || browserKind() !== 'firefox' }))
  return true
})

const notifyPermissions = async () => {
  if (!connected) return
  const info = await hello()
  if (connected) post({ event: 'hello', ...info })
}
api.permissions?.onAdded?.addListener(notifyPermissions)
api.permissions?.onRemoved?.addListener(notifyPermissions)

api.alarms?.create('yan-bridge', { periodInMinutes: 0.5 })
api.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === 'yan-bridge' && !port) connect()
})
api.runtime.onStartup?.addListener(connect)
void getInstanceId()
connect()
