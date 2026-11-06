export const FX_HOOK = `
window.__fx = (() => {
  let frames = [], shifts = [], longs = [], raf = 0, on = false, t0 = 0, last = 0, mode = 'sidebar'
  const state = () => window.__yanStore.getState()
  const squash = (text) => text.split(/\\s+/).join(' ').trim()
  const sample = (now) => {
    if (!on) return
    const rec = { t: Math.round((now - t0) * 10) / 10, dt: Math.round((now - last) * 10) / 10 }
    last = now
    if (mode === 'sidebar') {
      const rows = []
      for (const el of document.querySelectorAll('[data-sidebar-row]')) {
        const r = el.getBoundingClientRect()
        rows.push([el.dataset.sidebarRow, Math.round(r.top * 10) / 10, Math.round(r.height), squash(el.innerText), (el.closest('li') || el).offsetTop])
      }
      rec.rows = rows
      rec.drafts = [...document.querySelectorAll('[data-testid="sidebar-draft-row"]')].map((d) => { const r = d.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)] })
      const aside = document.querySelector('aside.v3-side')
      const scroller = aside ? [...aside.querySelectorAll('*')].find((n) => n.scrollHeight > n.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(n).overflowY)) : null
      rec.sc = scroller ? Math.round(scroller.scrollTop) : -1
    } else if (mode === 'switch') {
      const s = state()
      const stream = document.querySelector('.v3-stream')
      const turns = stream ? stream.querySelectorAll('[data-turn-id]') : []
      const composer = document.querySelector('[data-testid="composer-v3"]')
      const pm = document.querySelector('.ProseMirror')
      const skel = document.querySelector('[data-testid="v3-switch-skeleton"]')
      rec.file = (s.session && s.session.sessionFile) || null
      rec.peek = s.peekedPath || null
      rec.loading = !!s.switchLoading
      rec.msgs = s.messages.length
      rec.models = s.models ? s.models.length : -1
      rec.sess = !!s.session
      rec.model = s.session && s.session.model ? (s.session.model.id || s.session.model.name || '?') : null
      rec.skel = !!skel
      rec.skelOp = skel ? Number(getComputedStyle(skel).opacity) : null
      rec.turns = turns.length
      rec.first = turns.length ? turns[0].getAttribute('data-turn-id') : null
      rec.last = turns.length ? turns[turns.length - 1].getAttribute('data-turn-id') : null
      rec.top = stream ? Math.round(stream.scrollTop) : -1
      rec.h = stream ? Math.round(stream.scrollHeight) : -1
      rec.cmp = composer ? squash(composer.innerText).slice(0, 160) : null
      rec.pm = pm ? pm.textContent.slice(0, 60) : null
    }
    frames.push(rec)
    raf = requestAnimationFrame(sample)
  }
  let lsObs = null, ltObs = null
  return {
    start(m) {
      mode = m || 'sidebar'; frames = []; shifts = []; longs = []; on = true
      t0 = performance.now(); last = t0
      try {
        lsObs = new PerformanceObserver((l) => {
          for (const e of l.getEntries()) {
            shifts.push({ t: Math.round(e.startTime - t0), v: e.value, src: (e.sources || []).map((x) => {
              const n = x.node
              const el = n && n.nodeType === 1 ? n : n && n.parentElement
              return el ? (el.closest('aside.v3-side') ? 'side' : el.closest('.v3-stream') ? 'stream' : el.closest('[data-testid="composer-v3"]') ? 'composer' : 'other') : '?'
            }) })
          }
        })
        lsObs.observe({ type: 'layout-shift', buffered: false })
      } catch {}
      try {
        ltObs = new PerformanceObserver((l) => { for (const e of l.getEntries()) longs.push({ t: Math.round(e.startTime - t0), d: Math.round(e.duration) }) })
        ltObs.observe({ type: 'longtask' })
      } catch {}
      raf = requestAnimationFrame(sample)
    },
    stop() {
      on = false; cancelAnimationFrame(raf)
      try { lsObs && lsObs.disconnect() } catch {}
      try { ltObs && ltObs.disconnect() } catch {}
      return { frames, shifts, longs }
    }
  }
})()
`

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0)

export function frameStats(frames) {
  const dts = frames.slice(1).map((f) => f.dt).sort((a, b) => a - b)
  return {
    frames: frames.length,
    spanMs: frames.length ? Math.round(frames.at(-1).t) : 0,
    dtMax: Math.round(dts.at(-1) ?? 0),
    dtP95: Math.round(pct(dts, 0.95)),
    over34: dts.filter((d) => d > 34).length,
    over50: dts.filter((d) => d > 50).length,
    over100: dts.filter((d) => d > 100).length
  }
}

export function sidebarStats(frames, shifts, longs) {
  const out = { ...frameStats(frames) }
  let reorderEvents = 0
  let membership = 0
  const reorderFirstFrame = []
  const scrollJumps = []
  let moveFrames = 0
  const sigHist = new Map()
  const sigChanges = new Map()
  let blankFlashes = 0
  let heightChanges = 0
  const bigSteps = []
  let maxStep = 0
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]
    const b = frames[i]
    const prev = new Map(a.rows.map((r) => [r[0], r]))
    const common = b.rows.filter((r) => prev.has(r[0]))
    const commonSet = new Set(common.map((r) => r[0]))
    const orderA = a.rows.filter((r) => commonSet.has(r[0])).map((r) => r[0]).join('|')
    const orderB = common.map((r) => r[0]).join('|')
    const added = b.rows.length - common.length
    const removed = a.rows.length - common.length
    let step = 0
    let moved = 0
    for (const r of common) {
      const p = prev.get(r[0])
      const d = Math.abs(r[1] - p[1])
      step = Math.max(step, d)
      if (d > 0.5) moved++
      if (p[3] && !r[3]) blankFlashes++
      if (r[2] !== p[2] && r[0].startsWith('local:')) heightChanges++
      if (r[3] !== p[3]) {
        const hist = sigHist.get(r[0]) ?? []
        hist.push({ t: b.t, sig: r[3] })
        sigHist.set(r[0], hist)
        sigChanges.set(r[0], (sigChanges.get(r[0]) ?? 0) + 1)
      }
    }
    if (orderA !== orderB) {
      reorderEvents++
      reorderFirstFrame.push({ t: Math.round(b.t), px: Math.round(step * 10) / 10 })
    }
    if (added || removed) membership++
    if (step > 0.5) moveFrames++
    maxStep = Math.max(maxStep, step)
    if (step >= 16) bigSteps.push({ t: Math.round(b.t), px: Math.round(step), rows: moved })
    if (b.sc >= 0 && a.sc >= 0 && Math.abs(b.sc - a.sc) > 80) scrollJumps.push({ t: Math.round(b.t), d: b.sc - a.sc })
  }
  const flips = []
  for (const [key, hist] of sigHist) {
    for (let i = 2; i < hist.length; i++) {
      if (hist[i].sig === hist[i - 2].sig && hist[i].t - hist[i - 2].t < 600) {
        flips.push({ key: key.slice(-8), at: Math.round(hist[i].t), a: hist[i - 1].sig.slice(0, 50), b: hist[i].sig.slice(0, 50) })
      }
    }
  }
  out.blankRowFlashes = blankFlashes
  out.rowHeightChanges = heightChanges
  out.reorderEvents = reorderEvents
  out.membershipChanges = membership
  out.reorderFirstFrame = reorderFirstFrame.slice(0, 12)
  out.maxRowStepPx = Math.round(maxStep)
  out.bigSteps16 = bigSteps.length
  out.bigStepSamples = bigSteps.slice(0, 12)
  out.rowMoveFrames = moveFrames
  out.scrollJumps = scrollJumps.slice(0, 10)
  out.rowTextChanges = [...sigChanges.values()].reduce((x, y) => x + y, 0)
  out.rowTextChangesTop = [...sigChanges].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, n]) => ({ key: k.slice(-8), n }))
  out.flipFlops = flips.length
  out.flipFlopSamples = flips.slice(0, 8)
  out.layoutShiftSide = Math.round(shifts.filter((s) => s.src.includes('side')).reduce((x, s) => x + s.v, 0) * 1000) / 1000
  out.layoutShiftAll = Math.round(shifts.reduce((x, s) => x + s.v, 0) * 1000) / 1000
  out.longTasks = longs.length
  out.longTaskMax = Math.max(0, ...longs.map((l) => l.d))
  return out
}

export function switchStats(frames, target) {
  const base = frameStats(frames)
  const readyIdx = frames.findIndex((f) => f.peek === target.path && f.turns > 0 && !f.loading)
  const attachedIdx = frames.findIndex((f) => f.file === target.file)
  const stale = frames.filter((f, i) => i > 0 && f.turns > 0 && f.peek && f.peek !== target.path).length
  const blank = frames.filter((f, i) => i > 0 && f.turns === 0 && !f.loading && !f.skel).length
  const composerChanges = []
  let prevCmp = frames[0]?.cmp
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].cmp !== prevCmp) {
      composerChanges.push({ t: Math.round(frames[i].t), cmp: String(frames[i].cmp).slice(0, 70) })
      prevCmp = frames[i].cmp
    }
  }
  const contentChanges = []
  let prevKey = null
  for (const f of frames) {
    const k = `${f.first}|${f.last}|${f.turns}`
    if (k !== prevKey) {
      contentChanges.push({ t: Math.round(f.t), k: k.slice(0, 60) })
      prevKey = k
    }
  }
  const topChanges = []
  let prevTop = null
  for (const f of frames) {
    if (prevTop !== null && Math.abs(f.top - prevTop) > 4 && f.turns > 0) topChanges.push({ t: Math.round(f.t), from: prevTop, to: f.top })
    prevTop = f.top
  }
  return {
    ...base,
    readyMs: readyIdx >= 0 ? Math.round(frames[readyIdx].t) : null,
    sessionAttachedMs: attachedIdx >= 0 ? Math.round(frames[attachedIdx].t) : null,
    providerFlashFrames: frames.filter((f) => f.cmp && f.cmp.includes('提供商设置')).length,
    emptyModelFrames: frames.filter((f) => f.models === 0).length,
    staleFrames: stale,
    blankFrames: blank,
    skeletonFrames: frames.filter((f) => f.skel).length,
    skeletonVisibleFrames: frames.filter((f) => f.skel && f.skelOp > 0.05).length,
    contentChanges: contentChanges.length,
    contentChangeSamples: contentChanges.slice(0, 8),
    composerChanges: composerChanges.length,
    composerChangeSamples: composerChanges.slice(0, 6),
    scrollTopChanges: topChanges.length,
    scrollTopSamples: topChanges.slice(0, 6)
  }
}
