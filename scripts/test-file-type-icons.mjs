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
const id = icons.fileTypeIconId

const cases = [
  ['.gitignore', 'git'],
  ['.gitattributes', 'git'],
  ['.gitmodules', 'git'],
  ['COMMIT_EDITMSG', 'git'],
  ['AGENTS.md', 'doc'],
  ['README.md', 'doc'],
  ['README', 'doc'],
  ['readme.txt', 'doc'],
  ['CHANGELOG.md', 'doc'],
  ['notes.txt', 'doc'],
  ['report.pdf', 'doc'],
  ['notes.docx', 'doc'],
  ['LICENSE', 'file'],
  ['LICENSE.md', 'file'],
  ['package.json', 'json'],
  ['package-lock.json', 'json'],
  ['tsconfig.json', 'json'],
  ['tsconfig.web.json', 'json'],
  ['rows.jsonl', 'json'],
  ['electron-builder.yml', 'config'],
  ['config.yaml', 'config'],
  ['Cargo.toml', 'config'],
  ['.env', 'config'],
  ['.env.local', 'config'],
  ['Dockerfile', 'config'],
  ['electron.vite.config.ts', 'ts'],
  ['main.ts', 'ts'],
  ['types.d.ts', 'ts'],
  ['App.tsx', 'ts'],
  ['App.jsx', 'js'],
  ['index.js', 'js'],
  ['scratchpad_e.mjs', 'js'],
  ['main.py', 'py'],
  ['lib.rs', 'rs'],
  ['server.go', 'go'],
  ['style.css', 'css'],
  ['style.scss', 'css'],
  ['index.html', 'html'],
  ['Server.java', 'code'],
  ['main.cpp', 'code'],
  ['build.sh', 'terminal'],
  ['build.ps1', 'terminal'],
  ['Makefile', 'terminal'],
  ['run.cmd', 'file'],
  ['开发-砚.cmd - Shortcut.lnk', 'file'],
  ['tsconfig.node.tsbuildinfo', 'file'],
  ['setup.exe', 'file'],
  ['table.csv', 'table'],
  ['logo.svg', 'image'],
  ['photo.PNG', 'image'],
  ['clip.mp4', 'video'],
  ['song.mp3', 'audio'],
  ['backup.tar.gz', 'archive'],
  ['app.sqlite', 'database'],
  ['yarn.lock', 'lock'],
  ['Cargo.lock', 'lock'],
  ['HEAD', 'file'],
  ['nul', 'file'],
  ['archive.unknownext', 'file'],
  ['', 'file']
]
for (const [name, expected] of cases) assert.equal(id(name), expected, `${name || '(空)'} → ${expected}`)

assert.notEqual(id('README.md'), 'readme', 'README.md 不再用信息圆点图标')
assert.equal(id('README.md'), id('AGENTS.md'), 'README 与其它 Markdown 同一文档图标')
assert.equal(id('src/renderer/App.tsx'), 'ts', '相对路径取文件名')
assert.equal(id(String.raw`C:\repo\README.md`), 'doc', 'Windows 绝对路径取文件名')
assert.equal(id('src/'), 'file', '目录路径没有类型图标')
assert.equal(icons.fileBaseName('a/b/c.ts'), 'c.ts')

const tones = new Set(['gray', 'green', 'blue', 'yellow', 'orange', 'red', 'purple', 'teal'])
for (const icon of icons.FILE_TYPE_ICON_IDS) assert.ok(tones.has(icons.fileTypeTone(icon)), `${icon} 有色调`)
assert.equal(icons.fileTypeTone('file'), 'gray')
assert.equal(icons.fileTypeTone('doc'), 'green')
assert.equal(icons.fileTypeTone('ts'), 'blue')
assert.equal(icons.fileTypeTone('js'), 'yellow')
assert.equal(icons.fileTypeTone('json'), 'orange')
assert.equal(icons.fileTypeTone('git'), 'orange')
assert.equal(icons.fileTypeTone('config'), 'red')

const assets = new URL('assets/file-icons/', root)
const files = readdirSync(assets)
assert.deepEqual(files.filter((name) => !name.endsWith('.svg')), [], '目录里只有自绘 SVG，没有第三方许可文件')
const svgs = files.map((name) => name.slice(0, -4)).sort()
assert.deepEqual(svgs, [...icons.FILE_TYPE_ICON_IDS].sort(), '映射表里的图标与 SVG 一一对应')
assert.ok(svgs.length >= 16 && svgs.length <= 24, `图标数 ${svgs.length}`)
for (const name of svgs) {
  const svg = readFileSync(new URL(`${name}.svg`, assets), 'utf8')
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">'), `${name}.svg 统一 16 网格`)
  assert.ok(!/\sid=/.test(svg), `${name}.svg 不带 id，内联多份不会冲突`)
  assert.ok(!/<script|on[a-z]+=/i.test(svg), `${name}.svg 不含脚本`)
  assert.ok(!/(fill|stroke)="#/i.test(svg), `${name}.svg 不写死颜色，颜色来自色调`)
  assert.ok(svg.length < 1500, `${name}.svg 体积 ${svg.length}`)
}

console.log(`file type icons ok (${cases.length} names, ${svgs.length} icons)`)
