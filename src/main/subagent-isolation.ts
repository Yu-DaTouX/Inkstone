import { pick } from '../shared/ui-lang'
import { execFile } from 'node:child_process'
import { cp, lstat, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { sanitizedGitEnv } from './git-run-policy'

const execFileAsync = promisify(execFile)
const GIT_MAX_BUFFER = 24 * 1024 * 1024
const GIT_CONFIG_HARDENING = ['-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'diff.external=', '-c', 'color.ui=false']
let cachedGitEnv: NodeJS.ProcessEnv | undefined
let cachedHooksDir: string | undefined

export function gitHooksDisabledDir(): string {
  if (!cachedHooksDir) {
    const dir = mkdtempSync(join(tmpdir(), 'yan-subagent-no-hooks-'))
    cachedHooksDir = dir
    try {
      process.once('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch { } })
    } catch { }
  }
  return cachedHooksDir
}

function gitEnv(): NodeJS.ProcessEnv {
  if (!cachedGitEnv) cachedGitEnv = sanitizedGitEnv(process.env)
  return cachedGitEnv
}

function gitHardening(): string[] {
  return ['-c', `core.hooksPath=${gitHooksDisabledDir()}`, ...GIT_CONFIG_HARDENING]
}

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
  return detail ?? pick('git 命令失败', 'Git command failed')
}

async function runGitBytes(cwd: string, args: string[], timeout = 30_000): Promise<Buffer> {
  try {
    const result = await execFileAsync('git', [...gitHardening(), ...args], {
      cwd,
      windowsHide: true,
      timeout,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: 'buffer',
      env: gitEnv()
    })
    return Buffer.from((result as { stdout?: unknown }).stdout as Buffer)
  } catch (error) {
    throw new Error(gitErrorDetail(error))
  }
}

async function runGit(cwd: string, args: string[], timeout = 30_000, input?: string): Promise<GitOutput> {
  const argv = [...gitHardening(), ...args]
  try {
    const options = { cwd, windowsHide: true, timeout, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8' as const, env: gitEnv() }
    if (input !== undefined) {
      const result = await new Promise<GitOutput>((resolvePromise, rejectPromise) => {
        const child = execFile('git', argv, options, (error, stdout, stderr) => {
          if (error) {
            const detail = String(stderr || stdout || error.message || error).trim()
            rejectPromise(new Error(detail || pick('git 命令失败', 'Git command failed')))
            return
          }
          resolvePromise({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
        })
        child.stdin?.end(input)
      })
      return result
    }
    const result = await execFileAsync('git', argv, options)
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
    throw new Error(pick('写入型子 Agent需要 Git 项目；请改用只读模式，或先初始化 Git', 'A subagent that writes needs a Git project; use read-only mode or initialize Git first'))
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

export async function hasGitCommit(repoRoot: string): Promise<boolean> {
  try {
    await git(repoRoot, ['rev-parse', '--verify', 'HEAD'], 10_000)
    return true
  } catch {
    return false
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

export async function recoverWorktree(cwd: string, rootCwd: string): Promise<PreparedWorkspace | null> {
  const worktreePath = resolve(cwd)
  if (!existsSync(join(worktreePath, '.git'))) return null
  const repoRoot = await findGitRoot(rootCwd)
  if (!repoRoot) return null
  try {
    const baselineCommit = (await git(worktreePath, ['rev-parse', 'HEAD'], 10_000)).stdout.trim()
    if (!baselineCommit) return null
    const container = dirname(worktreePath)
    return {
      isolation: 'worktree', rootCwd: resolve(rootCwd), cwd: worktreePath, repoRoot, worktreePath, baselineCommit,
      ...(basename(worktreePath) === 'worktree' && basename(container).startsWith('yan-subagent-') ? { containerPath: container } : {})
    }
  } catch {
    return null
  }
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

const IGNORED_OUTPUT_COPY_LIMIT = 200 * 1024 * 1024

async function sizeWithin(path: string, budget: number): Promise<number> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) return 0
  if (!info.isDirectory()) return info.size
  let total = 0
  for (const entry of await readdir(path)) {
    total += await sizeWithin(join(path, entry), budget - total)
    if (total > budget) return total
  }
  return total
}

export type PreservedOutputs = { ok: true; path?: string; files: string[]; skipped?: string[] } | { ok: false; error: string }

export async function preserveIgnoredOutputs(workspace: PreparedWorkspace, archiveDir: string, id: string, limit = IGNORED_OUTPUT_COPY_LIMIT): Promise<PreservedOutputs> {
  if (workspace.isolation !== 'worktree' || !workspace.worktreePath) return { ok: true, files: [] }
  let outputs: string[]
  try {
    const listing = await git(workspace.cwd, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'])
    outputs = ignoredOutputsOf(listing.stdout)
  } catch (error) {
    return { ok: false, error: pick(`列不出被忽略的文件：${gitErrorDetail(error)}`, `Could not list ignored files: ${gitErrorDetail(error)}`) }
  }
  if (outputs.length === 0) return { ok: true, files: [] }
  try {
    const sized: Array<{ rel: string; size: number }> = []
    for (const rel of outputs) sized.push({ rel, size: await sizeWithin(join(workspace.cwd, rel), limit + 1) })
    sized.sort((a, b) => a.size - b.size)
    let total = 0
    const files: string[] = []
    const skipped: string[] = []
    for (const item of sized) {
      if (total + item.size > limit) {
        skipped.push(item.rel)
        continue
      }
      total += item.size
      files.push(item.rel)
    }
    if (!files.length) return { ok: true, files, skipped }
    const target = join(archiveDir, `${id}-outputs`)
    for (const rel of files) await cp(join(workspace.cwd, rel), join(target, rel), { recursive: true, force: true, verbatimSymlinks: true })
    return { ok: true, path: target, files, ...(skipped.length ? { skipped } : {}) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function applyPatch(rootCwd: string, patchPath: string): Promise<{ ok: boolean; error?: string }> {
  const root = await findGitRoot(rootCwd)
  if (!root) return { ok: false, error: pick('主工作目录不是 Git 项目，无法安全合并', 'The main working folder is not a Git project; cannot merge safely') }
  try {
    await git(root, ['apply', '--check', '--recount', '--whitespace=nowarn', patchPath], 60_000)
  } catch (error) {
    return { ok: false, error: pick(`合并冲突或补丁已失效：${error instanceof Error ? error.message : String(error)}`, `Merge conflict or stale patch: ${error instanceof Error ? error.message : String(error)}`) }
  }
  try {
    await git(root, ['apply', '--recount', '--whitespace=nowarn', patchPath], 60_000)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: pick(`应用补丁失败：${error instanceof Error ? error.message : String(error)}`, `Could not apply the patch: ${error instanceof Error ? error.message : String(error)}`) }
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
      if (registered) errors.push(pick(`移除 worktree 失败（${workspace.worktreePath}）：${error instanceof Error ? error.message : String(error)}`, `Could not remove the worktree (${workspace.worktreePath}): ${error instanceof Error ? error.message : String(error)}`))
    }
  }
  if (errors.length) return { ok: false, errors }
  if (workspace.containerPath) {
    await rm(workspace.containerPath, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch((error) => {
      console.warn(`[subagent] 临时目录暂时删不掉，留给系统清理（${workspace.containerPath}）：${error instanceof Error ? error.message : String(error)}`)
    })
  }
  return { ok: errors.length === 0, errors }
}
