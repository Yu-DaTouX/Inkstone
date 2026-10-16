/**
 * 空态动态 ASCII 背景开关的主进程落盘语义（AM2）。
 *
 * 与 `test-settings-store.mjs` 同一套隔离做法：`YAN_DATA_DIR` / `YAN_PI_DIR`
 * 指向临时目录 + electron 桩，绝不读写真实 `YAN_*` 数据。
 *
 * 覆盖「前端纯函数之外」的真实路径：
 *   1. 白名单放行 `asciiBackground`；
 *   2. 明确关 → 返回并落盘 `false`；
 *   3. 重新加载模块（模拟主进程重启）后仍读到 `false`；
 *   4. 缺省 / 明确开 / 脏值 → 一律不写该键（磁盘上删掉）；
 *   5. 写入该键后再改别的字段，`false` 不会被顺手抹掉。
 *
 *   node scripts/test-v3-ascii-settings.mjs
 */
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

/*
 * 每次调用得到**独立的模块实例**（Node 按完整 URL 缓存），用来模拟
 * 主进程重启：新实例没有上一次的内存缓存，只能从磁盘读。
 */
const load = (tag) => import(`${pathToFileURL(outfile).href}?instance=${tag}`)

const FILE = join(temp, 'data', 'desktop.json')
const readDisk = async () => JSON.parse(await readFile(FILE, 'utf8'))

const first = await load('first')
const { getSettings, patchSettings, validateRendererSettingsPatch } = first

/* ── 1 · 白名单放行 ASCII 字段 ──────────────────────────────── */
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

/* ── 2 · 缺省：不写该键 ─────────────────────────────────────── */
ok((await getSettings()).asciiBackground === undefined, '缺省不写 asciiBackground（视为开）')

/* ── 3 · 明确关：落 false ───────────────────────────────────── */
const off = await patchSettings({ asciiBackground: false })
ok(off.asciiBackground === false, '关掉后返回值为 false')
const diskOff = await readDisk()
ok(diskOff.asciiBackground === false, '磁盘上确实落了 false')

/* ── 4 · 重启后读回 false ───────────────────────────────────── */
const restarted = await load('restart')
ok((await restarted.getSettings()).asciiBackground === false, '重新加载模块（模拟重启）后仍读到 false')

/* ── 5 · 改别的字段不会把 false 抹掉 ───────────────────────── */
await patchSettings({ theme: 'light' })
const diskAfterTheme = await readDisk()
ok(diskAfterTheme.asciiBackground === false && diskAfterTheme.theme === 'light', '改其它字段后 false 仍在磁盘上')

/* ── 6 · 明确开 / 脏值：不写该键 ───────────────────────────── */
const on = await patchSettings({ asciiBackground: true })
ok(on.asciiBackground === undefined, '明确打开回落缺省（不写 true）')
ok((await readDisk()).asciiBackground === undefined, '磁盘上删除了 asciiBackground')

const dirty = await patchSettings({ asciiBackground: 'yes' })
ok(dirty.asciiBackground === undefined, '脏值不落盘')
ok((await readDisk()).asciiBackground === undefined, '脏值也没写进磁盘')

/* ── 7 · 再关一次仍然生效（清掉缓存后重读） ────────────────── */
const third = await load('third')
ok((await third.getSettings()).asciiBackground === undefined, '第三个实例读到缺省')
await third.patchSettings({ asciiBackground: false })
ok((await third.getSettings()).asciiBackground === false, '第三个实例写入 false 后读到 false')
ok((await readDisk()).asciiBackground === false, '第三个实例写入后磁盘上仍是 false')

await rm(temp, { recursive: true, force: true })

const failed = results.filter((r) => !r.condition)
console.log(
  failed.length === 0
    ? 'v3 空态 ASCII 背景开关（主进程落盘）：全部通过'
    : `v3 空态 ASCII 背景开关（主进程落盘）：${failed.length} 项失败`
)
process.exit(failed.length === 0 ? 0 : 1)
