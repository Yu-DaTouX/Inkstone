import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ELECTRON_STUB = `
export const app = {
  getLocale: () => 'zh-CN',
  getPath: () => process.env.YAN_TEST_DOCS_PATH
}
`

const results = []
const ok = (condition, label, detail) => {
  results.push({ condition: !!condition, label, detail })
  console.log(`  ${condition ? '✓' : '✗'} ${label}${detail === undefined ? '' : `  ${detail}`}`)
}

const temp = await mkdtemp(join(tmpdir(), 'yan-v3-ascii-settings-'))
process.env.YAN_PI_DIR = join(temp, 'pi')
process.env.YAN_DATA_DIR = join(temp, 'data')
process.env.YAN_TEST_DOCS_PATH = join(temp, 'documents')
await mkdir(process.env.YAN_TEST_DOCS_PATH, { recursive: true })

const outfile = join(temp, 'settings.mjs')
await build({
  entryPoints: ['src/main/settings.ts'],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
  plugins: [
    {
      name: 'v3-ascii-settings-electron-stub',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'v3-ascii-stub' }))
        b.onLoad({ filter: /.*/, namespace: 'v3-ascii-stub' }, () => ({ contents: ELECTRON_STUB, loader: 'js' }))
      }
    }
  ]
})

const load = (tag) => import(`${pathToFileURL(outfile).href}?instance=${tag}`)

const FILE = join(temp, 'data', 'desktop.json')
const readDisk = async () => JSON.parse(await readFile(FILE, 'utf8'))

const first = await load('first')
const { getSettings, patchSettings, validateRendererSettingsPatch } = first

let accepted = false
try {
  validateRendererSettingsPatch({ asciiBackground: false })
  accepted = true
} catch {
  accepted = false
}
ok(accepted, '渲染补丁白名单放行 asciiBackground')

let stillRejected = false
try {
  validateRendererSettingsPatch({ piBin: 'evil' })
} catch {
  stillRejected = true
}
ok(stillRejected, '白名单没有连带放行其它键（piBin 仍被拒）')

ok((await getSettings()).asciiBackground === undefined, '缺省不写 asciiBackground（视为关）')

const on = await patchSettings({ asciiBackground: true })
ok(on.asciiBackground === true, '打开后返回值为 true')
const diskOn = await readDisk()
ok(diskOn.asciiBackground === true, '磁盘上确实落了 true')

const restarted = await load('restart')
ok((await restarted.getSettings()).asciiBackground === true, '重新加载模块（模拟重启）后仍读到 true')

await patchSettings({ theme: 'light' })
const diskAfterTheme = await readDisk()
ok(diskAfterTheme.asciiBackground === true && diskAfterTheme.theme === 'light', '改其它字段后 true 仍在磁盘上')

const off = await patchSettings({ asciiBackground: false })
ok(off.asciiBackground === undefined, '明确关闭回落缺省（不写 false）')
ok((await readDisk()).asciiBackground === undefined, '磁盘上删除了 asciiBackground')

const dirty = await patchSettings({ asciiBackground: 'yes' })
ok(dirty.asciiBackground === undefined, '脏值不落盘')
ok((await readDisk()).asciiBackground === undefined, '脏值也没写进磁盘')

const third = await load('third')
ok((await third.getSettings()).asciiBackground === undefined, '第三个实例读到缺省')
await third.patchSettings({ asciiBackground: true })
ok((await third.getSettings()).asciiBackground === true, '第三个实例写入 true 后读到 true')
ok((await readDisk()).asciiBackground === true, '第三个实例写入后磁盘上仍是 true')

await rm(temp, { recursive: true, force: true })

const failed = results.filter((r) => !r.condition)
console.log(
  failed.length === 0
    ? 'v3 空态 ASCII 背景开关（主进程落盘）：全部通过'
    : `v3 空态 ASCII 背景开关（主进程落盘）：${failed.length} 项失败`
)
process.exit(failed.length === 0 ? 0 : 1)
