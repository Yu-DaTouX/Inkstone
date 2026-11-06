import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const meta = { description: '回答内容流式渲染：连续采样最后一条助手消息的高度、块高、表格列宽、代码着色、文字出现节奏、被替换的 DOM 节点与布局位移，结束瞬间单独统计（MD_TRIGGER 选触发词，默认 MDSHOW）' }

const PROBE = String.raw`(() => {
  if (window.__md) return true
  const st = window.__yanStore
  const m = window.__md = { t0: performance.now(), frames: [], marks: [], shifts: [], removed: {}, added: {}, fade: { added: 0, removed: 0 }, mutBatches: [] }
  const now = () => Math.round((performance.now() - m.t0) * 10) / 10
  const last = () => { const xs = document.querySelectorAll('.v3-msg.assistant'); return xs[xs.length - 1] || null }
  const key = (n) => n.tagName.toLowerCase() + (typeof n.className === 'string' && n.className ? '.' + n.className.split(' ')[0] : '')
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) m.shifts.push({ t: Math.round(e.startTime - m.t0), value: e.value, input: e.hadRecentInput, sources: (e.sources || []).slice(0, 3).map((s) => ({ node: s.node && s.node.nodeType === 1 ? key(s.node) : String(s.node && s.node.nodeName), dy: Math.round(s.currentRect.y - s.previousRect.y), dh: Math.round(s.currentRect.height - s.previousRect.height) })) })
  }).observe({ type: 'layout-shift', buffered: false })
  const root = document.querySelector('.v3-stream')
  const walkCount = (node, into, sign) => {
    if (node.nodeType !== 1) return
    if (node.classList.contains('v3-fade')) { m.fade[sign] += 1; return }
    const k = key(node)
    into[k] = (into[k] || 0) + 1
    for (const c of node.children) walkCount(c, into, sign)
  }
  const obs = new MutationObserver((records) => {
    const msg = last()
    const t = now()
    let removedEls = 0
    for (const r of records) {
      if (msg && !msg.contains(r.target)) continue
      for (const n of r.removedNodes) { walkCount(n, m.removed, 'removed'); if (n.nodeType === 1 && !n.classList.contains('v3-fade')) removedEls += 1 }
      for (const n of r.addedNodes) walkCount(n, m.added, 'added')
    }
    if (removedEls) m.mutBatches.push({ t, removedEls })
  })
  obs.observe(root, { childList: true, subtree: true })
  let running = false
  st.subscribe((s) => {
    const r = !!(s.session && (s.session.isStreaming || s.session.isAgentRunning))
    if (r !== running) { running = r; m.marks.push({ t: now(), kind: r ? 'run' : 'done' }) }
  })
  let lastT = performance.now()
  const r1 = (v) => Math.round(v * 10) / 10
  const tick = (ts) => {
    const msg = last()
    if (msg) {
      const proses = msg.querySelectorAll('.v3-prose')
      const prose = proses[proses.length - 1] || null
      const blocks = prose ? [...prose.children].map((el) => ({ tag: el.tagName.toLowerCase() + (el.classList.contains('v3-code') ? '.code' : el.querySelector(':scope > table') ? '.table' : ''), h: r1(el.getBoundingClientRect().height) })) : []
      const tables = [...msg.querySelectorAll('table')].map((tb) => [...tb.querySelectorAll('tr:first-child > *')].map((c) => r1(c.getBoundingClientRect().width)))
      const codes = [...msg.querySelectorAll('.v3-code pre')].map((pre) => ({ h: r1(pre.getBoundingClientRect().height), tok: pre.querySelectorAll('[class*=hljs-]').length, len: pre.textContent.length }))
      const visual = [...msg.querySelectorAll('.v3-visual-pending, .v3-mermaid, [data-testid=v3-mermaid], .v3-visual-widget, .katex-display')].map((el) => ({ c: key(el), h: r1(el.getBoundingClientRect().height) }))
      const imgs = [...msg.querySelectorAll('img')].map((el) => ({ h: r1(el.getBoundingClientRect().height), ok: el.complete && el.naturalWidth > 0 }))
      const body = msg.querySelector('.v3-assistant-body')
      const sig = body ? [...body.children].map((el) => (typeof el.className === 'string' ? el.className.split(' ')[0] : el.tagName) + ':' + r1(el.getBoundingClientRect().height)).join(' | ') : ''
      const raw = prose ? prose.innerText : ''
      const lit = { strong: raw.includes('**'), link: raw.includes(']('), fence: raw.includes(String.fromCharCode(96, 96, 96)), math: raw.includes('$$'), pipe: /^\s*\|/m.test(raw), head: /^\s*#{1,6}\s*$/m.test(raw), bullet: /^\s*[-*+>]\s*$/m.test(raw), tilde: raw.includes('~~') }
      const pb = msg.querySelector('.v3-process-body')
      const proc = pb ? [...pb.querySelectorAll(':scope > * > *')].map((el) => (typeof el.className === 'string' ? el.className.split(' ')[0] : el.tagName) + ':' + r1(el.getBoundingClientRect().height) + ':' + (el.innerText || '').slice(0, 12).split(String.fromCharCode(10)).join(' ')).join(' | ') : ''
      m.frames.push({ t: now(), proc, lit, act: document.querySelectorAll('.v3-stream [data-testid=v3-turn-activity]').length, pend: document.querySelectorAll('.v3-stream [data-testid=v3-pending]').length, sig, gap: r1(ts - lastT), h: r1(msg.getBoundingClientRect().height), chars: prose ? prose.textContent.length : 0, blocks, tables, codes, visual, imgs, katex: msg.querySelectorAll('.katex').length, katexErr: msg.querySelectorAll('.katex-error').length, imgAlt: msg.querySelectorAll('.v3-md-image-alt').length, links: msg.querySelectorAll('a.v3-md-link').length })
    }
    if (m.frames.length && m.frames[m.frames.length - 1].act === 0) { const g = st.getState(); m.actGone = m.actGone || []; if (m.actGone.length < 12) m.actGone.push({ t: now(), streaming: !!g.session?.isStreaming, agent: !!g.session?.isAgentRunning, tail: g.messages.slice(-3).map((x) => x.role + ':' + (x.toolCalls ? x.toolCalls.length : 0) + ':' + x.id.slice(-6)), runTail: g.runTail ? g.runTail.id.slice(-6) : null }) }
    lastT = ts
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  return true
})()`

function stats(arr) {
  if (!arr.length) return { n: 0 }
  const s = [...arr].sort((a, b) => a - b)
  return { n: s.length, max: s[s.length - 1], p95: s[Math.floor(s.length * 0.95)], med: s[Math.floor(s.length / 2)] }
}

function analyze(frames, from, to) {
  const fs = frames.filter((f) => f.t >= from && f.t <= to)
  const out = { frames: fs.length }
  const dh = []
  let shrinkFrames = 0
  let shrinkPx = 0
  for (let i = 1; i < fs.length; i++) {
    const d = fs[i].h - fs[i - 1].h
    dh.push(d)
    if (d < -0.5) { shrinkFrames++; shrinkPx += -d }
  }
  out.heightDelta = { maxGrow: +Math.max(0, ...dh).toFixed(1), maxShrink: +Math.max(0, ...dh.map((d) => -d)).toFixed(1), shrinkFrames, shrinkPx: +shrinkPx.toFixed(1), over40: dh.filter((d) => Math.abs(d) > 40).length }
  let blockShrink = 0
  let blockShrinkPx = 0
  const blockShrinkBy = {}
  for (let i = 1; i < fs.length; i++) {
    const a = fs[i - 1].blocks
    const b = fs[i].blocks
    for (let k = 0; k < Math.min(a.length, b.length); k++) {
      if (a[k].tag !== b[k].tag) { const key = 'retag:' + a[k].tag + '>' + b[k].tag; blockShrinkBy[key] = (blockShrinkBy[key] || 0) + 1; continue }
      const d = b[k].h - a[k].h
      if (d < -0.5) { blockShrink++; blockShrinkPx += -d; blockShrinkBy[b[k].tag] = (blockShrinkBy[b[k].tag] || 0) + 1 }
    }
  }
  out.blockShrink = { frames: blockShrink, px: +blockShrinkPx.toFixed(1), by: blockShrinkBy }
  let colChanges = 0
  let colPx = 0
  let colFrames = 0
  for (let i = 1; i < fs.length; i++) {
    const a = fs[i - 1].tables
    const b = fs[i].tables
    let changed = false
    for (let k = 0; k < Math.min(a.length, b.length); k++) {
      if (a[k].length !== b[k].length) continue
      for (let c = 0; c < a[k].length; c++) {
        const d = Math.abs(b[k][c] - a[k][c])
        if (d > 0.5) { colChanges++; colPx += d; changed = true }
      }
    }
    if (changed) colFrames++
  }
  out.tableCols = { frames: colFrames, changes: colChanges, px: +colPx.toFixed(1) }
  let tokDrop = 0
  let tokJump = 0
  for (let i = 1; i < fs.length; i++) {
    const a = fs[i - 1].codes
    const b = fs[i].codes
    for (let k = 0; k < Math.min(a.length, b.length); k++) {
      if (b[k].tok < a[k].tok) tokDrop++
      if (b[k].tok - a[k].tok > 12) tokJump++
    }
  }
  out.codeColor = { tokenDrops: tokDrop, tokenJumps: tokJump }
  const grow = []
  for (let i = 1; i < fs.length; i++) grow.push(fs[i].chars - fs[i - 1].chars)
  out.charsPerFrame = stats(grow.filter((g) => g > 0))
  out.stallFrames = (() => { let longest = 0; let cur = 0; for (const g of grow) { if (g === 0) { cur++; longest = Math.max(longest, cur) } else cur = 0 } return longest })()
  out.frameGap = stats(fs.map((f) => f.gap))
  const changes = []
  const lastVisual = new Map()
  for (const f of fs) {
    f.visual.forEach((v, i) => {
      const prev = lastVisual.get(i)
      if (prev && (prev.c !== v.c || Math.abs(prev.h - v.h) > 1)) changes.push({ t: f.t, i, from: prev.c + '@' + prev.h, to: v.c + '@' + v.h })
      lastVisual.set(i, v)
    })
  }
  out.visualChanges = changes.slice(0, 12)
  const img = []
  for (let i = 1; i < fs.length; i++) {
    const a = fs[i - 1].imgs
    const b = fs[i].imgs
    for (let k = 0; k < Math.min(a.length, b.length); k++) if (a[k].h !== b[k].h) img.push({ t: fs[i].t, from: a[k].h, to: b[k].h })
  }
  out.imageHeightChanges = img.slice(0, 8)
  out.literalFrames = Object.fromEntries(['strong', 'link', 'fence', 'math', 'pipe', 'head', 'bullet', 'tilde'].map((k) => [k, fs.filter((f) => f.lit && f.lit[k]).length]))
  return out
}

export default async function run({ box, cdp, newSession, check, sleep, shot, report, runDir, state, autoApprove }) {
  const tag = process.env.MD_TAG || 'run'
  const trigger = process.env.MD_TRIGGER || 'MDSHOW'
  const ev = (expr) => cdp.evaluate(expr)
  const burstDir = join(runDir, `burst-${tag}`)
  mkdirSync(burstDir, { recursive: true })
  mkdirSync(join(box.project, 'fig'), { recursive: true })
  copyFileSync(join(import.meta.dirname, '../../assets/inkstone/workspace-dark.png'), join(box.project, 'fig/pic.png'))
  await autoApprove()
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN', reduceMotion: false })`)
  await newSession()
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(1500)
  await ev(PROBE)
  await cdp.call('Performance.enable')
  const metrics = async () => Object.fromEntries((await cdp.call('Performance.getMetrics')).result.metrics.map((x) => [x.name, x.value]))
  const cpu0 = await metrics()
  await ev(`window.__md.marks.push({ t: Math.round(performance.now() - window.__md.t0), kind: 'send' })`)
  const sent = await ev(`window.__yanStore.getState().send(${JSON.stringify('请处理 ' + trigger)})`)
  if (sent === false) throw new Error('发送失败')
  const snapEvery = Number(process.env.MD_SNAP_MS || 0)
  let n = 0
  const end = Date.now() + 150000
  let doneAt = 0
  let started = false
  while (Date.now() < end) {
    const r = await state(`!!(s.session?.isStreaming || s.session?.isAgentRunning)`)
    if (r) started = true
    if (snapEvery && started && n < 400) {
      const res = await cdp.call('Page.captureScreenshot', { format: 'jpeg', quality: 60 })
      writeFileSync(join(burstDir, `${String(n++).padStart(3, '0')}.jpg`), Buffer.from(res.result.data, 'base64'))
      await sleep(snapEvery)
    } else await sleep(40)
    if (started && !r) {
      if (!doneAt) doneAt = Date.now()
      if (Date.now() - doneAt > 2000) break
    }
  }
  const cpu1 = await metrics()
  await sleep(500)
  await shot(`${tag}-done`)
  const md = await ev('window.__md')
  const send = md.marks.find((x) => x.kind === 'send')?.t ?? 0
  const done = md.marks.filter((x) => x.kind === 'done').at(-1)?.t ?? Infinity
  const live = analyze(md.frames, send, done)
  const settle = analyze(md.frames, done - 50, done + 1500)
  const doneShifts = md.shifts.filter((s) => !s.input && s.t >= done - 50 && s.t <= done + 1500)
  const liveShifts = md.shifts.filter((s) => !s.input && s.t >= send && s.t < done - 50)
  const sum = (xs) => +xs.reduce((a, s) => a + s.value, 0).toFixed(4)
  const result = {
    trigger,
    cpuMs: Object.fromEntries(['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'].map((k) => [k, Math.round((cpu1[k] - cpu0[k]) * 1000)])),
    live,
    settle,
    shifts: { live: { count: liveShifts.length, total: sum(liveShifts), nodes: [...new Set(liveShifts.flatMap((s) => s.sources.map((x) => x.node)))].slice(0, 8) }, settle: { count: doneShifts.length, total: sum(doneShifts), nodes: [...new Set(doneShifts.flatMap((s) => s.sources.map((x) => x.node)))].slice(0, 8) } },
    removedElements: md.removed,
    addedElements: md.added,
    fadeSpans: md.fade,
    removedBatches: md.mutBatches.length,
    removedAtSettle: md.mutBatches.filter((b) => b.t >= done - 50).length
  }
  report.md = result
  writeFileSync(join(runDir, `md-${tag}.json`), JSON.stringify({ actGone: md.actGone, result, frames: md.frames, shifts: md.shifts, marks: md.marks, mutBatches: md.mutBatches }))
  console.log(JSON.stringify(result, null, 1))
  check('回合结束', Number.isFinite(done))
}
