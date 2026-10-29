import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { validateBranchName } from '../../shared/git-actions'
import {
  COLLAB_MAX_BRANCHES,
  COLLAB_MAX_HAVES,
  type CollabBranch,
  type CollabCommit,
  type CollabComparison,
  type CollabFailure,
  type CollabFileChange,
  type CollabMergeResult
} from '../../shared/collab'
import { gitRun, resolveRepo } from '../git-service'

const OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/
const BUNDLE_TIMEOUT_MS = 10 * 60_000
const MERGE_TIMEOUT_MS = 2 * 60_000

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && OID_RE.test(value)
}

export function checkBranchName(name: unknown): CollabFailure | null {
  if (typeof name !== 'string') return { code: 'branch-name-invalid', error: 'Branch name is not valid' }
  if (name !== name.trim()) return { code: 'branch-name-invalid', error: 'Branch name cannot start or end with whitespace' }
  return validateBranchName(name) ? { code: 'branch-name-invalid', error: 'Branch name is not valid' } : null
}

export function checkTrackingRef(ref: unknown): CollabFailure | null {
  if (typeof ref !== 'string' || !ref.startsWith('refs/remotes/')) {
    return { code: 'ref-not-peer-branch', error: 'Only a collaborator branch can be compared or merged' }
  }
  const rest = ref.slice('refs/remotes/'.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return { code: 'ref-invalid', error: 'Branch reference is not valid' }
  return checkBranchName(rest.slice(slash + 1)) ?? checkBranchName(rest.slice(0, slash))
}

export async function repoRootOf(cwd: string): Promise<string | null> {
  if (!cwd || !existsSync(cwd)) return null
  return (await resolveRepo(cwd))?.root ?? null
}

const PLAIN_MESSAGES = { LANGUAGE: 'C', LC_MESSAGES: 'C' }

async function git(root: string, args: string[], timeout?: number): Promise<{ ok: boolean; out: string; error: string }> {
  const res = await gitRun(root, args, { allowFailure: true, env: PLAIN_MESSAGES, ...(timeout ? { timeout } : {}) })
  return { ok: res.ok, out: res.stdout, error: (res.error ?? res.stderr ?? '').trim() }
}

export async function rootCommits(root: string): Promise<string[]> {
  const res = await git(root, ['rev-list', '--max-parents=0', '--all', '--max-count=20'])
  return res.ok ? res.out.split(/\s+/).filter(isOid) : []
}

export async function currentBranch(root: string): Promise<string | null> {
  const res = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  return res.ok ? res.out.trim() || null : null
}

export async function localBranches(root: string): Promise<CollabBranch[]> {
  const current = await currentBranch(root)
  const res = await git(root, [
    'for-each-ref',
    `--count=${COLLAB_MAX_BRANCHES}`,
    '--sort=-committerdate',
    '--format=%(refname:short)%00%(objectname)%00%(subject)%00%(authorname)%00%(committerdate:unix)',
    'refs/heads'
  ])
  if (!res.ok) return []
  return res.out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split('\0'))
    .filter((parts) => parts.length >= 5 && isOid(parts[1]) && !checkBranchName(parts[0]))
    .map(([name, oid, subject, author, at]) => ({
      name,
      oid,
      subject: subject.slice(0, 300),
      author: author.slice(0, 120),
      committedAt: Number(at) * 1000 || 0,
      current: name === current,
      sessions: []
    }))
}

export async function refTips(root: string): Promise<string[]> {
  const res = await git(root, ['for-each-ref', `--count=${COLLAB_MAX_HAVES}`, '--sort=-committerdate', '--format=%(objectname)', 'refs/heads', 'refs/remotes'])
  return res.ok ? [...new Set(res.out.split(/\s+/).filter(isOid))] : []
}

export async function knownCommits(root: string, oids: string[]): Promise<string[]> {
  const candidates = [...new Set(oids.filter(isOid))].slice(0, COLLAB_MAX_HAVES)
  if (!candidates.length) return []
  const res = await gitRun(root, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
    allowFailure: true,
    stdin: candidates.join('\n') + '\n'
  })
  return res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(' '))
    .filter((parts) => parts[1] === 'commit' && isOid(parts[0]))
    .map((parts) => parts[0])
}

export async function resolveCommit(root: string, ref: string): Promise<string | null> {
  const res = await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  const oid = res.out.trim()
  return res.ok && isOid(oid) ? oid : null
}

export type BundleOutcome =
  | { kind: 'bundle'; oid: string }
  | { kind: 'up-to-date'; oid: string }
  | ({ kind: 'error' } & CollabFailure)

export async function createBundle(root: string, branch: string, haves: string[], file: string): Promise<BundleOutcome> {
  const invalid = checkBranchName(branch)
  if (invalid) return { kind: 'error', ...invalid }
  const oid = await resolveCommit(root, `refs/heads/${branch}`)
  if (!oid) return { kind: 'error', code: 'local-branch-missing', error: 'This computer does not have that branch' }
  const known = await knownCommits(root, haves)
  if (known.includes(oid)) return { kind: 'up-to-date', oid }
  const res = await git(root, ['bundle', 'create', file, `refs/heads/${branch}`, ...known.map((have) => `^${have}`)], BUNDLE_TIMEOUT_MS)
  if (res.ok) return { kind: 'bundle', oid }
  if (/empty bundle/i.test(res.error)) return { kind: 'up-to-date', oid }
  return { kind: 'error', code: 'bundle-create-failed', error: res.error || 'git bundle failed' }
}

export async function fetchBundle(root: string, file: string, branch: string, trackingRef: string, expectedOid: string): Promise<{ ok: true } | ({ ok: false } & CollabFailure)> {
  const invalid = checkBranchName(branch) ?? checkTrackingRef(trackingRef)
  if (invalid) return { ok: false, ...invalid }
  if (!isOid(expectedOid)) return { ok: false, code: 'peer-oid-invalid', error: 'They returned an invalid commit id' }
  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) return { ok: false, code: 'bundle-missing', error: 'No code bundle was received' }
  const verify = await git(root, ['bundle', 'verify', '--quiet', file], BUNDLE_TIMEOUT_MS)
  if (!verify.ok) return { ok: false, code: 'bundle-invalid', error: 'The code bundle failed verification' }
  const packed = await bundleHead(root, file, branch)
  if (!packed) return { ok: false, code: 'bundle-branch-missing', error: 'The code bundle does not contain this branch' }
  if (packed !== expectedOid) return { ok: false, code: 'bundle-oid-mismatch', error: 'The commit in the code bundle does not match what they declared' }
  const fetched = await git(root, ['fetch', '--no-tags', '--no-write-fetch-head', file, `+refs/heads/${branch}:${trackingRef}`], BUNDLE_TIMEOUT_MS)
  if (!fetched.ok) return { ok: false, code: 'fetch-failed', error: fetched.error || 'git fetch failed' }
  const landed = await resolveCommit(root, trackingRef)
  if (landed !== expectedOid) return { ok: false, code: 'fetched-oid-mismatch', error: 'The fetched commit does not match what they declared' }
  return { ok: true }
}

export async function bundleHead(root: string, file: string, branch: string): Promise<string | null> {
  if (checkBranchName(branch)) return null
  const res = await git(root, ['bundle', 'list-heads', file, `refs/heads/${branch}`], BUNDLE_TIMEOUT_MS)
  if (!res.ok) return null
  const line = res.out.split(/\r?\n/).find((item) => item.trim().endsWith(` refs/heads/${branch}`))
  const oid = line?.trim().split(' ')[0]
  return isOid(oid) ? oid : null
}

export async function pointTrackingRef(root: string, trackingRef: string, oid: string): Promise<{ ok: true } | ({ ok: false } & CollabFailure)> {
  const invalid = checkTrackingRef(trackingRef)
  if (invalid) return { ok: false, ...invalid }
  if (!(await knownCommits(root, [oid])).length) return { ok: false, code: 'commit-unknown', error: 'This computer does not have that commit' }
  const res = await git(root, ['update-ref', trackingRef, oid])
  return res.ok ? { ok: true } : { ok: false, code: 'update-ref-failed', error: res.error || 'git update-ref failed' }
}

export async function aheadBehind(root: string, ref: string): Promise<{ incoming: number; outgoing: number } | null> {
  const res = await git(root, ['rev-list', '--left-right', '--count', `HEAD...${ref}`])
  if (!res.ok) return null
  const [outgoing, incoming] = res.out.trim().split(/\s+/).map(Number)
  return Number.isFinite(incoming) && Number.isFinite(outgoing) ? { incoming, outgoing } : null
}

function parseCommits(out: string): CollabCommit[] {
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split('\0'))
    .filter((parts) => parts.length >= 4 && isOid(parts[0]))
    .map(([oid, subject, author, at]) => ({ oid, subject: subject.slice(0, 300), author: author.slice(0, 120), committedAt: Number(at) * 1000 || 0 }))
}

export async function compareWith(root: string, ref: string): Promise<CollabComparison | CollabFailure> {
  const invalid = checkTrackingRef(ref)
  if (invalid) return invalid
  if (!(await resolveCommit(root, ref))) return { code: 'branch-not-fetched', error: 'This branch has not been pulled yet' }
  const counts = (await aheadBehind(root, ref)) ?? { incoming: 0, outgoing: 0 }
  const base = (await git(root, ['merge-base', 'HEAD', ref])).out.trim() || null
  const log = await git(root, ['log', '--max-count=50', '--format=%H%x00%s%x00%an%x00%ct', `HEAD..${ref}`])
  const files = await changedFiles(root, ref)
  return { ref, base: base && isOid(base) ? base : null, ...counts, commits: log.ok ? parseCommits(log.out) : [], files }
}

async function changedFiles(root: string, ref: string): Promise<CollabFileChange[]> {
  const status = await git(root, ['diff', '--name-status', '-z', '--no-renames', `HEAD...${ref}`])
  const numstat = await git(root, ['diff', '--numstat', '-z', '--no-renames', `HEAD...${ref}`])
  const counts = new Map<string, { additions: number | null; deletions: number | null }>()
  for (const entry of numstat.out.split('\0').filter(Boolean)) {
    const [add, del, ...rest] = entry.split('\t')
    const path = rest.join('\t')
    if (path) counts.set(path, { additions: add === '-' ? null : Number(add), deletions: del === '-' ? null : Number(del) })
  }
  const parts = status.out.split('\0').filter(Boolean)
  const files: CollabFileChange[] = []
  for (let i = 0; i + 1 < parts.length && files.length < 500; i += 2) {
    const path = parts[i + 1]
    files.push({ path, status: parts[i].slice(0, 1), ...(counts.get(path) ?? { additions: null, deletions: null }) })
  }
  return files
}

export async function fileDiffWith(root: string, ref: string, path: string): Promise<string | CollabFailure> {
  const invalid = checkTrackingRef(ref)
  if (invalid) return invalid
  if (!path || path.startsWith('-') || path.includes('\0')) return { code: 'path-invalid', error: 'File path is not valid' }
  const res = await git(root, ['diff', '--no-color', '--no-ext-diff', `HEAD...${ref}`, '--', path])
  if (!res.ok) return { code: 'diff-failed', error: res.error || 'git diff failed' }
  return res.out.length > 400_000 ? `${res.out.slice(0, 400_000)}\n…` : res.out
}

export async function mergeInProgress(root: string): Promise<boolean> {
  const res = await git(root, ['rev-parse', '--git-path', 'MERGE_HEAD'])
  if (!res.ok) return false
  return existsSync(resolve(root, res.out.trim()))
}

async function hasCommitIdentity(root: string): Promise<boolean> {
  const name = await git(root, ['config', '--get', 'user.name'])
  if (!name.ok || !name.out.trim()) return false
  const email = await git(root, ['config', '--get', 'user.email'])
  return email.ok && !!email.out.trim()
}

export async function mergeRef(root: string, ref: string, message: string): Promise<CollabMergeResult> {
  const invalid = checkTrackingRef(ref)
  if (invalid) return { ok: false, ...invalid }
  if (!(await currentBranch(root))) {
    return { ok: false, code: 'merge-detached-head', error: 'No branch is checked out, so there is nothing to merge into' }
  }
  if (await mergeInProgress(root)) {
    return { ok: false, code: 'merge-in-progress', error: 'The previous merge is unfinished' }
  }
  const dirty = await git(root, ['status', '--porcelain=v1', '--untracked-files=no'])
  if (!dirty.ok) return { ok: false, code: 'worktree-status-failed', error: 'Could not read the working tree status' }
  if (dirty.out.trim()) return { ok: false, code: 'worktree-dirty', error: 'Working tree has uncommitted changes; commit or stash them before merging' }
  if (!(await resolveCommit(root, ref))) return { ok: false, code: 'branch-not-fetched', error: 'This branch has not been pulled yet' }
  const fastForward = await git(root, ['merge', '--ff-only', '--no-edit', ref], MERGE_TIMEOUT_MS)
  if (fastForward.ok) {
    const already = /already up to date/i.test(fastForward.out)
    const fastHead = (await resolveCommit(root, 'HEAD')) ?? ''
    return { ok: true, merged: !already, head: fastHead, message: already ? 'Already up to date' : 'Fast-forwarded' }
  }
  if (await mergeInProgress(root)) await git(root, ['merge', '--abort'])
  if (!/not possible to fast-forward/i.test(fastForward.error)) {
    return { ok: false, code: 'merge-failed', error: fastForward.error || 'git merge failed' }
  }
  if (!(await hasCommitIdentity(root))) {
    return { ok: false, code: 'git-identity-missing', error: 'git user.name / user.email is not configured' }
  }
  const res = await git(root, ['merge', '--no-ff', '--no-edit', '-m', message, ref], MERGE_TIMEOUT_MS)
  const head = (await resolveCommit(root, 'HEAD')) ?? ''
  if (res.ok) {
    const already = /already up to date/i.test(res.out)
    return { ok: true, merged: !already, head, message: already ? 'Already up to date' : 'Merged' }
  }
  const conflicts = await git(root, ['diff', '--name-only', '--diff-filter=U', '-z'])
  const files = conflicts.out.split('\0').filter(Boolean)
  if (files.length) return { ok: false, code: 'merge-conflicts', error: 'The merge has conflicts', conflicts: files }
  if (await mergeInProgress(root)) await git(root, ['merge', '--abort'])
  return { ok: false, code: 'merge-failed', error: res.error || 'git merge failed' }
}

export async function abortMerge(root: string): Promise<{ ok: true } | ({ ok: false } & CollabFailure)> {
  if (!(await mergeInProgress(root))) return { ok: false, code: 'no-merge-in-progress', error: 'No merge is in progress' }
  const res = await git(root, ['merge', '--abort'])
  return res.ok ? { ok: true } : { ok: false, code: 'abort-merge-failed', error: res.error || 'git merge --abort failed' }
}

export function branchOfPath(worktrees: Map<string, string>, cwd: string): string | undefined {
  const target = normalizePath(cwd)
  let best: { length: number; branch: string } | null = null
  for (const [path, branch] of worktrees) {
    const inside = target === path || target.startsWith(`${path}${process.platform === 'win32' ? '\\' : '/'}`)
    if (inside && (!best || path.length > best.length)) best = { length: path.length, branch }
  }
  return best?.branch
}

export async function worktreeBranches(root: string): Promise<Map<string, string>> {
  const res = await git(root, ['worktree', 'list', '--porcelain'])
  const map = new Map<string, string>()
  let path = ''
  for (const line of res.out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim()
    else if (line.startsWith('branch refs/heads/') && path) map.set(normalizePath(path), line.slice('branch refs/heads/'.length).trim())
  }
  return map
}

export function normalizePath(path: string): string {
  const full = resolve(path).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? full.toLowerCase() : full
}

export function bundleTempPath(dir: string, label: string): string {
  return join(dir, `${label}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.bundle`)
}
