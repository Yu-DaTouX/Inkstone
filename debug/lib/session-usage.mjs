import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
const dir = process.argv[2]
const files = []
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : n.endsWith('.jsonl') && files.push(p) } }
walk(dir)
const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 }
let ws = 0
for (const f of files) for (const line of readFileSync(f, 'utf8').split('\n')) {
  if (!line.trim()) continue
  let j; try { j = JSON.parse(line) } catch { continue }
  const m = j.message ?? j
  if (/yanWebSearch/.test(line)) ws++
  const u = m?.usage
  if (m?.role === 'assistant' && u) { t.calls++; t.input += u.input ?? 0; t.output += u.output ?? 0; t.cacheRead += u.cacheRead ?? 0; t.cacheWrite += u.cacheWrite ?? 0; t.cost += u.cost?.total ?? 0 }
}
console.log(JSON.stringify({ files: files.length, ...t, cost: +t.cost.toFixed(4), yanWebSearch: ws }))
