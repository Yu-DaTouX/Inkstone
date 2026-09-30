import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const exec = promisify(execFile)
export async function hubGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, env: env ?? process.env, windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' })
  return stdout
}

export async function createHubWorkspace(root: string, dir: string, baseline?: string): Promise<{ cwd: string; baseline: string }> {
  const base = baseline ?? (await hubGit(root, ['rev-parse', 'HEAD'])).trim()
  if (!/^[a-f0-9]{40}$/.test(base)) throw new Error('代码基线必须是完整 commit ID')
  await mkdir(join(dir, '..'), { recursive: true })
  await hubGit(root, ['worktree', 'add', '--detach', dir, base])
  return { cwd: dir, baseline: base }
}

/** 临时 index 收集已提交、未提交和未跟踪文件，不改变 agent 的 index 或工作区。 */
export async function freezeHubWorkspace(cwd: string, baseline: string, dir: string, report: string) {
  await mkdir(dir, { recursive: true })
  const index = join(dir, `index-${randomUUID()}`)
  const env = { ...process.env, GIT_INDEX_FILE: index }
  try {
    await hubGit(cwd, ['read-tree', 'HEAD'], env)
    await hubGit(cwd, ['add', '-A', '--', '.'], env)
    const tree = (await hubGit(cwd, ['write-tree'], env)).trim()
    const patch = await hubGit(cwd, ['diff', '--binary', '--full-index', baseline, tree, '--'], env)
    const patchPath = join(dir, 'changes.patch')
    const reportPath = join(dir, 'report.md')
    await writeFile(patchPath, patch, 'utf8')
    await writeFile(reportPath, report, 'utf8')
    return { patchPath, reportPath, tree, sha256: createHash('sha256').update(patch).digest('hex') }
  } finally { await unlink(index).catch(() => undefined) }
}

export async function applyHubArtifact(cwd: string, artifact: { patchPath: string; sha256: string; tree: string }): Promise<void> {
  const patch = await readFile(artifact.patchPath)
  if (createHash('sha256').update(patch).digest('hex') !== artifact.sha256) throw new Error('交付补丁版本已改变，拒绝审查')
  if (patch.length) await hubGit(cwd, ['apply', '--index', artifact.patchPath])
  const tree = (await hubGit(cwd, ['write-tree'])).trim()
  if (tree !== artifact.tree) throw new Error('审查工作区与交付版本不一致')
}
