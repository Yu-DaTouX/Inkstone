import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const execFileAsync = promisify(execFile)
const GIT_MAX_BUFFER = 24 * 1024 * 1024

export type SubagentIsolation = 'worktree' | 'controlled-cwd' | 'shared-cwd'

export interface PreparedWorkspace {
  isolation: SubagentIsolation
  rootCwd: string
  cwd: string
  repoRoot?: string
  worktreePath?: string
  containerPath?: string
  baselineCommit?: string
}

export interface WorkspaceCleanupResult {
  ok: boolean
  errors: string[]
}

export interface SubagentDiffSummary {
  files: number
  additions: number
  deletions: number
  paths: string[]
  truncated: boolean
  patchPath?: string
}

export interface CollectedDiff {
  summary: SubagentDiffSummary
  patchPath?: string
  ignoredOutputs?: string[]
}

const REBUILDABLE_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'target', '.gradle', '.cache', '.venv', 'venv', '__pycache__', '.next', '.turbo', 'coverage', '.pytest_cache'])

export function ignoredOutputsOf(listing: string): string[] {
  return listing
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\/$/, ''))
    .filter((path) => path && !path.split('/').some((part) => REBUILDABLE_DIRS.has(part)))
}

interface GitOutput {
  stdout: string
  stderr: string
}

async function git(cwd: string, args: string[], timeout = 30_000): Promise<GitOutput> {
  return runGit(cwd, args, timeout)
}

function gitErrorDetail(error: unknown): string {
  const e = error as { stdout?: unknown; stderr?: unknown; message?: unknown }
  const parts = [e.stderr, e.stdout, e.message].map((part) => (Buffer.isBuffer(part) ? part.toString('utf8') : String(part ?? '')))
  const detail = parts.map((part) => part.trim()).find((part) => part.length > 0)
  return detail ?? 'git 命令失败'
}

async function runGitBytes(cwd: string, args: string[], timeout = 30_000): Promise<Buffer> {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      windowsHide: true,
      timeout,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: 'buffer'
    })
    return Buffer.from((result as { stdout?: unknown }).stdout as Buffer)
  } catch (error) {
    throw new Error(gitErrorDetail(error))
  }
}

async function runGit(cwd: string, args: string[], timeout = 30_000, input?: string): Promise<GitOutput> {
  try {
    const options = { cwd, windowsHide: true, timeout, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8' as const }
    if (input !== undefined) {
      const result = await new Promise<GitOutput>((resolvePromise, rejectPromise) => {
        const child = execFile('git', args, options, (error, stdout, stderr) => {
          if (error) {
            const detail = String(stderr || stdout || error.message || error).trim()
            rejectPromise(new Error(detail || 'git 命令失败'))
            return
          }
          resolvePromise({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
        })
        child.stdin?.end(input)
      })
      return result
    }
    const result = await execFileAsync('git', args, options)
    return {
      stdout: String((result as { stdout?: unknown }).stdout ?? ''),
      stderr: String((result as { stderr?: unknown }).stderr ?? '')
    }
  } catch (error) {
    throw new Error(gitErrorDetail(error))
  }
}

function isWindowsInvalidPath(path: string): boolean {
  return path.split('/').some((segment) => {
    const trimmed = segment.replace(/[ .]+$/g, '')
    if (!trimmed || /[<>:"\\|?*\u0000-\u001f]/.test(segment)) return true
    const stem = trimmed.split('.')[0]?.toUpperCase() ?? ''
    return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)
  })
}

async function checkoutWindowsSafeTree(worktreePath: string): Promise<void> {
  const tree = await git(worktreePath, ['ls-tree', '-r', '-z', 'HEAD'])
  const indexLines: string[] = []
  for (const record of tree.stdout.split('\0')) {
    const tab = record.indexOf('\t')
    if (tab < 0) continue
    const [mode, , sha] = record.slice(0, tab).split(/\s+/)
    const path = record.slice(tab + 1)
    if (!mode || !sha || !path || isWindowsInvalidPath(path)) continue
    indexLines.push(`${mode} ${sha}\t${path}\n`)
  }
  await runGit(worktreePath, ['update-index', '--index-info'], 30_000, indexLines.join(''))
  await git(worktreePath, ['checkout-index', '-a'])
}

export async function findGitRoot(cwd: string): Promise<string | null> {
  try {
    const result = await git(resolve(cwd), ['rev-parse', '--show-toplevel'], 10_000)
    const root = result.stdout.trim()
    return root ? resolve(root) : null
  } catch {
    return null
  }
}

export async function prepareWorkspace(
  rootCwd: string,
  id: string,
  isolation: SubagentIsolation
): Promise<PreparedWorkspace> {
  const root = resolve(rootCwd)
  if (isolation === 'controlled-cwd' || isolation === 'shared-cwd') {
    return { isolation, rootCwd: root, cwd: root }
  }

  const repoRoot = await findGitRoot(root)
  if (!repoRoot) {
    throw new Error('写入型子代理需要 Git 项目；请改用只读模式，或先初始化 Git')
  }

  const containerPath = await mkdtemp(join(tmpdir(), `yan-subagent-${id}-`))
  const worktreePath = join(containerPath, 'worktree')
  try {
    const baselineCommit = (await git(repoRoot, ['rev-parse', 'HEAD'], 10_000)).stdout.trim()
    try {
      await git(repoRoot, ['worktree', 'add', '--detach', worktreePath, baselineCommit], 60_000)
    } catch (error) {
      if (!/invalid path/i.test(String(error))) throw error
      await git(repoRoot, ['worktree', 'add', '--detach', '--no-checkout', worktreePath, baselineCommit], 60_000)
      await checkoutWindowsSafeTree(worktreePath)
    }
    return { isolation, rootCwd: root, cwd: worktreePath, repoRoot, worktreePath, containerPath, baselineCommit }
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
    const parts = raw.split('\t')
    const path = (status.startsWith('R') || status.startsWith('C') ? parts.at(-1) : parts[0])?.trim()
    if (path) paths.push(path)
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

export async function collectDiff(workspace: PreparedWorkspace, archiveDir: string, id: string): Promise<CollectedDiff> {
  if (workspace.isolation !== 'worktree' || !workspace.repoRoot) {
    return { summary: { files: 0, additions: 0, deletions: 0, paths: [], truncated: false } }
  }

  await mkdir(archiveDir, { recursive: true })
  const base = workspace.baselineCommit ?? 'HEAD'
  await git(workspace.cwd, ['add', '-A', '--', '.'])
  const [nameStatus, numstat, patch] = await Promise.all([
    git(workspace.cwd, ['diff', '--cached', '--name-status', '--no-renames', base]).then((r) => r.stdout),
    git(workspace.cwd, ['diff', '--cached', '--numstat', base]).then((r) => r.stdout),
    runGitBytes(workspace.cwd, ['diff', '--cached', '--binary', '--no-ext-diff', base])
  ])

  const summary = summarizeGitDiff(nameStatus, numstat)
  if (patch.length === 0) {
    const listing = await git(workspace.cwd, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory']).then((r) => r.stdout, () => '')
    const ignoredOutputs = ignoredOutputsOf(listing)
    return ignoredOutputs.length ? { summary, ignoredOutputs } : { summary }
  }

  const patchPath = join(archiveDir, `${id}.patch`)
  await writeFile(patchPath, patch)
  return { summary: { ...summary, patchPath }, patchPath }
}

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

export async function cleanupWorkspace(workspace: PreparedWorkspace): Promise<WorkspaceCleanupResult> {
  const errors: string[] = []
  if (workspace.worktreePath && workspace.repoRoot) {
    try {
      await git(workspace.repoRoot, ['worktree', 'remove', '--force', workspace.worktreePath], 30_000)
    } catch (error) {
      const registered = await git(workspace.repoRoot, ['worktree', 'list', '--porcelain', '-z'], 10_000)
        .then(result => result.stdout.split('\0').some(line => {
          if (!line.startsWith('worktree ')) return false
          const path = resolve(line.slice(9))
          const target = resolve(workspace.worktreePath!)
          return process.platform === 'win32' ? path.toLowerCase() === target.toLowerCase() : path === target
        }))
        .catch(() => true)
      if (registered) errors.push(`移除 worktree 失败（${workspace.worktreePath}）：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (errors.length) return { ok: false, errors }
  if (workspace.containerPath) {
    try {
      await rm(workspace.containerPath, { recursive: true, force: true })
    } catch (error) {
      errors.push(`删除临时目录失败（${workspace.containerPath}）：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { ok: errors.length === 0, errors }
}
