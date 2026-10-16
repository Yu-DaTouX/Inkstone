import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const LOCALES = ['src/renderer/src/i18n/zh-CN.json', 'src/renderer/src/i18n/en-US.json']
const SCAN_DIRS = ['src', 'resources', 'scripts']

const files = []
for (const dir of SCAN_DIRS) {
  ;(function walk(d) {
    for (const entry of readdirSync(d)) {
      if (entry === 'node_modules') continue
      const p = join(d, entry)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (/\.(ts|tsx|mjs|cjs|js|json|md)$/.test(entry) && !LOCALES.includes(p.replace(/\\/g, '/'))) files.push(p)
    }
  })(dir)
}

const sources = files.map((f) => ({ path: f, text: readFileSync(f, 'utf8') }))

const prefixes = new Set()
for (const s of sources) {
  for (const m of s.text.matchAll(/`([a-zA-Z][\w.]*)\.\$\{/g)) prefixes.add(m[1] + '.')
}

const zh = JSON.parse(readFileSync(join(ROOT, LOCALES[0]), 'utf8'))
const en = JSON.parse(readFileSync(join(ROOT, LOCALES[1]), 'utf8'))

const unused = []
for (const key of Object.keys(zh)) {
  const hit = sources.some((s) => s.text.includes(`'${key}'`) || s.text.includes(`"${key}"`))
  if (hit) continue
  if ([...prefixes].some((p) => key.startsWith(p))) continue
  unused.push(key)
}

const onlyZh = Object.keys(zh).filter((k) => !(k in en))
const onlyEn = Object.keys(en).filter((k) => !(k in zh))

const report = {
  totals: { zh: Object.keys(zh).length, en: Object.keys(en).length },
  unusedCount: unused.length,
  unused,
  missingInEn: onlyZh,
  missingInZh: onlyEn,
  dynamicPrefixes: [...prefixes].sort()
}

if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2))
else {
  console.log(`键数 zh=${report.totals.zh} en=${report.totals.en}`)
  console.log(`未使用 ${unused.length} 个：`)
  for (const k of unused) console.log('  ' + k)
  console.log(`只有 zh 没有 en：${onlyZh.length} · 只有 en 没有 zh：${onlyEn.length}（应为 0）`)
}
