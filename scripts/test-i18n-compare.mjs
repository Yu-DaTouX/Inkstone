import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const CJK = /[一-鿿]/
const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(path)
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) files.push(path)
  }
}
for (const scanRoot of ['src', 'mobile/src', 'resources/pi-extensions']) if (existsSync(join(root, scanRoot))) walk(join(root, scanRoot))

const zhLiterals = new Set()
const pickPattern = /pick\(\s*(['`])((?:\\.|(?!\1).)*?)\1\s*,/g
for (const path of files) {
  if (!/[\\/](src|mobile)[\\/]/.test(path)) continue
  const text = readFileSync(path, 'utf8')
  let match
  while ((match = pickPattern.exec(text))) if (CJK.test(match[2])) zhLiterals.add(match[2])
}

const comparisons = [
  /(?:includes|startsWith|endsWith|indexOf)\(\s*(['`])((?:\\.|(?!\1).)*?)\1/g,
  /(?:===|!==|==)\s*(['`])((?:\\.|(?!\1).)*?)\1/g,
  /(['`])((?:\\.|(?!\1).)*?)\1\s*(?:===|!==)/g,
  /()\/((?:\\.|[^/\n])*[一-鿿](?:\\.|[^/\n])*)\/[gimsuy]*\.test\(/g
]

const failures = []
for (const path of files) {
  const lines = readFileSync(path, 'utf8').split('\n')
  lines.forEach((line, index) => {
    if (/^\s*(\/\/|\*)/.test(line)) return
    for (const pattern of comparisons) {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(line))) {
        const literal = match[2]
        if (!CJK.test(literal)) continue
        const pieces = literal.split(/[|.*+?()[\]\\]+/).filter((piece) => piece.length >= 2 && CJK.test(piece))
        const shared = zhLiterals.has(literal) || (pattern !== comparisons[3] && pieces.some((piece) => piece.length >= 4 && [...zhLiterals].some((zh) => zh.includes(piece) && zh.length <= piece.length + 12)))
        if (shared) failures.push(`${relative(root, path).split(sep).join('/')}:${index + 1}: ${line.trim().slice(0, 140)}`)
      }
    }
  })
}

if (failures.length) {
  console.error('按界面文案做判断（pick 的中文原文出现在比较的另一端），请改用错误码或常量：')
  console.error([...new Set(failures)].join('\n'))
  process.exit(1)
}
console.log(`pick 比较检查：${zhLiterals.size} 条双语文案，没有被拿来做比较`)
