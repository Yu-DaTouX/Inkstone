/**
 * 未使用的 i18n 键报告（B6 瘦身）。
 *
 * 保守口径：
 *   · 精确命中（代码里出现 `'set.theme'` / `"set.theme"`）算用了；
 *   · 动态前缀（代码里有 `t(\`set.ctxField.${k}\`)`）算用了 —— 从源码里抠出
 *     `` `前缀.${ `` 这种模板，凡是以该前缀开头的键都放行；
 *   · 其它一律报出来（**只报告，不自动删**：误删会让界面显示键名）。
 *
 * 用法： node scripts/report-unused-i18n.mjs [--json]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const LOCALES = ['src/renderer/src/i18n/zh-CN.json', 'src/renderer/src/i18n/en-US.json']

const files = []
;(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'out' || entry === 'release' || entry === '.git') continue
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) walk(p)
    else if (/\.(ts|tsx|mjs|cjs|js|json|md)$/.test(entry) && !LOCALES.some((l) => p.endsWith(l.replace(/\//g, '\\')) || p.endsWith(l))) {
      files.push(p)
    }
  }
})(ROOT)

const sources = files.map((f) => ({ path: f, text: readFileSync(f, 'utf8') }))

/* 动态前缀：`xxx.${` */
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
