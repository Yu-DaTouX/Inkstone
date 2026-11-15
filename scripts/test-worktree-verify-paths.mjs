import { execFileSync } from 'node:child_process'
import { symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function shortPath(path) {
  if (process.platform !== 'win32') return null
  try {
    const out = execFileSync('cmd', ['/d', '/s', '/c', `for %I in ("${path}") do @echo %~sI`], { encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true }).trim()
    return out && out.toLowerCase() !== path.toLowerCase() ? out : null
  } catch {
    return null
  }
}

await runSuite(import.meta.url, async (ok, compile) => {
  const isolation = await compile('src/main/subagent-isolation.ts')
  const base = await mkdtemp(join(tmpdir(), 'inkstone-verify-'))
  const savedTemp = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR }
  const workspaces = []
  try {
    const repo = join(base, 'repo')
    await mkdir(repo, { recursive: true })
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.email', 'verify@example.invalid')
    git(repo, 'config', 'user.name', 'verify')
    await writeFile(join(repo, 'a.txt'), 'a\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'base')
    const longTemp = join(base, 'LongTemporaryFolderName')
    await mkdir(longTemp, { recursive: true })
    const short = shortPath(longTemp)

    const useTemp = (path) => { process.env.TEMP = path; process.env.TMP = path; process.env.TMPDIR = path }
    useTemp(short ?? longTemp)
    const workspace = await isolation.prepareWorkspace(repo, 'sub-0000abcd', 'worktree')
    workspaces.push(workspace)
    ok(!short || workspace.worktreePath.toLowerCase().startsWith(short.toLowerCase()), short ? `记录里的路径是 8.3 短名（${short}）` : '本机拿不到 8.3 短名，只测大小写', workspace.worktreePath)
    ok(await isolation.verifyKeptWorktree('sub-0000abcd', workspace) === null, 'TEMP 是短名时，正常的工作树能通过核对', String(await isolation.verifyKeptWorktree('sub-0000abcd', workspace)))
    ok(await isolation.verifyKeptWorktree('sub-0000abcd', workspace, longTemp) === null, '临时目录用长名表示时也能通过')
    const upper = { ...workspace, cwd: workspace.cwd.toUpperCase(), worktreePath: workspace.worktreePath.toUpperCase(), containerPath: workspace.containerPath.toUpperCase(), repoRoot: workspace.repoRoot }
    ok(await isolation.verifyKeptWorktree('sub-0000abcd', upper, longTemp.toLowerCase()) === null, '路径大小写不同也能通过', String(await isolation.verifyKeptWorktree('sub-0000abcd', upper, longTemp.toLowerCase())))
    ok(await isolation.verifyKeptWorktree('sub-0000ffff', workspace) !== null, 'id 与临时目录名对不上时拒绝')
    ok(await isolation.verifyKeptWorktree('sub-0000abcd', workspace, base) !== null, '不在给定的临时目录下时拒绝')

    symlinkSync(repo, join(workspace.worktreePath, 'escape'), 'junction')
    const escaped = await isolation.verifyKeptWorktree('sub-0000abcd', { ...workspace, cwd: join(workspace.worktreePath, 'escape') })
    ok(escaped !== null && /工作目录/.test(escaped), 'cwd 是指向主项目的联接时拒绝（按 realpath 比较）', String(escaped))
    await rm(join(workspace.worktreePath, 'escape'), { force: true, recursive: false }).catch(() => undefined)

    useTemp(longTemp)
    const unregistered = { ...workspace, repoRoot: base }
    ok(await isolation.verifyKeptWorktree('sub-0000abcd', unregistered) !== null, '没登记在给定仓库里时拒绝')
  } finally {
    for (const [key, value] of Object.entries(savedTemp)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    for (const workspace of workspaces) await isolation.cleanupWorkspace(workspace).catch(() => undefined)
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
