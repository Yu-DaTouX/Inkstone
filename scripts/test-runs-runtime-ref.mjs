import { runSuite } from './lib/test-suite.mjs'

const oldEnvelope = (a, b) => {
  if (!a || !b) return false
  if (a.runId !== b.runId || a.generation !== b.generation) return false
  if (a.sessionId === b.sessionId) return true
  const pending = (value) => !value || value.startsWith('pending:')
  return pending(a.sessionId) || pending(b.sessionId)
}

const oldExpected = (runtime, expected) => {
  if (!runtime) return false
  if (expected.runId !== undefined && runtime.runId !== expected.runId) return false
  if (expected.generation !== undefined && runtime.generation !== expected.generation) return false
  if (expected.sessionId !== undefined && runtime.sessionId !== expected.sessionId) {
    if (!expected.sessionId.startsWith('pending:')) return false
  }
  return true
}

const oldExact = (a, b) => a.sessionId === b.sessionId && a.generation === b.generation

function refs() {
  const out = []
  for (const runId of [undefined, 'r1', 'r2'])
    for (const sessionId of [undefined, '', 's1', 's2', 'pending:r1', 'pending:r2'])
      for (const generation of [undefined, 1, 2]) {
        const ref = {}
        if (runId !== undefined) ref.runId = runId
        if (sessionId !== undefined) ref.sessionId = sessionId
        if (generation !== undefined) ref.generation = generation
        out.push(ref)
      }
  return out
}

await runSuite(import.meta.url, async (ok, compile) => {
  const { RuntimeRef } = await compile('src/shared/runs.ts')
  const all = refs()
  let envelopeDiff = 0
  let expectedDiff = 0
  let exactDiff = 0
  for (const a of all) {
    for (const b of all) {
      if (RuntimeRef.matches(a, b, 'envelope') !== oldEnvelope(a, b)) envelopeDiff++
      if (RuntimeRef.matches(a, b, 'expected') !== oldExpected(a, b)) expectedDiff++
      if (a.runId === undefined && b.runId === undefined && RuntimeRef.matches(a, b, 'exact') !== oldExact(a, b)) exactDiff++
    }
  }
  ok(envelopeDiff === 0, 'envelope 与原 sameRuntimeEnvelope 在全部组合上一致', String(envelopeDiff))
  ok(expectedDiff === 0, 'expected 与原 targetMatchesExpected 在全部组合上一致', String(expectedDiff))
  ok(exactDiff === 0, 'exact 与原队列 sameOwner 的 sessionId/generation 比较一致', String(exactDiff))
  ok(RuntimeRef.matches(null, { runId: 'r1' }, 'expected') === false && RuntimeRef.matches({ runId: 'r1' }, undefined, 'envelope') === false, '任一侧缺失时不匹配')
  ok(RuntimeRef.matches({ runId: 'r1', generation: 1, sessionId: 'real' }, { runId: 'r1', generation: 1, sessionId: 'pending:r1' }, 'envelope'), 'pending: 过继到真实 sessionId 仍视为同一运行')
  ok(RuntimeRef.matches({ runId: 'r1', generation: 1, sessionId: 'real' }, { generation: 1, sessionId: 'pending:x' }, 'expected'), 'expected 侧的 pending: 不卡真实 sessionId')
  ok(!RuntimeRef.matches({ runId: 'r1', generation: 1, sessionId: 'real-1' }, { generation: 1, sessionId: 'real-2' }, 'expected'), '两个不同真实 sessionId 不能互换')
  ok(!RuntimeRef.matches({ runId: 'r1', generation: 2, sessionId: 'real' }, { runId: 'r1', generation: 1, sessionId: 'pending:r1' }, 'envelope'), '代次不同即不匹配')
  ok(RuntimeRef.isPendingSessionId('pending:r1') && !RuntimeRef.isPendingSessionId('') && !RuntimeRef.isPendingSessionId(undefined), 'pending: 判定')
})
