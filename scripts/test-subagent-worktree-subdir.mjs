import './lib/test-isolate.mjs'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
const same = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)

await runSuite(import.meta.url, async (ok, compile) => {
  const isolation = await compile('src/main/subagent-isolation.ts')
  const prune = await compile('src/main/subagent-prune.ts')
  const { prepareWorkspace, cleanupWorkspace, collectDiff, preserveIgnoredOutputs, recoverWorktree } = isolation
  const root = await mkdtemp(join(tmpdir(), 'yan-subagent-subdir-'))
  const repo = join(root, 'repo')
  const sub = join(repo, 'apps', 'web')
  const archive = join(root, 'archive')
  const workspaces = []
  try {
    await mkdir(sub, { recursive: true })
    git(repo, ['init', '-q'])
    git(repo, ['config', 'user.name', 'Inkstone Test'])
    git(repo, ['config', 'user.email', 'test@example.invalid'])
    git(repo, ['config', 'commit.gpgsign', 'false'])
    await writeFile(join(repo, 'README.md'), 'root\n', 'utf8')
    await writeFile(join(repo, '.gitignore'), 'scratch/\n', 'utf8')
    await writeFile(join(sub, 'index.txt'), 'web\n', 'utf8')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'base'])

    const ws = await prepareWorkspace(sub, 'sub-subdir', 'worktree')
    workspaces.push(ws)
    ok(same(ws.cwd, join(ws.worktreePath, 'apps', 'web')), '项目在仓库子目录时，worktree 子代理的 cwd 是工作树里对应的子目录', `${ws.cwd} vs ${ws.worktreePath}`)
    ok(existsSync(join(ws.worktreePath, '.git')) && existsSync(join(ws.cwd, 'index.txt')), '工作树根仍是 git 工作树，子目录里有项目文件')
    ok(same(ws.rootCwd, sub) && same(ws.repoRoot, repo), 'rootCwd 与 repoRoot 不变')

    await writeFile(join(ws.cwd, 'added.txt'), 'new in web\n', 'utf8')
    await writeFile(join(ws.worktreePath, 'ROOT.txt'), 'new at root\n', 'utf8')
    await mkdir(join(ws.worktreePath, 'scratch'), { recursive: true })
    await writeFile(join(ws.worktreePath, 'scratch', 'notes.md'), 'ignored output\n', 'utf8')
    const collected = await collectDiff(ws, archive, 'sub-subdir')
    ok(collected.summary.paths.includes('apps/web/added.txt') && collected.summary.paths.includes('ROOT.txt'), '收集改动覆盖整个工作树（子目录内外都在补丁里）', JSON.stringify(collected.summary.paths))
    ok((collected.ignoredOutputs ?? []).includes('scratch'), '被忽略产物按工作树根列出', JSON.stringify(collected.ignoredOutputs))
    const saved = await preserveIgnoredOutputs(ws, archive, 'sub-subdir')
    ok(saved.ok && saved.files.includes('scratch') && existsSync(join(saved.path, 'scratch', 'notes.md')), '另存被忽略产物按工作树根取文件', JSON.stringify(saved))

    const recovered = await recoverWorktree(ws.cwd, sub)
    ok(!!recovered && same(recovered.worktreePath, ws.worktreePath) && same(recovered.cwd, ws.cwd) && same(recovered.containerPath ?? '', ws.containerPath), '重启后按子目录 cwd 能找回工作树根与容器目录', JSON.stringify(recovered))

    await mkdir(join(repo, 'untracked-dir'), { recursive: true })
    const loose = await prepareWorkspace(join(repo, 'untracked-dir'), 'sub-loose', 'worktree')
    workspaces.push(loose)
    ok(same(loose.cwd, loose.worktreePath), '子目录在工作树里不存在（未提交）时退回工作树根', `${loose.cwd} vs ${loose.worktreePath}`)

    const top = await prepareWorkspace(repo, 'sub-top', 'worktree')
    workspaces.push(top)
    ok(same(top.cwd, top.worktreePath), '项目就是仓库根时 cwd 仍是工作树根')

    const pruneDir = join(root, 'prune')
    await mkdir(pruneDir, { recursive: true })
    const doomed = await prepareWorkspace(sub, 'sub-prunesub', 'worktree')
    workspaces.push(doomed)
    await writeFile(join(pruneDir, 'sub-prunesub.json'), JSON.stringify({ id: 'sub-prunesub', status: 'done', review: 'discarded', isolation: 'worktree', cwd: doomed.cwd, rootCwd: sub }), 'utf8')
    const removed = await prune.pruneSubagentArchive(pruneDir, { now: Date.now() + 3 * 86_400_000, keepDays: 1, keepCount: 0 })
    ok(removed.includes('sub-prunesub'), '夹具：过期记录被清理', JSON.stringify(removed))
    ok(!existsSync(doomed.worktreePath) && !existsSync(doomed.containerPath), '清理过期记录时，子目录 cwd 的工作树和容器目录一并移除', doomed.containerPath)
    ok(!git(repo, ['worktree', 'list', '--porcelain']).toLowerCase().includes(resolve(doomed.worktreePath).replace(/\\/g, '/').toLowerCase()), '主仓库里不留这个工作树的登记')
  } finally {
    for (const ws of workspaces) if (ws.worktreePath && existsSync(ws.worktreePath)) await cleanupWorkspace(ws).catch(() => undefined)
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
})
