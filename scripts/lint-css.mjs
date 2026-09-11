/**
 * CSS 守卫：grid 里的 `1fr` 必须写成 `minmax(0, 1fr)`。
 *
 * 为什么值得单独一个脚本：
 *   裸 `1fr` 的轨道最小值是 `auto`（= 内容的 min-content/max-content）。
 *   内容一宽（长会话名、长路径、长单词）轨道就超出容器，**溢出的部分被右邻的
 *   不透明列盖住** —— 表现为「文字被遮」「边框不见」，而且不报任何错。
 *   这个坑在本项目已经出现 3 次（.rail、设计稿 .rail、应用侧 4 处），
 *   靠肉眼在截图里找显然不划算。
 *
 * `minmax(0, 1fr)` 把最小值钉成 0，轨道就能跟着容器收缩，配合子元素的
 * `min-width:0` + `overflow:hidden` 才是正确的截断写法。
 *
 * 用法： node scripts/lint-css.mjs
 */
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const TARGETS = [
  join(root, 'src/renderer/src/styles'),
  join(root, 'docs/design/prototype.html')
]

/** 收集要检查的文件 */
async function collect(target) {
  if (target.endsWith('.html') || target.endsWith('.css')) return [target]
  const out = []
  for (const e of await readdir(target, { withFileTypes: true })) {
    const p = join(target, e.name)
    if (e.isDirectory()) out.push(...(await collect(p)))
    else if (e.name.endsWith('.css')) out.push(p)
  }
  return out
}

/** 找出 grid-template-columns 里没被 minmax 包住的 fr */
function findBareFr(css) {
  const hits = []
  const lines = css.split('\n')

  lines.forEach((line, i) => {
    const m = /grid-template-columns\s*:\s*([^;}]+)/.exec(line)
    if (!m) return

    const value = m[1]
    // 先把 minmax(...) 整段挖掉，剩下的 fr 就是「裸」的
    const stripped = value.replace(/minmax\s*\([^)]*\)/g, '')
    if (/\d+(\.\d+)?fr/.test(stripped)) {
      hits.push({ line: i + 1, text: line.trim(), value: value.trim() })
    }
  })

  return hits
}

console.log('=== CSS 守卫：grid 的 1fr 必须用 minmax(0, 1fr) ===\n')

const files = (await Promise.all(TARGETS.map(collect))).flat()
let bad = 0

for (const file of files) {
  const css = await readFile(file, 'utf8')
  const hits = findBareFr(css)
  const rel = relative(root, file).replace(/\\/g, '/')

  if (hits.length === 0) {
    console.log(`✓ ${rel}`)
    continue
  }

  bad += hits.length
  console.log(`✗ ${rel}`)
  for (const h of hits) {
    console.log(`    ${h.line} 行: ${h.value}`)
  }
}

console.log()
if (bad) {
  console.log(`✗ 发现 ${bad} 处裸 1fr —— 换成 minmax(0, 1fr)（原因见 DESIGN.md §8）`)
  process.exit(1)
}
console.log(`✓ 全部合规（检查了 ${files.length} 个文件）`)
