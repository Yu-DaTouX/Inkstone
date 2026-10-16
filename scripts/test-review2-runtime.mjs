import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temp = await mkdtemp(path.join(os.tmpdir(), 'inkstone-review2-runtime-'))
try {
  const titleBundle = path.join(temp, 'title.mjs')
  await build({
    entryPoints: ['src/main/title.ts'],
    outfile: titleBundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    plugins: [{
      name: 'isolated-title-dependencies',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^\.\/protocol$/ }, () => ({ path: 'protocol-stub', namespace: 'test' }))
        buildApi.onLoad({ filter: /^protocol-stub$/, namespace: 'test' }, () => ({ contents: `import { EventEmitter } from 'node:events'; export class PiRpc extends EventEmitter { constructor() { super(); } spawn() { queueMicrotask(() => this.emit('exit', 0)); } async command() { return { success: true }; } async close() {} }`, loader: 'js' }))
        buildApi.onResolve({ filter: /^\.\/paths$/ }, () => ({ path: 'paths-stub', namespace: 'test' }))
        buildApi.onLoad({ filter: /^paths-stub$/, namespace: 'test' }, () => ({ contents: `export const PI_AGENT_DIR = ${JSON.stringify(temp)}; export const YAN_DIR = ${JSON.stringify(temp)};`, loader: 'js' }))
      }
    }]
  })
  const { generateTitle, setManualTitle } = await import(pathToFileURL(titleBundle).href)
  const exitedTitle = await generateTitle({ sessionId: 'session', samples: ['sample'], cwd: temp, force: true, timeoutMs: 50 })
  assert.equal(exitedTitle, null, '零退出但未产生标题的子进程应结束为失败而不挂起')
  const manualPath = path.join(temp, 'manual-titles.json')
  await (await import('node:fs/promises')).writeFile(manualPath, '{broken', 'utf8')
  const beforeCorrupt = await readFile(manualPath, 'utf8')
  assert.equal((await setManualTitle('session', 'name')).ok, false)
  assert.equal(await readFile(manualPath, 'utf8'), beforeCorrupt, '损坏的手动标题文件不可被空表覆盖')
  console.log('review2 runtime behavior: 3 assertions passed')
} finally {
  await rm(temp, { recursive: true, force: true })
}
