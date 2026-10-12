import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, mkdir, readFile, rm, writeFile, utimes, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = await mkdtemp(join(tmpdir(), 'inkstone-review2-sessions-'))
process.env.YAN_PI_DIR = join(root, 'pi')
process.env.YAN_DATA_DIR = join(root, 'data')
process.env.YAN_SESSIONS_DIR = join(root, 'sessions')
await mkdir(process.env.YAN_SESSIONS_DIR, { recursive: true })
const outputs = {}
try {
  for (const name of ['sessions', 'session-search', 'session-entries-lite', 'question-log']) {
    const outfile = join(root, `${name}.mjs`)
    await build({ entryPoints: [`src/main/${name}.ts`], outfile, bundle: true, platform: 'node', format: 'esm' })
    outputs[name] = await import(pathToFileURL(outfile).href)
  }

  const logPath = join(root, 'log.json')
  const { QuestionLogStore } = outputs['question-log']
  const log = new QuestionLogStore(() => logPath)
  log.append('sess-a', { question: 'Q', options: [], answer: 'A', cancelled: false, at: 100 })
  const persisted = JSON.parse(await readFile(logPath, 'utf8'))
  delete persisted.sessions['sess-a'][0].id
  await writeFile(logPath, JSON.stringify(persisted))
  const id1 = log.list('sess-a')[0].id
  const id2 = log.list('sess-a')[0].id
  assert.equal(id1, id2, 'missing IDs remain deterministic across reads')
  await writeFile(logPath, '{bad json')
  assert.throws(() => log.list('sess-a'), 'corrupt data is rejected instead of treated as empty')
  assert.equal(await readFile(logPath, 'utf8'), '{bad json', 'corrupt source is preserved')

  const sessionFile = join(process.env.YAN_SESSIONS_DIR, 'session.jsonl')
  const sessionHead = JSON.stringify({ type: 'session', id: 'first', cwd: root, timestamp: new Date().toISOString() })
  await writeFile(sessionFile, `${sessionHead}\n${JSON.stringify({ type: 'message', id: 'm1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello' } })}\n`)
  const lite = new outputs['session-entries-lite'].SessionEntriesLite()
  assert.equal((await lite.entries(sessionFile)).find((entry) => entry.type === 'message').id, 'm1')
  const stat = await (await import('node:fs/promises')).stat(sessionFile)
  const secondHead = JSON.stringify({ type: 'session', id: 'other', cwd: root, timestamp: new Date().toISOString() })
  const replacement = `${secondHead}\n${JSON.stringify({ type: 'message', id: 'm2', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello' } })}\n`
  await writeFile(sessionFile, replacement)
  await utimes(sessionFile, stat.atime, stat.mtime)
  assert.equal((await lite.entries(sessionFile)).find((entry) => entry.type === 'message').id, 'm2', 'same-size/header rewrite rebuilds lite index')

  const huge = 'x'.repeat(96 * 1024)
  await writeFile(sessionFile, `${JSON.stringify({ type: 'session', id: 'tail' })}\n${JSON.stringify({ type: 'message', id: 'old', timestamp: '2025-01-01T00:00:00Z', message: { role: 'user', content: 'older' } })}\n${JSON.stringify({ type: 'message', id: 'giant', timestamp: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: huge } })}\n`)
  const { listSessions } = outputs.sessions
  const listed = await listSessions(20)
  assert.equal(listed[0]?.lastActivityAt, Date.parse('2026-01-01T00:00:00Z'), 'tail scan finds activity following a >64KiB line')

  const { searchSessionText } = outputs['session-search']
  const found = await searchSessionText('older')
  assert.ok(found.hits.some((hit) => hit.path === sessionFile), 'search reads and indexes matching body on demand')

  const outside = join(root, 'outside')
  await mkdir(outside)
  const victim = join(outside, 'escape.jsonl')
  await writeFile(victim, '{}\n')
  const sessions = outputs.sessions
  await assert.rejects(() => sessions.deleteSession(victim), 'prefix sibling outside the session root is rejected')
  console.log('sessions review2 behavioral probes passed: strict/atomic question log, deterministic IDs, lazy search, long tail rows, header invalidation, delete boundary')
} finally {
  await rm(root, { recursive: true, force: true })
}
