function pageTextAudit(rootSelector) {
  const root = document.querySelector(rootSelector)
  if (!root) return { error: `找不到 ${rootSelector}` }
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const rgba = (css) => {
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = '#000'
    ctx.fillStyle = css
    ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2], d[3] / 255]
  }
  const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1)
  const pageBg = rgba(getComputedStyle(document.documentElement).backgroundColor || '#000')
  const baseBg = pageBg[3] > 0 ? pageBg : [0, 0, 0, 1]
  const bgOf = (el) => {
    const layers = []
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const c = rgba(getComputedStyle(n).backgroundColor)
      if (c[3] > 0) layers.push(c)
      if (c[3] >= 0.99) break
    }
    let acc = baseBg
    for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc)
    return acc
  }
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
  }
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  const label = (el) => {
    const t = el.closest('[data-testid]')?.getAttribute('data-testid') ?? ''
    const cls = (typeof el.className === 'string' ? el.className : '').split(/\s+/).filter(Boolean).slice(0, 3).join('.')
    return `${t ? `[${t}] ` : ''}${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}`
  }
  const sizes = {}
  const lowContrast = []
  const tiny = []
  const truncated = []
  let count = 0
  for (const el of root.querySelectorAll('*')) {
    if (!el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true })) continue
    const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim()
    if (!own) continue
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight) continue
    const cs = getComputedStyle(el)
    count++
    const fs = parseFloat(cs.fontSize)
    sizes[fs] = (sizes[fs] || 0) + 1
    let opacity = 1
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) opacity *= parseFloat(getComputedStyle(n).opacity)
    const fg = rgba(cs.color)
    const bg = bgOf(el)
    const shown = over([fg[0], fg[1], fg[2], fg[3] * opacity], bg)
    const cr = ratio(shown, bg)
    const disabled = !!el.closest('[disabled],[aria-disabled="true"],[data-disabled]')
    const item = { el: label(el), text: own.slice(0, 40), fs, fw: cs.fontWeight, contrast: Math.round(cr * 100) / 100, x: Math.round(r.left), y: Math.round(r.top) }
    const large = fs >= 18.66 || (fs >= 14 && Number(cs.fontWeight) >= 700)
    if (!disabled && cr < (large ? 3 : 4.5)) lowContrast.push(item)
    if (fs < 11) tiny.push(item)
    if (el.scrollWidth > el.clientWidth + 1 && (cs.textOverflow === 'ellipsis' || cs.overflow === 'hidden' || cs.overflowX === 'hidden')) truncated.push({ ...item, full: (el.textContent ?? '').trim().slice(0, 80) })
  }
  const cap = (list) => list.slice(0, 40)
  return { textNodes: count, fontSizes: sizes, lowContrast: cap(lowContrast), lowContrastCount: lowContrast.length, tinyFont: cap(tiny), truncated: cap(truncated), truncatedCount: truncated.length }
}

function pageControls(rootSelector) {
  const root = document.querySelector(rootSelector)
  if (!root) return { error: `找不到 ${rootSelector}` }
  const sel = 'button,a[href],input,select,textarea,[role="button"],[role="menuitem"],[role="tab"],[role="option"],[role="switch"],[role="checkbox"],[role="radio"],[role="link"],[tabindex]:not([tabindex="-1"])'
  const out = []
  for (const el of root.querySelectorAll(sel)) {
    if (!el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true })) continue
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) continue
    const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 40)
    out.push({
      testid: el.getAttribute('data-testid') ?? el.closest('[data-testid]')?.getAttribute('data-testid') ?? '',
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') ?? '',
      name,
      noName: !name,
      w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top),
      small: r.width < 20 || r.height < 20,
      disabled: el.matches(':disabled,[aria-disabled="true"]')
    })
  }
  return { total: out.length, noName: out.filter((c) => c.noName), small: out.filter((c) => c.small).slice(0, 40), list: out.slice(0, 150) }
}

function pageRect(selector) {
  const el = document.querySelector(selector)
  if (!el) return null
  el.scrollIntoView?.({ block: 'nearest' })
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }
}

export async function textAudit(cdp, rootSelector = 'body') {
  return cdp.evaluate(`(${pageTextAudit.toString()})(${JSON.stringify(rootSelector)})`)
}

export async function controls(cdp, rootSelector = 'body') {
  return cdp.evaluate(`(${pageControls.toString()})(${JSON.stringify(rootSelector)})`)
}

export async function rect(cdp, selector) {
  return cdp.evaluate(`(${pageRect.toString()})(${JSON.stringify(selector)})`)
}

export async function hover(cdp, selector, waitMs = 700) {
  const r = await rect(cdp, selector)
  if (!r) throw new Error(`找不到 ${selector}`)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y })
  await new Promise((done) => setTimeout(done, waitMs))
  return r
}

export async function hoverAt(cdp, x, y, waitMs = 700) {
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await new Promise((done) => setTimeout(done, waitMs))
}

export async function click(cdp, selector, { button = 'left', waitMs = 500 } = {}) {
  const r = await rect(cdp, selector)
  if (!r) throw new Error(`找不到 ${selector}`)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button, clickCount: 1 })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button, clickCount: 1 })
  await new Promise((done) => setTimeout(done, waitMs))
  return r
}

const KEYS = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Space: 32, Backspace: 8, Home: 36, End: 35 }

export async function press(cdp, key, { modifiers = 0, waitMs = 300 } = {}) {
  const code = KEYS[key]
  const text = key.length === 1 ? key : key === 'Enter' ? '\r' : undefined
  const base = { key: key === 'Space' ? ' ' : key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: code ?? key.toUpperCase().charCodeAt(0), modifiers }
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text && !modifiers ? { text } : {}) })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  await new Promise((done) => setTimeout(done, waitMs))
}

export const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 }

export async function typeText(cdp, text) {
  await cdp.call('Input.insertText', { text })
}

export async function openSession(cdp, title, until) {
  const file = await cdp.evaluate(`(() => { const s = window.__yanStore.getState(); const hit = (s.sessions ?? []).find((x) => (x.title ?? x.name ?? '').includes(${JSON.stringify(title)})); return hit?.path ?? hit?.file ?? null })()`)
  if (!file) throw new Error(`没有标题含「${title}」的会话`)
  await cdp.evaluate(`window.__yanStore.getState().switchSession(${JSON.stringify(file)})`)
  if (until) await until(`s.session?.sessionFile === ${JSON.stringify(file)}`, 15000)
  await new Promise((done) => setTimeout(done, 1200))
  return file
}

export async function setTheme(cdp, theme) {
  await cdp.evaluate(`window.__yanStore.getState().patchSettings({ theme: ${JSON.stringify(theme)} })`)
  await new Promise((done) => setTimeout(done, 600))
}

export async function writeJson(path, value) {
  const { writeFileSync, mkdirSync } = await import('node:fs')
  const { dirname } = await import('node:path')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms))

export async function resizeWindow(cdp, width, height) {
  if (width === 'max') {
    await cdp.call('Emulation.clearDeviceMetricsOverride', {})
  } else {
    const dpr = await cdp.evaluate('devicePixelRatio')
    await cdp.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false })
  }
  await wait(900)
  return cdp.evaluate('[innerWidth, innerHeight]')
}

export function startFrames(cdp, out, prefix, everyMs = 1000) {
  let stopped = false
  let index = 0
  const samples = []
  const loop = (async () => {
    while (!stopped) {
      const started = Date.now()
      const name = `${prefix}-${String(index++).padStart(3, '0')}`
      try {
        const metrics = await cdp.evaluate(`(() => { const sc = document.querySelector('[data-testid="v3-session-scroll"]') ?? document.querySelector('.v3-session-scroll') ?? document.scrollingElement; return { t: Date.now(), scrollTop: Math.round(sc?.scrollTop ?? -1), scrollHeight: Math.round(sc?.scrollHeight ?? -1), clientHeight: Math.round(sc?.clientHeight ?? -1), msgs: window.__yanStore.getState().messages?.length ?? null, running: !!(window.__yanStore.getState().session?.isStreaming || window.__yanStore.getState().session?.isAgentRunning) } })()`)
        await cdp.shot(name, out)
        samples.push({ name, ...metrics })
      } catch (error) { samples.push({ name, error: String(error).slice(0, 200) }) }
      const rest = everyMs - (Date.now() - started)
      if (rest > 0) await wait(rest)
    }
  })()
  return async () => { stopped = true; await loop; return samples }
}

export async function openRealSession(cdp, until, titlePart) {
  const path = await cdp.evaluate(`(() => { const s = window.__yanStore.getState(); const list = s.sessions ?? []; const hit = list.find((x) => String(x.title ?? x.name ?? '').includes(${JSON.stringify(titlePart)})); return hit?.path ?? hit?.sessionFile ?? null })()`)
  if (!path) return null
  await cdp.evaluate(`window.__yanStore.getState().switchSession(${JSON.stringify(path)})`)
  await until(`s.session?.sessionFile === ${JSON.stringify(path)}`, 20000)
  await wait(800)
  return path
}
