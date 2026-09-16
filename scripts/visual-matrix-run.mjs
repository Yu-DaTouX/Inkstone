/**
 * 分批跑视觉矩阵：**每组一个 Electron 进程**。
 *
 * 为什么不直接 `electron scripts/visual-matrix.mjs`（一个进程跑完 7 组）：
 * 这台机器上跑满时，后半程会出现 `Network service crashed` +
 * `GPU process exited unexpectedly`，脚本停住不动（只截到前几张）。
 * 拆开之后每组都能独立成功，某一组失败也不影响其它组，重跑也只重跑那一组。
 *
 * 用法：
 *   npm run visual:matrix          # 全部组
 *   npm run visual:matrix -- 0 2   # 只跑指定组
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electron = createRequire(import.meta.url)('electron')

const ALL = ['0', '1', '2', '3', '4', '5', '6', 'onboarding']
const wanted = process.argv.slice(2).filter(Boolean)
const groups = wanted.length ? wanted : ALL

const results = []
for (const g of groups) {
  /*
   * 必须显式清掉 `ELECTRON_RUN_AS_NODE`：pi 运行时会注入它，
   * 带着它 electron 二进制会退化成纯 Node，报
   * `does not provide an export named 'BrowserWindow'`（看着像启动失败）。
   */
  const env = { ...process.env, YAN_MATRIX_GROUP: g }
  delete env.ELECTRON_RUN_AS_NODE
  console.log(`\n${'='.repeat(64)}\n▶ 组 ${g}\n${'='.repeat(64)}`)
  const res = spawnSync(electron, [join(root, 'scripts/visual-matrix.mjs')], {
    cwd: root,
    env,
    stdio: 'inherit',
    windowsHide: true
  })
  results.push({ g, code: res.status ?? -1 })
}

console.log(`\n${'='.repeat(64)}`)
const bad = results.filter((r) => r.code !== 0)
for (const r of results) console.log(`  ${r.code === 0 ? '✓' : '✗'} 组 ${r.g}（退出码 ${r.code}）`)
console.log(bad.length ? `✗ ${bad.length}/${results.length} 组失败` : `✓ 全部 ${results.length} 组通过`)
process.exit(bad.length ? 1 : 0)
