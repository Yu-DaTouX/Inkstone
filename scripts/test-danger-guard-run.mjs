/**
 * 单独运行 danger-guard 判定测试（不经过完整 test:unit）。
 * 用法： node scripts/test-danger-guard-run.mjs
 */
import { build } from '../node_modules/esbuild/lib/main.js'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

await build({
  entryPoints: ['resources/pi-extensions/danger-guard.js'],
  outfile: 'out/test/danger-guard.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})
const mod = await import(pathToFileURL(resolve('out/test/danger-guard.mjs')).href)
const { runDangerGuardTests } = await import('./test-danger-guard.mjs')
let total = 0
let failed = 0
runDangerGuardTests((cond, name) => {
  total += 1
  if (!cond) {
    failed += 1
    console.log(`✗ ${name}`)
  }
}, mod)
console.log(`${total} 项，${failed} 项失败`)
process.exit(failed ? 1 : 0)
