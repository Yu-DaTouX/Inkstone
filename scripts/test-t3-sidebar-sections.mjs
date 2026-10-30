import assert from 'node:assert/strict'
import { build } from 'esbuild'

const result = await build({
  entryPoints: ['src/renderer/src/t3/adapters/sidebar/sections.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm'
})
const { buildSidebarSections } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
const now = Date.now()
const session = (id, extra = {}) => ({ id, path: `E:/sessions/${id}.jsonl`, title: id, createdAt: now - 1000, updatedAt: now, messageCount: 2, ...extra })
const run = (runId, sessionId, startedAt, extra = {}) => ({ runId, sessionId, startedAt, phase: { kind: 'done', at: now, seen: true }, ...extra })
const input = (sessions, runs, extra = {}) => ({ sessions, runs, projects: [], projectNames: {}, titles: {}, manualTitles: {}, now, ...extra })
const all = (sections) => Object.values(sections).flat()

const sessions = [session('id-match'), session('path-match'), session('ties'), session('missing')]
const runs = [
  run('path-tie-first', 'old-id', 50, { sessionPath: sessions[2].path }),
  run('id-tie-second', 'ties', 50),
  run('id-old', 'id-match', 10),
  run('id-new', 'id-match', 30),
  run('path-new', 'moved', 40, { sessionPath: sessions[1].path })
]
const views = new Map(all(buildSidebarSections(input(sessions, runs))).map(view => [view.id, view]))
assert.equal(views.get('id-match').latestRun.runId, 'id-new')
assert.equal(views.get('path-match').latestRun.runId, 'path-new')
assert.equal(views.get('ties').latestRun.runId, 'path-tie-first')
assert.equal(views.get('missing').latestRun, null)
const reversed = all(buildSidebarSections(input(sessions, [...runs].reverse())))
assert.equal(reversed.find(view => view.id === 'ties').latestRun.runId, 'id-tie-second')

const mixed = buildSidebarSections(input([
  session('pinned', { pinned: true }),
  session('snoozed', { snoozedUntil: now + 60000 }),
  session('archived', { archivedAt: now - 100 }),
  session('running'),
  session('active'),
  session('project-archived', { cwd: 'E:/archived', projectId: 'archived-project' })
], [run('running', 'running', now, { phase: { kind: 'running', since: now } })], {
  projects: [{ id: 'archived-project', name: 'Archive', cwd: 'E:/archived', archived: true }],
  titles: { active: 'Generated' },
  manualTitles: { active: 'Manual' }
}))
assert.deepEqual(mixed.pinned.map(view => view.id), ['pinned'])
assert.deepEqual(mixed.snoozed.map(view => view.id), ['snoozed'])
assert.deepEqual(new Set(mixed.settled.map(view => view.id)), new Set(['archived', 'project-archived']))
assert.deepEqual(mixed.working.map(view => view.id), ['running'])
assert.equal(mixed.active[0].title, 'Manual')

const manySessions = Array.from({ length: 200 }, (_, i) => session(`s-${i}`))
const manyRuns = Array.from({ length: 1200 }, (_, i) => run(`r-${i}`, `s-${i % 220}`, i % 37, {
  sessionPath: manySessions[(i * 7) % manySessions.length].path
}))
const manyViews = new Map(all(buildSidebarSections(input(manySessions, manyRuns))).map(view => [view.id, view]))
for (const item of manySessions) {
  const expected = manyRuns.reduce((latest, candidate) => {
    if (candidate.sessionId !== item.id && candidate.sessionPath !== item.path) return latest
    return !latest || candidate.startedAt > latest.startedAt ? candidate : latest
  }, null)
  assert.equal(manyViews.get(item.id).latestRun?.runId ?? null, expected?.runId ?? null, item.id)
}
console.log('PASS T3 sidebar sections: latest run identity/path/ties, shelves, archived projects, titles, 200 mixed identity comparisons')
