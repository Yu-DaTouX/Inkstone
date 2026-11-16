import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { startProfile, stopProfile } from '../lib/cpu-profile.mjs'
import { galleryBlocks } from '../lib/visual-gallery.mjs'

export const meta = { description: '可视化回答画廊：假模型在一条回复里流出全部块型（yan-chart 各形态、stats、cards、record、flow、steps、mermaid、全部小部件范例与点阵动画、一个写错的 JSON），记录流式出现过程，深浅主题 × 右栏开关逐块截图并测重叠、截断、对比度、配色区分度，查小部件取色与 canvas 像素、工具条遮挡、减少动效，最后滚动并分段测渲染进程 CPU 与屏外动画节流（VG_SHOT_DIR、VG_TAG、VG_SCROLL_MS、VG_CONFIGS=dark-rp,dark-wide,light-rp,light-wide,dark-narrow、VG_ONLY=块名,块名 只流出这几块、VG_STREAM_ONLY=1 只看流式出现、VG_SKIP_PERF=1 跳过焦点/动效/性能段、VG_PERF_ONLY=1 只跑流式与性能段）' }

const MEASURE = String.raw`function (root, baseBg, skipSel) {
  const parse = (c) => {
    if (!c) return null
    const m = /rgba?\(([^)]+)\)/.exec(c)
    if (m) { const p = m[1].split(/[\s,\/]+/).filter(Boolean).map((x) => x.endsWith('%') ? Number(x.slice(0, -1)) / 100 : Number(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 } }
    const s = /color\(srgb ([^)]+)\)/.exec(c)
    if (s) { const p = s[1].split(/[\s\/]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 } }
    return null
  }
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 })
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  const base = parse(baseBg) || { r: 0, g: 0, b: 0, a: 1 }
  const opacityOf = (el) => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o }
  const bgOf = (el) => {
    const layers = []
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break } }
    let bg = base
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg)
    return bg
  }
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
  const box = root.getBoundingClientRect()
  const nodes = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.nodeValue.replace(/\s+/g, ' ').trim()
    if (!text) continue
    const el = n.parentElement
    if (!el || el.closest('script,style,title,desc,details:not([open]) > :not(summary)') || (skipSel && el.closest(skipSel))) continue
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue
    const op = opacityOf(el)
    if (op < 0.05) continue
    const range = document.createRange()
    range.selectNodeContents(n)
    const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5)
    if (!rects.length) continue
    nodes.push({ text: text.slice(0, 40), el, rects, op })
  }
  const overlaps = []
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    if (nodes[i].el === nodes[j].el) continue
    for (const a of nodes[i].rects) for (const b of nodes[j].rects) {
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
      if (w > 1 && h > 1 && w * h > 0.15 * Math.min(a.width * a.height, b.width * b.height)) { overlaps.push([nodes[i].text, nodes[j].text, Math.round(w), Math.round(h)]); break }
    }
  }
  const outside = []
  const clipRoots = [...root.querySelectorAll('*')].filter((e) => { const s = getComputedStyle(e); return s.overflowX !== 'visible' && !e.closest('details:not([open]) > :not(summary)') })
  for (const n of nodes) for (const r of n.rects) {
    if (r.right > box.right + 1.5 || r.left < box.left - 1.5) { outside.push([n.text, Math.round(r.left - box.left), Math.round(r.right - box.right)]); break }
  }
  const truncated = []
  for (const e of root.querySelectorAll('*')) {
    if (e.closest('.sr-only')) continue
    const s = getComputedStyle(e)
    if (e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0 && (s.overflowX === 'hidden' || s.overflowX === 'clip' || s.textOverflow === 'ellipsis') && e.textContent.trim()) truncated.push([e.textContent.trim().slice(0, 40), e.clientWidth, e.scrollWidth])
  }
  const scrolls = clipRoots.filter((e) => (getComputedStyle(e).overflowX === 'auto' || getComputedStyle(e).overflowX === 'scroll') && e.scrollWidth > e.clientWidth + 1).map((e) => [(e.className || e.tagName).toString().slice(0, 40), e.clientWidth, e.scrollWidth])
  const contrast = []
  const seen = new Set()
  for (const n of nodes) {
    if (seen.has(n.el)) continue
    seen.add(n.el)
    const s = getComputedStyle(n.el)
    const svg = n.el instanceof SVGElement
    const fg = parse(svg ? s.fill : s.color)
    if (!fg) continue
    const bg = bgOf(n.el)
    const c = over({ ...fg, a: fg.a * n.op }, bg)
    const size = parseFloat(s.fontSize)
    const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700)
    const r = ratio(c, bg)
    contrast.push({ text: n.text, ratio: Math.round(r * 100) / 100, need: large ? 3 : 4.5, size, fg: hex(c), bg: hex(bg) })
  }
  const low = contrast.filter((x) => x.ratio < x.need).sort((a, b) => a.ratio - b.ratio)
  return { w: Math.round(box.width), h: Math.round(box.height), texts: nodes.length, overlaps: overlaps.slice(0, 12), outside: outside.slice(0, 12), truncated: truncated.slice(0, 12), scrolls, minContrast: contrast.length ? Math.min(...contrast.map((x) => x.ratio)) : null, lowContrast: low.slice(0, 12) }
}`

const PAGE_HELPERS = String.raw`(() => {
  const lastMsg = () => { const xs = document.querySelectorAll('.v3-msg.assistant'); return xs[xs.length - 1] || null }
  const labelOf = (id) => { const msg = lastMsg(); if (!msg) return null; for (const p of msg.querySelectorAll('p')) { const s = p.firstElementChild; if (s && s.tagName === 'STRONG' && s.textContent.split(' ')[0] === id) return p } return null }
  const find = (id) => labelOf(id)?.nextElementSibling ?? null
  const kind = (el) => !el ? 'none' : el.matches('.v3-visual-pending') ? 'pending' : el.matches('.v3-visual-invalid') ? 'invalid' : el.matches('.v3-visual-widget') ? (el.querySelector('iframe') ? 'widget:iframe' : el.querySelector('[data-testid=v3-visual-widget-paused]') ? 'widget:paused' : el.querySelector('.v3-visual-pending') ? 'widget:reserve' : el.querySelector('[data-testid=v3-artifact-frame-parked]') ? 'widget:parked' : 'widget:other') : el.matches('.v3-visual') ? 'visual' : el.matches('.v3-code') ? 'code' : el.tagName.toLowerCase()
  const scroller = () => { let e = lastMsg(); while (e && e !== document.body) { const s = getComputedStyle(e); if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 4) return e; e = e.parentElement } return document.scrollingElement }
  const pageBg = () => { const tryEls = [document.querySelector('.v3-conv'), document.querySelector('.v3-stream'), document.body, document.documentElement]; for (const e of tryEls) { if (!e) continue; const c = getComputedStyle(e).backgroundColor; if (c && !/rgba\([^)]*,\s*0\)$/.test(c) && c !== 'transparent') return c } return document.documentElement.dataset.theme === 'light' ? 'rgb(252, 252, 251)' : 'rgb(0, 0, 0)' }
  const resolve = (name) => { const p = document.createElement('span'); p.style.display = 'none'; p.style.color = 'var(' + name + ')'; (lastMsg() || document.body).appendChild(p); const c = getComputedStyle(p).color; p.remove(); return c }
  const idOf = (el) => el.previousElementSibling?.querySelector('strong')?.textContent.split(' ')[0] ?? '?'
  window.__vg = { lastMsg, labelOf, find, kind, idOf, scroller, pageBg, resolve, measure: (${MEASURE}) }
  return true
})()`

const STREAM_PROBE = String.raw`(() => {
  const ids = __IDS__
  const g = window.__vg
  const m = window.__vgs = { t0: performance.now(), events: [], shifts: [], marks: [], last: {}, frames: 0, longFrames: 0 }
  new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) m.shifts.push({ t: Math.round(e.startTime - m.t0), v: Math.round(e.value * 10000) / 10000, src: (e.sources || []).slice(0, 3).map((s) => s.node && s.node.nodeType === 1 ? String(s.node.className || s.node.tagName).slice(0, 40) : '') }) }).observe({ type: 'layout-shift' })
  let prev = performance.now()
  const tick = (ts) => {
    m.frames++
    if (ts - prev > 50) m.longFrames++
    prev = ts
    const t = Math.round(performance.now() - m.t0)
    for (const id of ids) {
      const el = g.find(id)
      const k = g.kind(el)
      const r = el ? el.getBoundingClientRect() : null
      const h = r ? Math.round(r.height) : 0
      const vis = !!r && r.bottom > 0 && r.top < innerHeight
      const last = m.last[id]
      const fresh = !!el && !!last && last.el !== el && last.k !== 'none'
      if (!last || fresh || last.k !== k || Math.abs(last.h - h) > 1) { m.events.push({ t, id, k: fresh ? k + '#new' : k, h, vis }); m.last[id] = { k, h, el } }
      else last.el = el
    }
    if (!m.stop) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  const st = window.__yanStore
  let running = false
  st.subscribe((s) => { const r = !!(s.session && (s.session.isStreaming || s.session.isAgentRunning)); if (r !== running) { running = r; m.marks.push({ t: Math.round(performance.now() - m.t0), kind: r ? 'run' : 'done' }) } })
  return true
})()`

const RANK = { none: 0, p: 0, code: 1, pending: 2, 'widget:reserve': 3, 'widget:paused': 3, 'widget:parked': 3, 'widget:other': 3, visual: 4, invalid: 4, 'widget:iframe': 4 }

function summarizeStream(events, doneAt) {
  const byId = {}
  for (const e of events) (byId[e.id] ??= []).push(e)
  const out = {}
  for (const [id, list] of Object.entries(byId)) {
    const kinds = []
    let regress = 0
    let best = 0
    let afterFinal = 0
    let finalAt = null
    for (const raw of list) {
      const e = { ...raw, k: raw.k.replace('#new', '') }
      if (!kinds.length || kinds[kinds.length - 1] !== e.k) kinds.push(e.k)
      const r = RANK[e.k] ?? 0
      if (r < best && best >= 2 && e.vis) regress++
      if (r === 4 && finalAt === null) finalAt = e.t
      else if (finalAt !== null && r === 4) afterFinal++
      best = Math.max(best, r)
    }
    const pend = list.filter((e) => e.k === 'pending').map((e) => e.h)
    const fin = list.filter((e) => RANK[e.k] === 4).map((e) => e.h)
    out[id] = { kinds: kinds.join(' > '), regress, heightChangesAfterFinal: afterFinal, pendingH: pend.length ? Math.max(...pend) : null, firstFinalH: fin[0] ?? null, lastH: list[list.length - 1].h, finalAt, finalAfterDone: finalAt !== null && doneAt !== null ? finalAt - doneAt : null }
  }
  return out
}

function sampleProcs(marker) {
  const query = "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Select-Object ProcessId,ParentProcessId,CommandLine,KernelModeTime,UserModeTime,WorkingSetSize | ConvertTo-Json -Compress"
  for (const shell of ['pwsh', 'powershell']) {
    try {
      const raw = execFileSync(shell, ['-NoProfile', '-Command', query], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20, timeout: 20000 })
      const list = [].concat(JSON.parse(raw))
      const mine = list.filter((p) => (p.CommandLine ?? '').toLowerCase().includes(marker.toLowerCase()))
      return { at: Date.now(), procs: mine.map((p) => ({ pid: p.ProcessId, type: /--type=([a-z-]+)/.exec(p.CommandLine ?? '')?.[1] ?? 'main', cpuMs: (Number(p.KernelModeTime ?? 0) + Number(p.UserModeTime ?? 0)) / 10000, wsMB: Math.round(Number(p.WorkingSetSize ?? 0) / 1048576), site: /--renderer-client-id=(\d+)/.exec(p.CommandLine ?? '')?.[1] ?? null })) }
    } catch {}
  }
  return { at: Date.now(), procs: [], error: 'no shell' }
}

function cpuDelta(a, b) {
  const wall = Math.max(1, b.at - a.at)
  const start = new Map(a.procs.map((p) => [p.pid, p.cpuMs]))
  const rows = b.procs.map((p) => ({ pid: p.pid, type: p.type, wsMB: p.wsMB, pct: Math.round(((p.cpuMs - (start.get(p.pid) ?? p.cpuMs)) / wall) * 1000) / 10 }))
  const sum = (type) => Math.round(rows.filter((r) => r.type === type).reduce((s, r) => s + r.pct, 0) * 10) / 10
  return { wallMs: wall, renderer: sum('renderer'), gpu: sum('gpu-process'), main: sum('main'), utility: sum('utility'), renderers: rows.filter((r) => r.type === 'renderer').sort((x, y) => y.pct - x.pct) }
}

async function targets(port) {
  return (await (await fetch(`http://127.0.0.1:${port}/json`)).json())
}

async function openTarget(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((done, fail) => { ws.onopen = done; ws.onerror = fail })
  let seq = 0
  const pending = new Map()
  ws.onmessage = (message) => { const data = JSON.parse(message.data); if (data.id && pending.has(data.id)) { pending.get(data.id)(data); pending.delete(data.id) } }
  const call = (method, params = {}) => new Promise((done) => { const id = ++seq; pending.set(id, done); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate = async (expression) => {
    const res = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text)
    return res.result?.result?.value
  }
  return { call, evaluate, close: () => ws.close() }
}

async function frameFor(cdp, url) {
  const list = await targets(cdp.port)
  const hit = list.find((t) => t.url === url && t.webSocketDebuggerUrl)
  if (hit) return { oopif: true, ...(await openTarget(hit.webSocketDebuggerUrl)) }
  const tree = (await cdp.call('Page.getFrameTree')).result?.frameTree
  const walk = (node) => node?.frame?.url === url ? node.frame : (node?.childFrames ?? []).map(walk).find(Boolean)
  const frame = walk(tree)
  if (!frame) return null
  const world = await cdp.call('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'vg' })
  const contextId = world.result?.executionContextId
  if (!contextId) return null
  return {
    oopif: false,
    evaluate: async (expression) => {
      const res = await cdp.call('Runtime.evaluate', { expression, contextId, awaitPromise: true, returnByValue: true })
      if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text)
      return res.result?.result?.value
    },
    close: () => {}
  }
}

const FRAME_PROBE = (baseBg) => `(() => {
  const css = getComputedStyle(document.documentElement)
  const vars = Object.fromEntries(['--text', '--text-dim', '--text-mute', '--c1', '--c2', '--ok', '--warn', '--err', '--accent', '--accent-t', '--border', '--surface-2', '--font', '--text-size'].map((n) => [n, css.getPropertyValue(n).trim()]))
  const canvases = [...document.querySelectorAll('canvas')].map((cv) => {
    try {
      const x = cv.getContext('2d')
      const d = x.getImageData(0, 0, cv.width, cv.height).data
      let painted = 0, black = 0
      const hues = {}
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 128) continue
        painted++
        const r = d[i], g = d[i + 1], b = d[i + 2]
        if (r < 24 && g < 24 && b < 24) { black++; continue }
        const key = (r >> 5) + ',' + (g >> 5) + ',' + (b >> 5)
        hues[key] = (hues[key] || 0) + 1
      }
      const top = Object.entries(hues).sort((a, b) => b[1] - a[1]).slice(0, 6)
      return { w: cv.width, h: cv.height, painted, black, colors: top }
    } catch (error) { return { error: String(error) } }
  })
  const links = [...document.querySelectorAll('a')].map((a) => getComputedStyle(a).color)
  const rm = matchMedia('(prefers-reduced-motion: reduce)').matches
  const m = (${MEASURE})(document.body, ${JSON.stringify(baseBg)}, null)
  return { vars, canvases, links, reducedMotion: rm, scheme: getComputedStyle(document.documentElement).colorScheme, measure: m, docH: document.documentElement.scrollHeight }
})()`

const RAF_COUNTER = `(() => { if (window.__vgRaf) return window.__vgRaf.n; const o = window.requestAnimationFrame.bind(window); window.__vgRaf = { n: 0 }; window.requestAnimationFrame = (cb) => o((t) => { window.__vgRaf.n++; cb(t) }); return 0 })()`

function srgbToLab(c) {
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  const r = lin(c[0]), g = lin(c[1]), b = lin(c[2])
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
}

function deltaE(a, b) {
  const p = srgbToLab(a), q = srgbToLab(b)
  return Math.round(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) * 10) / 10
}

const CVD = {
  deutan: [[0.367, 0.861, -0.228], [0.28, 0.673, 0.047], [-0.012, 0.043, 0.969]],
  protan: [[0.152, 1.053, -0.205], [0.115, 0.786, 0.099], [-0.004, -0.048, 1.052]]
}

function simulate(c, kind) {
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  const gam = (v) => Math.round(255 * Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)))
  const l = c.map(lin)
  return CVD[kind].map((row) => gam(row[0] * l[0] + row[1] * l[1] + row[2] * l[2]))
}

function rgbOf(text) {
  const m = /rgba?\(([^)]+)\)/.exec(text ?? '')
  if (!m) return null
  return m[1].split(/[\s,\/]+/).filter(Boolean).slice(0, 3).map(Number)
}

function contrastRatio(a, b) {
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  const L = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
  const x = L(a), y = L(b)
  return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100
}

function paletteReport(tokens, bg) {
  const data = ['--data-1', '--data-2', '--data-3', '--data-4', '--data-5', '--data-6']
  const vsBg = Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k, rgbOf(v) && bg ? contrastRatio(rgbOf(v), bg) : null]))
  const pairs = []
  const check = (names, label) => {
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
      const a = rgbOf(tokens[names[i]]), b = rgbOf(tokens[names[j]])
      if (!a || !b) continue
      pairs.push({ set: label, a: names[i], b: names[j], dE: deltaE(a, b), deutan: deltaE(simulate(a, 'deutan'), simulate(b, 'deutan')), protan: deltaE(simulate(a, 'protan'), simulate(b, 'protan')) })
    }
  }
  check(data.slice(0, 4), 'chart-series')
  check(['--data-1', '--ok', '--fail', '--fg3'], 'grid-states')
  check(['--ok', '--ask', '--fail'], 'tones')
  return { vsBg, pairs, weakest: [...pairs].sort((a, b) => Math.min(a.dE, a.deutan) - Math.min(b.dE, b.deutan)).slice(0, 6) }
}

export default async function run({ cdp, box, newSession, check, sleep, report, runDir, state, autoApprove, log }) {
  const dir = process.env.VG_SHOT_DIR ? join(process.env.VG_SHOT_DIR) : join(runDir, 'gallery')
  const tag = process.env.VG_TAG || 'vg'
  const scrollMs = Number(process.env.VG_SCROLL_MS || 30000)
  const configs = (process.env.VG_CONFIGS || 'dark-rp,dark-wide,light-rp,light-wide,dark-narrow').split(',').map((name) => ({ name, theme: name.startsWith('light') ? 'light' : 'dark', panel: name.endsWith('-rp'), narrow: name.endsWith('-narrow') }))
  mkdirSync(dir, { recursive: true })
  const burstDir = join(dir, `${tag}-stream`)
  mkdirSync(burstDir, { recursive: true })
  const only = process.env.VG_ONLY ? process.env.VG_ONLY.split(',') : null
  const blocks = galleryBlocks().filter((b) => !only || only.includes(b.id))
  const ids = blocks.map((b) => b.id)
  const ev = (expr) => cdp.evaluate(expr)
  const marker = basename(runDir)
  const result = { tag, blocks: ids, configs: {}, stream: null, cpu: {}, frames: {} }

  await autoApprove()
  await cdp.call('Performance.enable')
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN', reduceMotion: false })`)
  await ev(`window.__yanRightPanel?.getState().setOpen(true)`)
  await newSession()
  await sleep(1200)
  result.viewport = await ev('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, sidebar: Number(localStorage.getItem("inkstone.v3.sidebarWidth")), rightPanel: window.__yanRightPanel?.getState().width ?? null })')
  log('viewport', result.viewport)
  await ev(PAGE_HELPERS)
  await ev(STREAM_PROBE.replace('__IDS__', JSON.stringify(ids)))

  const sent = await ev(`window.__yanStore.getState().send(${JSON.stringify('请把每种可视化块画一遍 VISUALGALLERY' + (only ? ' VGONLY=' + only.join(',') : ''))})`)
  if (sent === false) throw new Error('发送失败')
  let started = false
  let doneSeen = 0
  let n = 0
  const end = Date.now() + 180000
  while (Date.now() < end) {
    const running = await state('!!(s.session?.isStreaming || s.session?.isAgentRunning)')
    if (running) started = true
    if (started && n < 60) {
      const res = await cdp.call('Page.captureScreenshot', { format: 'jpeg', quality: 70 })
      writeFileSync(join(burstDir, `${String(n++).padStart(3, '0')}.jpg`), Buffer.from(res.result.data, 'base64'))
    }
    await sleep(started ? 350 : 60)
    if (started && !running) {
      if (!doneSeen) doneSeen = Date.now()
      if (Date.now() - doneSeen > 4000) break
    }
  }
  const streamData = await ev('(() => { window.__vgs.stop = true; const m = window.__vgs; return { events: m.events, shifts: m.shifts, marks: m.marks, frames: m.frames, longFrames: m.longFrames } })()')
  const doneAt = streamData.marks.filter((x) => x.kind === 'done').at(-1)?.t ?? null
  const perBlock = summarizeStream(streamData.events, doneAt)
  const shiftTotal = Math.round(streamData.shifts.reduce((s, x) => s + x.v, 0) * 10000) / 10000
  result.stream = { doneAt, frames: streamData.frames, longFrames: streamData.longFrames, shiftTotal, shiftCount: streamData.shifts.length, shiftSources: [...new Set(streamData.shifts.flatMap((s) => s.src))].slice(0, 12), perBlock }
  writeFileSync(join(dir, `${tag}-stream.json`), JSON.stringify({ ...streamData, perBlock }, null, 1))
  check('回合结束', doneAt !== null)
  check('流式中已出图的块不回退为占位', Object.values(perBlock).every((b) => b.regress === 0), Object.fromEntries(Object.entries(perBlock).filter(([, b]) => b.regress).map(([id, b]) => [id, b.kinds])))
  const parkedInView = streamData.events.filter((e) => e.vis && (e.k === 'widget:parked' || e.k === 'widget:paused')).map((e) => `${e.id}@${e.t}:${e.k}`)
  check('流式中视口内小部件从未显示已暂停', parkedInView.length === 0, parkedInView.slice(0, 8))
  const perfOnly = !!process.env.VG_PERF_ONLY

  if (process.env.VG_STREAM_ONLY) {
    await sleep(3000)
    await cdp.shot(`${tag}-stream-end.png`, dir)
    report.gallery = { stream: result.stream }
    writeFileSync(join(dir, `${tag}-results.json`), JSON.stringify(result, null, 1))
    return
  }

  const settleBlock = async (id) => {
    await ev(`(() => { const p = window.__vg.labelOf(${JSON.stringify(id)}); if (!p) return false; p.style.scrollMarginTop = '72px'; p.dispatchEvent(new CustomEvent('yan-scroll-intent', { bubbles: true })); p.scrollIntoView({ block: 'start' }); return true })()`)
    let lastH = -1
    let stable = 0
    for (let i = 0; i < 30 && stable < 3; i++) {
      await sleep(150)
      const info = await ev(`(() => { const el = window.__vg.find(${JSON.stringify(id)}); if (!el) return null; const k = window.__vg.kind(el); const svg = el.querySelector('svg'); return { k, h: Math.round(el.getBoundingClientRect().height), ready: k !== 'widget:reserve' && k !== 'pending' && (k !== 'visual' || !el.matches('.v3-visual-mermaid') || !!svg) } })()`)
      if (info && info.ready && info.h === lastH) stable++
      else stable = 0
      lastH = info?.h ?? -1
    }
    await sleep(id.startsWith('widget') ? 500 : 120)
  }

  const shoot = async (id, file) => {
    const rect = await ev(`(() => { const p = window.__vg.labelOf(${JSON.stringify(id)}); const el = window.__vg.find(${JSON.stringify(id)}); if (!p || !el) return null; const a = p.getBoundingClientRect(), b = el.getBoundingClientRect(); const top = Math.max(0, a.top - 6), bottom = Math.min(innerHeight, b.bottom + 10); const left = Math.max(0, Math.min(a.left, b.left) - 12), right = Math.min(innerWidth, Math.max(a.right, b.right) + 12); return { x: left, y: top, width: right - left, height: bottom - top } })()`)
    if (!rect || rect.width < 4 || rect.height < 4) return null
    const res = await cdp.call('Page.captureScreenshot', { format: 'png' })
    const cropped = await ev(`(async () => {
      const img = new Image()
      await new Promise((done, fail) => { img.onload = done; img.onerror = fail; img.src = 'data:image/png;base64,${res.result.data}' })
      const k = img.naturalWidth / innerWidth
      const r = ${JSON.stringify(rect)}
      const c = document.createElement('canvas')
      c.width = Math.round(r.width * k); c.height = Math.round(r.height * k)
      c.getContext('2d').drawImage(img, r.x * k, r.y * k, r.width * k, r.height * k, 0, 0, c.width, c.height)
      return c.toDataURL('image/png').split(',')[1]
    })()`)
    writeFileSync(file, Buffer.from(cropped, 'base64'))
    return rect
  }

  const widgetUrls = async () => ev(`(() => Object.fromEntries(${JSON.stringify(ids)}.map((id) => { const el = window.__vg.find(id); const f = el && el.querySelector('iframe'); return [id, f ? f.src : null] }).filter((x) => x[1])))()`)

  for (const config of perfOnly ? [] : configs) {
    await ev(`window.__yanStore.getState().patchSettings({ theme: ${JSON.stringify(config.theme)} })`)
    await ev(`window.__yanRightPanel?.getState().setOpen(${config.panel})`)
    if (config.narrow) await cdp.call('Emulation.setDeviceMetricsOverride', { width: Number(process.env.VG_NARROW_WIDTH || 820), height: result.viewport.h, deviceScaleFactor: 0, mobile: false })
    else await cdp.call('Emulation.clearDeviceMetricsOverride')
    await sleep(1200)
    const layout = await ev(`(() => { const msg = window.__vg.lastMsg(); const rp = document.querySelector('[data-testid="rp"]'); const r = msg ? msg.getBoundingClientRect() : null; return { msgW: r ? Math.round(r.width) : null, msgX: r ? Math.round(r.left) : null, rpW: rp ? Math.round(rp.getBoundingClientRect().width) : 0, bg: window.__vg.pageBg() } })()`)
    const tokens = await ev(`Object.fromEntries(['--fg', '--fg2', '--fg3', '--accent', '--accent-t', '--ok', '--ok-t', '--ask', '--ask-t', '--fail', '--fail-t', '--line', '--line2', '--data-1', '--data-2', '--data-3', '--data-4', '--data-5', '--data-6'].map((n) => [n, window.__vg.resolve(n)]))`)
    const palette = paletteReport(tokens, rgbOf(layout.bg))
    const rows = {}
    for (const block of blocks) {
      await settleBlock(block.id)
      const m = await ev(`(() => {
        const g = window.__vg
        const el = g.find(${JSON.stringify(block.id)})
        if (!el) return null
        const k = g.kind(el)
        const out = { kind: k, ...g.measure(el, g.pageBg(), '.v3-artifact-frame-tools, .v3-visual-actions, .v3-artifact-frame-bar') }
        const content = el.querySelector('iframe, .v3-mermaid-svg svg')
        const tools = el.querySelector('.v3-artifact-frame-tools, .v3-visual-actions, .v3-artifact-frame-bar')
        if (content && tools) {
          const a = content.getBoundingClientRect(), b = tools.getBoundingClientRect()
          const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
          out.toolbar = { overlapPx: w > 0 && h > 0 ? Math.round(w * h) : 0, toolsRect: [Math.round(b.left - a.left), Math.round(b.top - a.top), Math.round(b.width), Math.round(b.height)], buttons: tools.querySelectorAll('button').length }
        }
        const frame = el.querySelector('iframe')
        if (frame) out.frameH = Math.round(frame.getBoundingClientRect().height)
        if (el.matches('.v3-visual-chart')) {
          const colors = new Set()
          for (const b of el.querySelectorAll('.v3-visual-bar, .v3-visual-hbar, .v3-visual-legend-item i')) colors.add(getComputedStyle(b).backgroundColor)
          for (const l of el.querySelectorAll('.v3-visual-line')) colors.add(getComputedStyle(l).stroke)
          out.seriesColors = [...colors]
        }
        return out
      })()`)
      const file = join(dir, `${tag}-${config.name}-${block.id}.png`)
      const rect = await shoot(block.id, file)
      rows[block.id] = { ...m, shot: rect ? basename(file) : null }
    }
    const frames = {}
    for (const id of ids.filter((x) => x.startsWith('widget'))) {
      await settleBlock(id)
      await sleep(400)
      const url = (await widgetUrls())[id]
      if (!url) { frames[id] = { error: 'not live' }; continue }
      const frame = await frameFor(cdp, url)
      if (!frame) { frames[id] = { error: 'no frame target' }; continue }
      try { frames[id] = { oopif: frame.oopif, ...(await frame.evaluate(FRAME_PROBE(layout.bg))) } } catch (error) { frames[id] = { error: String(error).slice(0, 200) } } finally { frame.close() }
    }
    await ev(`(() => { const p = window.__vg.labelOf('widget-grid'); if (p) { p.style.scrollMarginTop = '72px'; p.dispatchEvent(new CustomEvent('yan-scroll-intent', { bubbles: true })); p.scrollIntoView({ block: 'start' }) } })()`)
    await sleep(1500)
    await cdp.shot(`${tag}-${config.name}-viewport-widgets.png`, dir)
    await ev(`(() => { const p = window.__vg.labelOf('chart-bar'); if (p) { p.style.scrollMarginTop = '72px'; p.dispatchEvent(new CustomEvent('yan-scroll-intent', { bubbles: true })); p.scrollIntoView({ block: 'start' }) } })()`)
    await sleep(600)
    await cdp.shot(`${tag}-${config.name}-viewport-charts.png`, dir)
    result.configs[config.name] = { layout, tokens, palette, blocks: rows, frames }
    if (config.narrow) await cdp.call('Emulation.clearDeviceMetricsOverride')
    log(config.name, JSON.stringify(layout))
  }

  const main = result.configs[configs[0].name] ?? { blocks: {}, frames: {} }
  for (const [id, row] of Object.entries(main.blocks)) {
    if (!row) continue
    check(`${id} 无文字重叠`, !row.overlaps?.length, row.overlaps)
  }
  if (!perfOnly) {
  const frameVars = Object.entries(main.frames).map(([id, f]) => [id, f.vars?.['--c1'] ?? f.error])
  check('小部件颜色变量是具体色值', frameVars.every(([, v]) => typeof v === 'string' && /^(rgb|#)/.test(v)), frameVars)
  check('小部件链接色有效', Object.values(main.frames).every((f) => typeof f.vars?.['--accent-t'] === 'string' && /^(rgb|#)/.test(f.vars['--accent-t'])), Object.fromEntries(Object.entries(main.frames).map(([id, f]) => [id, f.vars?.['--accent-t']])))
  const canvasRows = Object.entries(main.frames).flatMap(([id, f]) => (f.canvases ?? []).map((c) => ({ id, ...c })))
  if (ids.includes('widget-6') || ids.includes('widget-grid')) check('canvas 画出彩色像素', canvasRows.length > 0 && canvasRows.every((c) => c.painted > 0 && c.colors?.length >= 2 && c.black < c.painted * 0.5), canvasRows.map((c) => ({ id: c.id, painted: c.painted, black: c.black, colors: c.colors?.length })))
  check('小部件工具条不遮挡内容', Object.values(main.blocks).every((row) => !row?.toolbar || row.toolbar.overlapPx === 0), Object.fromEntries(Object.entries(main.blocks).filter(([, row]) => row?.toolbar).map(([id, row]) => [id, row.toolbar])))
  }

  if (process.env.VG_SKIP_PERF) {
    writeFileSync(join(dir, `${tag}-results.json`), JSON.stringify(result, null, 1))
    return
  }
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark' })`)
  await ev(`window.__yanRightPanel?.getState().setOpen(true)`)
  await sleep(800)
  const focusId = ids.find((x) => x.startsWith('widget'))
  if (!perfOnly) {
  await settleBlock(focusId)
  await sleep(600)
  const focus0 = await ev(`(async () => {
    const el = window.__vg.find(${JSON.stringify(focusId)})
    if (!el) return null
    const buttons = [...el.querySelectorAll('button')]
    const first = buttons[0]
    if (!first) return { buttons: 0 }
    first.focus()
    window.__vgFirst = first
    return null
  })()`)
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 })
  await sleep(150)
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await sleep(350)
  const focus2 = await ev(`(async () => {
    const el = window.__vg.find(${JSON.stringify(focusId)})
    const first = window.__vgFirst
    if (!el || !first) return null
    const buttons = [...el.querySelectorAll('button')]
    const bar = first.closest('.v3-artifact-frame-tools, .v3-artifact-frame-bar, .v3-visual-actions')
    const frame = el.querySelector('iframe')
    const a = frame ? frame.getBoundingClientRect() : null
    const b = bar ? bar.getBoundingClientRect() : first.getBoundingClientRect()
    const overlap = a ? Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) : null
    const s = getComputedStyle(first)
    return { buttons: buttons.length, labels: buttons.map((x) => x.getAttribute('aria-label') || x.textContent.trim()), focused: document.activeElement === first, active: (document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent || '').trim().slice(0, 20), focusVisible: first.matches('[data-focus-visible], :focus-visible'), barOpacity: bar ? getComputedStyle(bar).opacity : null, outline: s.outlineStyle + ' ' + s.outlineWidth, boxShadow: s.boxShadow.slice(0, 60), overlap: Math.round(overlap ?? 0) }
  })()`)
  await sleep(300)
  const focus = { ...(focus0 ?? {}), ...(focus2 ?? {}) }
  await cdp.shot(`${tag}-focus-toolbar.png`, dir)
  result.focus = focus
  check('工具条可用键盘聚焦且可见', focus && focus.focused && Number(focus.barOpacity) > 0.9, focus)
  await ev('document.activeElement && document.activeElement.blur && document.activeElement.blur()')

  await ev(`(() => {
    const t0 = performance.now()
    const log = window.__vgFrameLog = []
    const fig = window.__vg.find('widget-grid')
    if (!fig) return
    fig.__vgFig = 1
    const note = (what) => { const fr = fig.querySelector('[data-testid=v3-artifact-frame]'); log.push([Math.round(performance.now() - t0), what, window.__vg.kind(fig), fr ? fr.getAttribute('data-live') : 'no-frame']) }
    note('start')
    window.__vgFrameObs?.disconnect()
    window.__vgFrameObs = new MutationObserver((list) => { for (const r of list) { for (const n of r.addedNodes) if (n.nodeName === 'IFRAME' || n.querySelector?.('iframe')) note('iframe+') ; for (const n of r.removedNodes) if (n.nodeName === 'IFRAME' || n.querySelector?.('iframe')) note('iframe-'); if (r.type === 'attributes') note('attr:' + r.attributeName) } })
    window.__vgFrameObs.observe(fig, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-live', 'src'] })
  })()`)
  const landing = []
  for (let i = 0; i < 12; i++) {
    const at = await ev(`(() => { const p = window.__vg.labelOf('widget-grid'); const el = window.__vg.find('widget-grid'); if (!p || !el) return null; const box = window.__vg.scroller().getBoundingClientRect(); const r = el.getBoundingClientRect(); const inView = r.top >= box.top && r.top < box.bottom - 40; if (!inView) { p.style.scrollMarginTop = '72px'; p.dispatchEvent(new CustomEvent('yan-scroll-intent', { bubbles: true })); p.scrollIntoView({ block: 'start' }) } return { top: Math.round(r.top - box.top), inView, kind: window.__vg.kind(el) } })()`)
    landing.push(at)
    if (at?.inView && at.kind === 'widget:iframe') break
    await sleep(500)
  }
  result.reducedLanding = landing
  const urlBefore = (await widgetUrls())['widget-grid']
  check('减少动效检查前 widget-grid 已在视口内并加载', !!urlBefore && !!landing.at(-1)?.inView, landing)
  await ev(`(() => { const f = window.__vg.find('widget-grid')?.querySelector('iframe'); if (f) f.__vgMark = 1 })()`)
  if (urlBefore) {
    const frame = await frameFor(cdp, urlBefore)
    if (frame) { try { await frame.evaluate(`(() => { window.__vgRm = []; matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => window.__vgRm.push(e.matches)); return true })()`) } finally { frame.close() } }
  }
  const kindsOf = () => ev(`(() => Object.fromEntries([...document.querySelectorAll('.v3-visual-widget')].map((el) => { const r = el.getBoundingClientRect(); return [window.__vg.idOf(el), window.__vg.kind(el) + (r.bottom > 0 && r.top < innerHeight ? ':in' : '') + (el.querySelector('iframe')?.__vgMark ? ':mark' : '') + (el.__vgFig ? ':fig' : '')] })))()`)
  result.reducedKinds = { before: await kindsOf() }
  await ev(`window.__yanStore.getState().patchSettings({ reduceMotion: true })`)
  await sleep(2500)
  result.reducedKinds.after = await kindsOf()
  result.reducedKinds.frameLog = await ev('(() => { window.__vgFrameObs?.disconnect(); return window.__vgFrameLog ?? null })()')
  log('reduced-kinds', JSON.stringify(result.reducedKinds))
  const rmUrl = (await widgetUrls())['widget-grid']
  const sameFrame = await ev(`(() => window.__vg.find('widget-grid')?.querySelector('iframe')?.__vgMark === 1)()`)
  check('切换减少动效不重建小部件', !!urlBefore && sameFrame === true && rmUrl === urlBefore, { sameFrame, sameUrl: !!urlBefore && rmUrl === urlBefore })
  let reduced = null
  if (rmUrl) {
    const frame = await frameFor(cdp, rmUrl)
    if (frame) { try { reduced = await frame.evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`); result.reducedListener = await frame.evaluate('window.__vgRm ?? null') } finally { frame.close() } }
  }
  result.reducedMotion = { appSetting: true, widgetSees: reduced }
  check('减少动效设置传到小部件', reduced === true, result.reducedMotion)
  check('小部件里 matchMedia 监听者收到减少动效变化', Array.isArray(result.reducedListener) && result.reducedListener.includes(true), result.reducedListener)
  await ev(`window.__yanStore.getState().patchSettings({ reduceMotion: false })`)
  await sleep(1500)
  }

  const scrollTo = async (id, offset = 0) => {
    await ev(`(() => { const p = window.__vg.labelOf(${JSON.stringify(id)}); if (!p) return; p.style.scrollMarginTop = '72px'; p.dispatchEvent(new CustomEvent('yan-scroll-intent', { bubbles: true })); p.scrollIntoView({ block: 'start' }); const sc = window.__vg.scroller(); sc.scrollTop += ${offset} })()`)
  }
  const metric = (m, k) => m.result?.metrics?.find((x) => x.name === k)?.value ?? 0
  const rafPhase = async (name, id, offset, ms) => {
    await scrollTo(id, offset)
    await sleep(1500)
    const url = (await widgetUrls())['widget-grid']
    const frame = url ? await frameFor(cdp, url) : null
    let before = null
    if (frame) { try { before = await frame.evaluate(RAF_COUNTER) } catch {} }
    await ev(`(() => { window.__vgMut = { n: 0, attrs: {} }; window.__vgMutObs?.disconnect(); window.__vgMutObs = new MutationObserver((list) => { for (const r of list) { window.__vgMut.n++; const k = (r.target.className || r.target.tagName || '').toString().slice(0, 30) + ':' + r.type + ':' + (r.attributeName || ''); window.__vgMut.attrs[k] = (window.__vgMut.attrs[k] || 0) + 1 } }); window.__vgMutObs.observe(document.documentElement, { attributes: true, childList: true, subtree: true, characterData: true }) })()`)
    await startProfile(cdp)
    const m0 = await cdp.call('Performance.getMetrics')
    const p0 = sampleProcs(marker)
    await sleep(ms)
    const p1 = sampleProcs(marker)
    const m1 = await cdp.call('Performance.getMetrics')
    const prof = await stopProfile(cdp, dir, 12).catch((error) => ({ error: String(error) }))
    const mut = await ev(`(() => { window.__vgMutObs?.disconnect(); const m = window.__vgMut; return { n: m.n, top: Object.entries(m.attrs).sort((a, b) => b[1] - a[1]).slice(0, 8) } })()`)
    let after = null
    if (frame) { try { after = await frame.evaluate(RAF_COUNTER) } catch {} finally { frame.close() } }
    const pos = await ev(`(() => { const el = window.__vg.find('widget-grid'); if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight, kind: window.__vg.kind(el) } })()`)
    const row = { pos, widgetRafPerSec: before !== null && after !== null ? Math.round(((after - before) / ms) * 10000) / 10 : null, hostTaskPct: Math.round(((metric(m1, 'TaskDuration') - metric(m0, 'TaskDuration')) / (ms / 1000)) * 1000) / 10, cpu: cpuDelta(p0, p1), mutations: mut, profileMs: prof.totalMs, profileTop: prof.top?.slice(0, 12), longBusy: prof.longBusy?.slice(0, 3) }
    result.cpu[name] = row
    log(name, JSON.stringify({ pos: row.pos, raf: row.widgetRafPerSec, renderer: row.cpu.renderer, gpu: row.cpu.gpu }))
    return row
  }
  await rafPhase('grid-in-view', 'widget-grid', 0, 8000)
  await rafPhase('grid-offscreen-below', 'widget-grid', -1300, 8000)
  await rafPhase('grid-offscreen-above', 'invalid-json', 250, 8000)
  await rafPhase('grid-far', 'chart-bar', 0, 8000)

  const crowdPhase = async (name, height, ms) => {
    const widgetIds = ids.filter((x) => x.startsWith('widget'))
    if (widgetIds.length < 2) return null
    if (height) await cdp.call('Emulation.setDeviceMetricsOverride', { width: result.viewport.w, height, deviceScaleFactor: 0, mobile: false })
    await sleep(800)
    await scrollTo(widgetIds[0])
    await sleep(3000)
    const seen = await ev(`(() => { const sc = window.__vg.scroller().getBoundingClientRect(); return ${JSON.stringify(widgetIds)}.map((id) => { const el = window.__vg.find(id); if (!el) return null; const r = el.getBoundingClientRect(); return { id, kind: window.__vg.kind(el), inView: r.bottom > sc.top && r.top < sc.bottom } }).filter((x) => x && x.inView) })()`)
    const p0 = sampleProcs(marker)
    await sleep(ms)
    const p1 = sampleProcs(marker)
    const after = await ev(`(() => ${JSON.stringify(widgetIds)}.map((id) => { const el = window.__vg.find(id); return el ? [id, window.__vg.kind(el)] : null }).filter(Boolean))()`)
    if (height) await cdp.call('Emulation.clearDeviceMetricsOverride')
    await sleep(800)
    const row = { viewportHeight: height || result.viewport.h, inView: seen, kindsAfter: Object.fromEntries(after), cpu: cpuDelta(p0, p1), rendererProcs: p1.procs.filter((p) => p.type === 'renderer').length, rendererMB: p1.procs.filter((p) => p.type === 'renderer').reduce((a, p) => a + p.wsMB, 0), totalMB: p1.procs.reduce((a, p) => a + p.wsMB, 0) }
    result.cpu[name] = row
    log(name, JSON.stringify({ inView: seen.length, kinds: seen.map((x) => x.kind), renderer: row.cpu.renderer, gpu: row.cpu.gpu, procs: row.rendererProcs, mb: row.rendererMB }))
    check(`${name} 视口内小部件都保持活动`, seen.length > 0 && seen.every((x) => x.kind === 'widget:iframe' && row.kindsAfter[x.id] === 'widget:iframe'), seen)
    return row
  }
  await crowdPhase('crowd-view', 0, 8000)
  const crowdTall = await crowdPhase('crowd-tall', Math.max(1500, result.viewport.h), 8000)
  if (crowdTall) check('高视口同屏 5 个以上小部件', crowdTall.inView.length >= 5, crowdTall.inView.length)

  const scrollPhase = async (name, fromId, toId, ms) => {
    if (!ids.includes(fromId) || !ids.includes(toId)) return null
    await scrollTo(fromId)
    await sleep(1500)
    const s0 = sampleProcs(marker)
    const m0 = await cdp.call('Performance.getMetrics')
    const stats = await ev(`(async () => {
      const sc = window.__vg.scroller()
      const first = window.__vg.labelOf(${JSON.stringify(fromId)}), last = window.__vg.find(${JSON.stringify(toId)})
      const top = sc.scrollTop + first.getBoundingClientRect().top - 80
      const bottom = sc.scrollTop + last.getBoundingClientRect().bottom - sc.clientHeight + 40
      const total = ${ms}
      const t0 = performance.now()
      let frames = 0, long = 0, prev = t0, worst = 0, parkedFrames = 0, reserveFrames = 0
      const parkedSeen = []
      const widgetEls = [...document.querySelectorAll('.v3-visual-widget')]
      await new Promise((done) => {
        const step = (now) => {
          frames++
          const gap = now - prev
          if (gap > 50) long++
          worst = Math.max(worst, gap)
          prev = now
          const p = ((now - t0) % 10000) / 10000
          const tri = p < 0.5 ? p * 2 : 2 - p * 2
          const box = sc.getBoundingClientRect()
          let parked = false, reserve = false
          for (const el of widgetEls) {
            const r = el.getBoundingClientRect()
            if (r.bottom <= box.top || r.top >= box.bottom) continue
            const k = window.__vg.kind(el)
            if (k === 'widget:parked' || k === 'widget:paused') { parked = true; if (parkedSeen.length < 8) parkedSeen.push(Math.round(now - t0) + ':' + (window.__vg.idOf ? window.__vg.idOf(el) : k)) }
            else if (k === 'widget:reserve') reserve = true
          }
          if (parked) parkedFrames++
          if (reserve) reserveFrames++
          first.dispatchEvent(new CustomEvent('yan-scroll-intent', { bubbles: true }))
          sc.scrollTop = top + (bottom - top) * tri
          if (now - t0 < total) requestAnimationFrame(step)
          else done()
        }
        requestAnimationFrame(step)
      })
      return { ms: Math.round(performance.now() - t0), frames, fps: Math.round(frames / ((performance.now() - t0) / 1000)), longFrames: long, worstGap: Math.round(worst), span: Math.round(bottom - top), parkedFrames, reserveFrames, parkedSeen }
    })()`)
    const s1 = sampleProcs(marker)
    const m1 = await cdp.call('Performance.getMetrics')
    const row = { ...stats, hostTaskPct: Math.round(((metric(m1, 'TaskDuration') - metric(m0, 'TaskDuration')) / (stats.ms / 1000)) * 1000) / 10, hostLayoutMs: Math.round((metric(m1, 'LayoutDuration') - metric(m0, 'LayoutDuration')) * 1000), hostStyleMs: Math.round((metric(m1, 'RecalcStyleDuration') - metric(m0, 'RecalcStyleDuration')) * 1000), hostScriptMs: Math.round((metric(m1, 'ScriptDuration') - metric(m0, 'ScriptDuration')) * 1000), cpu: cpuDelta(s0, s1), rendererProcs: s1.procs.filter((p) => p.type === 'renderer').length, rendererMB: s1.procs.filter((p) => p.type === 'renderer').reduce((a, p) => a + p.wsMB, 0), totalMB: s1.procs.reduce((a, p) => a + p.wsMB, 0) }
    result.cpu[name] = row
    check(`${name} 滚动中视口内小部件没有显示已暂停`, stats.parkedFrames === 0, { parkedFrames: stats.parkedFrames, reserveFrames: stats.reserveFrames, frames: stats.frames, seen: stats.parkedSeen })
    log(name, JSON.stringify({ fps: row.fps, long: row.longFrames, hostTaskPct: row.hostTaskPct, renderer: row.cpu.renderer, gpu: row.cpu.gpu, procs: row.rendererProcs, mb: row.rendererMB, totalMB: row.totalMB, parked: row.parkedFrames, reserve: row.reserveFrames }))
    return s1
  }
  await scrollPhase('scroll-data', 'chart-bar', 'steps-loop', 10000)
  await scrollPhase('scroll-widgets', 'widget-1', 'invalid-json', 10000)
  const s1 = await scrollPhase('scroll', 'chart-bar', 'invalid-json', scrollMs)
  if (s1) check('滚动采到进程 CPU', s1.procs.length > 0, s1.error)

  report.gallery = { stream: result.stream, focus: result.focus, reducedMotion: result.reducedMotion, cpu: result.cpu }
  writeFileSync(join(dir, `${tag}-results.json`), JSON.stringify(result, null, 1))
}
