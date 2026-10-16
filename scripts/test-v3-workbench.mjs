/**
 * P3 / R0：工作区归属推导的纯函数测试。
 *
 * 只编译 `features/workbench/ownership.ts`（纯函数 + 既有 workspace-key），
 * 不启动 Electron、不读用户数据、不调用模型，也不碰任何叶子面板。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../src/renderer/src/features/workbench/ownership.ts', import.meta.url))
const result = await build({
  entryPoints: [source],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const mod = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
const { deriveWorkspaceOwner, viewIdentity } = mod

const session = { sessionId: 's1', sessionFile: 'C:/data/s1.jsonl', cwd: 'C:/proj/one' }
const runner = (over = {}) => ({
  id: 'r1',
  runId: 'r1',
  sessionId: 's1',
  sessionFile: 'C:/data/s1.jsonl',
  cwd: 'C:/proj/one',
  generation: 4,
  isActive: true,
  ...over
})
const base = {
  peekedSessionId: null,
  peekedPath: null,
  session,
  pendingActivation: null,
  activeRunnerId: 'r1',
  runners: [runner()],
  sessions: [{ id: 's1', path: 'C:/data/s1.jsonl', cwd: 'C:/proj/one' }]
}

/* 1. 已激活：cwd / runId / generation 都来自当前视图对应的运行实例 */
const active = deriveWorkspaceOwner(base)
assert.equal(active.active, true)
assert.equal(active.sessionId, 's1')
assert.equal(active.cwd, 'C:/proj/one')
assert.equal(active.runId, 'r1')
assert.equal(active.generation, 4)
assert.ok(active.key.includes('s1.jsonl'), `key 用稳定会话键，实际 ${active.key}`)

/* 2. 只是 peek 历史、还没激活：active=false，cwd 取待激活目标，不带 runId */
const pending = deriveWorkspaceOwner({
  ...base,
  peekedSessionId: 's2',
  peekedPath: 'C:/data/s2.jsonl',
  pendingActivation: { sessionId: 's2', sessionFile: 'C:/data/s2.jsonl', cwd: 'C:/proj/two' },
  sessions: [
    { id: 's1', path: 'C:/data/s1.jsonl', cwd: 'C:/proj/one' },
    { id: 's2', path: 'C:/data/s2.jsonl', cwd: 'C:/proj/two' }
  ]
})
assert.equal(pending.active, false, '有待激活目标时不得当作已激活')
assert.equal(pending.sessionId, 's2')
assert.equal(pending.cwd, 'C:/proj/two', 'cwd 取待激活目标')
assert.equal(pending.runId, undefined, '未激活不给 runId')

/* 3. peek 新会话、活动实例仍停在旧会话：不得把旧 session.cwd 当新视图的 cwd */
const switched = deriveWorkspaceOwner({
  ...base,
  peekedSessionId: 's2',
  peekedPath: 'C:/data/s2.jsonl',
  pendingActivation: null,
  sessions: [
    { id: 's1', path: 'C:/data/s1.jsonl', cwd: 'C:/proj/one' },
    { id: 's2', path: 'C:/data/s2.jsonl', cwd: 'C:/proj/two' }
  ]
})
assert.equal(switched.sessionId, 's2')
assert.equal(switched.active, false, '活动实例属于另一条会话时不算已激活')
assert.equal(switched.cwd, 'C:/proj/two', 'cwd 用视图会话摘要，不盲取旧投影 session.cwd')
assert.equal(switched.runId, undefined)

/* 4. 运行实例的会话文件路径大小写 / 分隔符归一后仍能认出同一会话 */
const normalized = deriveWorkspaceOwner({
  ...base,
  session: { sessionId: 's1', sessionFile: 'c:\\data\\S1.jsonl', cwd: 'C:/proj/one' },
  runners: [runner({ sessionFile: 'C:/data/s1.jsonl' })]
})
assert.equal(normalized.sessionId, 's1')
assert.equal(normalized.active, true, '路径归一后仍是同一条会话')

/* 5. viewIdentity / 空视图：新会话没落盘时也要有可用的 key */
assert.deepEqual(viewIdentity({ ...base, peekedSessionId: 's9', peekedPath: 'C:/data/s9.jsonl' }), {
  sessionId: 's9',
  sessionFile: 'C:/data/s9.jsonl'
})
const empty = deriveWorkspaceOwner({
  peekedSessionId: null,
  peekedPath: null,
  session: null,
  pendingActivation: null,
  activeRunnerId: null,
  runners: [],
  sessions: []
})
assert.equal(empty.active, true, '没有可竞争的会话时视图视为已对齐')
assert.equal(empty.cwd, '')

console.log('v3 工作区归属：激活/待激活/切会话 cwd/路径归一/空视图 检查通过')
