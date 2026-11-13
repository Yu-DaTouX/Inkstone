import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const catalogDir = join(root, 'src', 'renderer', 'src', 'i18n')
const baselinePath = join(root, 'scripts', 'i18n-cjk-baseline.json')
const update = process.argv.includes('--update')
const CJK = /[一-鿿]/
const ENGLISH_VALUES_WITH_CJK = new Set(['voice.lang.zh', 'preview.font.sample'])
const SCAN_ROOTS = ['src/renderer/src', 'src/main', 'src/shared', 'mobile/src']
const SKIP = /(\.stories\.tsx$|[\\/]i18n[\\/]|\.generated\.ts$|[\\/]node_modules[\\/])/

const failures = []
const fail = (message) => failures.push(message)
const readJson = (name) => JSON.parse(readFileSync(join(catalogDir, name), 'utf8'))
const placeholders = (text) => (text.match(/\{\w+\}/g) ?? []).sort().join(',')

const zh = readJson('zh-CN.json')
const en = readJson('en-US.json')
for (const key of Object.keys(zh)) if (!(key in en)) fail(`en-US.json 缺键：${key}`)
for (const key of Object.keys(en)) if (!(key in zh)) fail(`zh-CN.json 缺键：${key}`)
for (const key of Object.keys(zh)) {
  if (!(key in en)) continue
  if (typeof zh[key] !== 'string' || typeof en[key] !== 'string') fail(`键的值不是字符串：${key}`)
  else if (placeholders(zh[key]) !== placeholders(en[key])) fail(`占位符不一致：${key}`)
  if (typeof en[key] === 'string' && CJK.test(en[key]) && !ENGLISH_VALUES_WITH_CJK.has(key)) fail(`英文文案里有中文：${key}`)
  if (typeof en[key] === 'string' && !en[key].trim()) fail(`英文文案为空：${key}`)
  if (typeof zh[key] === 'string' && !zh[key].trim()) fail(`中文文案为空：${key}`)
}

const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(path)
    } else if (/\.(ts|tsx)$/.test(entry.name) && !SKIP.test(path)) files.push(path)
  }
}
for (const scanRoot of SCAN_ROOTS) if (existsSync(join(root, scanRoot))) walk(join(root, scanRoot))

const counts = {}
for (const path of files) {
  let inBlock = false
  let count = 0
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false
      continue
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true
      continue
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
    if (CJK.test(line) && !line.includes('pick(')) count++
  }
  if (count) counts[relative(root, path).split(sep).join('/')] = count
}

if (update) {
  writeFileSync(baselinePath, JSON.stringify(counts, Object.keys(counts).sort(), 2) + '\n')
  console.log(`已更新基线：${Object.keys(counts).length} 个文件`)
} else {
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {}
  for (const [file, count] of Object.entries(counts)) {
    const allowed = baseline[file]
    if (allowed === undefined) fail(`新增写死中文的文件：${file}（${count} 行）。界面文案请用 pick(中文, English) 或 i18n 词表；确属中英成对词表再运行 node scripts/test-i18n-consistency.mjs --update`)
    else if (count > allowed) fail(`写死中文增加：${file}（${allowed} → ${count} 行）`)
  }
}

if (failures.length) {
  console.error(failures.slice(0, 40).join('\n'))
  if (failures.length > 40) console.error(`…另有 ${failures.length - 40} 项`)
  throw new Error("i18n 检查未通过")
}
console.log(`i18n 一致性：${Object.keys(zh).length} 个键，两份词表一致；${Object.keys(counts).length} 个文件含中文字面量，均在基线内`)
