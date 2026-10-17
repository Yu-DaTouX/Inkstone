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

export function checkBranchName(name: unknown): string | null {
  if (typeof name !== 'string') return '分支名无效'
  if (name !== name.trim()) return '分支名不能以空白开头或结尾'
  return validateBranchName(name)
}

export function checkTrackingRef(ref: unknown): string | null {
  if (typeof ref !== 'string' || !ref.startsWith('refs/remotes/')) return '只能对比或合并协作者的分支'
  const rest = ref.slice('refs/remotes/'.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return '分支引用无效'
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

export type BundleOutcome = { kind: 'bundle'; oid: string } | { kind: 'up-to-date'; oid: string } | { kind: 'error'; error: string }

export async function createBundle(root: string, branch: string, haves: string[], file: string): Promise<BundleOutcome> {
  const invalid = checkBranchName(branch)
  if (invalid) return { kind: 'error', error: invalid }
  const oid = await resolveCommit(root, `refs/heads/${branch}`)
  if (!oid) return { kind: 'error', error: `找不到分支 ${branch}` }
  const known = await knownCommits(root, haves)
  if (known.includes(oid)) return { kind: 'up-to-date', oid }
  const res = await git(root, ['bundle', 'create', file, `refs/heads/${branch}`, ...known.map((have) => `^${have}`)], BUNDLE_TIMEOUT_MS)
  if (res.ok) return { kind: 'bundle', oid }
  if (/empty bundle/i.test(res.error)) return { kind: 'up-to-date', oid }
  return { kind: 'error', error: res.error || 'git bundle 失败' }
}

export async function fetchBundle(root: string, file: string, branch: string, trackingRef: string, expectedOid: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const invalid = checkBranchName(branch) ?? checkTrackingRef(trackingRef)
  if (invalid) return { ok: false, error: invalid }
  if (!isOid(expectedOid)) return { ok: false, error: '对方返回的提交号无效' }
  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) return { ok: false, error: '没有收到代码包' }
  const verify = await git(root, ['bundle', 'verify', '--quiet', file], BUNDLE_TIMEOUT_MS)
  if (!verify.ok) return { ok: false, error: `代码包校验失败：${verify.error}` }
  const packed = await bundleHead(root, file, branch)
  if (!packed) return { ok: false, error: '代码包里没有这个分支' }
  if (packed !== expectedOid) return { ok: false, error: '代码包里的提交与声明的不一致' }
  const fetched = await git(root, ['fetch', '--no-tags', '--no-write-fetch-head', file, `+refs/heads/${branch}:${trackingRef}`], BUNDLE_TIMEOUT_MS)
  if (!fetched.ok) return { ok: false, error: `取回代码失败：${fetched.error}` }
  const landed = await resolveCommit(root, trackingRef)
  if (landed !== expectedOid) return { ok: false, error: '取回的提交与对方声明的不一致' }
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

export async function pointTrackingRef(root: string, trackingRef: string, oid: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const invalid = checkTrackingRef(trackingRef)
  if (invalid) return { ok: false, error: invalid }
  if (!(await knownCommits(root, [oid])).length) return { ok: false, error: '本机没有这个提交' }
  const res = await git(root, ['update-ref', trackingRef, oid])
  return res.ok ? { ok: true } : { ok: false, error: res.error || '更新引用失败' }
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

export async function compareWith(root: string, ref: string): Promise<CollabComparison | { error: string }> {
  const invalid = checkTrackingRef(ref)
  if (invalid) return { error: invalid }
  if (!(await resolveCommit(root, ref))) return { error: '还没有拉取这个分支' }
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

export async function fileDiffWith(root: string, ref: string, path: string): Promise<string | { error: string }> {
  const invalid = checkTrackingRef(ref)
  if (invalid) return { error: invalid }
  if (!path || path.startsWith('-') || path.includes('\0')) return { error: '文件路径无效' }
  const res = await git(root, ['diff', '--no-color', '--no-ext-diff', `HEAD...${ref}`, '--', path])
  if (!res.ok) return { error: res.error || 'git diff 失败' }
  return res.out.length > 400_000 ? `${res.out.slice(0, 400_000)}\n…` : res.out
}

export async function mergeInProgress(root: string): Promise<boolean> {
  const res = await git(root, ['rev-parse', '--git-path', 'MERGE_HEAD'])
  if (!res.ok) return false
  return existsSync(resolve(root, res.out.trim()))
}

export async function mergeRef(root: string, ref: string, message: string): Promise<CollabMergeResult> {
  const invalid = checkTrackingRef(ref)
  if (invalid) return { ok: false, error: invalid }
  if (!(await currentBranch(root))) return { ok: false, error: '当前不在任何分支上（分离 HEAD），先切到要合并进去的分支' }
  if (await mergeInProgress(root)) return { ok: false, error: '上一次合并还没完成：先解决冲突或放弃合并' }
  const dirty = await git(root, ['status', '--porcelain=v1', '--untracked-files=no'])
  if (!dirty.ok) return { ok: false, error: dirty.error || '读取工作区状态失败' }
  if (dirty.out.trim()) return { ok: false, error: '工作区有未提交的改动，先提交或暂存后再合并' }
  if (!(await resolveCommit(root, ref))) return { ok: false, error: '还没有拉取这个分支' }
  const res = await git(root, ['merge', '--no-ff', '--no-edit', '-m', message, ref], MERGE_TIMEOUT_MS)
  const head = (await resolveCommit(root, 'HEAD')) ?? ''
  if (res.ok) {
    const already = /already up to date/i.test(res.out)
    return { ok: true, merged: !already, head, message: already ? '已经包含对方的全部提交' : '已合并' }
  }
  const conflicts = await git(root, ['diff', '--name-only', '--diff-filter=U', '-z'])
  const files = conflicts.out.split('\0').filter(Boolean)
  if (files.length) return { ok: false, error: '合并有冲突', conflicts: files }
  if (await mergeInProgress(root)) await git(root, ['merge', '--abort'])
  return { ok: false, error: res.error || 'git merge 失败' }
}

export async function abortMerge(root: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await mergeInProgress(root))) return { ok: false, error: '没有进行中的合并' }
  const res = await git(root, ['merge', '--abort'])
  return res.ok ? { ok: true } : { ok: false, error: res.error || 'git merge --abort 失败' }
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
