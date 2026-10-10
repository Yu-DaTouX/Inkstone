import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { runRunnerTests } from './test-runners.mjs'

export async function runRunStateTests() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-run-state-'))
  async function load(entry, name) {
    const outfile = join(dir, `${name}.mjs`)
    const result = await build({ entryPoints: [entry], outfile, bundle: true, platform: 'neutral', format: 'esm', metafile: true, logLevel: 'silent' })
    // A neutral bundle with no externals proves this path needs no Electron/Node API.
    if (name === 'core') assert.deepEqual(Object.keys(result.metafile.inputs), ['src/core/run-state.ts'])
    return import(pathToFileURL(outfile).href)
  }
  const { executionBusy, runEnvelope, runStatus } = await load('src/core/run-state.ts', 'core')
  const identity = { id: 'r1', generation: 9, projectId: 'project' }
  assert.deepEqual(runEnvelope(identity, null), { runId: 'r1', sessionId: 'pending:r1', generation: 9, projectId: 'project' })
  const ready = runEnvelope(identity, { sessionId: 'saved-session' })
  assert.equal(ready.runId, 'r1')
  assert.equal(ready.generation, 9)
  assert.equal(ready.sessionId, 'saved-session')
  // Compaction / streaming / direct shell / waiting all block reuse independently.
  for (const field of ['isAgentRunning', 'isCompacting', 'isStreaming']) {
    assert.equal(executionBusy({ [field]: true }, () => { throw new Error('unexpected shell read') }, () => 0), true)
  }
  assert.equal(executionBusy(null, () => true, () => { throw new Error('unexpected UI read') }), true)
  assert.equal(executionBusy(null, () => false, () => 1), true)
  assert.equal(executionBusy(null, () => false, () => 0), false)
  const observation = { ...identity, cwd: 'registered-cwd', createdAt: 1, lastActiveAt: 2, state: { sessionId: 'saved-session', cwd: 'reported-cwd', isCompacting: true }, pendingUiCount: 1, conn: 'exited', isActive: false, isolation: { state: 'blocked', branch: 'isolated' } }
  const before = structuredClone(observation)
  const status = runStatus(observation)
  assert.deepEqual(status, { ...identity, runId: 'r1', cwd: 'reported-cwd', sessionFile: undefined, sessionId: 'saved-session', running: false, waiting: true, failed: true, conn: 'exited', createdAt: 1, lastActiveAt: 2, isActive: false, isolation: 'blocked', isolationBranch: 'isolated' })
  assert.deepEqual(observation, before)
  assert.equal(runStatus({ ...observation, state: null, isolation: undefined }).cwd, 'registered-cwd')
  assert.equal('isolation' in runStatus({ ...observation, isolation: undefined }), false)
  const { RunnerRegistry } = await load('src/main/runners.ts', 'runners')
  let checks = 0
  await runRunnerTests((condition, message) => { assert.ok(condition, message); checks++ }, RunnerRegistry)
  console.log(`run-state: core boundary and projection checks passed; ${checks} existing runner checks passed`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runRunStateTests()
