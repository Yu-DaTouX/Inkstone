import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temp = await mkdtemp(path.join(os.tmpdir(), 'inkstone-review2-runtime-'))
try {
  const bundle = path.join(temp, 'context-inspect.mjs')
  await build({
    entryPoints: ['src/main/context-inspect.ts'],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    plugins: [{
      name: 'isolated-paths',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^\.\/paths$/ }, () => ({ path: 'isolated-paths', namespace: 'test' }))
        buildApi.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `export const YAN_DIR = ${JSON.stringify(temp)};`, loader: 'js' }))
      }
    }]
  })
  const { saveContextInspect, readContextInspect } = await import(pathToFileURL(bundle).href)
  const snapshot = { version: 1, at: 42, promptTokens: 10, toolTokens: 2, sections: [], tools: [] }
  assert.equal(saveContextInspect('runtime1', snapshot), true)
  assert.deepEqual(await readContextInspect('runtime1'), snapshot)
  assert.equal(saveContextInspect('runtime1', { version: 1 }), false)
  assert.deepEqual(await readContextInspect('runtime1'), snapshot, '无效快照不能覆盖上次有效数据')
  const files = await readdir(path.join(temp, 'context-inspect'))
  assert.deepEqual(files, ['runtime1.json'], '临时文件应在成功替换后清除')

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
        buildApi.onResolve({ filter: /^\.\/normalize$/ }, () => ({ path: 'normalize-stub', namespace: 'test' }))
        buildApi.onLoad({ filter: /^normalize-stub$/, namespace: 'test' }, () => ({ contents: 'export const toUsage = () => null;', loader: 'js' }))
        buildApi.onResolve({ filter: /^\.\/context-background-usage$/ }, () => ({ path: 'usage-stub', namespace: 'test' }))
        buildApi.onLoad({ filter: /^usage-stub$/, namespace: 'test' }, () => ({ contents: 'export const appendContextBackgroundUsage = () => {};', loader: 'js' }))
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

  const stateBundle = path.join(temp, 'context-state-store.mjs')
  await build({
    entryPoints: ['src/main/context-state-store.ts'],
    outfile: stateBundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    plugins: [{
      name: 'isolated-paths',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^\.\/paths$/ }, () => ({ path: 'isolated-paths', namespace: 'test' }))
        buildApi.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `export const YAN_DIR = ${JSON.stringify(temp)};`, loader: 'js' }))
      }
    }]
  })
  const { loadContextState } = await import(pathToFileURL(stateBundle).href)
  const stateDir = path.join(temp, 'state')
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(stateDir, { recursive: true })
  await writeFile(path.join(stateDir, 'broken.json'), '{broken', 'utf8')
  assert.equal((await loadContextState('broken', { dir: stateDir })).status, 'discarded')
  const quarantined = (await readdir(stateDir)).filter(name => name.startsWith('broken.json.invalid-'))
  assert.equal(quarantined.length, 1, '非法状态应隔离保留而非直接删除')
  console.log('review2 runtime behavior: 9 assertions passed')
} finally {
  await rm(temp, { recursive: true, force: true })
}
