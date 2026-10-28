import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { SEARCH_TOOL_PINS, vendoredUpToDate } from './vendor-search-tools.mjs'

const outfile = resolve('out/test/search-tools.mjs')
await build({ entryPoints: ['src/main/search-tools.ts'], outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' })
const { bundledSearchToolsDir, withSearchToolsOnPath } = await import(pathToFileURL(outfile))

const dir = await mkdtemp(join(tmpdir(), 'inkstone-search-tools-'))
const bundled = join(dir, 'search-tools')
await mkdir(bundled)
await writeFile(join(bundled, 'rg.exe'), '')

assert.equal(bundledSearchToolsDir([join(dir, 'missing'), bundled], 'win32'), bundled, '找到带 rg 的随包目录')
assert.equal(bundledSearchToolsDir([join(dir, 'missing')], 'win32'), undefined, '没有随包目录时不改 PATH')

const path = ['C:\\Windows', 'C:\\Tools'].join(delimiter)
assert.equal(withSearchToolsOnPath(path, bundled), [bundled, 'C:\\Windows', 'C:\\Tools'].join(delimiter), '随包目录放在最前')
assert.equal(withSearchToolsOnPath(withSearchToolsOnPath(path, bundled), bundled), [bundled, 'C:\\Windows', 'C:\\Tools'].join(delimiter), '重复调用不重复插入')
assert.equal(withSearchToolsOnPath(path, undefined), path)

const pins = SEARCH_TOOL_PINS['win32-x64']
assert.deepEqual(pins.map((pin) => pin.binary), ['rg.exe', 'fd.exe'])
assert(pins.every((pin) => /^[0-9a-f]{64}$/.test(pin.sha256) && pin.size > 0 && pin.url.startsWith('https://github.com/')), '固定版本带大小和 sha256')
assert.equal(vendoredUpToDate(pins, join(dir, 'none')), false)
await writeFile(join(bundled, 'fd.exe'), '')
await writeFile(join(bundled, 'search-tools.json'), JSON.stringify(Object.fromEntries(pins.map((pin) => [pin.binary, pin.sha256]))))
assert.equal(vendoredUpToDate(pins, bundled), true, '清单与固定版本一致时跳过下载')

const builder = await readFile('electron-builder.yml', 'utf8')
assert.match(builder, /from: resources\/search-tools\s+to: search-tools/, '安装包随带 rg/fd')
const workflow = await readFile('.github/workflows/release-windows.yml', 'utf8')
assert.match(workflow, /npm run vendor:search-tools/, '发行流程先准备 rg/fd')
const host = await readFile('src/main/index.ts', 'utf8')
assert.match(host, /refreshManagedGit\(\)[^\n]*\n\s*applyBundledSearchTools\(\)/, '启动 agent 前把随包目录放进 PATH')

console.log('search tools ok')
