import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sleep } from './env.mjs'

const KEY_CODES = { Tab: 9, Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Space: 32, Home: 36, End: 35 }

async function captureTarget(port, match, timeoutMs = 6000) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const target = list.find((entry) => entry.type === 'page' && match(entry))
  if (!target) return null
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  try {
    await new Promise((done, fail) => { ws.onopen = done; ws.onerror = fail })
    const result = await new Promise((done) => {
      const timer = setTimeout(() => done(null), timeoutMs)
      ws.onmessage = (message) => {
        const data = JSON.parse(message.data)
        if (data.id === 1) { clearTimeout(timer); done(data.result?.data ?? null) }
      }
      ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }))
    })
    return result
  } catch {
    return null
  } finally {
    try { ws.close() } catch {}
  }
}

export function shotKit(cdp, outDir) {
  mkdirSync(outDir, { recursive: true })
  const ev = (expr) => cdp.evaluate(expr)
  const files = []

  const nativeLayer = async () => {
    const info = await ev(`(() => {
      const st = window.__yanStore.getState()
      const el = document.querySelector('[data-testid="browser-pane-viewport"]')
      if (!el || !st.browserNativeVisible || !st.browserState?.open) return null
      if (document.querySelector('[data-testid="browser-start-page"]') || el.querySelector('.v3-browser__frozen')) return null
      const r = el.getBoundingClientRect()
      if (r.width < 4 || r.height < 4) return null
      return { url: st.browserState.url, x: r.left, y: r.top, w: r.width, h: r.height, dpr: devicePixelRatio }
    })()`).catch(() => null)
    if (!info?.url || !cdp.port) return null
    const base = info.url.replace(/[#?].*$/, '')
    const data = await captureTarget(cdp.port, (entry) => entry.id !== cdp.targetId && !entry.url.startsWith('file:') && (entry.url === info.url || entry.url.startsWith(base)))
    return data ? { ...info, data } : null
  }

  const shot = async (name, { native = true } = {}) => {
    const file = join(outDir, name.endsWith('.png') ? name : `${name}.png`)
    const base = (await cdp.call('Page.captureScreenshot', { format: 'png' })).result.data
    const layer = native ? await nativeLayer() : null
    if (!layer) {
      writeFileSync(file, Buffer.from(base, 'base64'))
    } else {
      const merged = await ev(`(async () => {
        const load = (src) => new Promise((done, fail) => { const img = new Image(); img.onload = () => done(img); img.onerror = fail; img.src = src })
        const [a, b] = await Promise.all([load('data:image/png;base64,${base}'), load('data:image/png;base64,${layer.data}')])
        const canvas = document.createElement('canvas')
        canvas.width = a.naturalWidth
        canvas.height = a.naturalHeight
        const ctx = canvas.getContext('2d')
        ctx.drawImage(a, 0, 0)
        const k = a.naturalWidth / innerWidth
        ctx.drawImage(b, Math.round(${layer.x} * k), Math.round(${layer.y} * k), Math.round(${layer.w} * k), Math.round(${layer.h} * k))
        return canvas.toDataURL('image/png').split(',')[1]
      })()`)
      writeFileSync(file, Buffer.from(merged, 'base64'))
    }
    files.push(file)
    return file
  }

  const clip = async (name, selector, pad = 8) => {
    const box = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); if (r.width <= 0) return null; const x = Math.max(0, r.left - ${pad}); const y = Math.max(0, r.top - ${pad}); return { x, y, width: Math.min(innerWidth, r.right + ${pad}) - x, height: Math.min(innerHeight, r.bottom + ${pad}) - y } })()`)
    if (!box) return null
    const full = (await cdp.call('Page.captureScreenshot', { format: 'png' })).result.data
    const cropped = await ev(`(async () => {
      const img = await new Promise((done, fail) => { const i = new Image(); i.onload = () => done(i); i.onerror = fail; i.src = 'data:image/png;base64,${full}' })
      const k = img.naturalWidth / innerWidth
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(${box.width} * k)
      canvas.height = Math.round(${box.height} * k)
      canvas.getContext('2d').drawImage(img, Math.round(${box.x} * k), Math.round(${box.y} * k), canvas.width, canvas.height, 0, 0, canvas.width, canvas.height)
      return canvas.toDataURL('image/png').split(',')[1]
    })()`)
    const file = join(outDir, `${name}.png`)
    writeFileSync(file, Buffer.from(cropped, 'base64'))
    files.push(file)
    return file
  }

  const rectOf = async (selector, index = 0) => ev(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((n) => n.getBoundingClientRect().width > 0)[${index}]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)

  const missed = []
  const hover = async (selector, waitMs = 500, index = 0) => {
    const r = await rectOf(selector, index)
    if (!r) { missed.push(selector); return false }
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y })
    await sleep(waitMs)
    return true
  }

  const unhover = async () => {
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 })
    await sleep(200)
  }

  const click = async (selector, waitMs = 500, index = 0) => {
    const r = await rectOf(selector, index)
    if (!r) { missed.push(selector); return false }
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 })
    await sleep(waitMs)
    return true
  }

  const key = async (name, { shift = false, waitMs = 250 } = {}) => {
    const base = { key: name === 'Space' ? ' ' : name, code: name, windowsVirtualKeyCode: KEY_CODES[name] ?? name.toUpperCase().charCodeAt(0), modifiers: shift ? 8 : 0 }
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    await sleep(waitMs)
  }

  const focusThenTab = async (selector, { shift = false, presses = 1 } = {}) => {
    const ok = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); return document.activeElement === el })()`)
    if (!ok) return null
    for (let i = 0; i < presses; i++) await key('Tab', { shift })
    await sleep(250)
    return ev(`(() => { const el = document.activeElement; if (!el || el === document.body) return null; return (el.getAttribute('data-testid') || el.getAttribute('aria-label') || el.tagName).slice(0, 60) })()`)
  }

  const theme = async (value) => {
    await ev(`window.__yanStore.getState().patchSettings({ theme: ${JSON.stringify(value)} })`)
    await sleep(900)
  }

  const narrow = async (width = 880, height = 960) => {
    const dpr = await ev('devicePixelRatio')
    await cdp.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false })
    await sleep(1200)
  }

  const wide = async () => {
    await cdp.call('Emulation.clearDeviceMetricsOverride', {})
    await sleep(1200)
  }

  const audit = async (selector) => ev(`(() => {
    const root = document.querySelector(${JSON.stringify(selector)})
    if (!root) return null
    const out = { overflowX: root.scrollWidth - root.clientWidth, clipped: [] }
    for (const el of root.querySelectorAll('*')) {
      const cs = getComputedStyle(el)
      if (el.scrollWidth > el.clientWidth + 1 && cs.overflowX === 'visible' && el.children.length === 0 && el.textContent.trim()) out.clipped.push((el.className || el.tagName).toString().slice(0, 60))
    }
    out.clipped = out.clipped.slice(0, 20)
    return out
  })()`)

  const textAudit = async (selector) => ev(`(() => {
    const root = document.querySelector(${JSON.stringify(selector)})
    if (!root) return null
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const g = canvas.getContext('2d', { willReadFrequently: true })
    const rgba = (css) => { g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = css; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255] }
    const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1)
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]) }
    const bgOf = (el) => { const layers = []; for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const c = rgba(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 0.99) break } let acc = [0, 0, 0, 1]; for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc); return acc }
    const out = []
    for (const el of root.querySelectorAll('*')) {
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('')
      if (!own) continue
      const bg = bgOf(el)
      const fg = over(rgba(getComputedStyle(el).color), bg)
      const a = lum(fg), b = lum(bg)
      out.push({ text: own.slice(0, 24), ratio: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100 })
    }
    return out
  })()`)

  const typeText = async (text, waitMs = 400) => {
    await cdp.call('Input.insertText', { text })
    await sleep(waitMs)
  }

  const scripts = new Map()
  let debuggerOn = false
  const enableDebugger = async () => {
    if (debuggerOn) return
    debuggerOn = true
    const start = cdp.events.length
    await cdp.call('Debugger.enable')
    await sleep(300)
    for (const event of cdp.events.slice(start)) if (event.method === 'Debugger.scriptParsed' && /\/assets\/.+\.js/.test(event.params.url)) scripts.set(event.params.scriptId, event.params.url)
    await cdp.call('Overlay.enable').catch(() => {})
    await cdp.call('Overlay.setPausedInDebuggerMessage', {}).catch(() => {})
  }
  const pauseAt = async (needle, trigger, { timeoutMs = 10000, lineOffset = 0 } = {}) => {
    await enableDebugger()
    let location = null
    for (const scriptId of scripts.keys()) {
      const source = (await cdp.call('Debugger.getScriptSource', { scriptId })).result?.scriptSource ?? ''
      const at = source.indexOf(needle)
      if (at < 0) continue
      const before = source.slice(0, at)
      const lines = before.split('\n')
      const lineNumber = lines.length - 1 + lineOffset
      const columnNumber = lineOffset ? (source.split('\n')[lineNumber].match(/^\s*/)?.[0].length ?? 0) : at - (before.lastIndexOf('\n') + 1)
      location = { scriptId, lineNumber, columnNumber }
      break
    }
    if (!location) return null
    const breakpointId = (await cdp.call('Debugger.setBreakpoint', { location })).result?.breakpointId
    const mark = cdp.events.length
    void trigger()
    const end = Date.now() + timeoutMs
    let paused = false
    while (!paused && Date.now() < end) {
      paused = cdp.events.slice(mark).some((event) => event.method === 'Debugger.paused')
      if (!paused) await sleep(20)
    }
    const resume = async () => {
      if (breakpointId) await cdp.call('Debugger.removeBreakpoint', { breakpointId })
      if (paused) await cdp.call('Debugger.resume')
      await sleep(300)
    }
    return { paused, resume }
  }
  const shotPaused = async (name) => {
    const file = join(outDir, `${name}.png`)
    const data = (await cdp.call('Page.captureScreenshot', { format: 'png' })).result?.data
    if (!data) return null
    writeFileSync(file, Buffer.from(data, 'base64'))
    files.push(file)
    return file
  }

  const setHookState = async (selector, pattern, index, value) => ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return 'no-element'
    const key = Object.keys(el).find((name) => name.startsWith('__reactFiber$'))
    const pattern = ${JSON.stringify(pattern)}
    for (let fiber = el[key]; fiber; fiber = fiber.return) {
      const hooks = []
      for (let hook = fiber.memoizedState; hook && typeof hook === 'object' && 'next' in hook; hook = hook.next) hooks.push(hook)
      for (let i = 0; i + pattern.length <= hooks.length; i++) {
        if (pattern.every((want, j) => hooks[i + j].queue && hooks[i + j].memoizedState === want)) {
          hooks[i + ${index}].queue.dispatch(${JSON.stringify(value)})
          return 'ok'
        }
      }
    }
    return 'no-hook'
  })()`)

  const cdpCall = (method, params) => cdp.call(method, params)

  return { missed, textAudit, shot, clip, hover, unhover, click, key, focusThenTab, theme, narrow, wide, audit, files, ev, typeText, pauseAt, shotPaused, setHookState, cdpCall }
}
