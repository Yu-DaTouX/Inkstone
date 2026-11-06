export const SCROLL_HOOK = `
window.__sp = (() => {
  let frames = [], raf = 0, on = false, last = 0, t0 = 0, longs = [], obs = null
  const sample = (now) => {
    if (!on) return
    const stream = document.querySelector('.v3-stream')
    if (stream) {
      const sr = stream.getBoundingClientRect()
      const rows = []
      for (const el of stream.querySelectorAll('.v3-stream-row')) {
        const r = el.getBoundingClientRect()
        const m = el.querySelector('[data-turn-id]')
        rows.push([m ? m.getAttribute('data-turn-id') : el.dataset.rowId || '', r.top - sr.top, r.bottom - sr.top])
      }
      frames.push({ t: now - t0, dt: now - last, st: stream.scrollTop, sh: stream.scrollHeight, vh: stream.clientHeight, rows })
    }
    last = now
    raf = requestAnimationFrame(sample)
  }
  return {
    start() {
      frames = []; longs = []; on = true; t0 = performance.now(); last = t0
      try { obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) longs.push([e.startTime - t0, e.duration]) }); obs.observe({ type: 'longtask' }) } catch {}
      raf = requestAnimationFrame(sample)
    },
    stop() {
      on = false; cancelAnimationFrame(raf); obs && obs.disconnect()
      return { frames, longs }
    }
  }
})()
`

export function scrollStats(raw, { gapPx = 48 } = {}) {
  const { frames, longs } = raw
  let relFrames = 0, relSum = 0, relMax = 0, blank = 0, blankMax = 0, blankAfterContent = 0, jerkMax = 0, jerk100 = 0, vMax = 0
  let content = false, overlapFrames = 0, overlapMax = 0, gapFrames = 0, gapMax = 0
  const dts = frames.slice(1).map((f) => f.dt)
  let prevV = 0
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]
    const sorted = [...f.rows].sort((a, b) => a[1] - b[1])
    if (sorted.length) content = true
    const atBottom = f.sh - f.vh - f.st <= 1
    let gap = 0
    if (!sorted.length) gap = f.vh
    else {
      if (sorted[0][1] > gapPx) gap += Math.min(sorted[0][1], f.vh)
      for (let k = 1; k < sorted.length; k++) {
        const g = sorted[k][1] - sorted[k - 1][2]
        if (g > gapPx && sorted[k - 1][2] < f.vh && sorted[k][1] > 0) gap += g
      }
      const lastBottom = Math.max(...sorted.map((r) => r[2]))
      if (!atBottom && lastBottom < f.vh - gapPx) gap += f.vh - lastBottom
    }
    let ovl = 0, gp = 0
    for (let k = 1; k < sorted.length; k++) {
      if (sorted[k][2] < 0 || sorted[k - 1][1] > f.vh) continue
      const g = sorted[k][1] - sorted[k - 1][2]
      if (-g > ovl) ovl = -g
      if (g > gp) gp = g
    }
    if (ovl > 2) { overlapFrames++; overlapMax = Math.max(overlapMax, ovl) }
    if (gp > 12) { gapFrames++; gapMax = Math.max(gapMax, gp) }
    if (gap > 0) { blank++; blankMax = Math.max(blankMax, Math.round(gap)); if (content) blankAfterContent++ }
    if (i === 0) continue
    const p = frames[i - 1]
    const prev = new Map(p.rows.map((r) => [r[0], r]))
    const d = []
    for (const r of f.rows) {
      if (!r[0]) continue
      const q = prev.get(r[0])
      if (!q) continue
      if (r[2] < 0 || r[1] > f.vh || q[2] < 0 || q[1] > p.vh) continue
      d.push(r[1] - q[1])
    }
    if (!d.length) { prevV = 0; continue }
    const ds = [...d].sort((a, b) => a - b)
    const v = ds[ds.length >> 1]
    const rel = Math.max(...d.map((x) => Math.abs(x - v)))
    if (rel > 2) { relFrames++; relSum += rel; relMax = Math.max(relMax, rel) }
    vMax = Math.max(vMax, Math.abs(v))
    const jerk = Math.abs(v - prevV)
    jerkMax = Math.max(jerkMax, jerk)
    if (jerk > 100) jerk100++
    prevV = v
  }
  const sorted = [...dts].sort((a, b) => a - b)
  return {
    frames: frames.length,
    relShiftFrames: relFrames, relShiftSumPx: Math.round(relSum), relShiftMaxPx: Math.round(relMax),
    overlapFrames, overlapMaxPx: Math.round(overlapMax), gapFrames, gapMaxPx: Math.round(gapMax), blankFrames: blank, blankAfterContent, blankMaxPx: Math.round(blankMax),
    vMaxPx: Math.round(vMax), jerkMaxPx: Math.round(jerkMax), jerkOver100: jerk100,
    maxFrameMs: Math.round(Math.max(0, ...dts)), p95Ms: Math.round(sorted[Math.floor(sorted.length * .95)] ?? 0),
    over33: dts.filter((x) => x > 33.4).length, over50: dts.filter((x) => x > 50).length,
    longTasks: longs.length, maxLongMs: Math.round(Math.max(0, ...longs.map((l) => l[1]))),
    shStart: Math.round(frames[0]?.sh ?? 0), shEnd: Math.round(frames.at(-1)?.sh ?? 0), stEnd: Math.round(frames.at(-1)?.st ?? 0)
  }
}
