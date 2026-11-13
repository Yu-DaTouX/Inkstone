import { pick } from '../shared/ui-lang'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, resolve } from 'node:path'
import type { GitActionExpected } from '../shared/git-actions'
import { digestOf } from '../shared/git-actions'
import type { GitRefOption, GitRepoState, GitStatusParse } from '../shared/git'
import { parseStatusV2 } from '../shared/git'
import { classifyGitRunError, readOnlyGitEnv, sanitizedGitEnv, timeoutWithin } from './git-run-policy'
import type { GitDeadline, GitErrorCode } from './git-run-policy'

export function killProcessTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  killPidTree(child.pid, () => child.kill())
}

export function killPidTree(pid: number | undefined, fallback: () => void): Promise<void> {
  if (process.platform === 'win32' && pid) {
    return new Promise((resolve) => {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8_000 }, (error) => {
        if (error) fallback()
        resolve()
      })
    })
  }
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM')
      return Promise.resolve()
    } catch {
    }
  }
  fallback()
  return Promise.resolve()
}

const MAX_BUFFER = 48 * 1024 * 1024
const DEFAULT_TIMEOUT = 20_000
const gitMissingMessage = () => pick('没有找到 git：请先安装 Git（Windows 为 Git for Windows，https://git-scm.com/download/win），装好后重启砚。', 'Git not found. Install Git (Git for Windows on Windows: https://git-scm.com/download/win), then restart Inkstone.')

function enoentMessage(cwd: string): string {
  return existsSync(cwd) ? gitMissingMessage() : pick(`项目目录不存在：${cwd}`, `Project folder not found: ${cwd}`)
}

export interface GitRunResult {
  ok: boolean
  stdout: string
  stderr: string
  error?: string
  timedOut?: boolean
  code?: GitErrorCode
}

export interface GitRunOptions {
  timeout?: number
  allowFailure?: boolean
  env?: Record<string, string>
  stdin?: string | Buffer
  deadline?: GitDeadline
}

function gitFailure(message: string, timedOut: boolean, code: GitErrorCode): Error {
  return Object.assign(new Error(message), { timedOut, code })
}

const GIT_BASE_ARGS = ['-c', 'core.quotepath=false', '-c', 'core.pager=cat', '-c', 'core.fsmonitor=false']

export function gitReadBytes(cwd: string, args: string[], timeout = DEFAULT_TIMEOUT): Promise<{ ok: true; stdout: Buffer } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const child = execFile('git', [...GIT_BASE_ARGS, ...args], { cwd, windowsHide: true, maxBuffer: MAX_BUFFER, encoding: 'buffer', env: sanitizedGitEnv(process.env, readOnlyGitEnv(args)) }, (error, stdout, stderr) => {
      clearTimeout(timer)
      if (error) resolve({ ok: false, error: stderr.toString('utf8').trim() || error.message })
      else resolve({ ok: true, stdout })
    })
    const timer = setTimeout(() => killProcessTree(child), timeout)
  })
}

export async function gitRun(cwd: string, args: string[], opts: GitRunOptions = {}): Promise<GitRunResult> {
  const full = [...GIT_BASE_ARGS, ...args]
  const env = sanitizedGitEnv(process.env, { ...readOnlyGitEnv(args), ...(opts.env ?? {}) })
  const timeout = timeoutWithin(opts.timeout ?? DEFAULT_TIMEOUT, opts.deadline)
  if (timeout <= 0) {
    const message = pick('git 查询总期限已到', 'Git query deadline reached')
    if (opts.allowFailure) return { ok: false, stdout: '', stderr: '', error: message, timedOut: true, code: 'DEADLINE_EXCEEDED' }
    throw gitFailure(message, true, 'DEADLINE_EXCEEDED')
  }
  const codeFor = (input: { enoent?: boolean; timedOut?: boolean; outputLimit?: boolean; stderr?: string }): GitErrorCode =>
    classifyGitRunError({
      ...input,
      cwdExists: input.enoent ? existsSync(cwd) : undefined,
      deadlineExpired: opts.deadline?.expired() ?? false
    })
  if (opts.stdin !== undefined) {
    let timedOut = false
    let enoent = false
    const res = await new Promise<GitRunResult>((resolve) => {
      const child = spawn('git', full, { cwd, windowsHide: true, env })
      const timer = setTimeout(() => {
        timedOut = true
        killProcessTree(child)
      }, timeout)
      child.on('exit', () => clearTimeout(timer))
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString('utf8')
      })
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString('utf8')
      })
      child.on('error', (e) => {
        clearTimeout(timer)
        enoent = (e as NodeJS.ErrnoException).code === 'ENOENT'
        resolve({
          ok: false,
          stdout,
          stderr: enoent ? enoentMessage(cwd) : stderr + e.message
        })
      })
      child.on('close', (code) => resolve({ ok: code === 0 && !timedOut, stdout, stderr, ...(timedOut ? { timedOut } : {}) }))
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(opts.stdin, 'utf8')
    })
    if (res.ok) return res
    const code = codeFor({ enoent, timedOut, stderr: res.stderr })
    if (opts.allowFailure) return { ...res, code, error: (res.stderr || res.stdout).trim() || (timedOut ? pick('git 命令超时', 'Git command timed out') : undefined) }
    throw gitFailure((res.stderr || res.stdout).trim() || pick('git 命令失败', 'Git command failed'), timedOut, code)
  }
  let timedOutByTimer = false
  try {
    const res = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = execFile('git', full, { cwd, windowsHide: true, maxBuffer: MAX_BUFFER, encoding: 'utf8', env }, (error, stdout, stderr) => {
        clearTimeout(timer)
        if (error) reject(Object.assign(error, { stdout, stderr }))
        else resolve({ stdout, stderr })
      })
      const timer = setTimeout(() => {
        timedOutByTimer = true
        killProcessTree(child)
      }, timeout)
    })
    return { ok: true, stdout: String(res.stdout ?? ''), stderr: String(res.stderr ?? '') }
  } catch (error) {
    const e = error as { stdout?: unknown; stderr?: unknown; message?: unknown; code?: unknown; killed?: boolean; signal?: string }
    const enoent = e.code === 'ENOENT'
    const outputLimit = e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    const stdout = String(e.stdout ?? '')
    const stderr = enoent ? enoentMessage(cwd) : String(e.stderr ?? '')
    const timedOut = timedOutByTimer || (e.killed === true && !!e.signal && !outputLimit)
    const message = (stderr || stdout || String(e.message ?? error)).trim() || pick('git 命令失败', 'Git command failed')
    const code = codeFor({ enoent, timedOut, outputLimit, stderr })
    if (opts.allowFailure) {
      return { ok: false, stdout, stderr, error: message, timedOut, code }
    }
    throw gitFailure(message, timedOut, code)
  }
}

export interface RepoIdentity {
  root: string
  gitDir: string
  commonDir: string
  repoId: string
  worktreeId: string
  name: string
}

const repoCache = new Map<string, { at: number; value: RepoIdentity | null; gitDirMtime: number }>()
const REPO_TTL = 30_000
const REPO_CACHE_LIMIT = 64

function cacheRepo(dir: string, value: RepoIdentity | null, gitDirMtime: number): void {
  repoCache.delete(dir)
  repoCache.set(dir, { at: Date.now(), value, gitDirMtime })
  while (repoCache.size > REPO_CACHE_LIMIT) {
    const oldest = repoCache.keys().next().value
    if (oldest === undefined) break
    repoCache.delete(oldest)
  }
}

function hashId(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 16)
}

export async function resolveRepo(cwd: string): Promise<RepoIdentity | null> {
  const dir = resolve(cwd)
  const cached = repoCache.get(dir)
  if (cached && Date.now() - cached.at < REPO_TTL) {
    if (cached.value) {
      const mtime = await stat(cached.value.gitDir).then(
        (s) => s.mtimeMs,
        () => -1
      )
      if (mtime === cached.gitDirMtime) return cached.value
    } else {
      return null
    }
  }

  const res = await gitRun(
    dir,
    ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
    { allowFailure: true, timeout: 8000 }
  )
  if (!res.ok) {
    cacheRepo(dir, null, -1)
    return null
  }
  const lines = res.stdout.trim().split(/\r?\n/)
  const rootRaw = lines[0]
  const gitDirRaw = lines[1]
  const commonRaw = lines[2]
  if (!rootRaw || !gitDirRaw) {
    cacheRepo(dir, null, -1)
    return null
  }
  const commonDir = resolve(dir, commonRaw && commonRaw !== '.git' ? commonRaw : gitDirRaw)
  const root = await realpath(rootRaw).catch(() => resolve(rootRaw))
  const gitDir = await realpath(gitDirRaw).catch(() => resolve(gitDirRaw))
  const value: RepoIdentity = {
    root,
    gitDir,
    commonDir,
    repoId: hashId(commonDir.toLowerCase()),
    worktreeId: hashId(gitDir.toLowerCase()),
    name: basename(root)
  }
  const mtime = await stat(gitDir).then(
    (s) => s.mtimeMs,
    () => -1
  )
  cacheRepo(dir, value, mtime)
  return value
}

export function clearRepoCache(): void {
  repoCache.clear()
}

const STATUS_ARGS = ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']
const STATUS_FALLBACK_ARGS = ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']

interface StatusSnapshot {
  status: GitStatusParse
  stdout: string
}

const TRUSTED_LFS_FILTERS = new Set(['git-lfs clean -- %f', 'git-lfs smudge -- %f', 'git-lfs filter-process'])

async function repoFilterGuard(root: string): Promise<Record<string, string>> {
  const res = await gitRun(root, ['config', '--show-scope', '--includes', '-z', '--get-regexp', '^filter\\.'], { allowFailure: true, timeout: 8000 })
  const parts = res.stdout.split('\0')
  const names = new Set<string>()
  for (let index = 0; index + 1 < parts.length; index += 2) {
    if (parts[index] !== 'local' && parts[index] !== 'worktree') continue
    const entry = parts[index + 1]
    const newline = entry.indexOf('\n')
    const key = newline < 0 ? entry : entry.slice(0, newline)
    const match = /^filter\.(.+)\.(?:clean|smudge|process)$/.exec(key)
    if (match && !TRUSTED_LFS_FILTERS.has(newline < 0 ? '' : entry.slice(newline + 1))) names.add(match[1])
  }
  const overrides = [...names].flatMap((name) => [
    [`filter.${name}.clean`, ''],
    [`filter.${name}.smudge`, ''],
    [`filter.${name}.process`, ''],
    [`filter.${name}.required`, 'false']
  ])
  if (!overrides.length) return {}
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(overrides.length) }
  overrides.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key
    env[`GIT_CONFIG_VALUE_${index}`] = value
  })
  return env
}

async function readStatusSnapshot(root: string): Promise<StatusSnapshot> {
  const env = await repoFilterGuard(root)
  const res = await gitRun(root, STATUS_ARGS, { allowFailure: true, env })
  if (res.ok || res.stdout) return { status: parseStatusV2(res.stdout), stdout: res.stdout }
  const fallback = await gitRun(root, STATUS_FALLBACK_ARGS, { allowFailure: true, env })
  if (!fallback.ok && !fallback.stdout) {
    throw new Error(res.error ?? fallback.error ?? pick('git status 失败', 'git status failed'))
  }
  return { status: parseStatusV2(fallback.stdout), stdout: fallback.stdout }
}

export async function readStatus(root: string): Promise<GitStatusParse> {
  return (await readStatusSnapshot(root)).status
}

export interface RefListing {
  refs: GitRefOption[]
  busyBranches: string[]
  currentBranch: string | null
}

export async function listRefs(root: string): Promise<RefListing> {
  const refs: GitRefOption[] = []
  const format = '%(refname)%09%(refname:short)%09%(committerdate:unix)'
  const [heads, remotes, tags, worktrees] = await Promise.all([
    gitRun(root, ['for-each-ref', '--sort=-committerdate', `--format=${format}`, 'refs/heads'], {
      allowFailure: true
    }),
    gitRun(root, ['for-each-ref', '--sort=-committerdate', `--format=${format}`, 'refs/remotes'], {
      allowFailure: true
    }),
    gitRun(root, ['for-each-ref', '--sort=-creatordate', `--format=${format}`, 'refs/tags'], {
      allowFailure: true
    }),
    gitRun(root, ['worktree', 'list', '--porcelain', '-z'], { allowFailure: true })
  ])

  const current = await gitRun(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true })
  const currentBranch = current.ok ? current.stdout.trim() || null : null
  const currentWorktree = await realpath(root).catch(() => resolve(root))

  const push = (out: string, kind: GitRefOption['kind']): void => {
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue
      const [name, short] = line.split('\t')
      if (!short || short.endsWith('/HEAD')) continue
      refs.push({ ref: short, label: name, kind, current: kind === 'local' && short === currentBranch })
    }
  }
  push(heads.stdout, 'local')
  push(remotes.stdout, 'remote')
  push(tags.stdout, 'tag')

  const busyBranches: string[] = []
  let wtPath = ''
  for (const nulChunk of worktrees.stdout.split('\0')) {
    for (const line of nulChunk.split('\n')) {
      if (line.startsWith('worktree ')) wtPath = line.slice('worktree '.length).trim()
      else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length).trim()
        const short = ref.replace(/^refs\/heads\//, '')
        if (short && resolve(wtPath) !== currentWorktree) busyBranches.push(short)
      }
    }
  }

  if (currentBranch && refs.some((r) => r.kind === 'head' && r.ref === currentBranch)) {
    return { refs, busyBranches, currentBranch }
  }
  if (currentBranch) {
    refs.unshift({ ref: currentBranch, label: `refs/heads/${currentBranch}`, kind: 'head', current: true })
  }
  return { refs, busyBranches, currentBranch }
}

export async function readRepoState(cwd: string, opts: { withRefs?: boolean } = {}): Promise<GitRepoState | null> {
  const repo = await resolveRepo(cwd)
  if (!repo) return null
  const status = await readStatus(repo.root)
  const refs = opts.withRefs === false ? null : await listRefs(repo.root)
  return repoStateFrom(repo, status, refs)
}

const snapshotsInFlight = new Map<string, Promise<{ repo: GitRepoState; expected: GitActionExpected }>>()

export function readRepoSnapshot(repo: RepoIdentity): Promise<{ repo: GitRepoState; expected: GitActionExpected }> {
  const running = snapshotsInFlight.get(repo.root)
  if (running) return running
  const task = (async () => {
    const [headRes, indexRes, snapshot] = await Promise.all([
      gitRun(repo.root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFailure: true, timeout: 8000 }),
      gitRun(repo.root, ['ls-files', '-s', '-z'], { allowFailure: true }),
      readStatusSnapshot(repo.root)
    ])
    return {
      repo: repoStateFrom(repo, snapshot.status, null),
      expected: {
        head: headRes.ok ? headRes.stdout.trim() || null : null,
        indexDigest: digestOf([indexRes.stdout]),
        statusDigest: digestOf([snapshot.stdout])
      }
    }
  })().finally(() => snapshotsInFlight.delete(repo.root))
  snapshotsInFlight.set(repo.root, task)
  return task
}

const statesInFlight = new Map<string, Promise<GitRepoState>>()

export function readRepoStatusState(repo: RepoIdentity): Promise<GitRepoState> {
  const full = snapshotsInFlight.get(repo.root)
  if (full) return full.then((snapshot) => snapshot.repo)
  const running = statesInFlight.get(repo.root)
  if (running) return running
  const task = readStatusSnapshot(repo.root)
    .then((snapshot) => repoStateFrom(repo, snapshot.status, null))
    .finally(() => statesInFlight.delete(repo.root))
  statesInFlight.set(repo.root, task)
  return task
}

function repoStateFrom(repo: RepoIdentity, status: GitStatusParse, refs: RefListing | null): GitRepoState {
  let stagedCount = 0
  let unstagedCount = 0
  let untrackedCount = 0
  for (const e of status.entries) {
    if (e.ignored) continue
    if (e.untracked) {
      untrackedCount++
      continue
    }
    if (e.unmerged || (e.x !== '.' && e.x !== ' ')) stagedCount++
    if (e.unmerged || (e.y !== '.' && e.y !== ' ')) unstagedCount++
  }

  return {
    root: repo.root,
    name: repo.name,
    repoId: repo.repoId,
    worktreeId: repo.worktreeId,
    branch: status.branch,
    detached: status.detached,
    unborn: status.unborn,
    head: status.head,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    busyBranches: refs?.busyBranches ?? [],
    changedCount: status.entries.filter((e) => !e.ignored).length,
    stagedCount,
    unstagedCount,
    untrackedCount,
    unpushedCount: status.upstream ? status.ahead : null,
    hasCommit: !status.unborn && !!status.head
  }
}

export async function readExpected(root: string): Promise<GitActionExpected> {
  const [headRes, indexRes, snapshot] = await Promise.all([
    gitRun(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFailure: true, timeout: 8000 }),
    gitRun(root, ['ls-files', '-s', '-z'], { allowFailure: true }),
    readStatusSnapshot(root)
  ])
  const head = headRes.ok ? headRes.stdout.trim() || null : null
  return {
    head,
    indexDigest: digestOf([indexRes.stdout]),
    statusDigest: digestOf([snapshot.stdout])
  }
}

export function refLooksSafe(ref: string): boolean {
  const s = ref.trim()
  if (!s) return false
  if (s.startsWith('-')) return false
  if (s.length > 250) return false
  return /^[\w./@^~{}+-]+$/.test(s)
}

export async function refExists(root: string, ref: string): Promise<boolean> {
  if (!refLooksSafe(ref)) return false
  const res = await gitRun(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    allowFailure: true,
    timeout: 8000
  })
  return res.ok && !!res.stdout.trim()
}

export function safeRepoPath(path: string): string | null {
  const cleaned = String(path ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
  if (!cleaned || cleaned.length > 4096) return null
  if (cleaned.startsWith('-')) return null
  if (/^[A-Za-z]:/.test(cleaned)) return null
  if (cleaned.split('/').includes('..')) return null
  return cleaned
}
