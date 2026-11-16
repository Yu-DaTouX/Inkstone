import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = mkdtempSync(join(tmpdir(), 'yan-git-submodule-'))
const outdir = join(root, 'out')
await build({
  entryPoints: { 'git-service': 'src/main/git-service.ts', 'git-inspect': 'src/main/git-inspect.ts', snapshots: 'src/main/snapshots.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir,
  outExtension: { '.js': '.mjs' },
  external: ['electron'],
  logLevel: 'error'
})
const { readStatus, readRepoState, clearRepoCache } = await import(pathToFileURL(join(outdir, 'git-service.mjs')).href)
const { readChanges, readFileDiff } = await import(pathToFileURL(join(outdir, 'git-inspect.mjs')).href)
const { captureTree } = await import(pathToFileURL(join(outdir, 'snapshots.mjs')).href)
const { gitInspectArgs } = await import('../resources/pi-extensions/readonly-tools.js')

const slash = (path) => path.replace(/\\/g, '/')
const marker = join(root, 'marker.txt')
const hookFile = join(root, 'hook.sh')
writeFileSync(hookFile, `#!/bin/sh\necho ran >> "${slash(marker)}"\ncat\n`)
const hook = `sh "${slash(hookFile)}"`
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: slash(join(root, 'empty.gitconfig')) }
writeFileSync(join(root, 'empty.gitconfig'), '')
const gitIn = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=yan-tests@example.invalid', '-c', 'user.name=Yan tests', '-c', 'core.autocrlf=false', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString()

let bump = 0
const touch = (file) => {
  bump += 1
  const later = new Date(Date.now() + 60_000 * bump)
  utimesSync(file, later, later)
}
const reset = () => rmSync(marker, { force: true })
const authorize = async (cwd) => ({ ok: true, cwd })

function makeProject(name) {
  const src = join(root, `${name}-src`)
  mkdirSync(src)
  gitIn(src, 'init', '-q')
  writeFileSync(join(src, 'a.txt'), 'x\n')
  writeFileSync(join(src, '.gitattributes'), '* filter=evil\n*.t diff=tc\n')
  gitIn(src, 'add', '.')
  gitIn(src, 'commit', '-qm', 'sub')
  const main = join(root, name)
  mkdirSync(main)
  gitIn(main, 'init', '-q')
  writeFileSync(join(main, 'm.txt'), 'm\n')
  gitIn(main, 'add', '.')
  gitIn(main, 'commit', '-qm', 'main')
  gitIn(main, 'tag', 'base')
  gitIn(main, '-c', 'protocol.file.allow=always', 'submodule', '-q', 'add', slash(src), 'sub')
  gitIn(main, 'commit', '-qm', 'add sub')
  const sub = join(main, 'sub')
  gitIn(sub, 'config', 'filter.evil.clean', hook)
  gitIn(sub, 'config', 'diff.tc.textconv', hook)
  gitIn(main, 'config', 'submodule.sub.ignore', 'none')
  gitIn(main, 'config', 'diff.submodule', 'diff')
  const dirty = () => touch(join(sub, 'a.txt'))
  return { main, sub, dirty }
}

try {
  const { main, sub, dirty } = makeProject('proj')
  assert.ok(!gitIn(main, 'config', '--list', '--name-only').includes('filter.evil'), '前提：主仓库配置里没有子模块的 filter')

  dirty()
  execFileSync('git', ['-c', 'core.fsmonitor=false', '--no-optional-locks', 'status', '--porcelain=v2'], { cwd: main, env, stdio: 'ignore' })
  assert.equal(existsSync(marker), true, '前提：不加保护时主仓库 git status 会执行子模块里的 clean 过滤器')
  reset()

  dirty()
  const status = await readStatus(main)
  assert.equal(existsSync(marker), false, '自动 status 不执行子模块配置里的 clean 过滤器')
  assert.ok(status.entries.every((entry) => entry.path !== 'sub'), '子模块内部改动不再计为脏')
  console.log('✓ git-service 自动 status 不进子模块执行过滤器')

  dirty()
  clearRepoCache()
  const state = await readRepoState(main, { withRefs: false })
  assert.equal(existsSync(marker), false, 'readRepoState 不执行子模块过滤器')
  assert.equal(state?.changedCount, 0, '子模块只有内部改动时仓库仍显示干净')
  console.log('✓ 仓库状态轮询不执行子模块过滤器')

  dirty()
  const changes = await readChanges(main, authorize, { patches: true })
  assert.equal(existsSync(marker), false, '变更面板读取不执行子模块过滤器')
  assert.equal(changes.ok, true, changes.error)
  console.log('✓ 变更面板不执行子模块过滤器')

  dirty()
  const branchChanges = await readChanges(main, authorize, { scope: { kind: 'branch', base: 'base' }, patches: true })
  assert.equal(existsSync(marker), false, '提交范围的变更读取不执行子模块过滤器')
  assert.equal(branchChanges.ok, true, branchChanges.error)

  dirty()
  await captureTree(main)
  assert.equal(existsSync(marker), false, '会话改动快照不执行子模块过滤器')
  console.log('✓ 会话改动快照不执行子模块过滤器')

  writeFileSync(join(sub, 'b.t'), 'hi\n')
  gitIn(sub, '-c', 'filter.evil.clean=', 'add', '-A')
  gitIn(sub, '-c', 'filter.evil.clean=', 'commit', '-qm', 'move')
  reset()
  execFileSync('git', ['--no-optional-locks', 'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', 'HEAD'], { cwd: main, env, stdio: 'ignore' })
  assert.equal(existsSync(marker), true, '前提：diff.submodule=diff 会在子模块里起 diff 并执行子模块的 textconv')
  reset()

  const moved = await readChanges(main, authorize, { patches: true })
  assert.equal(existsSync(marker), false, '子模块提交变化时读取变更不执行子模块 textconv')
  assert.ok(moved.files.some((file) => file.path === 'sub'), '子模块指向的提交变了仍然显示')
  assert.match(JSON.stringify(moved.patches ?? {}), /Subproject commit/, '子模块 diff 仍显示提交变化')
  dirty()
  await readFileDiff(main, 'sub/a.txt', authorize, { contents: true })
  await readChanges(main, authorize, { scope: { kind: 'branch', base: 'base' }, patches: true })
  assert.equal(existsSync(marker), false, '子模块提交变化且内部有改动时也不执行子模块配置')
  const movedStatus = await readStatus(main)
  assert.ok(movedStatus.entries.some((entry) => entry.path === 'sub'), '子模块提交变化在状态里仍可见')
  console.log('✓ 子模块提交变化仍可见，且不执行子模块的 textconv')

  for (const action of ['status', 'diff', 'show', 'log']) {
    const built = gitInspectArgs(action, [])
    assert.ok(built.argv.includes('--ignore-submodules=dirty'), `git_inspect ${action} 不进子模块检查脏状态`)
    if (action !== 'status') assert.ok(built.argv.includes('--submodule=short'), `git_inspect ${action} 不在子模块里起 diff`)
  }
  for (const blocked of ['--ignore-submodules=none', '--ignore-submodules', '--submodule=diff', '--submodule']) {
    assert.ok(gitInspectArgs('diff', [blocked]).error, `git_inspect 拒绝覆盖子模块保护：${blocked}`)
  }
  dirty()
  execFileSync('git', gitInspectArgs('status', []).argv, { cwd: main, env, stdio: 'ignore' })
  execFileSync('git', gitInspectArgs('diff', ['HEAD']).argv, { cwd: main, env, stdio: 'ignore' })
  assert.equal(existsSync(marker), false, 'git_inspect 的 status/diff 不执行子模块过滤器')
  console.log('✓ 模型的只读 git_inspect 也不进子模块执行过滤器')

  const plain = join(root, 'plain')
  mkdirSync(plain)
  gitIn(plain, 'init', '-q')
  writeFileSync(join(plain, 'a.txt'), 'x\n')
  writeFileSync(join(plain, '.gitattributes'), '* filter=evil\n')
  gitIn(plain, 'add', '.')
  gitIn(plain, 'commit', '-qm', 'base')
  gitIn(plain, 'config', 'filter.evil.clean', hook)
  reset()
  touch(join(plain, 'a.txt'))
  await captureTree(plain)
  assert.equal(existsSync(marker), false, '会话改动快照不执行主仓库配置里的 clean 过滤器')
  console.log('✓ 会话改动快照不执行主仓库过滤器')
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log('子模块配置不能借自动 git 读取执行命令')
