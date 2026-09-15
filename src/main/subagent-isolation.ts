/**
 * 子代理写入隔离与差异处理（L03）。
 *
 * 这个模块只处理文件系统 / Git 边界，不启动 pi，也不把差异正文推到
 * renderer。写入任务从当前 HEAD 创建独立 worktree，因此主工作树里已有的
 * 未提交修改不会被复制、覆盖或重置；完成后只把摘要和补丁路径交给审阅层。
 */
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const execFileAsync = promisify(execFile)
const GIT_MAX_BUFFER = 24 * 1024 * 1024

export type SubagentIsolation = 'worktree' | 'controlled-cwd'

export interface PreparedWorkspace {
  isolation: SubagentIsolation
  rootCwd: string
  cwd: string
  repoRoot?: string
  worktreePath?: string
  containerPath?: string
}

export interface SubagentDiffSummary {
  files: number
  additions: number
  deletions: number
  paths: string[]
  truncated: boolean
  /** 仅保存到用户数据目录；不把补丁正文放进 IPC 快照。 */
  patchPath?: string
}

export interface CollectedDiff {
  summary: SubagentDiffSummary
  patchPath?: string
}

interface GitOutput {
  stdout: string
  stderr: string
}

async function git(cwd: string, args: string[], timeout = 30_000): Promise<GitOutput> {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      windowsHide: true,
      timeout,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: 'utf8'
    })
    return {
      stdout: String((result as { stdout?: unknown }).stdout ?? ''),
      stderr: String((result as { stderr?: unknown }).stderr ?? '')
    }
  } catch (error) {
    const e = error as { stdout?: unknown; stderr?: unknown; message?: unknown }
    const detail = String(e.stderr ?? e.stdout ?? e.message ?? error).trim()
    throw new Error(detail || 'git 命令失败')
  }
}

/** 返回 cwd 所属的 Git 根目录；非 Git 项目返回 null。 */
export async function findGitRoot(cwd: string): Promise<string | null> {
  try {
    const result = await git(resolve(cwd), ['rev-parse', '--show-toplevel'], 10_000)
    const root = result.stdout.trim()
    return root ? resolve(root) : null
  } catch {
    return null
  }
}

/**
 * 创建一个以当前 HEAD 为基线的隔离工作区。
 *
 * 只读模式故意不创建 worktree：它仍然只拿到受控 cwd，并由上层限制为
 * 只读用途。写入模式在非 Git 项目中直接失败，避免退回到会污染主目录的
 *“临时复制但无法安全合并”伪隔离。
 */
export async function prepareWorkspace(
  rootCwd: string,
  id: string,
  isolation: SubagentIsolation
): Promise<PreparedWorkspace> {
  const root = resolve(rootCwd)
  if (isolation === 'controlled-cwd') {
    return { isolation, rootCwd: root, cwd: root }
  }

  const repoRoot = await findGitRoot(root)
  if (!repoRoot) {
    throw new Error('写入型子代理需要 Git 项目；请改用只读模式，或先初始化 Git')
  }

  /* 先创建容器，再让 git 创建 worktree 目录；避免目标目录已存在导致 Git 拒绝。 */
  const containerPath = await mkdtemp(join(tmpdir(), `yan-subagent-${id}-`))
  const worktreePath = join(containerPath, 'worktree')
  try {
    await git(repoRoot, ['worktree', 'add', '--detach', worktreePath, 'HEAD'], 60_000)
    return { isolation, rootCwd: root, cwd: worktreePath, repoRoot, worktreePath, containerPath }
  } catch (error) {
    await rm(containerPath, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

function parseNameStatus(text: string): string[] {
  const paths: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const status = line.slice(0, tab)
    const raw = line.slice(tab + 1)
    /* rename/copy 的最后一列是新路径；普通项只有一列。 */
    const parts = raw.split('\t')
    const path = parts[parts.length - 1]?.trim()
    if (path) paths.push(status.startsWith('R') || status.startsWith('C') ? path : path)
  }
  return paths
}

function parseNumstat(text: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const [a, d] = line.split('\t')
    const add = Number(a)
    const del = Number(d)
    if (Number.isFinite(add)) additions += add
    if (Number.isFinite(del)) deletions += del
  }
  return { additions, deletions }
}

/** 只根据 Git 输出生成摘要，供单元测试和 controller 共用。 */
export function summarizeGitDiff(nameStatus: string, numstat: string): SubagentDiffSummary {
  const paths = parseNameStatus(nameStatus)
  const counts = parseNumstat(numstat)
  const limit = 100
  return {
    files: paths.length,
    additions: counts.additions,
    deletions: counts.deletions,
    paths: paths.slice(0, limit),
    truncated: paths.length > limit
  }
}

/**
 * 将 worktree 的变更固化成审阅补丁。`git add` 只发生在隔离 worktree 的
 * 独立 index 中，不会改变主工作树或主 index。
 */
export async function collectDiff(workspace: PreparedWorkspace, archiveDir: string, id: string): Promise<CollectedDiff> {
  if (workspace.isolation !== 'worktree' || !workspace.repoRoot) {
    return { summary: { files: 0, additions: 0, deletions: 0, paths: [], truncated: false } }
  }

  await mkdir(archiveDir, { recursive: true })
  await git(workspace.cwd, ['add', '-A', '--', '.'])
  const [nameStatus, numstat, patch] = await Promise.all([
    git(workspace.cwd, ['diff', '--cached', '--name-status', '--no-renames']).then((r) => r.stdout),
    git(workspace.cwd, ['diff', '--cached', '--numstat']).then((r) => r.stdout),
    git(workspace.cwd, ['diff', '--cached', '--binary', '--no-ext-diff']).then((r) => r.stdout)
  ])

  const summary = summarizeGitDiff(nameStatus, numstat)
  if (!patch.trim()) return { summary }

  const patchPath = join(archiveDir, `${id}.patch`)
  await writeFile(patchPath, patch, 'utf8')
  return { summary: { ...summary, patchPath }, patchPath }
}

/**
 * 无副作用地检查补丁能否应用到主工作树，再执行真正应用。
 * 主工作树已有重叠修改时返回冲突，不写入半截结果。
 */
export async function applyPatch(rootCwd: string, patchPath: string): Promise<{ ok: boolean; error?: string }> {
  const root = await findGitRoot(rootCwd)
  if (!root) return { ok: false, error: '主工作目录不是 Git 项目，无法安全合并' }
  try {
    await git(root, ['apply', '--check', '--recount', '--whitespace=nowarn', patchPath], 60_000)
  } catch (error) {
    return { ok: false, error: `合并冲突或补丁已失效：${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    await git(root, ['apply', '--recount', '--whitespace=nowarn', patchPath], 60_000)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: `应用补丁失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 删除 worktree 和临时容器；主工作树不会被触碰。 */
export async function cleanupWorkspace(workspace: PreparedWorkspace): Promise<void> {
  if (workspace.worktreePath && workspace.repoRoot) {
    await git(workspace.repoRoot, ['worktree', 'remove', '--force', workspace.worktreePath], 30_000).catch(() => {})
  }
  if (workspace.containerPath) {
    await rm(workspace.containerPath, { recursive: true, force: true }).catch(() => {})
  }
}
