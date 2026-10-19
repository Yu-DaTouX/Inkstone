import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const NULL_CONFIG = process.platform === 'win32' ? 'NUL' : '/dev/null'
process.env.GIT_CONFIG_GLOBAL = NULL_CONFIG
process.env.GIT_CONFIG_SYSTEM = NULL_CONFIG
process.env.GIT_TERMINAL_PROMPT = '0'
process.env.GIT_AUTHOR_NAME = 'yan-test'
process.env.GIT_AUTHOR_EMAIL = 'yan-test@example.com'
process.env.GIT_COMMITTER_NAME = 'yan-test'
process.env.GIT_COMMITTER_EMAIL = 'yan-test@example.com'

async function compile(entry, outfile) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

const PNG_A = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
const PNG_B = Buffer.from('89504e470d0a1a0a0000000d4948445200000002000000020806000000', 'hex')

async function run() {
  const dir = mkdtempSync(join(tmpdir(), 'inkstone-git-services-'))
  try {
    const policy = await compile('src/main/git-run-policy.ts', join(dir, 'policy.mjs'))
    const identity = await compile('src/main/git-remote-identity.ts', join(dir, 'identity.mjs'))
    const switching = await compile('src/main/git-branch-switch.ts', join(dir, 'switch.mjs'))
    const model = await compile('src/main/git-changes-model.ts', join(dir, 'model.mjs'))
    const inspect = await compile('src/main/git-inspect.ts', join(dir, 'inspect.mjs'))
    const service = await compile('src/main/git-service.ts', join(dir, 'service.mjs'))
    const actions = await compile('src/main/git-actions.ts', join(dir, 'actions.mjs'))

    const env = policy.sanitizedGitEnv({ PATH: 'p', GIT_DIR: '/x', git_index_file: 'i', GIT_SSH_COMMAND: 'ssh -i k', GIT_CONFIG_GLOBAL: 'g', GIT_CONFIG_PARAMETERS: "'core.pager'='evil'" }, { GIT_OPTIONAL_LOCKS: '0' })
    assert.equal(env.PATH, 'p')
    assert.equal(env.GIT_DIR, undefined)
    assert.equal(env.git_index_file, undefined)
    assert.equal(env.GIT_CONFIG_PARAMETERS, undefined)
    assert.equal(env.GIT_SSH_COMMAND, 'ssh -i k')
    assert.equal(env.GIT_CONFIG_GLOBAL, 'g')
    assert.equal(env.GIT_TERMINAL_PROMPT, '0')
    assert.equal(env.GIT_OPTIONAL_LOCKS, '0')

    let now = 1000
    const deadline = policy.createGitDeadline(500, () => now)
    assert.equal(policy.timeoutWithin(10_000, deadline), 500)
    now = 1300
    assert.equal(policy.timeoutWithin(100, deadline), 100)
    assert.equal(policy.timeoutWithin(10_000, deadline), 200)
    now = 1600
    assert.equal(deadline.expired(), true)
    assert.equal(policy.timeoutWithin(10_000, deadline), 0)
    assert.equal(policy.classifyGitRunError({ enoent: true, cwdExists: false }), 'CWD_MISSING')
    assert.equal(policy.classifyGitRunError({ enoent: true, cwdExists: true }), 'GIT_MISSING')
    assert.equal(policy.classifyGitRunError({ timedOut: true, deadlineExpired: true }), 'DEADLINE_EXCEEDED')
    assert.equal(policy.classifyGitRunError({ timedOut: true }), 'GIT_TIMEOUT')
    assert.equal(policy.classifyGitRunError({ outputLimit: true }), 'OUTPUT_LIMIT')
    assert.equal(policy.classifyGitRunError({ stderr: 'fatal: not a git repository (or any of the parent directories)' }), 'NOT_A_REPO')
    assert.equal(policy.classifyGitRunError({ stderr: 'boom' }), 'QUERY_FAILED')

    const expired = policy.createGitDeadline(0)
    const late = await service.gitRun(dir, ['--version'], { allowFailure: true, deadline: expired })
    assert.equal(late.ok, false)
    assert.equal(late.code, 'DEADLINE_EXCEEDED')
    const notRepo = await service.gitRun(dir, ['rev-parse', '--show-toplevel'], { allowFailure: true })
    assert.equal(notRepo.code, 'NOT_A_REPO')
    process.env.GIT_DIR = join(dir, 'nowhere')
    const leaked = await service.gitRun(dir, ['--version'], { allowFailure: true })
    delete process.env.GIT_DIR
    assert.equal(leaked.ok, true)

    assert.deepEqual(identity.parseRemoteUrl('https://github.com/Owner/Repo.git'), { host: 'github.com', owner: 'Owner', name: 'Repo' })
    assert.deepEqual(identity.parseRemoteUrl('git@github.com:owner/repo.git'), { host: 'github.com', owner: 'owner', name: 'repo' })
    assert.deepEqual(identity.parseRemoteUrl('ssh://git@gitlab.example.com:2222/group/sub/proj.git'), { host: 'gitlab.example.com', owner: 'group/sub', name: 'proj' })
    assert.deepEqual(identity.parseRemoteUrl('https://user:token@github.com/o/r'), { host: 'github.com', owner: 'o', name: 'r' })
    assert.equal(identity.parseRemoteUrl('C:\\repos\\thing'), null)
    assert.equal(identity.parseRemoteUrl('https://github.com/only'), null)
    const lru = new identity.LruCache(2)
    lru.set('a', 1)
    lru.set('b', 2)
    lru.get('a')
    lru.set('c', 3)
    assert.equal(lru.has('b'), false)
    assert.equal(lru.has('a'), true)
    assert.equal(lru.size, 2)

    assert.deepEqual(switching.checkSwitch({ unmerged: false, dirty: [], targetChanged: null }), { blocked: false, paths: [] })
    assert.equal(switching.checkSwitch({ unmerged: true, dirty: [], targetChanged: [] }).reason, 'unmerged')
    assert.equal(switching.checkSwitch({ unmerged: false, dirty: ['a.txt'], targetChanged: null }).reason, 'unknown')
    assert.equal(switching.checkSwitch({ unmerged: false, dirty: ['a.txt'], targetChanged: ['b.txt'] }).blocked, false)
    assert.deepEqual(switching.checkSwitch({ unmerged: false, dirty: ['a.txt', 'c.txt'], targetChanged: ['a.txt'] }).paths, ['a.txt'])
    assert.equal(switching.checkSwitch({ unmerged: false, dirty: ['src'], targetChanged: ['src/x.ts'] }).blocked, true)
    assert.equal(switching.checkSwitch({ unmerged: false, dirty: ['lib/x/y.ts'], targetChanged: ['lib'] }).blocked, true)
    assert.equal(switching.checkSwitch({ unmerged: false, dirty: ['A.txt'], targetChanged: ['a.txt'], caseInsensitive: true }).blocked, true)
    assert.equal(switching.checkSwitch({ unmerged: false, dirty: ['A.txt'], targetChanged: ['a.txt'] }).blocked, false)

    assert.deepEqual(model.normalizeChangesScope(undefined), { kind: 'working' })
    assert.deepEqual(model.normalizeChangesScope('branch'), { kind: 'branch' })
    assert.deepEqual(model.normalizeChangesScope({ kind: 'branch', base: 'origin/main' }), { kind: 'branch', base: 'origin/main' })
    assert.equal(model.normalizeChangesScope({ kind: 'branch', base: '--output=x' }), null)
    assert.equal(model.normalizeChangesScope({ kind: 'branch', base: 'a..b' }), null)
    assert.deepEqual(model.normalizeChangesScope('commit:ABCDEF1'), { kind: 'commit', sha: 'abcdef1' })
    assert.equal(model.normalizeChangesScope({ kind: 'commit', sha: 'HEAD;rm' }), null)
    assert.equal(model.normalizeChangesScope({ kind: 'nope' }), null)
    assert.deepEqual(model.baseCandidates(undefined, 'origin/trunk'), ['origin/trunk', 'origin/main', 'origin/master', 'main', 'master'])
    assert.deepEqual(model.baseCandidates('dev', 'origin/trunk'), ['dev'])
    assert.deepEqual(model.parseNameStatus('M\0a.txt\0A\0dir/b.txt\0'), [{ status: 'M', path: 'a.txt' }, { status: 'A', path: 'dir/b.txt' }])
    const raw = 'diff --git a/a b/a\n+1\ndiff --git a/b b/b\n+2\n'
    assert.deepEqual(model.splitPatch(raw), ['diff --git a/a b/a\n+1\n', 'diff --git a/b b/b\n+2\n'])
    assert.deepEqual(model.splitPatch(''), [])
    const available = new Map([
      ['a', 'x'.repeat(600)],
      ['b', 'y'.repeat(600)],
      ['c', 'diff --git a/c b/c\nBinary files a/c and b/c differ\n'],
      ['d', 'z'.repeat(50)]
    ])
    const allocated = model.allocatePatches(['a', 'b', 'c', 'd', 'e'], available, { totalBytes: 1000, maxFiles: 300, singleFileBytes: 5000 })
    assert.equal(allocated.patches.a.state, 'inline')
    assert.equal(allocated.patches.b.state, 'deferred')
    assert.equal(allocated.patches.c.state, 'binary')
    assert.equal(allocated.patches.d.state, 'inline')
    assert.equal(allocated.patches.e.state, 'deferred')
    assert.equal(model.allocatePatches(['a'], available, { totalBytes: 10_000, maxFiles: 300, singleFileBytes: 100 }).patches.a.state, 'too-large')
    assert.equal(model.allocatePatches(['a', 'd'], available, { totalBytes: 10_000, maxFiles: 1, singleFileBytes: 5000 }).patches.d.state, 'deferred')
    assert.equal(model.imageMimeOf('x/LOGO.PNG'), 'image/png')
    assert.equal(model.imageMimeOf('x.txt'), null)

    const repo = join(dir, 'repo')
    mkdirSync(repo)
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'core.autocrlf', 'false'])
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    writeFileSync(join(repo, 'c.txt'), 'c\n')
    writeFileSync(join(repo, 'logo.png'), PNG_A)
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'base'])
    git(repo, ['switch', '-q', '-c', 'feature'])
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
    writeFileSync(join(repo, 'logo.png'), PNG_B)
    git(repo, ['commit', '-q', '-am', 'feature work'])
    const featureSha = git(repo, ['rev-parse', 'HEAD']).trim()
    writeFileSync(join(repo, 'new.txt'), 'fresh\n')
    writeFileSync(join(repo, 'c.txt'), 'c\nc2\n')

    const realRepo = realpathSync(repo)
    const authorize = async (cwd) => ({ ok: true, cwd })
    const working = await inspect.readChanges(repo, authorize, { patches: true })
    assert.equal(working.ok, true)
    assert.equal(working.scopeKind, 'working')
    assert.deepEqual(working.files.map((file) => file.path).sort(), ['c.txt', 'new.txt'])
    assert.equal(working.patches['c.txt'].state, 'inline')
    assert.match(working.patches['c.txt'].patch, /\+c2/)
    assert.equal(working.patches['new.txt'].state, 'inline')

    const branch = await inspect.readChanges(repo, authorize, { scope: { kind: 'branch', base: 'main' }, patches: true })
    assert.equal(branch.ok, true, branch.error)
    assert.equal(branch.scopeKind, 'branch')
    assert.equal(branch.baseRef, 'main')
    assert.deepEqual(branch.files.map((file) => file.path).sort(), ['a.txt', 'c.txt', 'logo.png', 'new.txt'])
    assert.equal(branch.patches['logo.png'].state, 'binary')
    assert.match(branch.patches['a.txt'].patch, /\+two/)
    assert.equal(branch.added >= 3, true)

    const autoBase = await inspect.readChanges(repo, authorize, { scope: { kind: 'branch' } })
    assert.equal(autoBase.baseRef, 'main')

    const commit = await inspect.readChanges(repo, authorize, { scope: { kind: 'commit', sha: featureSha } })
    assert.equal(commit.ok, true, commit.error)
    assert.equal(commit.targetSha, featureSha)
    assert.deepEqual(commit.files.map((file) => file.path).sort(), ['a.txt', 'logo.png'])

    const root = await inspect.readChanges(repo, authorize, { scope: { kind: 'commit', sha: git(repo, ['rev-parse', 'main']).trim() } })
    assert.equal(root.baseSha, null)
    assert.deepEqual(root.files.map((file) => file.path).sort(), ['a.txt', 'c.txt', 'logo.png'])

    const badScope = await inspect.readChanges(repo, authorize, { scope: { kind: 'commit', sha: 'zzz' } })
    assert.equal(badScope.ok, false)
    const missingBase = await inspect.readChanges(repo, authorize, { scope: { kind: 'branch', base: 'nope' } })
    assert.equal(missingBase.ok, false)

    const lazy = await inspect.readFileDiff(repo, 'a.txt', authorize, { scope: { kind: 'commit', sha: featureSha } })
    assert.equal(lazy.ok, true)
    assert.match(lazy.patch, /\+two/)
    const lazyUntracked = await inspect.readFileDiff(repo, 'new.txt', authorize, { scope: { kind: 'branch', base: 'main' } })
    assert.equal(lazyUntracked.untracked, true)

    const images = await inspect.readFileDiff(repo, 'logo.png', authorize, { scope: { kind: 'commit', sha: featureSha }, images: true })
    assert.equal(images.ok, true)
    assert.equal(images.image.before.dataUrl, `data:image/png;base64,${PNG_A.toString('base64')}`)
    assert.equal(images.image.after.dataUrl, `data:image/png;base64,${PNG_B.toString('base64')}`)
    writeFileSync(join(repo, 'logo.png'), PNG_A)
    const workingImage = await inspect.readFileDiff(repo, 'logo.png', authorize, { images: true })
    assert.equal(workingImage.image.before.dataUrl, `data:image/png;base64,${PNG_B.toString('base64')}`)
    assert.equal(workingImage.image.after.dataUrl, `data:image/png;base64,${PNG_A.toString('base64')}`)
    git(repo, ['checkout', '-q', '--', 'logo.png'])

    git(repo, ['remote', 'add', 'origin', 'git@github.com:inkstone/demo.git'])
    const first = await identity.readRemoteIdentity(realRepo)
    assert.deepEqual(first, { host: 'github.com', owner: 'inkstone', name: 'demo', remote: 'origin' })
    git(repo, ['remote', 'set-url', 'origin', 'https://github.com/inkstone/other.git'])
    assert.equal((await identity.readRemoteIdentity(realRepo)).name, 'demo')
    assert.equal((await identity.readRemoteIdentity(realRepo, { refresh: true })).name, 'other')

    const expected = await service.readExpected(realRepo)
    const blocked = await actions.runGitAction({ requestId: 'r1', cwd: repo, kind: 'switch-branch', branch: 'main', expected })
    assert.equal(blocked.ok, true, JSON.stringify(blocked.failure))
    git(repo, ['switch', '-q', 'feature'])
    writeFileSync(join(repo, 'a.txt'), 'local edit\n')
    const overlap = await actions.runGitAction({ requestId: 'r2', cwd: repo, kind: 'switch-branch', branch: 'main', expected: await service.readExpected(realRepo) })
    assert.equal(overlap.ok, false)
    assert.equal(overlap.failure.code, 'dirty-blocks-switch')
    assert.match(overlap.failure.detail, /a\.txt/)
    assert.equal(git(repo, ['branch', '--show-current']).trim(), 'feature')

    console.log('test-git-services: 全部通过')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
