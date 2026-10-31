import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundle = await build({ entryPoints: ['src/main/git-pr-branch.ts'], bundle: true, platform: 'node', format: 'esm', write: false })
const m = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

assert.equal(m.normalizeRepoKey('https://github.com/Acme/App.git'), 'github.com/acme/app')
assert.equal(m.normalizeRepoKey('git@github.com:acme/app.git'), 'github.com/acme/app')
assert.equal(m.normalizeRepoKey('ssh://git@github.com/acme/app'), 'github.com/acme/app')
assert.equal(m.normalizeRepoKey(''), null)
assert.equal(m.normalizeRepoKey('C:\repo'), null)

assert.deepEqual(m.prBranchCandidates('feat/x', 12), ['feat/x', 'feat/x-pr12'])
assert.deepEqual(m.prBranchCandidates('--evil', 12), ['pr-12'])
assert.deepEqual(m.prBranchCandidates('', 7), ['pr-7'])
assert.deepEqual(m.prBranchCandidates('a..b', 7), ['pr-7'])

const sha = 'a'.repeat(40)
const url = 'https://github.com/acme/app'
const base = { exists: true, tip: 'b'.repeat(40), merge: 'refs/heads/feat/x', remoteUrl: 'git@github.com:acme/app.git', descendantOfTip: true }
assert.equal(m.decidePrBranch({ ...base, exists: false, tip: null }, sha, 'feat/x', url), 'create')
assert.equal(m.decidePrBranch({ ...base, tip: sha }, sha, 'feat/x', url), 'reuse')
assert.equal(m.decidePrBranch(base, sha, 'feat/x', url), 'fast-forward')
assert.equal(m.decidePrBranch({ ...base, descendantOfTip: false }, sha, 'feat/x', url), 'skip')
assert.equal(m.decidePrBranch({ ...base, remoteUrl: 'https://github.com/other/app' }, sha, 'feat/x', url), 'skip')
assert.equal(m.decidePrBranch({ ...base, merge: 'refs/heads/other' }, sha, 'feat/x', url), 'skip')
assert.equal(m.decidePrBranch({ ...base, merge: null, remoteUrl: null }, sha, 'feat/x', url), 'skip')

const options = { headRef: 'feat/x', headRepoUrl: url, baseRepoUrl: url }
assert.equal(m.pushRightsNote(options), '')
assert.match(m.pushRightsNote({ ...options, headRepoUrl: 'https://github.com/fork/app' }), /没有允许维护者修改/)
assert.match(m.pushRightsNote({ ...options, headRepoUrl: 'https://github.com/fork/app', maintainerCanModify: true }), /写权限/)
assert.match(m.pushRightsNote({ ...options, headRepoUrl: null }), /已不存在/)

console.log('test-github-pr-branch: PASS (repo key, branch candidates, reuse/fast-forward/skip decisions, fork push notes)')
