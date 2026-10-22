import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const execFileAsync = promisify(execFile)

async function git(cwd, args) {
  await execFileAsync('git', args, { cwd, windowsHide: true, encoding: 'utf8' })
}

async function initRepo(suffix) {
  const dir = await mkdtemp(join(tmpdir(), `yan-subagent-${suffix}-`))
  await git(dir, ['init', '-q'])
  await git(dir, ['config', 'user.email', 'yan-tests@example.invalid'])
  await git(dir, ['config', 'user.name', 'Yan tests'])
  await git(dir, ['config', 'commit.gpgsign', 'false'])
  await git(dir, ['config', 'core.autocrlf', 'false'])
  return dir
}

const readText = async (path) => (await readFile(path, 'utf8')).replace(/\r\n/g, '\n')

export async function runSubagentIsolationTests(ok, isolation) {
  const root = await mkdtemp(join(tmpdir(), 'yan-subagent-test-'))
  const extraRoots = []
  const archive = join(root, 'archives')
  try {
    await git(root, ['init', '-q'])
    await git(root, ['config', 'user.email', 'yan-tests@example.invalid'])
    await git(root, ['config', 'user.name', 'Yan tests'])
    await git(root, ['config', 'core.autocrlf', 'false'])
    await writeFile(join(root, 'base.txt'), 'base\n', 'utf8')
    await git(root, ['add', 'base.txt'])
    await git(root, ['commit', '-qm', 'base'])

    const worktree = await isolation.prepareWorkspace(root, 'unit', 'worktree')
    ok(worktree.cwd !== root, '写入任务使用独立 worktree')
    ok(worktree.repoRoot === root, 'worktree 归属正确的 Git 根目录')
    ok(typeof worktree.baselineCommit === 'string' && /^[0-9a-f]{40}$/.test(worktree.baselineCommit), '工作区记录了基线提交', String(worktree.baselineCommit))

    await writeFile(join(worktree.cwd, 'base.txt'), 'changed\n', 'utf8')
    await writeFile(join(worktree.cwd, 'new.txt'), 'created\n', 'utf8')
    const diff = await isolation.collectDiff(worktree, archive, 'unit')
    ok(diff.summary.files === 2, '差异摘要包含修改和新增文件', JSON.stringify(diff.summary))
    ok(diff.summary.additions === 2 && diff.summary.deletions === 1, '差异行数可审阅')
    ok(!!diff.patchPath, '差异已归档为补丁')
    ok((await readText(join(root, 'base.txt'))) === 'base\n', '主工作树在审阅前未被修改')

    const merged = await isolation.applyPatch(root, diff.patchPath)
    ok(merged.ok, '干净主工作树可以应用补丁', merged.error ?? '')
    ok((await readText(join(root, 'base.txt'))) === 'changed\n', '合并后主工作树得到修改')
    ok((await readText(join(root, 'new.txt'))) === 'created\n', '合并后主工作树得到新增文件')
    const cleanedWorktree = await isolation.cleanupWorkspace(worktree)
    ok(cleanedWorktree.ok, '正常清理返回成功', JSON.stringify(cleanedWorktree.errors))

    const readOnly = await isolation.prepareWorkspace(root, 'readonly', 'controlled-cwd')
    ok(readOnly.cwd === root, '只读模式使用受控父 cwd')
    const readOnlyDiff = await isolation.collectDiff(readOnly, archive, 'readonly')
    ok(readOnlyDiff.summary.files === 0, '只读模式不生成写入差异')
    await isolation.cleanupWorkspace(readOnly)

    const commitRepo = await initRepo('commit-test')
    extraRoots.push(commitRepo)
    await writeFile(join(commitRepo, 'base.txt'), 'base\n', 'utf8')
    await git(commitRepo, ['add', 'base.txt'])
    await git(commitRepo, ['commit', '-qm', 'base'])

    const committed = await isolation.prepareWorkspace(commitRepo, 'commit', 'worktree')
    await writeFile(join(committed.cwd, 'base.txt'), 'committed\n', 'utf8')
    await git(committed.cwd, ['add', 'base.txt'])
    await git(committed.cwd, ['commit', '-qm', 'subagent commit'])
    await writeFile(join(committed.cwd, 'after.txt'), 'after\n', 'utf8')
    const committedDiff = await isolation.collectDiff(committed, archive, 'commit')
    ok(committedDiff.summary.files === 2, '子代理自行提交后改动仍计入补丁', JSON.stringify(committedDiff.summary))
    ok(committedDiff.summary.additions === 2 && committedDiff.summary.deletions === 1, '提交后的差异行数可审阅', JSON.stringify(committedDiff.summary))
    ok(!!committedDiff.patchPath, '提交后的差异已归档为补丁')
    const committedMerge = await isolation.applyPatch(commitRepo, committedDiff.patchPath)
    ok(committedMerge.ok, '子代理提交过的改动可以合并回主工作树', committedMerge.error ?? '')
    ok((await readText(join(commitRepo, 'base.txt'))) === 'committed\n', '合并后主工作树得到子代理提交的修改')
    ok((await readText(join(commitRepo, 'after.txt'))) === 'after\n', '合并后主工作树得到提交之后的新文件')
    await isolation.cleanupWorkspace(committed)

    const encodingRepo = await initRepo('encoding-test')
    extraRoots.push(encodingRepo)
    const gbkBase = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a])
    const gbkChanged = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a, 0xd3, 0xa2, 0x0a])
    await writeFile(join(encodingRepo, 'gbk.txt'), gbkBase)
    await git(encodingRepo, ['add', 'gbk.txt'])
    await git(encodingRepo, ['commit', '-qm', 'gbk base'])

    const encoded = await isolation.prepareWorkspace(encodingRepo, 'encoding', 'worktree')
    await writeFile(join(encoded.cwd, 'gbk.txt'), gbkChanged)
    const encodedDiff = await isolation.collectDiff(encoded, archive, 'encoding')
    ok(encodedDiff.summary.files === 1, '非 UTF-8 文本计入差异', JSON.stringify(encodedDiff.summary))
    ok(!!encodedDiff.patchPath, '非 UTF-8 差异已归档为补丁')
    const patchBytes = await readFile(encodedDiff.patchPath)
    ok(!patchBytes.includes(Buffer.from([0xef, 0xbf, 0xbd])), '补丁按原始字节写入，没有 U+FFFD 替换字符')
    ok(patchBytes.includes(Buffer.from([0xd3, 0xa2])), '补丁保留了非 UTF-8 原始字节', patchBytes.length.toString())
    const encodedMerge = await isolation.applyPatch(encodingRepo, encodedDiff.patchPath)
    ok(encodedMerge.ok, '非 UTF-8 补丁可以合并', encodedMerge.error ?? '')
    ok((await readFile(join(encodingRepo, 'gbk.txt'))).equals(gbkChanged), '合并后主工作树得到原始字节内容')
    await isolation.cleanupWorkspace(encoded)

    const missingWorktree = join(commitRepo, 'not-a-worktree')
    const failedCleanup = await isolation.cleanupWorkspace({
      isolation: 'worktree',
      rootCwd: commitRepo,
      cwd: missingWorktree,
      repoRoot: commitRepo,
      worktreePath: missingWorktree
    })
    ok(failedCleanup.ok === false, '清理失败不再静默', JSON.stringify(failedCleanup))
    ok(failedCleanup.errors.length > 0, '清理失败返回可见错误', JSON.stringify(failedCleanup.errors))
  } finally {
    await rm(root, { recursive: true, force: true })
    for (const dir of extraRoots) await rm(dir, { recursive: true, force: true })
  }
}
