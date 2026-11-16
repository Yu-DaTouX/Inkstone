import { pick } from '../shared/ui-lang'
import { execFile } from 'node:child_process'
import { copyFile, lstat, mkdtemp, mkdir, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { existsSync, mkdtempSync, realpath as realpathFs, rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { sanitizedGitEnv } from './git-run-policy'
import { subagentWorktreeRoot } from './subagent-worktree-root'

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
  skippedLinks?: string[]
  skippedLinkCount?: number
}

export interface CollectedDiff {
  summary: SubagentDiffSummary
  patchPath?: string
  removedFiles?: number
  ignoredOutputs?: string[]
}

const REBUILDABLE_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'target', '.gradle', '.cache', '.venv', 'venv', '__pycache__', '.next', '.turbo', 'coverage', '.pytest_cache', '.pnpm-store', '.parcel-cache', '.mypy_cache', '.ruff_cache'])

const DEBUG_SANDBOX_DIRS = new Set(['pi-agent', 'yan', 'electron', 'downloads', 'android-sdk', 'project', 'projects', 'demo'])

export function isDisposableOutput(path: string): boolean {
  const parts = path.split('/')
  if (parts.some((part) => REBUILDABLE_DIRS.has(part))) return true
  if (parts[parts.length - 1].endsWith('.tsbuildinfo')) return true
  return parts[0] === 'debug' && parts[1] === 'runs' && parts.length >= 4 && DEBUG_SANDBOX_DIRS.has(parts[3])
}

export function ignoredOutputsOf(listing: string): string[] {
  return listing
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\/$/, ''))
    .filter((path) => path && !isDisposableOutput(path))
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

async function repoPrefix(cwd: string): Promise<string> {
  try {
    return (await git(cwd, ['rev-parse', '--show-prefix'], 10_000)).stdout.trim().replace(/\/+$/, '')
  } catch {
    return ''
  }
}

function worktreeCwd(worktreePath: string, prefix: string): string {
  if (!prefix || prefix.split('/').some((part) => !part || part === '.' || part === '..')) return worktreePath
  const cwd = join(worktreePath, ...prefix.split('/'))
  return existsSync(cwd) ? cwd : worktreePath
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

  const prefix = await repoPrefix(root)
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
    return { isolation, rootCwd: root, cwd: worktreeCwd(worktreePath, prefix), repoRoot, worktreePath, containerPath, baselineCommit }
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
  const worktreePath = subagentWorktreeRoot(cwd) ?? resolve(cwd)
  if (!existsSync(join(worktreePath, '.git'))) return null
  const repoRoot = await findGitRoot(rootCwd)
  if (!repoRoot) return null
  try {
    const baselineCommit = (await git(worktreePath, ['rev-parse', 'HEAD'], 10_000)).stdout.trim()
    if (!baselineCommit) return null
    const container = dirname(worktreePath)
    return {
      isolation: 'worktree', rootCwd: resolve(rootCwd), cwd: resolve(cwd), repoRoot, worktreePath, baselineCommit,
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

async function linkRootsOf(tree: string, paths: Iterable<string>, known = new Map<string, boolean>()): Promise<string[]> {
  const roots = new Set<string>()
  const linkAt = async (rel: string, leaf: boolean): Promise<boolean> => {
    const key = `${leaf ? 'f' : 'd'}:${rel}`
    const cached = known.get(key)
    if (cached !== undefined) return cached
    const info = await lstat(join(tree, ...rel.split('/'))).catch(() => null)
    const link = !!info && (info.isSymbolicLink() || (leaf && info.isFile() && info.nlink > 1))
    known.set(key, link)
    return link
  }
  for (const entry of paths) {
    if (!entry) continue
    const parts = entry.split('/')
    let prefix = ''
    for (let i = 0; i < parts.length; i += 1) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i]
      if (roots.has(prefix)) break
      if (await linkAt(prefix, i === parts.length - 1)) {
        roots.add(prefix)
        break
      }
    }
  }
  return [...roots].sort()
}

export async function changedLinkRoots(tree: string, base = 'HEAD'): Promise<string[]> {
  const listings = await Promise.all([
    runGitBytes(tree, ['ls-files', '--others', '--exclude-standard', '-z'], 120_000),
    runGitBytes(tree, ['diff', '--cached', '--name-only', '--no-renames', '-z', base], 120_000),
    runGitBytes(tree, ['diff', '--name-only', '--no-renames', '-z'], 120_000)
  ])
  return linkRootsOf(tree, listings.map((bytes) => bytes.toString('utf8')).join('\0').split('\0'))
}

async function stageWithoutLinks(tree: string, base: string): Promise<string[]> {
  const links = await changedLinkRoots(tree, base)
  if (links.length) {
    await runGit(tree, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], 120_000, ['.', ...links.map((path) => `:(exclude,literal)${path}`)].join('\0'))
    await runGit(tree, ['reset', '-q', base, '--pathspec-from-file=-', '--pathspec-file-nul'], 60_000, links.map((path) => `:(literal)${path}`).join('\0'))
  } else {
    await git(tree, ['add', '-A', '--', '.'])
  }
  const staged = (await runGitBytes(tree, ['diff', '--cached', '--name-only', '--no-renames', '-z', base], 120_000)).toString('utf8').split('\0').filter(Boolean)
  const linked = new Set(links)
  const underKnown = staged.filter((path) => links.some((link) => path === link || path.startsWith(`${link}/`)))
  const underFresh = await linkRootsOf(tree, staged)
  const leaked = [...underKnown, ...underFresh.filter((path) => !linked.has(path))]
  if (leaked.length) throw new Error(pick(`暂存后仍有位于链接下、与基线不同的路径，没有生成补丁：${leaked.slice(0, 5).join(', ')}`, `Staged paths that differ from the baseline still sit under links; no patch was made: ${leaked.slice(0, 5).join(', ')}`))
  return links
}

export async function collectDiff(workspace: PreparedWorkspace, archiveDir: string, id: string, options: { patchName?: string } = {}): Promise<CollectedDiff> {
  if (workspace.isolation !== 'worktree' || !workspace.repoRoot) {
    return { summary: { files: 0, additions: 0, deletions: 0, paths: [], truncated: false }, removedFiles: 0 }
  }

  await mkdir(archiveDir, { recursive: true })
  const base = workspace.baselineCommit ?? 'HEAD'
  const tree = workspace.worktreePath ?? workspace.cwd
  const links = await stageWithoutLinks(tree, base)
  const [nameStatus, numstat, patch] = await Promise.all([
    git(tree, ['diff', '--cached', '--name-status', '--no-renames', base]).then((r) => r.stdout),
    git(tree, ['diff', '--cached', '--numstat', base]).then((r) => r.stdout),
    runGitBytes(tree, ['diff', '--cached', '--binary', '--no-ext-diff', base])
  ])

  const removedFiles = nameStatus.split(/\r?\n/).filter((line) => line.startsWith('D\t')).length
  const summary = { ...summarizeGitDiff(nameStatus, numstat), ...(links.length ? { skippedLinks: links.slice(0, 20), skippedLinkCount: links.length } : {}) }
  const listing = await git(tree, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory']).then((r) => r.stdout, () => '')
  const ignoredOutputs = ignoredOutputsOf(listing)
  const ignored = ignoredOutputs.length ? { ignoredOutputs } : {}
  if (patch.length === 0) return { summary, removedFiles, ...ignored }

  const patchPath = join(archiveDir, `${options.patchName ?? id}.patch`)
  await writeFile(patchPath, patch)
  return { summary: { ...summary, patchPath }, patchPath, removedFiles, ...ignored }
}

export const IGNORED_OUTPUT_COPY_LIMIT = 200 * 1024 * 1024
const IGNORED_OUTPUT_FILE_LIMIT = 20_000
const NOTE_FILE = /\.(md|markdown|txt|rst|json|ya?ml|toml|csv|tsv|html?|xml|log|pdf|patch|diff)$/i
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i

export function ignoredOutputRank(path: string): number {
  if (NOTE_FILE.test(path)) return 0
  if (IMAGE_FILE.test(path)) return 1
  return 2
}

interface OutputFile { rel: string; top: string; size: number; rank: number; mtimeMs: number }
interface OutputScan { found: OutputFile[]; overflow: Set<string>; links: Set<string>; withheld: string[] }

const SECRET_OUTPUT = /^(?:\.env(?:[._-].*)?|.+\.env(?:\..*)?|\.envrc|.*\.(?:pem|key|pfx|p12|p8|ppk|kdbx|jks|keystore|tfvars)|.*\.tfstate(?:\.backup)?|id_(?:rsa|ed25519|ecdsa|dsa).*|auth\.json|\.netrc|_netrc|\.npmrc|\.pypirc|\.git-credentials|\.htpasswd|kubeconfig.*|.*\.kubeconfig|credentials.*|application_default_credentials\.json|client_secret.*\.json|secrets?(?:[._-].*)?\.(?:json|ya?ml|toml)|service[-_]?account.*\.json)$/i
const SECRET_OUTPUT_PATH = /(?:^|\/)(?:\.kube\/config|\.docker\/config\.json|\.aws\/config)$/i

export function withheldOutput(rel: string): boolean {
  return SECRET_OUTPUT.test(rel.split('/').pop() ?? rel) || SECRET_OUTPUT_PATH.test(rel)
}

async function linkOnPath(root: string, rel: string): Promise<boolean> {
  const parts = rel.split('/').filter(Boolean)
  for (let i = 1; i <= parts.length; i += 1) {
    const info = await lstat(join(root, ...parts.slice(0, i))).catch(() => null)
    if (!info) return false
    if (info.isSymbolicLink()) return true
  }
  return false
}

async function listOutputFiles(root: string, rel: string, top: string, scan: OutputScan): Promise<void> {
  if (scan.found.length >= IGNORED_OUTPUT_FILE_LIMIT) {
    scan.overflow.add(top)
    return
  }
  const info = await lstat(join(root, rel))
  if (info.isSymbolicLink()) {
    scan.links.add(rel)
    return
  }
  if (!info.isDirectory()) {
    if (info.nlink > 1) scan.links.add(rel)
    else if (withheldOutput(rel)) scan.withheld.push(rel)
    else scan.found.push({ rel, top, size: info.size, rank: ignoredOutputRank(rel), mtimeMs: info.mtimeMs })
    return
  }
  for (const entry of await readdir(join(root, rel))) {
    if (isDisposableOutput(`${rel}/${entry}`)) continue
    await listOutputFiles(root, `${rel}/${entry}`, top, scan)
  }
}

export function pickIgnoredOutputs<T extends { size: number; rank: number }>(files: readonly T[], limit: number): { kept: T[]; dropped: T[] } {
  const ordered = [...files].sort((a, b) => a.rank - b.rank || a.size - b.size)
  let total = 0
  const kept: T[] = []
  const dropped: T[] = []
  for (const file of ordered) {
    if (total + file.size > limit) {
      dropped.push(file)
      continue
    }
    total += file.size
    kept.push(file)
  }
  return { kept, dropped }
}

export function savedOutputsDir(archiveDir: string, id: string): string {
  return join(archiveDir, `${id}-outputs`)
}

export interface SkippedOutput { path: string; bytes: number; partial?: boolean }

export type PreservedOutputs = {
  ok: true
  path?: string
  files: string[]
  skipped?: string[]
  skippedSizes?: SkippedOutput[]
  moved?: string[]
  movedFiles?: number
  movedBytes?: number
  links?: string[]
  withheld?: string[]
} | { ok: false; error: string }

export interface PreserveOptions { moveOverflow?: boolean }

async function copiedAlready(to: string, file: OutputFile): Promise<boolean> {
  const info = await stat(to).catch(() => null)
  return !!info && info.isFile() && info.size === file.size && info.mtimeMs >= file.mtimeMs
}

export async function preserveIgnoredOutputs(workspace: PreparedWorkspace, archiveDir: string, id: string, limit = IGNORED_OUTPUT_COPY_LIMIT, options: PreserveOptions = {}): Promise<PreservedOutputs> {
  if (workspace.isolation !== 'worktree' || !workspace.worktreePath) return { ok: true, files: [] }
  const tree = workspace.worktreePath
  let outputs: string[]
  try {
    const listing = await git(tree, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'])
    outputs = ignoredOutputsOf(listing.stdout)
  } catch (error) {
    return { ok: false, error: pick(`列不出被忽略的文件：${gitErrorDetail(error)}`, `Could not list ignored files: ${gitErrorDetail(error)}`) }
  }
  if (outputs.length === 0) return { ok: true, files: [] }
  try {
    const scan: OutputScan = { found: [], overflow: new Set<string>(), links: new Set<string>(), withheld: [] }
    for (const rel of outputs) {
      if (await linkOnPath(tree, rel)) scan.links.add(rel)
      else await listOutputFiles(tree, rel, rel, scan)
    }
    const { kept, dropped } = pickIgnoredOutputs(scan.found, limit)
    const target = savedOutputsDir(archiveDir, id)
    const realTree = kept.length || (options.moveOverflow && dropped.length) ? await realpath(tree) : ''
    for (const file of kept) {
      const from = join(tree, file.rel)
      const real = await realpath(from)
      if (!pathInside(realTree, real)) {
        scan.links.add(file.rel)
        continue
      }
      const to = join(target, file.rel)
      if (await copiedAlready(to, file)) continue
      await mkdir(dirname(to), { recursive: true })
      await copyFile(from, to)
    }
    const movedFiles: OutputFile[] = []
    let unmoved = dropped
    if (options.moveOverflow && dropped.length) {
      unmoved = []
      let failed = false
      for (const file of dropped) {
        if (failed) {
          unmoved.push(file)
          continue
        }
        const from = join(tree, file.rel)
        const real = await realpath(from)
        if (!pathInside(realTree, real)) {
          scan.links.add(file.rel)
          continue
        }
        const to = join(target, file.rel)
        try {
          await mkdir(dirname(to), { recursive: true })
          await rename(from, to)
          movedFiles.push(file)
        } catch {
          failed = true
          unmoved.push(file)
        }
      }
    }
    const keptTops = new Set(kept.map((file) => file.top))
    const movedTops = new Set(movedFiles.map((file) => file.top))
    const droppedTops = new Set([...unmoved.map((file) => file.top), ...scan.overflow])
    const files = outputs.filter((rel) => keptTops.has(rel))
    const moved = outputs.filter((rel) => movedTops.has(rel))
    const skipped = outputs.filter((rel) => droppedTops.has(rel))
    const skippedSizes = skipped.map((rel): SkippedOutput => ({
      path: rel,
      bytes: unmoved.filter((file) => file.top === rel).reduce((sum, file) => sum + file.size, 0),
      ...(scan.overflow.has(rel) ? { partial: true } : {})
    }))
    const extra = {
      ...(skipped.length ? { skipped, skippedSizes } : {}),
      ...(moved.length ? { moved, movedFiles: movedFiles.length, movedBytes: movedFiles.reduce((sum, file) => sum + file.size, 0) } : {}),
      ...(scan.links.size ? { links: [...scan.links].sort() } : {}),
      ...(scan.withheld.length ? { withheld: scan.withheld.sort() } : {})
    }
    if (!files.length && !moved.length) return { ok: true, files, ...extra }
    return { ok: true, path: target, files, ...extra }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function outputBytesText(bytes: number): string {
  return bytes >= 1024 * 1024 * 1024 ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 / 1024))} MB`
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

function pathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

function samePath(a: string, b: string): boolean {
  const left = resolve(a)
  const right = resolve(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

export function removableContainer(workspace: Pick<PreparedWorkspace, 'containerPath' | 'worktreePath'>): boolean {
  const container = workspace.containerPath
  if (!container || !basename(container).startsWith('yan-subagent-')) return false
  return !workspace.worktreePath || samePath(join(container, 'worktree'), workspace.worktreePath)
}

function nativeRealpath(path: string): Promise<string | null> {
  return new Promise((done) => realpathFs.native(path, (error, resolved) => done(error ? null : resolved)))
}

export async function verifyKeptWorktree(id: string, workspace: Pick<PreparedWorkspace, 'cwd' | 'repoRoot' | 'worktreePath' | 'containerPath'>, tempRoot = tmpdir()): Promise<string | null> {
  const tree = workspace.worktreePath
  if (!tree || !workspace.repoRoot) return pick('记录里缺少工作树路径或仓库路径', 'The record has no worktree or repository path')
  const top = await lstat(tree).catch(() => null)
  if (!top?.isDirectory() || top.isSymbolicLink()) return pick(`工作树不存在或是链接：${tree}`, `The worktree is missing or is a link: ${tree}`)
  const realTree = await nativeRealpath(tree)
  if (!realTree) return pick(`工作树路径解析不了：${tree}`, `The worktree path could not be resolved: ${tree}`)
  const container = dirname(realTree)
  if (basename(realTree).toLowerCase() !== 'worktree' || !basename(container).toLowerCase().startsWith(`yan-subagent-${id}-`)) return pick(`工作树路径不是砚为 ${id} 建的临时目录：${tree}`, `The worktree path is not a temporary folder Inkstone created for ${id}: ${tree}`)
  const realTemp = await nativeRealpath(tempRoot)
  if (!realTemp || !samePath(dirname(container), realTemp)) return pick(`工作树不在系统临时目录下：${tree}`, `The worktree is not under the system temporary folder: ${tree}`)
  if (workspace.containerPath) {
    const realContainer = await nativeRealpath(workspace.containerPath)
    if (!realContainer || !samePath(realContainer, container)) return pick(`临时目录与工作树不对应：${workspace.containerPath}`, `The temporary folder does not match the worktree: ${workspace.containerPath}`)
  }
  const realCwd = await nativeRealpath(workspace.cwd)
  if (!realCwd || (!samePath(realCwd, realTree) && !pathInside(realTree, realCwd))) return pick(`工作目录不在工作树里：${workspace.cwd}`, `The working folder is not inside the worktree: ${workspace.cwd}`)
  const listed = await git(workspace.repoRoot, ['worktree', 'list', '--porcelain', '-z'], 10_000).then((result) => result.stdout, () => null)
  if (listed === null) return pick(`读不到仓库的工作树登记：${workspace.repoRoot}`, `Could not read the repository's worktree list: ${workspace.repoRoot}`)
  for (const line of listed.split('\0')) {
    if (!line.startsWith('worktree ')) continue
    const real = await nativeRealpath(line.slice(9))
    if (real && samePath(real, realTree)) return null
  }
  return pick(`工作树没有登记在 ${workspace.repoRoot} 的 git worktree list 里`, `The worktree is not registered in git worktree list of ${workspace.repoRoot}`)
}

export async function detachLinks(root: string): Promise<string[]> {
  const errors: string[] = []
  const top = await lstat(root).catch((error: NodeJS.ErrnoException) => error)
  if (top instanceof Error) return top.code === 'ENOENT' ? [] : [top.message]
  if (top.isSymbolicLink()) return [pick(`工作树路径本身是链接，拒绝清理：${root}`, `The worktree path itself is a link; refusing to clean it up: ${root}`)]
  if (!top.isDirectory()) return []
  const pending = [root]
  while (pending.length) {
    const dir = pending.pop()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(error instanceof Error ? error.message : String(error))
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        await unlink(path).catch((error: unknown) => {
          errors.push(pick(`删不掉工作树里的链接（${path}）：${error instanceof Error ? error.message : String(error)}`, `Could not remove a link in the worktree (${path}): ${error instanceof Error ? error.message : String(error)}`))
        })
      } else if (entry.isDirectory()) {
        pending.push(path)
      }
    }
  }
  return errors
}

export async function cleanupWorkspace(workspace: PreparedWorkspace): Promise<WorkspaceCleanupResult> {
  const errors: string[] = []
  if (workspace.worktreePath) {
    const top = await lstat(workspace.worktreePath).catch(() => null)
    if (top?.isSymbolicLink()) return { ok: false, errors: [pick(`工作树路径本身是链接，拒绝清理：${workspace.worktreePath}`, `The worktree path itself is a link; refusing to clean it up: ${workspace.worktreePath}`)] }
  }
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
  if (workspace.worktreePath && basename(workspace.worktreePath) === 'worktree' && basename(dirname(workspace.worktreePath)).startsWith('yan-subagent-')) {
    const linkErrors = await detachLinks(workspace.worktreePath)
    if (linkErrors.length) return { ok: false, errors: linkErrors }
  }
  if (workspace.containerPath && !removableContainer(workspace)) {
    console.warn(`[subagent] 不是砚创建的临时目录，不递归删除（${workspace.containerPath}）`)
  } else if (workspace.containerPath) {
    await rm(workspace.containerPath, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch((error) => {
      console.warn(`[subagent] 临时目录暂时删不掉，留给系统清理（${workspace.containerPath}）：${error instanceof Error ? error.message : String(error)}`)
    })
  }
  return { ok: errors.length === 0, errors }
}
