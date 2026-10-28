import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const dir = await mkdtemp(join(tmpdir(), 'yan-sync-baseline-'))

const bundle = async (entry, name) => {
  const outfile = join(dir, `${name}.mjs`)
  await build({ entryPoints: [join(ROOT, entry)], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

const user = (id, text = '问题') => ({ id, role: 'user', text })
const assistant = (id, text = '回答') => ({ id, role: 'assistant', text })

try {
  const plan = await bundle('src/main/session-sync-plan.ts', 'plan')
  const store = await bundle('src/main/sync-baseline.ts', 'store')
  const tools = await bundle('src/main/session-items/tool-events.ts', 'tools')

  const base = [user('m0'), assistant('m1'), user('m2')]
  const against = (previous, next) => plan.planSessionSyncAgainst(plan.syncBaselineOf(previous), next)

  assert.deepEqual(plan.planSessionSyncAgainst(undefined, base), { kind: 'full' })
  assert.deepEqual(against(base, base), { kind: 'none' }, '内容一致不重发')
  const grown = [...base, assistant('m3')]
  const delta = against(base, grown)
  assert.equal(delta.kind, 'delta')
  assert.equal(delta.anchorId, 'm2')
  assert.equal(delta.anchorIndex, 2)
  assert.deepEqual(delta.messages.map((m) => m.id), ['m3'])
  assert.deepEqual(against(base, grown), plan.planSessionSync(base, grown), '与按消息对象规划结果一致')
  const edited = [user('m0'), assistant('m1', '回答被改写了'), user('m2')]
  assert.equal(against(base, edited).kind, 'delta', '前缀签名不同从首个差异处起发')
  assert.equal(against(base, edited).anchorId, 'm0')
  assert.equal(against([user('x0')], base).kind, 'full', '没有共同前缀走全量')

  const now = Date.now()
  store.clearSyncBaselines()
  store.rememberSyncBaseline('C:\a\s.jsonl', base)
  assert.ok(store.takeSyncBaseline('C:\a\s.jsonl'), '记住后可取')
  assert.equal(store.takeSyncBaseline('C:\a\s.jsonl'), undefined, '取一次即失效')
  store.rememberSyncBaseline('C:\a\s.jsonl', base)
  assert.equal(store.takeSyncBaseline('C:\a\s.jsonl', now + 60_000), undefined, '超时失效')
  store.rememberSyncBaseline('C:\a\s.jsonl', [])
  assert.equal(store.takeSyncBaseline('C:\a\s.jsonl'), undefined, '空历史不记基线')
  for (let i = 0; i < 6; i += 1) store.rememberSyncBaseline(`C:\a\f${i}.jsonl`, base)
  assert.equal(store.takeSyncBaseline('C:\a\f0.jsonl'), undefined, '超出容量淘汰最旧')
  assert.ok(store.takeSyncBaseline('C:\a\f5.jsonl'))

  assert.equal(tools.toolOutputPushMode('abc', 3, 'abc'), 'skip')
  assert.equal(tools.toolOutputPushMode('abc', 3, 'abcdef'), 'delta')
  assert.equal(tools.toolOutputPushMode('abc', 3, 'xbcdef'), 'replace', '截断尾部后非前缀整段替换')
  assert.equal(tools.toolOutputPushMode('abcdef', 6, 'def'), 'replace', '变短且非前缀也替换')
  assert.equal(tools.toolOutputPushMode(undefined, 3, 'abcdef'), 'delta', '没有已推内容沿用长度增量')
  assert.equal(tools.toolOutputPushMode(undefined, 3, 'ab'), 'skip')

  console.log('PASS: test-sync-baseline')
} finally {
  await rm(dir, { recursive: true, force: true })
}
