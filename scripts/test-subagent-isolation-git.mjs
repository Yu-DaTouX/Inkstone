import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BUILD_DIR = '.tmp/audit-subagent'

await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/subagent-isolation.ts'],
    outfile: `${BUILD_DIR}/subagent-isolation-git.mjs`,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
)

const { prepareWorkspace, cleanupWorkspace, gitHooksDisabledDir } = await import(`../${BUILD_DIR}/subagent-isolation-git.mjs`)

let checks = 0
const ok = (condition, label, detail) => {
  assert.ok(condition, detail === undefined ? label : `${label}（${detail}）`)
  checks += 1
}

const posix = (path) => path.replace(/\\/g, '/')
const readdirCatch = (path) => readdir(path).catch(() => [])
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })

const root = await mkdtemp(join(tmpdir(), 'yan-subagent-git-hooks-'))
const repo = join(root, 'repo')
const hookMarker = join(root, 'hook-ran.log')
const filterMarker = join(root, 'filter-ran.log')

try {
  await mkdir(repo, { recursive: true })
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.name', 'Inkstone Test'])
  git(repo, ['config', 'user.email', 'test@example.invalid'])
  git(repo, ['config', 'commit.gpgsign', 'false'])

  const clean = `sh -c 'cat; echo clean >> "${posix(filterMarker)}"'`
  const smudge = `sh -c 'cat; echo smudge >> "${posix(filterMarker)}"'`
  git(repo, ['config', 'filter.probe.clean', clean])
  git(repo, ['config', 'filter.probe.smudge', smudge])
  git(repo, ['config', 'filter.probe.required', 'false'])

  await writeFile(join(repo, '.gitattributes'), '*.probe filter=probe\n', 'utf8')
  await writeFile(join(repo, 'payload.probe'), 'original content\n', 'utf8')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'base'])

  const hookScript = `#!/bin/sh\necho "hook $1" >> "${posix(hookMarker)}"\nexit 0\n`
  for (const hook of ['post-checkout', 'post-commit', 'post-merge']) {
    const path = join(repo, '.git', 'hooks', hook)
    await mkdir(join(repo, '.git', 'hooks'), { recursive: true })
    await writeFile(path, hookScript, 'utf8')
    try {
      execFileSync('chmod', ['+x', path], { windowsHide: true, stdio: 'ignore' })
    } catch {
    }
  }

  const hooksDir = gitHooksDisabledDir()
  ok(existsSync(hooksDir) && hooksDir !== join(tmpdir(), 'yan-subagent-git-hooks'), '禁钩子目录是本次进程独立的随机空目录，不用固定路径', hooksDir)
  ok((await readdirCatch(hooksDir)).length === 0, '禁钩子目录是空的（不含任何残留钩子）')
  ok(gitHooksDisabledDir() === hooksDir, '同一进程复用同一个禁钩子目录')

  const evilHooks = join(root, 'evil-hooks')
  await mkdir(evilHooks, { recursive: true })
  await writeFile(join(evilHooks, 'post-checkout'), `#!/bin/sh
echo "evil hook" >> "${posix(hookMarker)}"
`, 'utf8')
  try {
    execFileSync('chmod', ['+x', join(evilHooks, 'post-checkout')], { windowsHide: true, stdio: 'ignore' })
  } catch {
  }
  git(repo, ['config', 'core.hooksPath', evilHooks])
  ok(existsSync(filterMarker), '夹具：提交时 clean 过滤器确实运行过', filterMarker)

  const probeWorktree = join(root, 'probe-wt')
  await rm(hookMarker, { force: true })
  git(repo, ['worktree', 'add', '--detach', probeWorktree, 'HEAD'])
  ok(existsSync(hookMarker), '夹具：未加固的 git worktree add 会执行仓库 / 仓库配置的钩子（后置条件才有意义）', existsSync(hookMarker) ? await readFile(hookMarker, 'utf8') : '')
  git(repo, ['worktree', 'remove', '--force', probeWorktree])
  await rm(hookMarker, { force: true })
  await rm(filterMarker, { force: true })

  const workspace = await prepareWorkspace(repo, 'sub-hooktest', 'worktree')
  ok(workspace.isolation === 'worktree' && existsSync(workspace.worktreePath), 'worktree 子代理准备出独立工作树', workspace.worktreePath)
  const content = await readFile(join(workspace.cwd, 'payload.probe'), 'utf8')
  ok(content.includes('original content'), '工作树里拿到真实文件内容（过滤器仍生效）', content)
  ok(existsSync(filterMarker) && /smudge|clean/.test(await readFile(filterMarker, 'utf8')), '保留必要的过滤（LFS 类 smudge/clean 仍执行）', existsSync(filterMarker) ? await readFile(filterMarker, 'utf8') : '')
  ok(!existsSync(hookMarker), '仓库钩子与仓库自己配置的 hooksPath 都不执行（恶意钩子不运行）', existsSync(hookMarker) ? await readFile(hookMarker, 'utf8') : '')

  const cleaned = await cleanupWorkspace(workspace)
  ok(cleaned.ok && !existsSync(workspace.worktreePath), '清理后工作树被移除', JSON.stringify(cleaned))
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`subagent-isolation-git: ${checks} checks passed`)
