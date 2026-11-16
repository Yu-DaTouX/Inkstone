import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const out = outIndex >= 0 ? args.splice(outIndex, 2)[1] : null
const root = join(import.meta.dirname, 'runs')

function resolveDirs(selector) {
  if (selector.includes('/') || selector.includes('\\')) return [selector]
  return readdirSync(root).filter((name) => name.endsWith(`-${selector}`) || name.includes(selector)).sort().map((name) => join(root, name))
}

function flatten(value, prefix, into) {
  if (typeof value === 'number' && Number.isFinite(value)) into[prefix] = value
  else if (Array.isArray(value)) value.forEach((item, index) => { if (typeof item === 'number') into[`${prefix}[${index}]`] = item })
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) flatten(item, prefix ? `${prefix}.${key}` : key, into)
}

const median = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null
}

const dirs = args.flatMap(resolveDirs)
const rows = []
for (const dir of dirs) {
  try {
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'))
    const flat = {}
    flatten(report.timings, '', flat)
    rows.push({ dir, flat })
  } catch {}
}
const keys = [...new Set(rows.flatMap((row) => Object.keys(row.flat)))].sort()
const lines = ['| 指标 | 中位 | 各次 |', '| --- | --- | --- |']
const summary = {}
for (const key of keys) {
  const values = rows.map((row) => row.flat[key]).filter((x) => x !== undefined)
  summary[key] = { median: median(values), values }
  lines.push(`| ${key} | ${median(values)} | ${values.join(' / ')} |`)
}
console.log(`运行数 ${rows.length}\n${lines.join('\n')}`)
if (out) writeFileSync(out, JSON.stringify({ runs: rows.map((r) => r.dir), summary }, null, 2))
