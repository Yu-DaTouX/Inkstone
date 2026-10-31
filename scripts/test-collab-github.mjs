import assert from 'node:assert/strict'
import { build } from 'esbuild'

async function load(path, replacements = {}) {
  const bundle = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false, plugins: [{ name: 'fixture', setup(b) {
    b.onResolve({ filter: /.*/ }, (a) => (a.path in replacements ? { path: a.path, namespace: 'fixture' } : undefined))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, (a) => ({ contents: replacements[a.path], loader: 'js' }))
  } }] })
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
}

const shared = await load('src/shared/collab-github.ts')
assert.equal(shared.githubBranchName('Demo', 'feature/Login Page'), 'demo/feature/Login-Page')
assert.equal(shared.githubBranchName('demo', 'demo/fix-bug'), 'demo/fix-bug')
assert.equal(shared.githubBranchName('demo', '...'), 'demo/work')
assert.equal(shared.isPublishBranchName('demo/fix', 'Demo'), true)
for (const name of ['other/fix', 'demo/', 'demo', '-demo/x', 'demo/a..b', 'demo/x.lock', ' demo/x']) assert.equal(shared.isPublishBranchName(name, 'demo'), false, name)
assert.equal(shared.isPublishBranchName('demo/x', '--bad'), false)

const pulls = [
  { number: 7, title: 'Add login', headRefName: 'demo/login', author: { login: 'demo' }, isDraft: false, url: 'https://github.com/o/r/pull/7' },
  { number: 9, title: 'Docs', headRefName: 'ghost/docs', author: { login: 'ghost' }, isDraft: true, url: 'https://github.com/o/r/pull/9' }
]
const github = [{ name: 'main', oid: 'a'.repeat(40), protected: true }, { name: 'demo/login', oid: 'b'.repeat(40), protected: false }, { name: 'alice/exp', oid: 'c'.repeat(40), protected: false }]
const rows = shared.mergeChannels([
  { name: 'demo/login', author: 'Demo Laptop', fetched: true },
  { name: 'wip', author: 'Bob', fetched: false }
], github, pulls)
const by = Object.fromEntries(rows.map((row) => [row.name, row]))
assert.deepEqual(by['demo/login'].channels, ['peer', 'github'])
assert.equal(by['demo/login'].owner, 'demo')
assert.equal(by['demo/login'].pr.number, 7)
assert.equal(by['demo/login'].peerFetched, true)
assert.deepEqual(by.wip.channels, ['peer'])
assert.equal(by.wip.owner, null)
assert.equal(by.wip.pr, null)
assert.deepEqual(by['alice/exp'].channels, ['github'])
assert.equal(by['alice/exp'].owner, 'alice')
assert.equal(by['ghost/docs'].pr.isDraft, true)
assert.equal(by.main.owner, null)
assert.equal(rows[0].channels.includes('peer'), true)

assert.deepEqual(shared.sanitizePrRefs([
  { repo: 'o/r', number: 7, url: 'https://github.com/o/r/pull/7' },
  { repo: 'o/r', number: 7 },
  { repo: 'o/r', number: 0 },
  { repo: '../x', number: 1 },
  { repo: 'o/r', number: 8, url: 'javascript:alert(1)' },
  { repo: 'o/r', number: 9, url: 'https://u:p@github.com/o/r/pull/9' },
  'junk',
  null
]), [{ repo: 'o/r', number: 7, url: 'https://github.com/o/r/pull/7' }, { repo: 'o/r', number: 8 }, { repo: 'o/r', number: 9 }])
assert.deepEqual(shared.sanitizePrRefs('x'), [])
assert.equal(shared.sanitizePrRefs(Array.from({ length: 40 }, (_, index) => ({ repo: 'o/r', number: index + 1 }))).length, shared.PR_REFS_MAX)

const trackingOk = (ref) => (typeof ref === 'string' && ref.startsWith('refs/remotes/yan-') ? null : { code: 'ref-not-peer-branch' })
const publish = await load('src/main/collab/github-publish.ts', {
  './git': `export const checkTrackingRef = (${trackingOk.toString()})`
})
const request = { trackingRef: 'refs/remotes/yan-pc/feat', branch: 'demo/feat', base: 'main', title: 'Feat', body: 'body', confirmed: true }
const calls = []
const deps = (over = {}) => ({
  login: async () => 'Demo',
  resolve: async () => 'a'.repeat(40),
  push: async (...args) => { calls.push(['push', ...args]); return { ok: true } },
  createPr: async (input) => { calls.push(['pr', input]); return { ok: true, number: 12, url: 'https://github.com/o/r/pull/12', completedSteps: ['create'] } },
  ...over
})

const done = await publish.publishPeerBranch(request, deps())
assert.equal(done.ok, true)
assert.deepEqual(done.completedSteps, ['push', 'create'])
assert.deepEqual(calls[0], ['push', 'refs/remotes/yan-pc/feat', 'demo/feat', 'origin'])
assert.deepEqual(calls[1][1], { title: 'Feat', body: 'body', base: 'main', head: 'demo/feat', draft: false })

calls.length = 0
const unconfirmed = await publish.publishPeerBranch({ ...request, confirmed: false }, deps())
assert.equal(unconfirmed.failure.code, 'confirmation-required')
assert.equal((await publish.publishPeerBranch({ ...request, confirmed: undefined }, deps())).failure.code, 'confirmation-required')
assert.equal(calls.length, 0)

for (const patch of [{ trackingRef: 'refs/heads/main' }, { branch: 'other/feat' }, { branch: '--force' }, { base: '-x' }, { title: '' }, { remote: '-o' }, { branch: 'demo/' }]) {
  const result = await publish.publishPeerBranch({ ...request, ...patch }, deps())
  assert.equal(result.ok, false, JSON.stringify(patch))
}
assert.equal(calls.length, 0)

assert.equal((await publish.publishPeerBranch(request, deps({ login: async () => null }))).failure.code, 'not-authenticated')
assert.equal((await publish.publishPeerBranch(request, deps({ resolve: async () => null }))).ok, false)
const pushFail = await publish.publishPeerBranch(request, deps({ push: async () => ({ ok: false, error: 'rejected non-fast-forward' }) }))
assert.equal(pushFail.ok, false)
assert.equal(pushFail.failure.code, 'git-failed')
assert.equal(calls.filter((call) => call[0] === 'pr').length, 0)
const prFail = await publish.publishPeerBranch(request, deps({ createPr: async () => ({ ok: false, failure: { code: 'forbidden', message: 'x', hint: '', retrySafe: true } }) }))
assert.equal(prFail.ok, false)
assert.deepEqual(prFail.completedSteps, ['push'])

const manualRows = Object.fromEntries(shared.mergeChannels([
  { name: 'demo/login', author: 'Demo Laptop', fetched: true },
  { name: 'wip', author: 'Bob', fetched: false }
], github, pulls, 'bob-gh').map((row) => [row.name, row]))
assert.equal(manualRows.wip.owner, 'bob-gh')
assert.equal(manualRows.wip.ownerSource, 'manual')
assert.equal(manualRows['demo/login'].owner, 'bob-gh')
assert.equal(manualRows['alice/exp'].owner, 'alice')
assert.equal(manualRows['alice/exp'].ownerSource, 'inferred')
assert.equal(by.wip.ownerSource, null)
assert.equal(by['demo/login'].ownerSource, 'inferred')
const badManual = Object.fromEntries(shared.mergeChannels([{ name: 'wip', author: 'Bob', fetched: false }], [], [], '--bad').map((row) => [row.name, row]))
assert.equal(badManual.wip.owner, null)

assert.deepEqual(shared.sanitizePeerLogins({ 'peer-abc': 'Alice', 'peer-x': '--bad', 'a b': 'ok', __proto__: 'x', 'peer-y': 42, 'peer-z': 'bob-1' }), { 'peer-abc': 'Alice', 'peer-z': 'bob-1' })
assert.equal(shared.sanitizePeerLogins([]), undefined)
assert.equal(shared.sanitizePeerLogins({ a: '--' }), undefined)
assert.equal(shared.sanitizePeerLogins(Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`peer-${index}`, 'user']))) && Object.keys(shared.sanitizePeerLogins(Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`peer-${index}`, 'user'])))).length, shared.PEER_LOGINS_MAX)
assert.equal(shared.isGithubLogin('a--b'), false)
assert.equal(shared.isGithubLogin('octo-cat'), true)

console.log('test-collab-github: PASS (channel merge, manual and inferred owner, peer login sanitising, branch naming, PR ref sanitising, confirmed publish flow and guards)')
