import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = new URL('../src/renderer/src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (/\.(ts|tsx)$/.test(name) && !/\.stories\.tsx$/.test(name)) out.push(path)
  }
  return out
}

const ALLOWED = new Set(['lib/reduced-motion.ts', 'lib/boot-splash.ts', 'features/artifacts/WidgetBlock.tsx'])
const HONORS_APP_SETTING = /reduceMotion|reduce-motion|prefersReducedMotion|appReducedMotion|from '[./]+(?:\/lib)?\/reduced-motion'/
const QUERY = /matchMedia\??\.?\(\s*['"]\(prefers-reduced-motion/

const offenders = []
let guarded = 0
for (const file of walk(root)) {
  const rel = relative(root, file).replaceAll('\\', '/')
  if (ALLOWED.has(rel)) continue
  const text = readFileSync(file, 'utf8')
  if (!QUERY.test(text)) continue
  if (HONORS_APP_SETTING.test(text.replace(QUERY, ''))) guarded++
  else offenders.push(rel)
}

assert.deepEqual(offenders, [], `这些文件只看系统的 prefers-reduced-motion，忽略应用内「减少动效」开关，请改用 lib/reduced-motion 的 prefersReducedMotion：${offenders.join(', ')}`)
assert.ok(guarded >= 4, `应有多处已同时遵守应用开关，实际 ${guarded}`)
console.log(`减少动效源码检查通过：${guarded} 个文件同时遵守系统与应用开关`)
