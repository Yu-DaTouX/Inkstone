import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const execFileAsync = promisify(execFile)

async function git(cwd, args) {
  await execFileAsync('git', args, { cwd, windowsHide: true, encoding: 'utf8' })
}

export async function runSubagentIsolationTests(ok, isolation) {
  const root = await mkdtemp(join(tmpdir(), 'yan-subagent-test-'))
  const archive = join(root, 'archives')
  try {
    await git(root, ['init', '-q'])
    await git(root, ['config', 'user.email', 'yan-tests@example.invalid'])
    await git(root, ['config', 'user.name', 'Yan tests'])
    await writeFile(join(root, 'base.txt'), 'base\n', 'utf8')
    await git(root, ['add', 'base.txt'])
    await git(root, ['commit', '-qm', 'base'])

    const worktree = await isolation.prepareWorkspace(root, 'unit', 'worktree')
    ok(worktree.cwd !== root, '写入任务使用独立 worktree')
    ok(worktree.repoRoot === root, 'worktree 归属正确的 Git 根目录')

    await writeFile(join(worktree.cwd, 'base.txt'), 'changed\n', 'utf8')
    await writeFile(join(worktree.cwd, 'new.txt'), 'created\n', 'utf8')
    const diff = await isolation.collectDiff(worktree, archive, 'unit')
    ok(diff.summary.files === 2, '差异摘要包含修改和新增文件', JSON.stringify(diff.summary))
    ok(diff.summary.additions === 2 && diff.summary.deletions === 1, '差异行数可审阅')
    ok(!!diff.patchPath, '差异已归档为补丁')
    const readText = async (path) => (await readFile(path, 'utf8')).replace(/\r\n/g, '\n')
    ok((await readText(join(root, 'base.txt'))) === 'base\n', '主工作树在审阅前未被修改')

    const merged = await isolation.applyPatch(root, diff.patchPath)
    ok(merged.ok, '干净主工作树可以应用补丁', merged.error ?? '')
    ok((await readText(join(root, 'base.txt'))) === 'changed\n', '合并后主工作树得到修改')
    ok((await readText(join(root, 'new.txt'))) === 'created\n', '合并后主工作树得到新增文件')
    await isolation.cleanupWorkspace(worktree)

    const readOnly = await isolation.prepareWorkspace(root, 'readonly', 'controlled-cwd')
    ok(readOnly.cwd === root, '只读模式使用受控父 cwd')
    const readOnlyDiff = await isolation.collectDiff(readOnly, archive, 'readonly')
    ok(readOnlyDiff.summary.files === 0, '只读模式不生成写入差异')
    await isolation.cleanupWorkspace(readOnly)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
