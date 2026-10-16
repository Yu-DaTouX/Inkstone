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
