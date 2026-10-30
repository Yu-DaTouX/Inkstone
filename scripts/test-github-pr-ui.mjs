import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

async function load(path) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(path, import.meta.url))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const m = await load('../src/renderer/src/features/github/pr-actions-model.ts')
const model = await load('../src/renderer/src/features/github/pr-model.ts')
const textMod = await load('../src/renderer/src/features/github/pr-action-text.ts')

{
  const base = m.DEFAULT_LIST_FILTERS
  assert.deepEqual(m.buildListOptions(base, 1), { state: 'open', sort: 'updated', direction: 'desc', limit: 30 })
  const full = m.buildListOptions(
    { ...base, state: 'all', author: ' octocat ', labels: [' bug ', 'ui', 'bug', ''], draft: 'ready', review: 'changes_requested', sort: 'comments', direction: 'asc' },
    3
  )
  assert.deepEqual(full, {
    state: 'all',
    sort: 'comments',
    direction: 'asc',
    limit: 90,
    author: 'octocat',
    labels: ['bug', 'ui'],
    draft: false,
    review: 'changes_requested'
  })
  assert.equal(m.buildListOptions({ ...base, draft: 'draft' }, 0).draft, true)
  assert.equal(m.buildListOptions({ ...base, draft: 'draft' }, 0).limit, 30)
  assert.equal(m.activeFilterCount(base), 0)
  assert.equal(m.activeFilterCount({ ...base, author: 'hubot', labels: ['x'], draft: 'draft', review: 'approved' }), 4)
  assert.deepEqual(m.toggleLabel(['a'], 'b'), ['a', 'b'])
  assert.deepEqual(m.toggleLabel(['a', 'b'], 'a'), ['b'])
}

{
  const pass = { state: 'pass', total: 2, passed: 2, failed: 0, pending: 0 }
  const fail = { state: 'fail', total: 2, passed: 1, failed: 1, pending: 0 }
  const pending = { state: 'pending', total: 2, passed: 1, failed: 0, pending: 1 }
  const clean = { state: 'open', checks: pass, reviewDecision: 'APPROVED', mergeable: 'mergeable', mergeState: 'CLEAN' }
  assert.deepEqual(m.mergeVerdict(clean), { canMerge: true, canAutoMerge: true, blockers: [] })
  assert.deepEqual(m.mergeVerdict({ ...clean, state: 'merged' }), { canMerge: false, canAutoMerge: false, blockers: ['not-open'] })
  assert.deepEqual(m.mergeVerdict({ ...clean, state: 'draft' }), { canMerge: false, canAutoMerge: false, blockers: ['draft'] })
  assert.deepEqual(m.mergeVerdict({ ...clean, mergeable: 'conflicting' }).blockers, ['conflict'])
  assert.equal(m.mergeVerdict({ ...clean, mergeable: 'conflicting' }).canAutoMerge, false)
  const failing = m.mergeVerdict({ ...clean, checks: fail })
  assert.deepEqual(failing, { canMerge: false, canAutoMerge: false, blockers: ['checks-failed'] })
  const waiting = m.mergeVerdict({ ...clean, checks: pending, reviewDecision: 'REVIEW_REQUIRED' })
  assert.deepEqual(waiting, { canMerge: false, canAutoMerge: true, blockers: ['checks-pending', 'review-required'] })
  assert.deepEqual(m.mergeVerdict({ ...clean, reviewDecision: 'CHANGES_REQUESTED' }).blockers, ['changes-requested'])
  assert.deepEqual(m.mergeVerdict({ ...clean, reviewDecision: '', mergeState: 'BLOCKED' }), { canMerge: false, canAutoMerge: true, blockers: ['blocked'] })
  assert.deepEqual(m.mergeVerdict({ ...clean, mergeable: 'unknown' }).blockers, [])
  assert.deepEqual(model.mergeableOf({ mergeable: 'CONFLICTING', mergeStateStatus: 'dirty' }), { mergeable: 'conflicting', mergeState: 'DIRTY' })
  assert.deepEqual(model.mergeableOf({}), { mergeable: 'unknown', mergeState: '' })
  const row = model.normalizePrRow({ number: 3, labels: [{ name: 'bug' }, { name: '' }, null] })
  assert.deepEqual(row.labels, ['bug'])
}

{
  let list = []
  list = m.addPendingComment(list, { path: 'a.ts', line: 4, startLine: 2, side: 'RIGHT', body: '  fix  ' }, 'p1')
  list = m.addPendingComment(list, { path: 'b.ts', line: 1, startLine: 1, side: 'LEFT', body: 'old' }, 'p2')
  assert.equal(m.addPendingComment(list, { path: 'c.ts', line: 1, startLine: 1, side: 'LEFT', body: '   ' }, 'p3').length, 2)
  assert.equal(m.addPendingComment(list, { path: '', line: 1, startLine: 1, side: 'LEFT', body: 'x' }, 'p3').length, 2)
  assert.equal(list[0].body, 'fix')
  list = m.updatePendingComment(list, 'p2', 'changed')
  assert.equal(list[1].body, 'changed')
  assert.deepEqual(m.updatePendingComment(list, 'p2', '  ').map((item) => item.id), ['p1'])
  assert.deepEqual(m.removePendingComment(list, 'p1').map((item) => item.id), ['p2'])
  assert.deepEqual(m.inlineCommentsOf(list), [
    { path: 'a.ts', line: 4, side: 'RIGHT', body: 'L2-L4\n\nfix' },
    { path: 'b.ts', line: 1, side: 'LEFT', body: 'changed' }
  ])
  const raw = JSON.stringify([...list, { id: 'bad', path: 'x', line: '1' }, { id: 'e', path: 'x', line: 1, startLine: 1, side: 'RIGHT', body: ' ' }])
  assert.deepEqual(m.parsePending(raw), list)
  assert.deepEqual(m.parsePending('nope'), [])
  assert.deepEqual(m.parsePending(null), [])
  assert.equal(m.pendingStorageKey('acme/app', 12), 'inkstone.github.pr.pending:acme/app#12')
  assert.notEqual(m.pendingStorageKey('acme/app', 12), m.pendingStorageKey('acme/other', 12))
}

{
  const patch = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -10,3 +10,4 @@',
    ' keep',
    '-gone',
    '+added one',
    '+added two',
    ' tail',
    '\\ No newline at end of file'
  ].join('\n')
  assert.equal(m.inferCommentSide(patch, 11, 12, 'added one\nadded two'), 'RIGHT')
  assert.equal(m.inferCommentSide(patch, 11, 11, 'gone'), 'LEFT')
  assert.equal(m.inferCommentSide(patch, 10, 10, 'keep'), 'RIGHT')
  assert.equal(m.inferCommentSide(patch, 13, 13, 'tail'), 'RIGHT')
  assert.equal(m.inferCommentSide(patch, 99, 99, 'nothing'), null)
}

{
  const fail = (code, retrySafe) => ({ ok: false, failure: { code, message: 'm', hint: 'h', retrySafe } })
  let s = { phase: 'idle' }
  assert.equal(m.canStartAction(s), true)
  s = m.reduceAction(s, { type: 'start', kind: 'merge' })
  assert.deepEqual(s, { phase: 'running', kind: 'merge' })
  assert.equal(m.canStartAction(s), false)
  assert.deepEqual(m.reduceAction(s, { type: 'start', kind: 'close' }), s)
  assert.deepEqual(m.reduceAction(s, { type: 'reset' }), s)
  const timeout = m.reduceAction(s, { type: 'result', result: fail('timeout', false) })
  assert.equal(timeout.phase, 'failed')
  assert.equal(timeout.recovery, 'refresh')
  assert.equal(m.reduceAction(s, { type: 'result', result: fail('forbidden', true) }).recovery, 'retry')
  assert.equal(m.reduceAction(s, { type: 'result', result: fail('not-mergeable', false) }).recovery, 'refresh')
  assert.equal(m.reduceAction(s, { type: 'result', result: fail('invalid-input', true) }).recovery, 'none')
  assert.equal(m.reduceAction(s, { type: 'result', result: { ok: false } }).recovery, 'refresh')
  assert.equal(m.reduceAction(s, { type: 'error', message: 'ipc' }).recovery, 'refresh')
  assert.deepEqual(m.reduceAction(s, { type: 'result', result: { ok: true, branchDeletion: 'pending' } }), {
    phase: 'done',
    kind: 'merge',
    refreshFailed: false,
    pendingBranch: true
  })
  assert.equal(m.reduceAction(s, { type: 'result', result: { ok: true, refreshFailure: { code: 'other' } } }).refreshFailed, true)
  assert.deepEqual(m.reduceAction({ phase: 'idle' }, { type: 'result', result: { ok: true } }), { phase: 'idle' })
  assert.deepEqual(m.reduceAction(timeout, { type: 'reset' }), { phase: 'idle' })
  assert.equal(
    m.failureCause({ code: 'git-failed', message: 'x', hint: '', retrySafe: true, gitFailure: { code: 'dirty-blocks-switch', message: '冲突', detail: 'a.ts', retrySafe: true } }),
    'code: git-failed\ngit: dirty-blocks-switch\n冲突\na.ts'
  )
}

{
  assert.equal(m.baseBranchOf('origin/main'), 'main')
  assert.equal(m.baseBranchOf('upstream/dev'), 'dev')
  assert.equal(m.baseBranchOf('refs/heads/trunk'), 'trunk')
  assert.equal(m.baseBranchOf('feature/x'), 'feature/x')
  assert.equal(m.baseBranchOf(null), '')
  assert.equal(m.titleFromBranch('feat/add-pr_ui'), 'Add pr ui')
  assert.deepEqual(m.createDefaults({ branch: 'feat/x', detached: false, baseRef: 'origin/main', upstream: null, unpushed: null }), {
    head: 'feat/x', base: 'main', title: 'X', pushFirst: true, blocked: null
  })
  assert.equal(m.createDefaults({ branch: 'feat/x', detached: false, baseRef: 'origin/main', lastCommit: 'Fix bug\n\nbody', upstream: 'origin/feat/x', unpushed: 0 }).title, 'Fix bug')
  assert.equal(m.createDefaults({ branch: 'feat/x', detached: false, baseRef: null, upstream: 'origin/feat/x', unpushed: 0 }).pushFirst, false)
  assert.equal(m.createDefaults({ branch: 'main', detached: false, baseRef: 'origin/main', upstream: 'origin/main', unpushed: 0 }).blocked, 'default-branch')
  assert.equal(m.createDefaults({ branch: null, detached: true, baseRef: 'origin/main', upstream: null, unpushed: null }).blocked, 'detached')
  const draft = { title: 't', body: '', base: 'main', head: 'x', draft: false, pushFirst: false }
  assert.equal(m.createProblem(draft), null)
  assert.equal(m.createProblem({ ...draft, title: ' ' }), 'title')
  assert.equal(m.createProblem({ ...draft, base: '' }), 'base')
  assert.equal(m.createProblem({ ...draft, head: '' }), 'head')
  assert.equal(m.createProblem({ ...draft, base: 'x' }), 'same')
  assert.deepEqual(m.diffNames(['a', 'b'], ['b', 'c']), { add: ['c'], remove: ['a'] })
  assert.equal(m.quoteReply('octo', 'line1\nline2', ' ok '), '> @octo\n>\n> line1\n> line2\n\nok')
}

{
  for (const lang of ['zh-CN', 'en-US']) {
    const labels = textMod.prActionText(lang).agent.prompt
    const detail = {
      number: 42,
      title: 'Add  PR\nactions',
      url: 'https://github.com/acme/app/pull/42',
      head: 'feat/pr',
      base: 'main',
      checkItems: [
        { name: 'build', state: 'fail', url: 'https://ci/1', detail: 'FAILURE' },
        { name: 'lint', state: 'pass', url: '', detail: 'SUCCESS' }
      ],
      timeline: [
        { id: 'k', kind: 'commit', author: 'a', at: '', body: 'commit msg', review: 'abc' },
        { id: 'r', kind: 'review', author: 'rev', at: '', body: 'Please rename\nthis', review: 'CHANGES_REQUESTED' },
        { id: 'c', kind: 'comment', author: 'bob', at: '', body: 'nit', review: '' },
        { id: 'e', kind: 'comment', author: 'bot', at: '', body: '  ', review: '' }
      ]
    }
    const explain = m.agentPrompt('explain', detail, labels)
    assert.match(explain, /#42/)
    assert.match(explain, /https:\/\/github\.com\/acme\/app\/pull\/42/)
    assert.match(explain, /Add PR actions/)
    assert.match(explain, /feat\/pr → main/)
    assert.ok(explain.includes(labels.untrusted))
    const fix = m.agentPrompt('fix-checks', detail, labels)
    assert.match(fix, /- build \(FAILURE\) https:\/\/ci\/1/)
    assert.doesNotMatch(fix, /lint/)
    assert.ok(m.agentPrompt('fix-checks', { ...detail, checkItems: [] }, labels).includes(labels.noFailedChecks))
    const respond = m.agentPrompt('respond-reviews', detail, labels)
    assert.match(respond, /> @rev \[CHANGES_REQUESTED\]: Please rename this/)
    assert.match(respond, /> @bob: nit/)
    assert.doesNotMatch(respond, /commit msg|@bot/)
    assert.ok(m.agentPrompt('respond-reviews', { ...detail, timeline: [] }, labels).includes(labels.noReviewNotes))
  }
  const long = 'x'.repeat(1000)
  const notes = m.reviewNotesOf(Array.from({ length: 12 }, (_, i) => ({ id: String(i), kind: 'comment', author: 'a', at: '', body: long, review: '' })))
  assert.equal(notes.length, 8)
  assert.equal(notes[0].id, '4')
  const prompt = m.agentPrompt('respond-reviews', { number: 1, title: 't', url: 'u', head: 'h', base: 'b', checkItems: [], timeline: notes }, textMod.prActionText('en-US').agent.prompt)
  assert.ok(prompt.split('\n').every((line) => line.length < 450))
}

{
  assert.deepEqual(m.nextCondensed({ previous: false, top: 100, foldHeight: 80, condensedHeight: 30 }), { condensed: false, scrollTo: null })
  assert.deepEqual(m.nextCondensed({ previous: false, top: 113, foldHeight: 80, condensedHeight: 30 }), { condensed: true, scrollTo: 63 })
  assert.deepEqual(m.nextCondensed({ previous: false, top: 500, foldHeight: 0, condensedHeight: 30 }), { condensed: false, scrollTo: null })
  assert.deepEqual(m.nextCondensed({ previous: true, top: 50, foldHeight: 80, condensedHeight: 30 }), { condensed: true, scrollTo: null })
  assert.deepEqual(m.nextCondensed({ previous: true, top: 3, foldHeight: 80, condensedHeight: 30 }), { condensed: false, scrollTo: null })
  assert.deepEqual(m.nextCondensed({ previous: true, top: 4, foldHeight: 80, condensedHeight: 30 }), { condensed: true, scrollTo: null })
  assert.equal(m.nextCondensed({ previous: false, top: 40, foldHeight: 2, condensedHeight: 30 }).scrollTo, 68)
  assert.equal(m.isBotLogin('dependabot[bot]'), true)
  assert.equal(m.isBotLogin('github-actions'), true)
  assert.equal(m.isBotLogin('octocat'), false)
  const timeline = [
    { id: 'k', kind: 'commit', author: 'a', at: '2026-01-01T00:00:00Z', body: 'c', review: '' },
    { id: 'c1', kind: 'comment', author: 'bob', at: '2026-01-02T00:00:00Z', body: 'first', review: '' },
    { id: 'b1', kind: 'comment', author: 'dependabot[bot]', at: '2026-01-03T00:00:00Z', body: 'bump', review: '' },
    { id: 'r1', kind: 'review', author: 'rev', at: '2026-01-04T00:00:00Z', body: '', review: 'APPROVED' },
    { id: 'e', kind: 'comment', author: 'x', at: '2026-01-05T00:00:00Z', body: '  ', review: '' }
  ]
  const newest = m.commentView(timeline, { hideBots: false, order: 'newest' })
  assert.deepEqual(newest.items.map((item) => item.id), ['r1', 'b1', 'c1'])
  assert.equal(newest.total, 3)
  assert.equal(newest.hidden, 0)
  const filtered = m.commentView(timeline, { hideBots: true, order: 'oldest' })
  assert.deepEqual(filtered.items.map((item) => item.id), ['c1', 'r1'])
  assert.equal(filtered.hidden, 1)
  assert.deepEqual(m.commentView([], { hideBots: true, order: 'newest' }), { items: [], total: 0, hidden: 0 })
}

console.log('test-github-pr-ui: ok')
