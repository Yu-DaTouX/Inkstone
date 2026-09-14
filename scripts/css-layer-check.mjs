/**
 * 层叠等价校验：迁移 CSS 规则后，最终生效的声明必须一字不变。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么不能只做文本 diff
 * ══════════════════════════════════════════════════════════════════
 * 迁移的意义就是「同一批声明换个文件放」。文本必然不同，但**计算后的结果**
 * 必须相同：对每个 (媒体查询, 选择器)，把所有文件按加载顺序叠一遍，
 * 属性取最后一次赋值 —— 这个结果前后要完全一致。
 *
 * 用法：
 *   node scripts/css-layer-check.mjs <迁移前的 styles 目录> [迁移后目录]
 *
 * 典型流程（迁移前先拍快照）：
 *   cp -r src/renderer/src/styles /tmp/styles-before
 *   node scripts/css-migrate.mjs --from redesign.css --to tools.css --match ".rp-"
 *   node scripts/css-layer-check.mjs /tmp/styles-before src/renderer/src/styles
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'

/* 加载顺序无关紧要（两个目录用同一套规则），但必须**两个目录一致** */
const ORDER = [
  'tokens.css',
  'app.css',
  'stage1.css',
  'stage2.css',
  'redesign.css',
  'motion.css',
  'settings.css',
  'electron.css',
  'highlight.css',
  'layout.css',
  'rail.css',
  'chat.css',
  'tools.css',
  'browser.css'
]

/** 解析成 Map<"媒体查询|选择器", Map<属性,值>>，同 key 后写覆盖前写 */
function layer(dir) {
  const result = new Map()
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.css')) : []
  /* 目录里可能有 ORDER 之外的新文件（比如设置页的独立样式），一并纳入，
     但放在 ORDER 之后 —— 以文件名为序，保证两个目录的处理顺序一致 */
  const extra = files.filter((f) => !ORDER.includes(f)).sort()
  for (const name of [...ORDER, ...extra]) {
    const p = join(dir, name)
    if (!existsSync(p)) continue
    const css = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    let i = 0
    let buf = ''
    let depth = 0
    let media = ''
    const apply = (head, body) => {
      if (!head || head.startsWith('@')) return
      for (const one of head.split(',')) {
        const sel = one.replace(/\s+/g, ' ').trim()
        if (!sel) continue
        const key = (media ? media + ' ' : '') + sel
        const m = result.get(key) ?? new Map()
        for (const decl of body.split(';')) {
          const norm = decl.replace(/\s+/g, ' ').trim()
          if (!norm) continue
          const idx = norm.indexOf(':')
          if (idx < 0) continue
          m.set(norm.slice(0, idx).trim(), norm.slice(idx + 1).trim())
        }
        result.set(key, m)
      }
    }
    let headStart = 0
    while (i < css.length) {
      const ch = css[i]
      if (ch === '{') {
        const head = css.slice(headStart, i).trim()
        if (head.startsWith('@media') || head.startsWith('@supports')) {
          media = head.replace(/\s+/g, ' ')
          depth++
          i++
          headStart = i
          continue
        }
        /* 找配对 */
        let d = 1
        let j = i + 1
        let body = ''
        while (j < css.length && d > 0) {
          if (css[j] === '{') d++
          else if (css[j] === '}') {
            d--
            if (d === 0) break
          }
          body += css[j]
          j++
        }
        if (depth === 0 || media) apply(head, body)
        i = j + 1
        headStart = i
        continue
      }
      if (ch === '}') {
        depth = Math.max(0, depth - 1)
        if (depth === 0) media = ''
        i++
        headStart = i
        continue
      }
      if (ch === ';' && depth === 0) headStart = i + 1
      i++
    }
  }
  return result
}

const [beforeDir, afterDir = 'src/renderer/src/styles'] = process.argv.slice(2)
if (!beforeDir) {
  console.error('用法: node scripts/css-layer-check.mjs <迁移前的 styles 目录> [迁移后目录]')
  process.exit(2)
}

const A = layer(resolve(beforeDir))
const B = layer(resolve(afterDir))

let bad = 0
const report = (s) => {
  console.log(s)
  bad++
}

for (const [key, props] of A) {
  const now = B.get(key)
  if (!now) {
    report(`✗ 选择器消失：${key}`)
    continue
  }
  for (const [prop, value] of props) {
    if (!now.has(prop)) report(`✗ 属性消失：${key} { ${prop}: ${value} }`)
    else if (now.get(prop) !== value) report(`✗ 值变化：${key} { ${prop}: ${value} → ${now.get(prop)} }`)
  }
}

for (const [key, props] of B) {
  const was = A.get(key)
  for (const [prop, value] of props) {
    if (!was || !was.has(prop)) report(`✗ 新增属性：${key} { ${prop}: ${value} }`)
  }
}

console.log('')
console.log(`  ${basename(resolve(beforeDir))}：${A.size} 个 (媒体查询,选择器) 组合`)
console.log(`  ${basename(resolve(afterDir))}：${B.size} 个`)
if (bad === 0) console.log(`\n✓ 层叠等价：计算后的声明完全一致`)
else {
  console.log(`\n✗ 有 ${bad} 处不一致`)
  process.exit(1)
}
