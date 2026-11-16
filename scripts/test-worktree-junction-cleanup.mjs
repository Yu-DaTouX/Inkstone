import './lib/test-isolate.mjs'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, linkSync, lstatSync, readdirSync, symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function listTree(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/')).sort()
}

function snapshot(dir) {
  return readdirSync(dir, { recursive: true }).map(String).sort().join('|')
}

async function makeTarget(base, name) {
  const dir = join(base, name)
  await mkdir(join(dir, 'pkg', 'lib'), { recursive: true })
  await writeFile(join(dir, 'pkg', 'lib', 'index.js'), `${name}\n`)
  await writeFile(join(dir, 'top.txt'), 'keep\n')
  return dir
}

await runSuite(import.meta.url, async (ok, compile) => {
  const isolation = await compile('src/main/subagent-isolation.ts')
  const base = await mkdtemp(join(tmpdir(), 'inkstone-junction-'))
  const containers = []
  try {
    const repo = join(base, 'repo')
    await mkdir(repo, { recursive: true })
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.email', 'junction@example.invalid')
    git(repo, 'config', 'user.name', 'junction')
    await writeFile(join(repo, '.gitignore'), 'node_modules/\n')
    await writeFile(join(repo, 'a.txt'), 'a\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'base')

    const deps = await makeTarget(base, 'deps')
    const shared = await makeTarget(base, 'shared')
    const nested = await makeTarget(base, 'nested')
    const before = { deps: snapshot(deps), shared: snapshot(shared), nested: snapshot(nested) }
    const intact = () => snapshot(deps) === before.deps && snapshot(shared) === before.shared && snapshot(nested) === before.nested

    const workspace = await isolation.prepareWorkspace(repo, 'sub-junction1', 'worktree')
    containers.push(workspace.containerPath)
    symlinkSync(deps, join(workspace.worktreePath, 'node_modules'), 'junction')
    await mkdir(join(workspace.worktreePath, 'tools'), { recursive: true })
    symlinkSync(shared, join(workspace.worktreePath, 'tools', 'shared'), 'junction')
    await mkdir(join(workspace.worktreePath, 'deep', 'pkg'), { recursive: true })
    symlinkSync(nested, join(workspace.worktreePath, 'deep', 'pkg', 'node_modules'), 'junction')
    ok(lstatSync(join(workspace.worktreePath, 'node_modules')).isSymbolicLink(), '联接在 Node 里按链接识别')
    await writeFile(join(workspace.worktreePath, 'a.txt'), 'changed\n')
    await writeFile(join(workspace.worktreePath, 'tools', 'new.txt'), 'new file\n')
    git(workspace.worktreePath, 'add', '--', 'tools/shared')
    let dirLink = false
    try {
      symlinkSync(nested, join(workspace.worktreePath, 'tools', 'dirlink'), 'dir')
      dirLink = true
    } catch {}
    const collected = await isolation.collectDiff(workspace, join(base, 'archive'), 'sub-junction1')
    const patch = await readFile(collected.patchPath, 'utf8')
    ok(collected.summary.paths.includes('a.txt') && collected.summary.paths.includes('tools/new.txt') && patch.includes('new file'), '普通文件照常进补丁', JSON.stringify(collected.summary.paths))
    ok(!collected.summary.paths.some((path) => path.startsWith('tools/shared') || path.startsWith('deep/') || path.startsWith('node_modules')) && !patch.includes('top.txt'), '未忽略的联接（含之前已被暂存的）目标文件不进补丁', JSON.stringify(collected.summary.paths))
    ok(collected.summary.skippedLinks?.includes('tools/shared') && collected.summary.skippedLinkCount === collected.summary.skippedLinks.length && collected.summary.skippedLinkCount <= (dirLink ? 2 : 1), '补丁摘要写明跳过的链接（被忽略的 node_modules 不算）', JSON.stringify(collected.summary))
    ok(!collected.summary.paths.some((path) => path.startsWith('tools/dirlink/')), dirLink ? '目录符号链接的目标文件也不进补丁' : '本机不能建目录符号链接，跳过该项', JSON.stringify({ dirLink, paths: collected.summary.paths }))
    ok(intact(), '收集补丁不动联接目标')
    appendFileSync(join(repo, '.git', 'info', 'exclude'), 'reports/\nreports2\nreports2/\n')
    await mkdir(join(workspace.worktreePath, 'reports'), { recursive: true })
    await writeFile(join(workspace.worktreePath, 'reports', 'report.md'), 'report\n')
    await writeFile(join(workspace.worktreePath, 'reports', '.env'), 'TOKEN=x\n')
    await writeFile(join(workspace.worktreePath, 'reports', 'id_rsa'), 'key\n')
    const moreSecrets = ['.git-credentials', '.pypirc', 'kubeconfig', 'vault.kdbx', 'service-account-prod.json', 'prod.env', '.env.local', 'secrets.yaml']
    for (const name of ['server.key', '.npmrc', 'credentials.json', 'id_card.png', 'environment.md', 'config', ...moreSecrets]) await writeFile(join(workspace.worktreePath, 'reports', name), `${name}\n`)
    await mkdir(join(workspace.worktreePath, 'reports', '.kube'), { recursive: true })
    await writeFile(join(workspace.worktreePath, 'reports', '.kube', 'config'), 'token: x\n')
    const outsideNote = join(base, 'outside-note.md')
    await writeFile(outsideNote, 'outside note\n')
    linkSync(outsideNote, join(workspace.worktreePath, 'reports', 'hard.md'))
    symlinkSync(shared, join(workspace.worktreePath, 'reports', 'linked'), 'junction')
    symlinkSync(nested, join(workspace.worktreePath, 'reports2'), 'junction')
    const outputs = await isolation.preserveIgnoredOutputs(workspace, join(base, 'archive'), 'sub-junction1')
    const savedFiles = outputs.ok && outputs.path ? listTree(outputs.path) : []
    ok(outputs.ok && savedFiles.includes('reports/report.md'), '普通的被忽略产物照常另存', JSON.stringify({ outputs, savedFiles }))
    ok(!savedFiles.some((file) => file.startsWith('reports/linked') || file.startsWith('reports2') || file.includes('top.txt')), '穿过链接的被忽略路径不复制链接目标里的文件', JSON.stringify(savedFiles))
    ok(outputs.ok && !savedFiles.includes('reports/hard.md') && outputs.links?.includes('reports/hard.md'), '硬链接（nlink>1）的产物按链接处理，不复制', JSON.stringify(outputs))
    ok(outputs.ok && outputs.links?.includes('reports/linked') && outputs.links?.includes('reports2'), '发现的链接写进结果，不静默排除', JSON.stringify(outputs))
    const expectedWithheld = ['.env', '.npmrc', 'credentials.json', 'id_rsa', 'server.key', ...moreSecrets, '.kube/config'].map((name) => `reports/${name}`).sort()
    ok(outputs.ok && !savedFiles.includes('reports/.env') && !savedFiles.includes('reports/id_rsa') && JSON.stringify([...(outputs.withheld ?? [])].sort()) === JSON.stringify(expectedWithheld) && savedFiles.includes('reports/id_card.png'), '可能含凭据的文件不复制，只列文件名（含 .git-credentials、.pypirc、kubeconfig、.kdbx、service-account*.json、*.env 变体与 .kube/config）', JSON.stringify(outputs))
    ok(savedFiles.includes('reports/environment.md') && savedFiles.includes('reports/config'), '名字相近但不是凭据的文件照常另存', JSON.stringify(savedFiles))
    ok(intact(), '另存产物不动联接目标')
    const cleaned = await isolation.cleanupWorkspace(workspace)
    ok(cleaned.ok, 'cleanupWorkspace 成功', cleaned.errors.join('; '))
    ok(!existsSync(workspace.worktreePath) && !existsSync(workspace.containerPath), '工作树与临时目录都已删除')
    ok(intact(), 'git worktree remove --force 与递归删除都没有顺着联接删掉目标目录')
    ok(!git(repo, 'worktree', 'list', '--porcelain').includes('sub-junction1'), '工作树已从仓库登记里移除')

    const committed = await isolation.prepareWorkspace(repo, 'sub-junction3', 'worktree')
    containers.push(committed.containerPath)
    symlinkSync(shared, join(committed.worktreePath, 'junc'), 'junction')
    await writeFile(join(committed.worktreePath, 'own.txt'), 'own work\n')
    git(committed.worktreePath, 'add', '-A')
    git(committed.worktreePath, '-c', 'user.email=j@example.invalid', '-c', 'user.name=j', 'commit', '-qm', 'wip')
    ok(git(committed.worktreePath, 'ls-tree', '-r', '--name-only', 'HEAD').includes('junc/top.txt'), '子代理先建联接再 git add -A && git commit：联接目标内容已进工作树的提交')
    const outside = join(base, 'outside-secret.txt')
    await writeFile(outside, 'outside content\n')
    linkSync(outside, join(committed.worktreePath, 'hard.txt'))
    const afterCommit = await isolation.collectDiff(committed, join(base, 'archive'), 'sub-junction3')
    const committedPatch = afterCommit.patchPath ? await readFile(afterCommit.patchPath, 'utf8') : ''
    ok(committedPatch.includes('own work') && afterCommit.summary.paths.includes('own.txt'), '提交里的普通文件照常进补丁', JSON.stringify(afterCommit.summary.paths))
    ok(!afterCommit.summary.paths.some((path) => path.startsWith('junc')) && !committedPatch.includes('top.txt') && !committedPatch.includes('keep'), '已提交的联接目标内容不进补丁（reset 以 base 为准）', JSON.stringify(afterCommit.summary.paths))
    ok(!afterCommit.summary.paths.includes('hard.txt') && !committedPatch.includes('outside content') && afterCommit.summary.skippedLinks?.includes('hard.txt') && afterCommit.summary.skippedLinks?.includes('junc'), '硬链接（nlink>1）按链接处理，不进补丁', JSON.stringify(afterCommit.summary))
    ok(intact(), '已提交联接的情形下联接目标完好')

    const raw = await isolation.prepareWorkspace(repo, 'sub-junction2', 'worktree')
    containers.push(raw.containerPath)
    symlinkSync(deps, join(raw.worktreePath, 'node_modules'), 'junction')
    symlinkSync(shared, join(raw.worktreePath, 'shared-link'), 'junction')
    git(repo, 'worktree', 'remove', '--force', raw.worktreePath)
    ok(intact(), '单独跑 git worktree remove --force 也不碰联接目标（本机 Git 行为）')
    await rm(raw.containerPath, { recursive: true, force: true })
    ok(!existsSync(raw.containerPath) && intact(), '单独递归删除含联接的目录只删联接本身')

    const linkRoot = join(base, 'root-link')
    symlinkSync(deps, linkRoot, 'junction')
    const refused = await isolation.detachLinks(linkRoot)
    ok(refused.length === 1 && intact() && existsSync(linkRoot), '工作树路径本身是联接时拒绝处理')

    const foreign = join(base, 'not-ours')
    await mkdir(join(foreign, 'worktree'), { recursive: true })
    await writeFile(join(foreign, 'sentinel.txt'), 'keep\n')
    symlinkSync(deps, join(foreign, 'worktree', 'node_modules'), 'junction')
    const guarded = await isolation.cleanupWorkspace({ isolation: 'worktree', rootCwd: repo, cwd: join(foreign, 'worktree'), worktreePath: join(foreign, 'worktree'), containerPath: foreign })
    ok(guarded.ok && existsSync(join(foreign, 'sentinel.txt')) && existsSync(join(foreign, 'worktree', 'node_modules')), '不是砚建的临时目录：不递归删除、也不动其中的联接')
    ok(!isolation.removableContainer({ containerPath: repo }) && isolation.removableContainer({ containerPath: join(base, 'yan-subagent-x'), worktreePath: join(base, 'yan-subagent-x', 'worktree') }), '只认 yan-subagent- 开头且工作树在其下的临时目录')
    ok(!isolation.removableContainer({ containerPath: join(base, 'yan-subagent-x'), worktreePath: repo }), '工作树不在临时目录下时不删临时目录')
    ok(intact(), '全部用例后联接目标仍完好')
  } finally {
    for (const container of containers) await rm(container, { recursive: true, force: true }).catch(() => {})
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
  }
})
