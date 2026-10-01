// Agent Hub worktree compatibility: carried working changes, dependency links, safe cleanup,
// non-git folders and attachments. Uses a throwaway git repository; no agent CLI is started.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, lstatSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'inkstone-hub-worktree-'))
const repo = join(root, 'project'), plain = join(root, 'plain'), data = join(root, 'data')
await mkdir(repo, { recursive: true }); await mkdir(plain, { recursive: true })
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true })
git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'fixture'); git('config', 'core.autocrlf', 'false')
await writeFile(join(repo, 'a.txt'), 'one\n'); await writeFile(join(repo, '.gitignore'), 'node_modules\n')
git('add', '-A'); git('commit', '-qm', 'base')
await mkdir(join(repo, 'node_modules', 'dep'), { recursive: true })
await writeFile(join(repo, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
// Uncommitted work in the main tree: a modified file and a new untracked file.
await writeFile(join(repo, 'a.txt'), 'one\ntwo\n'); await writeFile(join(repo, 'b.txt'), 'new\n')

await build({ entryPoints: ['src/main/agent-hub/service.ts'], outfile: 'out/test/agent-hub-worktree.mjs', bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' })
const { AgentHubService } = await import(pathToFileURL(resolve('out/test/agent-hub-worktree.mjs')))
const hub = new AgentHubService({ dataDir: data, piDir: join(data, 'pi'), resourcesDir: resolve('resources'), browser: () => null, piBin: async () => undefined,
  projects: async () => [{ id: 'repo', name: 'repo', cwd: repo }, { id: 'plain', name: 'plain', cwd: plain }] })
hub.adapters = [{ agent: 'codex', available: true, modes: ['managed', 'terminal'] }]
hub.launch = async (task) => { task.status = 'running' }

const status = await hub.command({ action: 'workspace-status', projectId: 'repo' })
assert.equal(status.git, true); assert.equal(status.changed, 2, 'modified and untracked files are both counted')
assert.equal((await hub.command({ action: 'workspace-status', projectId: 'plain' })).git, false)

// Carried changes become the starting point; the user's own index is untouched.
const carried = { id: 'carried-task', mode: 'managed', status: 'running', includeWorkingChanges: true, projectId: 'repo' }
await hub.prepareWorkspace(carried, repo)
assert.equal(await readFile(join(carried.workspace, 'a.txt'), 'utf8'), 'one\ntwo\n')
assert.equal(await readFile(join(carried.workspace, 'b.txt'), 'utf8'), 'new\n')
assert.equal(carried.startArtifact.files, 2)
assert.deepEqual(execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: carried.workspace, encoding: 'utf8' }).trim().split('\n').sort(), ['a.txt', 'b.txt'], 'agent sees the carried changes with git diff HEAD')
assert.equal(git('diff', '--cached', '--name-only').trim(), '', "the project's index is not modified")
assert.ok(lstatSync(join(carried.workspace, 'node_modules')).isSymbolicLink(), 'ignored dependency directory is linked')
assert.equal(await readFile(join(carried.workspace, 'node_modules', 'dep', 'index.js'), 'utf8'), 'module.exports = 1\n')

// The delivered patch holds only the agent's own change, not the carried start.
await writeFile(join(carried.workspace, 'c.txt'), 'agent\n')
await build({ entryPoints: ['src/main/agent-hub/workspaces.ts'], outfile: 'out/test/hub-workspaces.mjs', bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' })
const { freezeHubWorkspace } = await import(pathToFileURL(resolve('out/test/hub-workspaces.mjs')))
carried.artifact = await freezeHubWorkspace(carried.workspace, carried.startTree, join(data, 'artifacts', 'carried'), 'report')
const patch = await readFile(carried.artifact.patchPath, 'utf8')
assert.match(patch, /c\.txt/); assert.doesNotMatch(patch, /a\.txt|b\.txt/, 'carried changes are not part of the delivery')

// A review of that delivery rebuilds both layers.
carried.status = 'needs_review'; carried.baseline ??= git('rev-parse', 'HEAD').trim()
hub.tasks.set(carried.id, carried)
const review = { id: 'review-task', mode: 'managed', status: 'running', reviewOf: carried.id, projectId: 'repo' }
await hub.prepareWorkspace(review, repo)
for (const [file, text] of [['a.txt', 'one\ntwo\n'], ['b.txt', 'new\n'], ['c.txt', 'agent\n']]) assert.equal(await readFile(join(review.workspace, file), 'utf8'), text)

// Cleanup removes the worktree but never the project's dependency directory.
await assert.rejects(hub.removeWorkspace({ ...carried, status: 'running' }), /运行中/)
carried.status = 'completed'
await hub.removeWorkspace(carried)
assert.equal(existsSync(carried.workspace), false); assert.equal(carried.workspaceRemoved, true)
assert.equal(await readFile(join(repo, 'node_modules', 'dep', 'index.js'), 'utf8'), 'module.exports = 1\n', 'linked dependency survives cleanup')
assert.doesNotMatch(git('worktree', 'list'), /carried-task/)
review.status = 'cancelled'; await hub.removeWorkspace(review)
assert.ok(existsSync(join(repo, 'node_modules', 'dep', 'index.js')))

// Non-git folders: terminals run in place, managed runs are refused.
const inPlace = { id: 'plain-terminal', mode: 'terminal' }
await hub.prepareWorkspace(inPlace, plain)
assert.equal(inPlace.workspace, plain); assert.equal(inPlace.inPlace, true)
await assert.rejects(hub.prepareWorkspace({ id: 'plain-managed', mode: 'managed' }, plain), /git 仓库/)

// Attachments are stored outside every workspace; names are sanitised.
const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')
const created = await hub.command({ action: 'create', request: { requestId: 'fixture-attach', projectId: 'repo', agent: 'codex', mode: 'managed', prompt: '看截图', attachments: [{ name: '../shot.png', data: png, mime: 'image/png' }, { name: 'notes.md', data: Buffer.from('# n').toString('base64') }] } })
const task = hub.tasks.get(created.taskId)
assert.equal(task.createdBy, 'desktop')
assert.deepEqual(task.attachments.map((a) => [a.name, a.image]), [['shot.png', true], ['notes.md', false]])
for (const a of task.attachments) { assert.ok(existsSync(a.path)); assert.ok(a.path.startsWith(join(data, 'agent-hub', 'attachments'))) }
await assert.rejects(hub.command({ action: 'create', request: { requestId: 'fixture-attach-many', projectId: 'repo', agent: 'codex', mode: 'managed', prompt: 'x', attachments: Array.from({ length: 9 }, (_, i) => ({ name: `${i}.txt`, data: 'eA==' })) } }), /最多/)
const fromSession = await hub.create({ requestId: 'fixture-session', projectId: 'repo', agent: 'codex', mode: 'managed', prompt: 'review', includeWorkingChanges: true }, 'pi:session')
assert.equal(hub.tasks.get(fromSession.taskId).createdBy, 'session')
assert.equal(hub.tasks.get(fromSession.taskId).includeWorkingChanges, true)
await hub.shutdown()
console.log('Agent Hub worktree checks passed: carried working changes, untouched user index, dependency links, delivery excludes start, layered review, safe cleanup, non-git terminals, attachments.')
