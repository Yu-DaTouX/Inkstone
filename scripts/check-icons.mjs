import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SRC = join(ROOT, 'src/renderer/src')
const TS = join(SRC, 'icons/sprite.ts')

const problems = []
const catalog = JSON.parse(readFileSync(join(HERE, 'design/icons/catalog.json'), 'utf8'))
const ts = readFileSync(TS, 'utf8')

const semanticToLib = new Map()
for (const [semantic, def] of Object.entries(catalog.icons)) {
  if (semanticToLib.has(def.name)) {
    problems.push(`语义混用：${def.name} 被 ${semanticToLib.get(def.name)} 与 ${semantic} 同时借用`)
  } else {
    semanticToLib.set(def.name, semantic)
  }
  if (!def.use) problems.push(`编目缺用途说明：${semantic}`)
}

const namesBlock = ts.match(/export const ICON_NAMES = (\[[\s\S]*?\]) as const/)
if (!namesBlock) {
  problems.push('sprite.ts 里找不到 ICON_NAMES')
} else {
  const names = JSON.parse(namesBlock[1])
  const want = Object.keys(catalog.icons).sort()
  const missing = want.filter((n) => !names.includes(n))
  const extra = names.filter((n) => !want.includes(n))
  if (missing.length) problems.push(`ICON_NAMES 缺少：${missing.join(', ')}`)
  if (extra.length) problems.push(`ICON_NAMES 多出：${extra.join(', ')}`)
}

try {
  execFileSync(process.execPath, [join(HERE, 'design/icons/build-icons.mjs'), '--check'], { stdio: 'pipe' })
} catch (e) {
  const out = String(e.stdout || '') + String(e.stderr || '')
  problems.push('生成物与 catalog 不一致，请跑 npm run icons：\n     ' + out.trim().split('\n').join('\n     '))
}

const sprite = ts.match(/export const ICON_SPRITE = "((?:[^"\\]|\\.)*)"/)
if (!sprite) {
  problems.push('sprite.ts 里找不到 ICON_SPRITE')
} else {
  const body = JSON.parse('"' + sprite[1] + '"')
  const symbols = [...body.matchAll(/<symbol\b[^>]*>/g)].map((m) => m[0])
  const count = (body.match(/<symbol/g) || []).length
  if (symbols.length !== count) problems.push('symbol 标签解析异常')
  const { grid, strokeWidth } = catalog
  for (const tag of symbols) {
    const id = (tag.match(/id="([^"]+)"/) || [])[1] ?? '?'
    if (!tag.includes(`viewBox="0 0 ${grid} ${grid}"`)) problems.push(`${id}: viewBox 不是 0 0 ${grid} ${grid}`)
    for (const must of [`fill="none"`, `stroke="currentColor"`, `stroke-width="${strokeWidth}"`]) {
      if (!tag.includes(must)) problems.push(`${id}: symbol 缺少 ${must}`)
    }
  }
  for (const m of body.matchAll(/<(\w+)\b[^>]*\bfill="(?!none)([^"]*)"[^>]*>/g)) {
    const r = Number((m[0].match(/\br="([\d.]+)"/) || [])[1] ?? NaN)
    if (!(m[1] === 'circle' && Number.isFinite(r) && r <= 0.6)) {
      problems.push(`sprite 出现实心填充：${m[0].slice(0, 70)}`)
    }
  }
}

const usable = new Set(Object.keys(catalog.icons))
const MOBILE_SRC = join(ROOT, 'mobile/src')
const collect = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) collect(p, out)
    else if (/\.(tsx|ts)$/.test(entry) && !p.endsWith('icons/sprite.ts')) out.push(p)
  }
  return out
}
const spriteConsumers = collect(SRC).filter((p) => /icons\/sprite['"]/.test(readFileSync(p, 'utf8')))
const files = [...spriteConsumers, ...collect(MOBILE_SRC)]

const used = new Set()
const refs = []
const retired = new Set(catalog.retired ?? [])
const take = (rel, name, ctx) => {
  if (!name) return
  if (usable.has(name)) used.add(name)
  else refs.push([rel, name, ctx])
}
for (const file of files) {
  const src = readFileSync(file, 'utf8')
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  for (const m of src.matchAll(/<Icon\b[^>]*?\bname=(\{[^{}]*\}|"[^"]*"|'[^']*')/gs)) {
    const expr = m[1]
    const ctx = ('<Icon name=' + expr.replace(/\s+/g, ' ')).slice(0, 80)
    const literals = [...expr.matchAll(/["']([a-z0-9-]+)["']/g)].map((x) => x[1])
    if (!expr.startsWith('{')) take(rel, literals[0], ctx)
    else if (/^\{\s*["'][a-z0-9-]+["']\s*\}$/.test(expr)) take(rel, literals[0], ctx)
    else {
      for (const name of literals) {
        if (usable.has(name)) used.add(name)
        if (retired.has(name)) refs.push([rel, name, ctx])
      }
    }
  }
  for (const m of src.matchAll(/\bicon:\s*['"]([a-z0-9-]+)['"]/g)) take(rel, m[1], m[0])
}

for (const [rel, name, ctx] of refs) {
  problems.push(`引用了 sprite 中不存在的图标「${name}」：${rel} → ${ctx}`)
}

if (problems.length) {
  console.error(`✗ 图标检查失败（${problems.length} 项）：`)
  for (const p of problems) console.error('   ' + p)
  process.exit(1)
}
console.log(
  `✓ 图标检查通过 · ${usable.size} 个语义 · 引用命中 ${used.size} 个 · 未使用 ${usable.size - used.size} 个` +
    (!process.env.YAN_ICON_VERBOSE
      ? ''
      : `\n   未使用：${[...usable].filter((n) => !used.has(n)).join(', ')}`)
)
