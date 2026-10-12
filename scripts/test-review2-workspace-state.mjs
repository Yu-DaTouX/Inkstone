import assert from 'node:assert/strict'
import { build, transform } from 'esbuild'

async function compile(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, format: 'esm', write: false, platform: 'node' })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

for (const file of [
  'src/renderer/src/state/store.ts',
  'src/renderer/src/state/daily-sources.ts',
  'src/renderer/src/state/refresh-models.ts',
  'src/renderer/src/main.tsx',
  'src/renderer/src/lib/interaction-state.tsx'
]) {
  const { outputFiles } = await build({ entryPoints: [file], bundle: false, write: false, loader: { '.tsx': 'tsx' } })
  assert.ok(outputFiles[0].text.length > 0, `${file} transpiles`)
}

const split = await compile('src/renderer/src/state/split-snapshots.ts')
const message = (id, text) => ({ id, role: 'user', text, timestamp: 1 })
split.rememberShown({ sessionId: 'small' }, [message('small', 'kept')])
split.rememberShown({ sessionId: 'large' }, [message('large', 'x'.repeat(17 * 1024 * 1024))])
assert.equal(split.shownMessages({ sessionId: 'large' }), undefined, 'oversized snapshots must be evicted')
assert.equal(split.shownMessages({ sessionId: 'small' })[0].text, 'kept', 'byte cap preserves the small snapshot')

const runtime = await compile('src/renderer/src/state/session-runtime.ts')
const envelope = (sessionId) => ({ runnerId: `runner-${sessionId}`, runId: `run-${sessionId}`, sessionId, generation: 1 })
const snapshot = (sessionId, draft, messages = []) => ({
  runtime: envelope(sessionId), session: null, messages, stats: null, queue: { steering: [], followUp: [] },
  todos: [], todoHistory: [], uiRequests: [], statuses: {}, widgets: {}, draft, workMode: null,
  agentProfile: null, goal: { goalId: '', phase: 'planning', revision: 0, steps: [], evidence: [], links: [], verification: null, budget: null, budgetStop: null, blocker: null, pursue: false, brief: null, readyApproval: 'automatic', pendingReady: null, failure: null, updatedAt: 0 },
  models: [], thinkingLevels: [], commands: [], touchedAt: 1
})
let runtimes = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`draft-${i}`, { ...snapshot(`draft-${i}`, `draft-${i}`), touchedAt: i + 1 }]))
runtimes = runtime.pruneSessionRuntimes(runtimes, new Set())
assert.equal(Object.keys(runtimes).length, 16, 'draft-only session cache is bounded')
assert.ok(Object.values(runtimes).every((item) => item.draft), 'retained cache entries preserve drafts')
assert.ok(!runtimes['draft-0'], 'least recently used draft is evicted')

const consumers = await compile('src/renderer/src/state/push-consumers.ts')
const request = { id: 'question-1', title: 'Pick', message: 'Choose', kind: 'select', options: [] }
let state = { uiRequests: [request], uiCollapsed: true, settings: null }
let alerts = 0
const ctx = { get: () => state, set: (patch) => { state = { ...state, ...patch } }, alertAttention: () => alerts++, pushNotice: (list) => list, applyBrowserVisibility() {} }
assert.equal(consumers.consumeQuestionPush({ ch: 'ui-request', payload: { ...request, message: 'Updated' } }, state, ctx), true)
assert.equal(state.uiRequests.length, 1, 'same request ID is replaced, not duplicated')
assert.equal(state.uiRequests[0].message, 'Updated')
assert.equal(alerts, 0, 'duplicate delivery does not alert again')
assert.equal(state.uiCollapsed, true, 'duplicate delivery does not reopen a dismissed panel')
console.log('workspace-state behavioral regressions: split byte cap, draft cache bound, ui-request dedupe passed')
