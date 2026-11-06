import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export async function startProfile(cdp) {
  await cdp.call('Profiler.enable')
  await cdp.call('Profiler.setSamplingInterval', { interval: 200 })
  await cdp.call('Profiler.start')
}

export async function stopProfile(cdp, outDir, top = 25) {
  const { result } = await cdp.call('Profiler.stop')
  const profile = result.profile
  const { TraceMap, originalPositionFor } = require('@jridgewell/trace-mapping')
  const maps = new Map()
  const mapFor = (url) => {
    if (maps.has(url)) return maps.get(url)
    let tm = null
    try {
      const file = decodeURIComponent(url.replace(/^file:\/\/\//, '')) + '.map'
      if (existsSync(file)) tm = new TraceMap(readFileSync(file, 'utf8'))
    } catch {}
    maps.set(url, tm)
    return tm
  }
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const self = new Map()
  const dt = profile.timeDeltas
  for (let i = 0; i < profile.samples.length; i++) self.set(profile.samples[i], (self.get(profile.samples[i]) ?? 0) + (dt[i] ?? 0))
  const rows = new Map()
  for (const [id, us] of self) {
    const n = byId.get(id)
    const cf = n.callFrame
    let where = `${cf.url.split('/').pop()}:${cf.lineNumber + 1}`
    const tm = cf.url ? mapFor(cf.url) : null
    if (tm) {
      const o = originalPositionFor(tm, { line: cf.lineNumber + 1, column: cf.columnNumber })
      if (o.source) where = `${o.source.split('/').slice(-2).join('/')}:${o.line}`
    }
    const key = `${cf.functionName || '(anon)'} ${where}`
    rows.set(key, (rows.get(key) ?? 0) + us)
  }
  const where = (cf) => {
    let w = `${cf.url.split('/').pop()}:${cf.lineNumber + 1}`
    const tm = cf.url ? mapFor(cf.url) : null
    if (tm) {
      const o = originalPositionFor(tm, { line: cf.lineNumber + 1, column: cf.columnNumber })
      if (o.source) w = `${o.source.split('/').slice(-2).join('/')}:${o.line}`
    }
    return `${cf.functionName || '(anon)'} ${w}`
  }
  const segments = []
  let at = profile.startTime
  let seg = null
  for (let i = 0; i < profile.samples.length; i++) {
    at += dt[i] ?? 0
    const n = byId.get(profile.samples[i])
    const idle = n.callFrame.functionName === '(idle)'
    if (!idle) {
      if (!seg) seg = { start: at - (dt[i] ?? 0), end: at, fns: new Map() }
      seg.end = at
      const k = where(n.callFrame)
      seg.fns.set(k, (seg.fns.get(k) ?? 0) + (dt[i] ?? 0))
    } else if (seg && at - seg.end > 3000) {
      segments.push(seg)
      seg = null
    }
  }
  if (seg) segments.push(seg)
  const longBusy = segments.filter((x) => x.end - x.start > 40000).sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, 8).map((x) => ({ atMs: Math.round((x.start - profile.startTime) / 1000), ms: Math.round((x.end - x.start) / 1000), top: [...x.fns].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, us]) => `${k} ${Math.round(us / 1000)}ms`) }))
  const total = [...rows.values()].reduce((a, b) => a + b, 0)
  const list = [...rows].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, us]) => ({ fn: k, ms: Math.round(us / 100) / 10 }))
  return { totalMs: Math.round(total / 100) / 10, top: list, longBusy, profile }
}
