import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(path.join(os.tmpdir(), 'inkstone-runtime-followup-'))
try {
  const pathsPlugin = { name: 'isolated-paths', setup(api) {
    api.onResolve({ filter: /^\.\/paths$/ }, () => ({ path: 'paths-stub', namespace: 'fixture' }))
    api.onLoad({ filter: /^paths-stub$/, namespace: 'fixture' }, () => ({ contents: `export const YAN_DIR=${JSON.stringify(root)};`, loader: 'js' }))
  } }
  const stateBundle = path.join(root, 'state.mjs')
  await build({ entryPoints: ['src/main/context-state-store.ts'], outfile: stateBundle, bundle: true, platform: 'node', format: 'esm', plugins: [pathsPlugin] })
  const store = await import(pathToFileURL(stateBundle).href)
  const dir = path.join(root, 'state')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 's1.json'), '{bad', 'utf8')
  const { CONTEXT_STATE_SCHEMA_VERSION, emptyTaskState } = store
  const state = { schemaVersion: CONTEXT_STATE_SCHEMA_VERSION, sessionId: 's1', sourceWatermark: { entryCount: 0, lastEntryId: null }, createdAt: 1, updatedAt: 2, task: emptyTaskState('objective', 'phase'), episodes: [] }
  const [loaded] = await Promise.all([store.loadContextState('s1', { dir }), store.saveContextState(state, { dir })])
  assert.equal(loaded.status, 'discarded')
  assert.equal((await store.loadContextState('s1', { dir })).status, 'ok', '坏文档隔离与并发保存串行，保存的新状态仍在')
  await store.deleteContextStates(['s1'], { dir })
  assert.equal((await store.loadContextState('s1', { dir })).status, 'missing', 'clear 与 load 同 scope 串行')

  const policyBundle = path.join(root, 'policy.mjs')
  await build({ entryPoints: ['src/main/context-policy.ts'], outfile: policyBundle, bundle: true, platform: 'node', format: 'esm' })
  const policy = await import(pathToFileURL(policyBundle).href)
  const sharedBundle = path.join(root, 'shared-policy.mjs')
  await build({ entryPoints: ['src/shared/context-policy.ts'], outfile: sharedBundle, bundle: true, platform: 'node', format: 'esm' })
  const shared = await import(pathToFileURL(sharedBundle).href)
  const policyDir = path.join(root, 'policy')
  const first = { user: { workingSetCap: 100 } }, latest = { user: { workingSetCap: 200 } }
  await Promise.all([policy.syncEffectivePolicyFile(policyDir, first), policy.syncEffectivePolicyFile(policyDir, latest)])
  const written = JSON.parse(await readFile(path.join(policyDir, 'context-policy.effective.json'), 'utf8'))
  assert.equal(written.revision, shared.contextPolicyRevision(latest), 'revision 写入只保留最新 settings')
  console.log('runtime-followup behavior: 4 assertions passed')
} finally { await rm(root, { recursive: true, force: true }) }
