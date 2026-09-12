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
let badFr = 0
let badBrace = 0

/**
 * 花括号平衡检查。
 *
 * 为什么需要（真实事故）：用脚本删 CSS 片段时留下了一个未闭合的 `{`，
 * 把后面**所有规则**都吞进了一个非法块 —— 结果压缩记号、高度把手、
 * 收起态按钮全部静默失效（CSS 不报错，只是不生效）。
 * 这类错误很难发现：浏览器什么都不说，只能靠量像素才看得出来。
 */
function braceImbalance(css) {
  let depth = 0
  let firstBad = 0
  const lines = css.split('\n')
  for (let i = 0; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth < 0 && !firstBad) firstBad = i + 1
      }
    }
  }
  return depth === 0 ? null : { depth, firstBad: firstBad || lines.length }
}

for (const file of files) {
  const css = await readFile(file, 'utf8')
  const rel = relative(root, file).replace(/\\/g, '/')
  const imbalance = braceImbalance(css)
  if (imbalance) {
    badBrace++
    console.log(`✗ ${rel}  花括号不平衡（结束时还差 ${imbalance.depth} 个 }）—— 后面全部规则会失效`)
    continue
  }
  const hits = findBareFr(css)

  if (hits.length === 0) {
    console.log(`✓ ${rel}`)
    continue
  }

  badFr += hits.length
  console.log(`✗ ${rel}`)
  for (const h of hits) {
    console.log(`    ${h.line} 行: ${h.value}`)
  }
}

console.log()
if (badBrace) {
  console.log(`✗ 有 ${badBrace} 个文件的花括号不平衡 —— 那里之后的所有规则都会**静默失效**`)
}
if (badFr) {
  console.log(`✗ 发现 ${badFr} 处裸 1fr —— 换成 minmax(0, 1fr)（原因见 DESIGN.md §8）`)
}
if (badBrace || badFr) process.exit(1)
console.log(`✓ 全部合规（检查了 ${files.length} 个文件）`)
