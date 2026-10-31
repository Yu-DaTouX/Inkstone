import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function load(path) {
  const bundle = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false, external: ['electron'] })
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
}
const repos = await load('src/main/github/repos.ts')
const ok = (value) => ({ ok: true, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '', missing: false, missingCwd: false, timedOut: false, overflow: false })
const bad = (stderr, extra = {}) => ({ ok: false, stdout: '', stderr, missing: false, missingCwd: false, timedOut: false, overflow: false, ...extra })

const repo = (nameWithOwner, updatedAt, extra = {}) => ({ nameWithOwner, description: `desc ${nameWithOwner}`, isPrivate: false, isFork: false, updatedAt, defaultBranchRef: { name: 'main' }, url: `https://github.com/${nameWithOwner}`, ...extra })
const calls = []
const run = async (cwd, args) => {
  calls.push(args)
  if (args[0] === 'api' && args[1] === 'user') return ok({ login: 'demo' })
  if (args[0] === 'api' && args[1].startsWith('user/orgs')) return ok([{ login: 'acme' }, { login: '--bad' }])
  if (args[0] === 'repo' && args[1] === 'list') {
    return ok(args[2] === 'demo' ? [repo('demo/ledger', '2026-10-01T00:00:00Z'), repo('demo/notes', '2026-10-05T00:00:00Z', { isPrivate: true }), { nameWithOwner: 'broken' }] : [repo('acme/site', '2026-10-03T00:00:00Z')])
  }
  if (args[0] === 'repo' && args[1] === 'view') return ok(repo(args[2], '2026-09-01T00:00:00Z'))
  return ok({})
}

const listed = await repos.listGithubRepos({}, run, '/fixture')
assert.equal(listed.ok, true)
assert.deepEqual(listed.owners, ['demo', 'acme'])
assert.deepEqual(listed.items.map((item) => item.nameWithOwner), ['demo/notes', 'acme/site', 'demo/ledger'])
assert.equal(listed.items[0].isPrivate, true)
assert.equal(listed.items[0].defaultBranch, 'main')
assert.ok(calls.some((args) => args[0] === 'repo' && args[1] === 'list' && args.includes('--json') && args.includes('--limit')))
const searched = await repos.listGithubRepos({ query: 'LEDGER' }, run, '/fixture')
assert.deepEqual(searched.items.map((item) => item.nameWithOwner), ['demo/ledger'])
const direct = await repos.listGithubRepos({ query: 'other/tool' }, run, '/fixture')
assert.deepEqual(direct.items.map((item) => item.nameWithOwner), ['other/tool'])
const scoped = await repos.listGithubRepos({ owner: 'acme' }, run, '/fixture')
assert.deepEqual(scoped.items.map((item) => item.nameWithOwner), ['acme/site'])
assert.equal((await repos.listGithubRepos({ owner: '--evil' }, run, '/fixture')).ok, false)
const limited = await repos.listGithubRepos({ limit: 1 }, run, '/fixture')
assert.equal(limited.hasMore, true)
const unauthed = await repos.listGithubRepos({}, async () => bad('To get started with GitHub CLI, please run:  gh auth login'), '/fixture')
assert.equal(unauthed.failure.code, 'not-authenticated')
const missing = await repos.listGithubRepos({}, async () => bad('', { missing: true }), '/fixture')
assert.equal(missing.failure.code, 'gh-missing')

assert.deepEqual(await repos.readGithubAccount(run, '/fixture'), { installed: true, authed: true, login: 'demo' })
assert.deepEqual(await repos.readGithubAccount(async () => bad('', { missing: true }), '/fixture'), { installed: false, authed: false })
const loggedOut = await repos.readGithubAccount(async (cwd, args) => (args[0] === '--version' ? ok('gh') : bad('gh auth login')), '/fixture')
assert.deepEqual(loggedOut, { installed: true, authed: false })

for (const url of ['https://github.com/demo/ledger.git', 'ssh://git@github.com/demo/ledger', 'git@github.com:demo/ledger.git', 'git://example.com/a/b.git']) {
  const checked = repos.validateCloneUrl(url)
  assert.equal(checked.ok, true, url)
  assert.equal(checked.name, url.includes('ledger') ? 'ledger' : 'b')
}
for (const url of ['file:///etc/passwd', '/tmp/repo', 'C:\\repo', './repo', '--upload-pack=calc', '-oProxyCommand=x', 'ext::sh -c id', 'https://user:token@github.com/a/b', 'https://github.com/a', 'http://github.com/a/b', 'https://github.com/a/b?x=1', 'git@github.com:a', 'https://github.com/a/b c', '', 42]) {
  assert.equal(repos.validateCloneUrl(url).ok, false, String(url))
}

const dir = await mkdtemp(join(tmpdir(), 'yan-repos-'))
try {
  assert.equal((await repos.resolveCloneTarget(dir, 'fresh')).created, true)
  await mkdir(join(dir, 'empty'))
  assert.equal((await repos.resolveCloneTarget(dir, 'empty')).created, false)
  await mkdir(join(dir, 'full'))
  await writeFile(join(dir, 'full', 'a.txt'), 'x')
  assert.equal((await repos.resolveCloneTarget(dir, 'full')).ok, false)
  for (const name of ['..', '../escape', 'a/b', 'a\\b', 'con', '']) assert.equal((await repos.resolveCloneTarget(dir, name)).ok, false, name)
  assert.equal((await repos.resolveCloneTarget('relative/dir', 'x')).ok, false)

  assert.deepEqual(repos.parseCloneProgress('Receiving objects:  45% (45/100)\rResolving deltas: 10% (1/10)\r', 'c1'), { id: 'c1', phase: 'resolving', percent: 10 })
  assert.deepEqual(repos.parseCloneProgress('Receiving objects:  45% (45/100)', 'c1'), { id: 'c1', phase: 'receiving', percent: 45 })
  assert.equal(repos.parseCloneProgress('Cloning into x', 'c1'), null)

  const github = repos.cloneArguments({ id: 'a', source: { kind: 'github', nameWithOwner: 'demo/ledger' } }, 'T')
  assert.deepEqual(github.args, ['repo', 'clone', 'demo/ledger', 'T', '--', '--progress'])
  assert.ok('error' in repos.cloneArguments({ id: 'a', source: { kind: 'github', nameWithOwner: '--bad/x' } }, 'T'))
  const urlArgs = repos.cloneArguments({ id: 'a', source: { kind: 'url', url: 'https://example.com/a/b.git' } }, 'T')
  assert.deepEqual(urlArgs.args, ['clone', '--progress', '--', 'https://example.com/a/b.git', 'T'])

  const fakeSpawn = (script) => (command, args, options) => {
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stderr.setEncoding = () => undefined
    child.kill = () => { child.emit('close', null) }
    fakeSpawn.last = { command, args, options }
    queueMicrotask(() => { void script(child, args, command) })
    return child
  }
  const events = []
  const added = []
  const deps = (spawn, extra = {}) => ({ spawn, defaultDir: () => dir, onProgress: (p) => events.push(p), addProject: async (cwd) => { added.push(cwd); return { projectId: 'p1' } }, trusted: async () => false, ...extra })

  const success = await repos.cloneRepository({ id: 'ok1', source: { kind: 'github', nameWithOwner: 'demo/ledger' }, parentDir: dir }, deps(fakeSpawn(async (child, args) => {
    await mkdir(args[3], { recursive: true })
    await writeFile(join(args[3], 'README.md'), 'x')
    child.stderr.emit('data', 'Receiving objects: 50% (1/2)\r')
    child.emit('close', 0)
  })))
  assert.equal(success.ok, true)
  assert.equal(success.cwd, join(dir, 'ledger'))
  assert.equal(success.projectId, 'p1')
  assert.equal(success.trusted, false)
  assert.deepEqual(added, [join(dir, 'ledger')])
  assert.ok(events.some((e) => e.phase === 'receiving' && e.percent === 50))
  assert.equal(events.at(-1).phase, 'done')
  assert.equal(fakeSpawn.last.command, 'gh')
  assert.equal(fakeSpawn.last.options.env.GIT_TERMINAL_PROMPT, '0')

  const existing = await repos.cloneRepository({ id: 'dup', source: { kind: 'github', nameWithOwner: 'demo/ledger' }, parentDir: dir }, deps(fakeSpawn(async (child) => { child.emit('close', 0) })))
  assert.equal(existing.ok, false)

  await mkdir(join(dir, 'occupied'))
  await writeFile(join(dir, 'occupied', 'f'), '1')
  const occupied = await repos.cloneRepository({ id: 'occ', source: { kind: 'github', nameWithOwner: 'demo/occupied' }, parentDir: dir }, deps(fakeSpawn(async () => undefined)))
  assert.equal(occupied.ok, false)

  const failed = await repos.cloneRepository({ id: 'f1', source: { kind: 'url', url: 'https://example.com/a/gone.git' }, parentDir: dir }, deps(fakeSpawn(async (child, args) => {
    await mkdir(args.at(-1), { recursive: true })
    child.stderr.emit('data', 'remote: Repository not found.\nfatal: repository not found')
    child.emit('close', 128)
  })))
  assert.equal(failed.ok, false)
  assert.equal(failed.failure.code, 'pr-not-found')
  assert.equal(existsSync(join(dir, 'gone')), false)

  const cancelled = repos.cloneRepository({ id: 'c1', source: { kind: 'url', url: 'https://example.com/a/slow.git' }, parentDir: dir }, deps(fakeSpawn(async (child, args) => {
    await mkdir(args.at(-1), { recursive: true })
    setTimeout(() => assert.equal(repos.cancelClone('c1'), true), 5)
  })))
  const cancelResult = await cancelled
  assert.equal(cancelResult.cancelled, true)
  assert.equal(existsSync(join(dir, 'slow')), false)
  assert.equal(repos.cancelClone('missing'), false)

  const timed = await repos.cloneRepository({ id: 't1', source: { kind: 'url', url: 'https://example.com/a/late.git' }, parentDir: dir }, deps(fakeSpawn(async () => undefined), { timeoutMs: 10 }))
  assert.equal(timed.failure.code, 'timeout')

  const noGit = await repos.cloneRepository({ id: 'm1', source: { kind: 'url', url: 'https://example.com/a/nogit.git' }, parentDir: dir }, deps(fakeSpawn(async (child) => {
    child.emit('error', Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }))
    child.emit('close', null)
  })))
  assert.equal(noGit.failure.code, 'gh-missing')

  const created = await repos.createLocalProject('我的 项目', dir, { gitInit: async (target) => { await writeFile(join(target, '.git-marker'), '') }, addProject: async () => ({ projectId: 'p2' }) })
  assert.equal(created.ok, true)
  assert.equal(created.cwd, join(dir, '我的 项目'))
  assert.equal((await repos.createLocalProject('../x', dir, { addProject: async () => ({}) })).ok, false)
  assert.equal((await repos.createLocalProject('我的 项目', dir, { addProject: async () => ({}) })).ok, false)
} finally {
  await rm(dir, { recursive: true, force: true })
}

assert.match(repos.defaultCloneDir().replace(/\\/g, '/'), /\/Inkstone\/projects$/)

const branchRun = async (cwd, args) => {
  if (args[0] === 'api') return ok([{ name: 'main', commit: { sha: 'a'.repeat(40) }, protected: true }, { name: 'demo/feat', commit: { sha: 'b'.repeat(40) } }, { name: 'bad', commit: { sha: 'zz' } }])
  if (args[0] === 'pr') return ok([{ number: 7, title: 'Feat', headRefName: 'demo/feat', author: { login: 'demo' }, state: 'OPEN', url: 'https://github.com/demo/ledger/pull/7' }])
  return ok({ nameWithOwner: 'demo/ledger' })
}
const branches = await repos.ghBranchesAndPulls('/fixture', branchRun)
assert.equal(branches.ok, true)
assert.equal(branches.repo, 'demo/ledger')
assert.deepEqual(branches.branches.map((b) => b.name), ['main', 'demo/feat'])
assert.equal(branches.pulls[0].number, 7)
assert.equal((await repos.ghBranchesAndPulls('/fixture', async () => bad('HTTP 404: Not Found'))).ok, false)

const command = await load('src/main/github/command.ts')
assert.deepEqual(command.ghFallbackPaths({ ProgramFiles: 'C:\\PF', LOCALAPPDATA: 'C:\\L' }, 'win32'), ['C:\\PF\\GitHub CLI\\gh.exe', 'C:\\L\\Programs\\GitHub CLI\\gh.exe'].map((path) => path.replaceAll('\\', process.platform === 'win32' ? '\\' : '/')))
assert.deepEqual(command.ghFallbackPaths({ ProgramFiles: '/x' }, 'linux'), [])
const executed = []
const fakeExecute = (file, args, options, callback) => {
  executed.push(file)
  queueMicrotask(() => (file === 'gh' ? callback(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), '', '') : callback(null, 'gh version 2', '')))
  return { stdin: { on() {}, end() {} } }
}
const withFallback = await command.createGhRunner(fakeExecute, () => ['C:/gh/gh.exe'])(process.cwd(), ['--version'])
assert.equal(withFallback.ok, true)
assert.deepEqual(executed, ['gh', 'C:/gh/gh.exe'])
executed.length = 0
const noFallback = await command.createGhRunner(fakeExecute, () => [])(process.cwd(), ['--version'])
assert.equal(noFallback.missing, true)
assert.deepEqual(executed, ['gh'])
const failedButInstalled = await repos.readGithubAccount(async () => bad('HTTP 403: forbidden'), '/fixture')
assert.equal(failedButInstalled.installed, true)
assert.equal(failedButInstalled.authed, false)

const searchCalls = []
const searchRun = async (cwd, args) => {
  searchCalls.push(args)
  return ok([
    { fullName: 'torvalds/linux', description: 'Kernel', isPrivate: false, isFork: false, updatedAt: '2026-10-01T00:00:00Z', url: 'https://github.com/torvalds/linux', stargazersCount: 190000, defaultBranch: 'master' },
    { fullName: 'broken', stargazersCount: 1 },
    { fullName: 'me/secret', description: null, isPrivate: true, stargazersCount: -3 }
  ])
}
const found = await repos.searchGithubRepos('  linux kernel ', searchRun, '/fixture')
assert.equal(found.ok, true)
assert.deepEqual(found.items.map((item) => item.nameWithOwner), ['torvalds/linux', 'me/secret'])
assert.equal(found.items[0].stars, 190000)
assert.equal(found.items[0].defaultBranch, 'master')
assert.equal(found.items[1].isPrivate, true)
assert.equal(found.items[1].stars, 0)
assert.deepEqual(searchCalls[0].slice(0, 3), ['search', 'repos', '--limit'])
assert.equal(searchCalls[0][3], '30')
assert.equal(searchCalls[0].at(-2), '--')
assert.equal(searchCalls[0].at(-1), 'linux kernel')
const callsBefore = searchCalls.length
for (const query of ['', 'a', '  ', 'x'.repeat(201), 'bad\nquery', 42, null]) assert.equal((await repos.searchGithubRepos(query, searchRun, '/fixture')).failure.code, 'invalid-input', String(query))
const dashQuery = await repos.searchGithubRepos('--owner=evil', searchRun, '/fixture')
assert.equal(dashQuery.ok, true)
assert.equal(searchCalls.at(-1).at(-2), '--')
assert.equal(searchCalls.length, callsBefore + 1)
const many = await repos.searchGithubRepos('many', async () => ok(Array.from({ length: 50 }, (_, index) => ({ fullName: `o/r${index}`, stargazersCount: index }))), '/fixture')
assert.equal(many.items.length, 30)
assert.equal((await repos.searchGithubRepos('zz', async () => bad('gh auth login'), '/fixture')).failure.code, 'not-authenticated')
assert.equal((await repos.searchGithubRepos('zz', async () => ok('not json'), '/fixture')).ok, false)

console.log('test-github-repos: PASS (repo list/search/global search/owners,account status, clone URL validation, target safety, progress, clone success/failure/cancel/timeout, new project, branches)')
