import './lib/test-isolate.mjs'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runSuite } from './lib/test-suite.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const snapshot = (dir) => readdirSync(dir, { recursive: true }).map(String).sort().join('|')

async function makeRepo(dir) {
  await mkdir(dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'debug@example.invalid')
  git(dir, 'config', 'user.name', 'debug')
  await writeFile(join(dir, 'a.txt'), 'a\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'base')
  return dir
}

async function record(archiveDir, id, workspace) {
  await mkdir(archiveDir, { recursive: true })
  await writeFile(join(archiveDir, `${id}.json`), JSON.stringify({ id, isolation: 'worktree', status: 'running', resume: { workspace } }))
}

await runSuite(import.meta.url, async (ok) => {
  const lib = await import(pathToFileURL(resolve('debug/lib/subagent-worktrees.mjs')).href)
  const base = await mkdtemp(join(tmpdir(), 'inkstone-debug-wt-'))
  try {
    const temp = join(base, 'temp')
    await mkdir(temp, { recursive: true })
    const runDir = join(base, 'debug', 'runs', '20261116-000000-swarm')
    const archiveDir = join(runDir, 'yan', 'subagents')
    const project = await makeRepo(join(runDir, 'projects', 'ledger'))
    const other = await makeRepo(join(base, 'real-repo'))
    const target = join(base, 'deps')
    await mkdir(join(target, 'pkg'), { recursive: true })
    await writeFile(join(target, 'pkg', 'index.js'), 'keep\n')
    const before = snapshot(target)

    const add = (repo, id, suffix) => {
      const worktreePath = join(temp, `yan-subagent-${id}-${suffix}`, 'worktree')
      git(repo, 'worktree', 'add', '-q', '--detach', worktreePath)
      return { isolation: 'worktree', cwd: worktreePath, rootCwd: repo, repoRoot: repo, worktreePath, containerPath: join(temp, `yan-subagent-${id}-${suffix}`) }
    }
    const mine = add(project, 'sub-00000001', 'AAAAAA')
    symlinkSync(target, join(mine.worktreePath, 'node_modules'), 'junction')
    await record(archiveDir, 'sub-00000001', mine)
    const unrecorded = add(project, 'sub-00000002', 'BBBBBB')
    const foreign = add(other, 'sub-00000003', 'CCCCCC')
    await record(archiveDir, 'sub-00000003', foreign)
    const mismatched = add(project, 'sub-00000004', 'DDDDDD')
    await record(archiveDir, 'sub-00000005', { ...mismatched })
    const plainPath = join(temp, 'plain-checkout')
    git(project, 'worktree', 'add', '-q', '--detach', plainPath)
    await record(archiveDir, 'sub-00000006', { isolation: 'worktree', cwd: plainPath, rootCwd: project, repoRoot: project, worktreePath: plainPath })

    const missingTree = join(temp, 'yan-subagent-sub-00000008-FFFFFF')
    await mkdir(missingTree, { recursive: true })
    await writeFile(join(missingTree, 'leftover.txt'), 'x')
    await record(archiveDir, 'sub-00000008', { isolation: 'worktree', cwd: join(missingTree, 'worktree'), rootCwd: project, repoRoot: project, worktreePath: join(missingTree, 'worktree'), containerPath: missingTree })
    const emptyTree = join(temp, 'yan-subagent-sub-00000009-GGGGGG')
    await mkdir(emptyTree, { recursive: true })
    await record(archiveDir, 'sub-00000009', { isolation: 'worktree', cwd: join(emptyTree, 'worktree'), rootCwd: project, repoRoot: project, worktreePath: join(emptyTree, 'worktree'), containerPath: emptyTree })
    ok(lib.cleanupInstanceWorktrees(runDir).removed.length === 0 && existsSync(mine.containerPath), '临时目录不在系统临时目录下时一个都不动')
    const result = lib.cleanupInstanceWorktrees(runDir, undefined, { tempRoot: temp })
    ok(result.removed.includes(mine.worktreePath) && result.removed.length === 2 && !existsSync(mine.containerPath), '按本实例记录清掉自己的子代理工作树与临时目录', JSON.stringify(result))
    ok(snapshot(target) === before && existsSync(join(target, 'pkg', 'index.js')), '先摘链接：工作树里的联接目标完好')
    ok(!git(project, 'worktree', 'list', '--porcelain').includes('sub-00000001'), '经 git worktree remove 清掉登记')
    ok(existsSync(unrecorded.worktreePath), '没有记录的同名结构工作树不动（不按 yan-subagent-* 通配删除）')
    ok(existsSync(foreign.worktreePath) && result.skipped.some((item) => item.reason.includes('运行目录')), '记录指向运行目录外的仓库时不动', JSON.stringify(result.skipped))
    ok(existsSync(mismatched.worktreePath) && result.skipped.some((item) => item.reason.includes('yan-subagent-<id>')), '记录 id 与临时目录名对不上时不动')
    ok(existsSync(plainPath), '不是 yan-subagent-<id>-*/worktree 结构的不动')
    ok(existsSync(join(missingTree, 'leftover.txt')) && result.skipped.some((item) => item.reason.includes('还有别的东西')), '工作树已不在、临时目录非空时不删')
    ok(!existsSync(emptyTree), '工作树已不在、临时目录是空的才删')

    const goneRepo = await makeRepo(join(base, 'gone', 'debug', 'runs', 'x', 'projects', 'p'))
    const gone = add(goneRepo, 'sub-00000007', 'EEEEEE')
    await rm(goneRepo, { recursive: true, force: true })
    ok(lib.checkSubagentWorktree({ id: 'sub-00000007', ...gone }, { tempRoot: temp }) === null, '仓库已不存在时仍可按 gitdir 文本核对')
    ok(lib.removeSubagentWorktree({ id: 'sub-00000007', ...gone }).ok && !existsSync(gone.containerPath), '仓库已不存在的孤儿可删')
    ok(lib.checkSubagentWorktree({ id: 'sub-00000003', ...foreign }, { repoWithin: runDir, tempRoot: temp }) !== null, '核对会拒绝运行目录外的仓库')
    ok(snapshot(target) === before, '全部用例后联接目标完好')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
