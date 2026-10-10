import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
await build({ entryPoints: ['src/main/browser.ts'], outfile: 'out/test/browser-popup.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const result = await new Promise((done, reject) => {
  const child = spawn(createRequire(import.meta.url)('electron'), [resolve('scripts/probe/browser-popup-boundary.cjs')], { env, windowsHide: true, stdio: 'inherit' })
  child.once('error', reject)
  child.once('exit', done)
})
if (result !== 0) throw new Error(`Browser popup boundary fixture failed: ${result}`)
