import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'inkstone-cleanup-retry-'))
const exec = promisify(execFile)
const git = args => exec('git', args, { cwd: root, timeout: 15000, windowsHide: true })
let workspace
try {
  const isolationFile = join(root, 'isolation.mjs')
  await build({ entryPoints: ['src/main/subagent-isolation.ts'], outfile: isolationFile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const isolation = await import(pathToFileURL(isolationFile).href)
  await git(['init', '-q'])
  await writeFile(join(root, 'base.txt'), 'fixture')
  await git(['add', 'base.txt'])
  await git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'])
  workspace = await isolation.prepareWorkspace(root, 'retry', 'worktree')
  await git(['worktree', 'lock', workspace.worktreePath])
  const failed = await isolation.cleanupWorkspace(workspace)
  assert.equal(failed.ok, false)
  assert.ok(failed.errors.length)
  assert.ok(existsSync(workspace.cwd), 'failed Git removal must preserve workspace files')
  await git(['worktree', 'unlock', workspace.worktreePath])
  assert.equal((await isolation.cleanupWorkspace(workspace)).ok, true)
  assert.equal(existsSync(workspace.containerPath), false)
  assert.equal((await isolation.cleanupWorkspace(workspace)).ok, true, 'already removed workspace cleanup is idempotent')

  process.env.YAN_DATA_DIR = join(root, 'data')
  process.env.YAN_PI_DIR = join(root, 'pi')
  process.env.YAN_USER_DATA = join(root, 'user')
  const controllerFile = join(root, 'controller.mjs')
  await build({
    entryPoints: ['src/main/subagents.ts'], outfile: controllerFile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    plugins: [{ name: 'cleanup-fixture', setup(b) {
      b.onResolve({ filter: /^\.\/subagent-isolation$/ }, () => ({ path: 'isolation', namespace: 'fixture' }))
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export const cleanupWorkspace = async () => { globalThis.cleanupCalls++; return globalThis.cleanupCalls === 1 ? { ok: false, errors: ['fixture occupied'] } : { ok: true, errors: [] } }
        export const collectDiff = async () => ({ summary: { files: 0 } })
        export const applyPatch = async () => ({ ok: true })
        export const prepareWorkspace = async () => ({})
      ` }))
    } }]
  })
  const { SubagentController } = await import(pathToFileURL(controllerFile).href)
  const controller = Object.create(SubagentController.prototype)
  controller.opts = {}
  controller.emit = () => {}
  controller.writeMetadata = async () => {}
  globalThis.cleanupCalls = 0
  const run = { id: 'fixture', status: 'done', workspace: { rootCwd: root }, isolation: 'worktree', review: 'none' }
  await controller.finalizeOnce(run, false)
  assert.equal(run.worktreeDone, false)
  assert.match(run.error, /fixture occupied/)
  controller.runs = new Map([[run.id, run]])
  controller.resuming = new Map()
  controller.list = () => [run]
  controller.history = { hide: () => assert.fail('failed cleanup record must remain available for retry') }
  await controller.clearFinished()
  assert.equal(controller.runs.get(run.id), run)
  await controller.archiveOnExit(run)
  assert.equal(globalThis.cleanupCalls, 2)
  assert.equal(run.worktreeDone, true)
  await controller.archiveOnExit(run)
  assert.equal(globalThis.cleanupCalls, 2, 'successful cleanup is not repeated')
  console.log('Subagent cleanup retry: passed (locked worktree, preservation, retry, idempotence, finalization and exit retry)')
} finally {
  if (workspace) {
    await git(['worktree', 'unlock', workspace.worktreePath]).catch(() => {})
    await git(['worktree', 'remove', '--force', workspace.worktreePath]).catch(() => {})
    await rm(workspace.containerPath, { recursive: true, force: true })
  }
  delete globalThis.cleanupCalls
  await rm(root, { recursive: true, force: true })
}
