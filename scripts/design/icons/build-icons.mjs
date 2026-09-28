/**
 * build-icons.mjs —— 图标生成的**唯一入口**（npm run icons）。
 *
 * 链路：
 *   scripts/design/icons/catalog.json          语义 → 用途（唯一真源，手写）
 *   scripts/design/icons/inkline.json          「砚线」几何（手写，16 网格）
 *   → scripts/design/icons/sprite.svg          完整 sprite（设计稿 / 预览用）
 *   → src/renderer/src/icons/sprite.ts         渲染端内联 sprite（构建产物；手机端也读它）
 *   → scripts/design/icons/preview.html        对照预览页
 *   → scripts/design/prototype.html            设计稿内联子集（同步写入，无手工同步点）
 *
 * 统一属性：16×16、fill="none"、stroke="currentColor"、方头斜接；描边宽度写在 symbol 上，
 * 每条路径带 vector-effect="non-scaling-stroke"，所以 12 / 14 / 16px 三档一样粗
 * （设计规范 §3.4）。几何只允许 path，坐标落在 0…16 之内，不允许填充。
 *
 * 用法：
 *   node scripts/design/icons/build-icons.mjs            # 生成
 *   node scripts/design/icons/build-icons.mjs --check    # 只校验，有差异 exit 1
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const ICON_DIR = HERE
const TS_OUT = join(ROOT, 'src/renderer/src/icons/sprite.ts')
const PROTO = join(ROOT, 'scripts/design/prototype.html')
const CHECK = process.argv.includes('--check')

const catalog = JSON.parse(readFileSync(join(ICON_DIR, 'catalog.json'), 'utf8'))
const { grid, strokeWidth, linecap, linejoin, icons } = catalog
const source = catalog.libraries.inkline.source
const inkline = JSON.parse(readFileSync(join(ICON_DIR, source), 'utf8'))

/* ---------- 1. 校验编目本身 ---------- */

const problems = []
const byLibName = new Map()
for (const [semantic, def] of Object.entries(icons)) {
  if (!/^[a-z0-9-]+$/.test(semantic)) problems.push(`语义名不合法: ${semantic}`)
  if (def.lib !== 'inkline') problems.push(`${semantic}: 未登记的库 ${def.lib}`)
  if (byLibName.has(def.name)) {
    problems.push(`几何 ${def.name} 被两个语义复用：${byLibName.get(def.name)} 与 ${semantic}`)
  } else {
    byLibName.set(def.name, semantic)
  }
  if (!inkline.icons[def.name]) problems.push(`${semantic}: ${source} 里没有 ${def.name} 的几何`)
}
for (const name of Object.keys(inkline.icons)) {
  if (!byLibName.has(name)) problems.push(`${source} 里的 ${name} 没有在 catalog.json 登记语义`)
}
if (inkline.grid !== grid) problems.push(`${source} 的网格 ${inkline.grid} 与编目 ${grid} 不一致`)
if (problems.length) {
  console.error('✗ 编目校验失败：')
  for (const p of problems) console.error('   ' + p)
  process.exit(1)
}

/* ---------- 2. 几何 ---------- */

/** 只接受 path 数据；坐标（含圆弧端点）不能出 0…grid */
function geometry(semantic, name) {
  const d = String(inkline.icons[name].d ?? '').trim()
  if (!d) problems.push(`${semantic}: 几何为空`)
  if (/[^MmLlHhVvCcSsQqTtAaZz0-9.\s,-]/.test(d)) problems.push(`${semantic}: path 含非法字符`)
  for (const n of d.match(/-?\d*\.?\d+/g) ?? []) {
    const v = Number(n)
    if (v < -grid || v > grid) problems.push(`${semantic}: 坐标 ${n} 超出 ${grid} 网格`)
  }
  return `<path d="${d}" vector-effect="non-scaling-stroke"/>`
}

const attrs =
  `viewBox="0 0 ${grid} ${grid}" fill="none" stroke="currentColor" ` +
  `stroke-width="${strokeWidth}" stroke-linecap="${linecap}" stroke-linejoin="${linejoin}"`

const symbols = Object.entries(icons)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([semantic, def]) => `<symbol id="i-${semantic}" ${attrs}>${geometry(semantic, def.name)}</symbol>`)

const sprite = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">${symbols.join('')}</svg>\n`

/* ---------- 3. 产物 ---------- */

const names = Object.keys(icons).sort()
const ts = `/**
 * ⚠️ 自动生成，不要手改。来源：scripts/design/icons/catalog.json + ${source}
 * 重新生成： npm run icons
 *
 * 图标是「引用」（<use href="#i-x">），symbol 定义由 <IconSprite /> 在应用根部挂一次。
 * 全部图标：${grid}×${grid} 网格、纯描边、stroke-width ${strokeWidth}（non-scaling-stroke）、
 * ${linecap} 端点、${linejoin} 转角、颜色随 CSS color。
 */
export const ICON_SPRITE = ${JSON.stringify(sprite.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, ''))}

/** sprite 里可用的图标名（去掉 i- 前缀，直接 <Icon name="search" />） */
export const ICON_NAMES = ${JSON.stringify(names, null, 2)} as const

export type IconName = (typeof ICON_NAMES)[number]
`

const preview = previewHtml()
const protoNext = syncPrototype()

/* ---------- 4. 写入 / 比对 ---------- */

const outputs = [
  [join(ICON_DIR, 'sprite.svg'), sprite],
  [TS_OUT, ts],
  [join(ICON_DIR, 'preview.html'), preview],
  [PROTO, protoNext]
].filter(([, v]) => typeof v === 'string')

if (problems.length) {
  console.error('✗ 几何校验失败：')
  for (const p of problems) console.error('   ' + p)
  process.exit(1)
}

let changed = 0
for (const [file, next] of outputs) {
  const prev = existsSync(file) ? readFileSync(file, 'utf8') : null
  if (prev === next) continue
  changed++
  if (CHECK) {
    console.error(`✗ 需要重新生成：${file.replace(ROOT + '\\', '').replace(ROOT + '/', '')}`)
  } else {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, next, 'utf8')
  }
}

const kb = (s) => (Buffer.byteLength(s, 'utf8') / 1024).toFixed(1) + ' KB'
if (CHECK && changed) process.exit(1)

console.log(
  `${CHECK ? '✓ 已是最新' : changed ? `✓ 写入 ${changed} 个文件` : '✓ 无变化'} · ` +
    `${names.length} 个语义 / ${symbols.length} 个 symbol · sprite ${kb(sprite)}`
)

/* ---------- 预览页 ---------- */

function previewHtml() {
  const groups = new Map()
  for (const [semantic, def] of Object.entries(icons)) {
    if (!groups.has(def.group)) groups.set(def.group, [])
    groups.get(def.group).push([semantic, def])
  }
  const cards = [...groups.entries()]
    .map(([group, list]) => {
      const cells = list
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(
          ([semantic, def]) =>
            `<div class="cell" title="${def.use}"><svg class="ico"><use href="#i-${semantic}"/></svg>` +
            `<span class="nm">${semantic}</span><span class="src">${inkline.icons[def.name].zh ?? ''}</span></div>`
        )
        .join('')
      return `<section class="grp"><h2>${group} · ${list.length}</h2><div class="grid">${cells}</div></section>`
    })
    .join('\n')

  const sizes = [12, 14, 16, 20, 24, 32]
    .map(
      (s) =>
        `<div class="szbox"><svg class="ico" style="width:${s}px;height:${s}px"><use href="#i-folder"/></svg>` +
        `<span>${s}px</span></div>`
    )
    .join('')

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>砚图标集 · 砚线</title>
<style>
:root{--bg:#0b0b0d;--bg2:#121215;--bd:#26262c;--bd2:#34343c;--fg:#d6d6dd;--dim:#a8a8b5;--mute:#82828f;--ac:#7aa2f7}
html[data-theme=light]{--bg:#fbfbfa;--bg2:#fff;--bd:#e6e6e3;--bd2:#d2d2cd;--fg:#22222a;--dim:#4a4a55;--mute:#82828f;--ac:#3b5bdb}
*{box-sizing:border-box}
body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font:12px/1.5 "Maple Mono CN",ui-monospace,monospace;-webkit-font-smoothing:antialiased}
h1{font-size:14px;margin:0 0 4px}
.sub{color:var(--mute);margin:0 0 18px}
button.t{margin-left:8px;font:inherit;padding:2px 8px;background:var(--bg2);color:var(--fg);border:1px solid var(--bd);border-radius:5px;cursor:pointer}
.row{display:flex;gap:22px;flex-wrap:wrap;background:var(--bg2);border:1px solid var(--bd);border-radius:8px;padding:14px 18px;margin-bottom:20px;align-items:flex-end}
.szbox{display:flex;flex-direction:column;align-items:center;gap:6px;color:var(--mute)}
.grp{margin-bottom:20px}
.grp h2{font-size:12px;color:var(--dim);margin:0 0 8px;padding-bottom:6px;border-bottom:1px solid var(--bd)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px}
.cell{background:var(--bg2);border:1px solid var(--bd);border-radius:6px;padding:10px 6px;display:flex;flex-direction:column;align-items:center;gap:6px}
.cell:hover{border-color:var(--bd2)}
.cell:hover .ico{color:var(--ac)}
.ico{width:22px;height:22px;color:var(--fg);flex:none}
.nm{font-size:10px;color:var(--dim);text-align:center;word-break:break-all}
.src{font-size:9px;color:var(--mute)}
</style></head>
<body>
<h1>砚图标集</h1>
<p class="sub">砚线 · ${grid}×${grid} · 恒定描边 ${strokeWidth}px · ${names.length} 个语义<button class="t" onclick="document.documentElement.dataset.theme=document.documentElement.dataset.theme==='light'?'dark':'light'">切换主题</button></p>
<div class="row">${sizes}</div>
${cards}
${sprite}
</body></html>
`
}

/* ---------- 设计稿同步 ---------- */

function syncPrototype() {
  const START = '<!-- ICON-SPRITE-START -->'
  const END = '<!-- ICON-SPRITE-END -->'
  if (!existsSync(PROTO)) return null
  const html = readFileSync(PROTO, 'utf8')
  const i = html.indexOf(START)
  const j = html.indexOf(END)
  if (i < 0 || j < 0) return null

  const bare = html.slice(0, i) + html.slice(j + END.length)
  const used = new Set([...bare.matchAll(/#(i-[a-z0-9-]+)/g)].map((m) => m[1]))
  if (!used.has('i-sun') && !used.has('i-moon')) {
    // 主题切换是运行时 JS，静态扫描扫不到
  }
  for (const id of ['i-sun', 'i-moon', 'i-folder', 'i-folder-open']) used.add(id)
  const missing = [...used].filter((id) => !names.includes(id.slice(2)))
  if (missing.length) {
    console.error('✗ 设计稿引用了编目外的图标：' + missing.join(', '))
    process.exit(1)
  }
  const picked = symbols.filter((s) => used.has(s.match(/id="([^"]+)"/)[1]))
  const block = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">${picked.join('')}</svg>`
  return html.slice(0, i + START.length) + '\n' + block + '\n' + html.slice(j)
}
