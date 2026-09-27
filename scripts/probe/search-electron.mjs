/**
 * 搜索后端在 **Electron 运行时**下的探针（实施-27 回归，cost 0）。
 *
 * 为什么必须单独一个：`scripts/probe/search.mjs` 跑在普通 node 下
 * （`process.versions.electron` 不存在），而砚的主进程是 Electron —— 那正是
 * 「commander 按 electron 语义切参数 → 子命令全部错位 → doctor 假绿」的那条路。
 * 这个探针用 `ELECTRON_RUN_AS_NODE=1 <electron> <driver>` 跑同一份
 * `src/main/search/opencli.ts`，钉住两件事：
 *   ① `searchDoctor()` 在 Electron 下也报 available；
 *   ② 至少一个来源真的返回了结果（不是「可用但查不到」）。
 *
 * 需要本机装了 OpenCLI 与 node（与 `probe/search.mjs` 同样的前提）。
 * 用法：node scripts/probe/search-electron.mjs
 * 退出码：0 = 两件都成立；1 = 不成立（如实失败，不假装成功）。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { build } from '../../node_modules/esbuild/lib/main.js'

const OUT = 'out/probe'
mkdirSync(OUT, { recursive: true })

await build({
  entryPoints: ['src/main/search/opencli.ts'],
  outfile: `${OUT}/search-electron-mod.mjs`,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})

/* 一次性 driver：在 Electron 运行时里读回真实探针结果，只把 JSON 交回本进程 */
const driver = join(OUT, 'search-electron-drive.mjs')
writeFileSync(
  driver,
  [
    "import { searchDoctor, runSearch, createOpencliRunner } from './search-electron-mod.mjs'",
    'const doctor = await searchDoctor()',
    'const outcome = await runSearch(',
    "  { text: 'flash attention', limitPerSource: 3, limitTotal: 6 },",
    '  { runner: createOpencliRunner(), now: () => Date.now() }',
    ')',
    "console.log('__RESULT__' + JSON.stringify({",
    '  electron: Boolean(process.versions.electron),',
    '  available: doctor.available,',
    '  code: doctor.code ?? null,',
    '  sourcesReady: doctor.sources.every((s) => s.ready),',
    "  reached: outcome.sources.filter((s) => s.status === 'ok' && s.count > 0).length,",
    "  detail: (doctor.detail || '').split('\\n')[0].slice(0, 160)",
    '}))',
    ''
  ].join('\n'),
  'utf8'
)

const requireEsm = createRequire(import.meta.url)
let electronPath
try {
  electronPath = requireEsm('electron')
} catch (e) {
  console.error('找不到 electron 包（这个探针要在装了 devDependencies 的仓库里跑）：', e instanceof Error ? e.message : e)
  process.exit(1)
}
const run = spawnSync(electronPath, [driver], {
  encoding: 'utf8',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  timeout: 120_000
})

const line = (run.stdout ?? '').split('\n').find((l) => l.startsWith('__RESULT__'))
if (!line) {
  console.error('探针没有返回结果。stderr:', (run.stderr ?? '').slice(0, 600))
  process.exit(1)
}
const result = JSON.parse(line.slice('__RESULT__'.length))

console.log('Electron 运行时 =', result.electron, '| available =', result.available, '| code =', result.code)
console.log('来源 ready =', result.sourcesReady, '| 有结果的来源 =', result.reached)
console.log('detail head =', result.detail)

if (result.electron !== true) {
  console.error('✗ 探针没跑在 Electron 运行时里（那这条证据不成立）')
  process.exit(1)
}
if (result.available !== true || result.reached <= 0) {
  console.error('✗ Electron 运行时下搜索后端不可用，或没有来源返回结果')
  process.exit(1)
}
console.log('✓ Electron 运行时下搜索后端可用，且至少一个来源返回了结果')
process.exit(0)
