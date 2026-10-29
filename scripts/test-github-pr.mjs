import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../src/renderer/src/features/github/pr-model.ts', import.meta.url))
const result = await build({
  entryPoints: [source],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const mod = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

const {
  ageOf,
  countPatchLines,
  filterByListState,
  filterPrRows,
  hashText,
  normalizeChecks,
  normalizePrDetail,
  normalizePrRow,
  parseViewed,
  prFileKey,
  prStateOf,
  serializeViewed,
  splitDiffByFile,
  timelineOf,
  toggleViewed,
  VIEWED_LIMIT,
  viewedCount
} = mod

const listItem = {
  number: 12,
  title: 'Add pull request panel',
  author: { login: 'octocat', name: 'The Octocat' },
  state: 'OPEN',
  isDraft: false,
  headRefName: 'feat/pr-panel',
  baseRefName: 'main',
  updatedAt: '2026-03-02T10:00:00Z',
  reviewDecision: 'APPROVED',
  additions: 120,
  deletions: 8,
  url: 'https://github.com/acme/app/pull/12',
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://ci/build' },
    { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'CheckRun', name: 'e2e', status: 'IN_PROGRESS', conclusion: '' },
    { __typename: 'StatusContext', context: 'coverage', state: 'SUCCESS', targetUrl: 'https://ci/coverage' }
  ]
}

const row = normalizePrRow(listItem)
assert.equal(row.number, 12)
assert.equal(row.title, 'Add pull request panel')
assert.equal(row.author, 'octocat')
assert.equal(row.state, 'open')
assert.equal(row.head, 'feat/pr-panel')
assert.equal(row.base, 'main')
assert.equal(row.additions, 120)
assert.equal(row.deletions, 8)
assert.deepEqual(row.checks, { state: 'fail', total: 4, passed: 2, failed: 1, pending: 1 })

assert.equal(prStateOf({ state: 'MERGED' }), 'merged')
assert.equal(prStateOf({ state: 'CLOSED' }), 'closed')
assert.equal(prStateOf({ state: 'OPEN', isDraft: true }), 'draft')
assert.equal(prStateOf({ state: 'OPEN' }), 'open')
assert.equal(prStateOf({}), 'open')

assert.deepEqual(normalizeChecks(null).summary, { state: 'none', total: 0, passed: 0, failed: 0, pending: 0 })
assert.deepEqual(
  normalizeChecks([{ __typename: 'CheckRun', name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' }]).summary,
  { state: 'pass', total: 1, passed: 1, failed: 0, pending: 0 }
)
const statusOnly = normalizeChecks([{ __typename: 'StatusContext', context: 'deploy', state: 'PENDING' }])
assert.equal(statusOnly.summary.state, 'pending')
assert.equal(statusOnly.items[0].name, 'deploy')
assert.equal(normalizeChecks([{ __typename: 'CheckRun', name: 'x', status: 'COMPLETED', conclusion: 'TIMED_OUT' }]).items[0].state, 'fail')

const diff = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,3 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  '+const c = 4',
  'diff --git a/old name.txt b/new name.txt',
  'similarity index 100%',
  'rename from old name.txt',
  'rename to new name.txt',
  'diff --git a/assets/logo.png b/assets/logo.png',
  'index 3333333..4444444 100644',
  'Binary files a/assets/logo.png and b/assets/logo.png differ',
  ''
].join('\n')

const parts = splitDiffByFile(diff)
assert.equal(parts.length, 3)
assert.equal(parts[0].path, 'src/a.ts')
assert.deepEqual(countPatchLines(parts[0].patch), { additions: 2, deletions: 1 })
assert.equal(parts[1].path, 'new name.txt')
assert.equal(parts[2].path, 'assets/logo.png')
assert.deepEqual(splitDiffByFile(''), [])

const keyA = prFileKey('acme/app', 12, 'src/a.ts', parts[0].patch)
const keyARepeat = prFileKey('acme/app', 12, 'src/a.ts', parts[0].patch)
const keyChanged = prFileKey('acme/app', 12, 'src/a.ts', `${parts[0].patch} `)
const keyOtherRepo = prFileKey('acme/other', 12, 'src/a.ts', parts[0].patch)
assert.equal(keyA, keyARepeat)
assert.notEqual(keyA, keyChanged)
assert.notEqual(keyA, keyOtherRepo)
assert.match(keyA, /^acme\/app#12:src\/a\.ts:[a-z0-9]+$/)
assert.equal(hashText(''), hashText(''))

const detailJson = {
  number: 12,
  title: 'Add pull request panel',
  body: '## Summary\n\n- add the panel',
  author: { login: 'octocat' },
  state: 'OPEN',
  isDraft: false,
  headRefName: 'feat/pr-panel',
  baseRefName: 'main',
  createdAt: '2026-03-01T09:00:00Z',
  updatedAt: '2026-03-02T10:00:00Z',
  reviewDecision: 'CHANGES_REQUESTED',
  statusCheckRollup: [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  files: [{ path: 'src/a.ts', additions: 2, deletions: 1, changeType: 'MODIFIED' }],
  commits: [{ oid: 'abc', messageHeadline: 'add panel' }],
  comments: [{ author: { login: 'reviewer' }, body: 'looks good', createdAt: '2026-03-02T11:00:00Z' }],
  reviews: [
    { author: { login: 'maintainer' }, body: '', state: 'APPROVED', submittedAt: '2026-03-02T08:00:00Z' },
    { author: { login: 'qa' }, body: 'please fix', state: 'CHANGES_REQUESTED', submittedAt: '2026-03-02T12:00:00Z' }
  ],
  url: 'https://github.com/acme/app/pull/12'
}

const detail = normalizePrDetail(detailJson, { repo: 'acme/app', diff })
assert.equal(detail.number, 12)
assert.equal(detail.state, 'open')
assert.equal(detail.commitCount, 1)
assert.deepEqual(detail.checks, { state: 'pass', total: 1, passed: 1, failed: 0, pending: 0 })
assert.equal(detail.files.length, 3)
assert.equal(detail.files[0].path, 'src/a.ts')
assert.deepEqual([detail.files[0].additions, detail.files[0].deletions], [2, 1])
assert.equal(detail.files[0].key, prFileKey('acme/app', 12, 'src/a.ts', parts[0].patch))
assert.equal(detail.files[1].path, 'new name.txt')
assert.equal(detail.files[1].patch.includes('rename from'), true)
assert.equal(detail.files[1].key.startsWith('acme/app#12:new name.txt:'), true)
assert.deepEqual(
  detail.timeline.map((item) => [item.kind, item.author]),
  [
    ['commit', ''],
    ['review', 'maintainer'],
    ['comment', 'reviewer'],
    ['review', 'qa']
  ]
)
assert.equal(detail.timeline[0].body, 'add panel')
assert.equal(detail.timeline[3].review, 'CHANGES_REQUESTED')
assert.deepEqual(detail.labels, [])
assert.deepEqual(
  normalizePrDetail(
    {
      ...detailJson,
      labels: [{ name: 'bug' }, { name: '' }],
      latestReviews: [{ author: { login: 'ann' }, state: 'APPROVED' }],
      reviewRequests: [{ login: 'bob' }, { slug: 'core' }, { login: 'ann' }],
      additions: 30,
      deletions: 4,
      changedFiles: 5
    },
    { repo: 'acme/app', diff: '' }
  ).reviewers,
  [
    { name: 'ann', state: 'approved' },
    { name: 'bob', state: 'pending' },
    { name: 'core', state: 'pending' }
  ]
)
assert.equal(normalizePrDetail({ ...detailJson, changedFiles: 5 }, { repo: 'acme/app', diff: '' }).changedFiles, 5)
assert.deepEqual(normalizePrDetail({ ...detailJson, labels: [{ name: 'bug' }, { name: '' }] }, { repo: 'acme/app', diff: '' }).labels, ['bug'])

const detailWithoutDiff = normalizePrDetail(detailJson, { repo: 'acme/app', diff: '' })
assert.equal(detailWithoutDiff.files.length, 1)
assert.equal(detailWithoutDiff.files[0].patch, '')
assert.match(detailWithoutDiff.files[0].key, /^acme\/app#12:src\/a\.ts:/)

const merged = normalizePrDetail({ ...detailJson, state: 'MERGED', isDraft: false }, { repo: 'acme/app', diff: '' })
assert.equal(merged.state, 'merged')

assert.deepEqual(timelineOf(null, null), [])

const rows = [
  normalizePrRow(listItem),
  normalizePrRow({ number: 7, title: 'Fix sidebar', author: { login: 'hubot' }, state: 'CLOSED', headRefName: 'fix/side', baseRefName: 'main' }),
  normalizePrRow({ number: 9, title: 'Docs only', author: { login: 'claude' }, state: 'OPEN', isDraft: true, headRefName: 'docs', baseRefName: 'main' })
]
assert.deepEqual(filterPrRows(rows, '').map((item) => item.number), [12, 7, 9])
assert.deepEqual(filterPrRows(rows, 'sidebar').map((item) => item.number), [7])
assert.deepEqual(filterPrRows(rows, '#9').map((item) => item.number), [9])
assert.deepEqual(filterPrRows(rows, 'hubot').map((item) => item.number), [7])
assert.deepEqual(filterPrRows(rows, 'MAIN').map((item) => item.number), [12, 7, 9])
assert.deepEqual(filterPrRows(rows, 'nothing here'), [])
assert.equal(filterPrRows(rows, 'zzz').length, 0)

const closedRows = [...rows, normalizePrRow({ number: 3, title: 'Merged work', state: 'MERGED', baseRefName: 'main' })]
assert.deepEqual(filterByListState(closedRows, 'closed').map((item) => item.number), [12, 7, 9])
assert.deepEqual(filterByListState(closedRows, 'merged').map((item) => item.number), [12, 7, 9, 3])
assert.deepEqual(filterByListState(closedRows, 'all').length, 4)
assert.deepEqual(filterByListState(rows, 'open'), rows)
assert.notEqual(filterByListState(rows, 'open'), rows)

const now = Date.parse('2026-03-02T12:00:00Z')
assert.deepEqual(ageOf('2026-03-02T11:59:40Z', now), { unit: 'now', value: 0 })
assert.deepEqual(ageOf('2026-03-02T11:30:00Z', now), { unit: 'minute', value: 30 })
assert.deepEqual(ageOf('2026-03-02T09:00:00Z', now), { unit: 'hour', value: 3 })
assert.deepEqual(ageOf('2026-02-27T12:00:00Z', now), { unit: 'day', value: 3 })
assert.equal(ageOf('2025-11-01T00:00:00Z', now).unit, 'long')
assert.equal(ageOf('not a date', now).unit, 'long')
assert.equal(ageOf('', now).value, 0)

const emptyViewed = parseViewed(null)
assert.deepEqual(emptyViewed, [])
assert.deepEqual(parseViewed('nope'), [])
assert.deepEqual(parseViewed('{"a":1}'), [])
assert.deepEqual(parseViewed('["a",2,"b"]'), ['a', 'b'])

const afterRead = toggleViewed(emptyViewed, 'k1', true)
assert.deepEqual(afterRead, ['k1'])
assert.deepEqual(toggleViewed(afterRead, 'k2', true), ['k1', 'k2'])
assert.deepEqual(toggleViewed(afterRead, 'k1', false), [])
assert.deepEqual(toggleViewed(afterRead, 'k1', true), ['k1'])
assert.equal(viewedCount(afterRead, ['k1', 'k2']), 1)
assert.deepEqual(parseViewed(serializeViewed(afterRead)), ['k1'])

let many = []
for (let i = 0; i < VIEWED_LIMIT + 10; i++) many = toggleViewed(many, `k${i}`, true)
assert.equal(many.length, VIEWED_LIMIT)
assert.equal(many[0], 'k10')
assert.equal(parseViewed(serializeViewed(many)).length, VIEWED_LIMIT)

console.log('test-github-pr: ok')
