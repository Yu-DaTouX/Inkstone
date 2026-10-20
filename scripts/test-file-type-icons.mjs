import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../src/renderer/src/', import.meta.url)

async function load(rel) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(rel, root))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const icons = await load('ui/file-type-icons.ts')
const map = await load('ui/file-type-icon-map.ts')
const id = icons.fileTypeIconId

const cases = [
  ['.gitignore', 'git'],
  ['.gitattributes', 'git'],
  ['COMMIT_EDITMSG', 'git'],
  ['AGENTS.md', 'markdown'],
  ['README.md', 'markdown'],
  ['README', 'markdown'],
  ['CHANGELOG.md', 'markdown'],
  ['CLAUDE.md', 'claude'],
  ['.mcp.json', 'mcp'],
  ['server.mcp', 'mcp'],
  ['notes.txt', 'text'],
  ['THIRD-PARTY.md', 'markdown'],
  ['LICENSE', 'text'],
  ['report.pdf', 'pdf'],
  ['notes.docx', 'word'],
  ['deck.pptx', 'slides'],
  ['table.csv', 'table'],
  ['budget.xlsx', 'table'],
  ['Inter.woff2', 'font'],
  ['package.json', 'npm'],
  ['package-lock.json', 'npm'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['tsconfig.json', 'typescript'],
  ['tsconfig.web.json', 'json'],
  ['rows.jsonl', 'json'],
  ['electron-builder.yml', 'electron'],
  ['electron.vite.config.ts', 'electron'],
  ['vite.config.ts', 'vite'],
  ['vitest.config.mts', 'vitest'],
  ['webpack.config.js', 'webpack'],
  ['eslint.config.mjs', 'eslint'],
  ['.eslintrc.json', 'eslint'],
  ['.prettierrc', 'prettier'],
  ['biome.json', 'biome'],
  ['.oxlintrc.json', 'oxc'],
  ['babel.config.js', 'babel'],
  ['postcss.config.cjs', 'postcss'],
  ['.stylelintrc.yml', 'stylelint'],
  ['tailwind.config.ts', 'tailwind'],
  ['bootstrap.min.css', 'bootstrap'],
  ['.browserslistrc', 'config'],
  ['svgo.config.mjs', 'svgo'],
  ['app.code-workspace', 'vscode'],
  ['config.yaml', 'yaml'],
  ['Cargo.toml', 'rust'],
  ['Cargo.lock', 'rust'],
  ['pyproject.toml', 'python'],
  ['settings.toml', 'toml'],
  ['.env', 'dotenv'],
  ['.env.local', 'dotenv'],
  ['Dockerfile', 'docker'],
  ['docker-compose.yml', 'docker'],
  ['compose.yaml', 'docker'],
  ['main.ts', 'typescript'],
  ['types.d.ts', 'typescript'],
  ['App.tsx', 'react'],
  ['App.jsx', 'react'],
  ['index.js', 'javascript'],
  ['scratchpad_e.mjs', 'javascript'],
  ['main.py', 'python'],
  ['lib.rs', 'rust'],
  ['server.go', 'go'],
  ['style.css', 'css'],
  ['style.scss', 'sass'],
  ['theme.less', 'css'],
  ['index.html', 'html'],
  ['App.vue', 'vue'],
  ['App.svelte', 'svelte'],
  ['page.astro', 'astro'],
  ['schema.graphql', 'graphql'],
  ['main.zig', 'zig'],
  ['mod.wasm', 'wasm'],
  ['main.tf', 'terraform'],
  ['Gemfile', 'ruby'],
  ['app.rb', 'ruby'],
  ['main.swift', 'swift'],
  ['Server.java', 'java'],
  ['main.c', 'c'],
  ['main.cpp', 'cpp'],
  ['Program.cs', 'csharp'],
  ['Main.kt', 'kotlin'],
  ['index.php', 'php'],
  ['init.lua', 'lua'],
  ['main.dart', 'dart'],
  ['build.sh', 'terminal'],
  ['.zshrc', 'terminal'],
  ['build.ps1', 'powershell'],
  ['Makefile', 'terminal'],
  ['doc.mdx.tsx', 'markdown'],
  ['run.cmd', 'file'],
  ['开发-砚.cmd - Shortcut.lnk', 'file'],
  ['tsconfig.node.tsbuildinfo', 'file'],
  ['setup.exe', 'file'],
  ['logo.svg', 'svg'],
  ['photo.PNG', 'image'],
  ['clip.mp4', 'video'],
  ['song.mp3', 'audio'],
  ['backup.tar.gz', 'archive'],
  ['app.sqlite', 'database'],
  ['query.sql', 'database'],
  ['poetry.lock', 'python'],
  ['deps.lock', 'lock'],
  ['HEAD', 'file'],
  ['nul', 'file'],
  ['archive.unknownext', 'file'],
  ['', 'file']
]
for (const [name, expected] of cases) assert.equal(id(name), expected, `${name || '(空)'} → ${expected}`)

assert.equal(id('README.md'), id('AGENTS.md'), 'README 与其它 Markdown 同一图标')
assert.equal(id('src/renderer/App.tsx'), 'react', '相对路径取文件名')
assert.equal(id(String.raw`C:\repo\README.md`), 'markdown', 'Windows 绝对路径取文件名')
assert.equal(id('src/'), 'file', '目录路径没有类型图标')
assert.equal(icons.fileBaseName('a/b/c.ts'), 'c.ts')

const names = Object.keys(map.FILE_TYPE_NAME_ICONS)
const extensions = Object.keys(map.FILE_TYPE_EXTENSION_ICONS)
assert.ok(names.length >= 100, `完整文件名 ${names.length} 条`)
assert.ok(extensions.length >= 177, `扩展名 ${extensions.length} 条`)
for (const key of [...names, ...extensions]) assert.equal(key, key.toLowerCase(), `${key} 用小写键`)

const expectedExtensions =
  '7z astro avif bash bmp bz2 cfg cjs code-workspace conf csh css csv cts db doc docm docx dotm dotx editorconfig env env.development env.local env.production eot erb fish gemspec gif go gql graphql gz htm html icns ico ini jar jpeg jpg js json json5 jsonc jsonl jsx ksh less log markdown mcp md mdx mdx.tsx mjs mts odp ods odt otf pdf png postcss potm potx pps ppsm ppsx ppt pptm pptx py pyi pyw pyx rake rar rb rs rst rtf sass scss sh sql sqlite sqlite3 styl svelte svg swift tar tf tfstate tfvars tgz tif tiff ts tsv tsx ttf txt vue war wasm wast wat webp woff woff2 xhtml xls xlsb xlsm xlsx xltm xltx xz yaml yml zig zip zsh'.split(' ')
assert.equal(expectedExtensions.length, 126)
for (const ext of expectedExtensions) assert.ok(map.FILE_TYPE_EXTENSION_ICONS[ext], `扩展名 ${ext} 有图标`)

const tones = new Set(['gray', 'ink', 'green', 'blue', 'yellow', 'orange', 'red', 'pink', 'purple', 'teal', 'brand'])
for (const icon of icons.FILE_TYPE_ICON_IDS) assert.ok(tones.has(icons.fileTypeTone(icon)), `${icon} 有色调`)
for (const icon of icons.FILE_TYPE_BRAND_ICON_IDS) assert.equal(icons.fileTypeTone(icon), 'brand', `${icon} 用品牌色`)
assert.equal(icons.fileTypeTone('file'), 'gray')
assert.equal(icons.fileTypeTone('text'), 'gray')
assert.equal(icons.fileTypeTone('pdf'), 'red')
assert.equal(icons.fileTypeTone('word'), 'blue')
assert.equal(icons.fileTypeTone('slides'), 'orange')
assert.equal(icons.fileTypeTone('font'), 'ink')

const assets = new URL('assets/file-icons/', root)
const files = readdirSync(assets)
assert.deepEqual(files.filter((name) => !name.endsWith('.svg')), [], '目录里只有 SVG')
const svgs = files.map((name) => name.slice(0, -4)).sort()
assert.deepEqual(svgs, [...icons.FILE_TYPE_ICON_IDS].sort(), '映射表里的图标与 SVG 一一对应')
const brandIds = new Set(icons.FILE_TYPE_BRAND_ICON_IDS)
const themedColor = /^ style="color:light-dark\(#[0-9A-F]{6},#[0-9A-F]{6}\)(;--fti-alt:light-dark\(#[0-9A-F]{6},#[0-9A-F]{6}\))?"$/
for (const name of svgs) {
  const svg = readFileSync(new URL(`${name}.svg`, assets), 'utf8')
  const open = svg.match(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 16 16"([^>]*)>/)
  assert.ok(open, `${name}.svg 统一 16 网格`)
  if (brandIds.has(name)) {
    assert.match(open[1], themedColor, `${name}.svg 品牌色分深浅两套`)
    assert.match(svg, /class="fti-brand(-line)?"/, `${name}.svg 用品牌形状类`)
  } else assert.equal(open[1], '', `${name}.svg 颜色来自色调`)
  assert.ok(!/\sid=/.test(svg), `${name}.svg 不带 id，内联多份不会冲突`)
  assert.ok(!/<script|\son[a-z]+=|href=/i.test(svg), `${name}.svg 不含脚本与外链`)
  assert.ok(!/(fill|stroke)="#/i.test(svg), `${name}.svg 不写死颜色属性`)
  assert.ok(svg.length < 4500, `${name}.svg 体积 ${svg.length}`)
}
const python = readFileSync(new URL('python.svg', assets), 'utf8')
assert.match(python, /fti-brand-alt/, 'Python 保持蓝黄双色')

console.log(`file type icons ok (${cases.length} cases, ${names.length} names, ${extensions.length} extensions, ${svgs.length} icons)`)
