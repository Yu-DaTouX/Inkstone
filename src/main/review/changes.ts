/**
 * 评审变更集适配（§10.2 / WP-50）。
 *
 * ── 它做什么 ──
 * 把「本会话改动 / 某分支相对主分支 / 某个 worktree / 未提交改动」四类来源
 * 统一成 `ReviewChangeSet`。**不造状态机**：未提交与 worktree / 会话来源
 * 直接复用既有 `git-inspect.readChanges`（它已经是唯一一条只读读通道），
 * 只有「分支相对主分支」的范围 diff 是这里新加的一段（既有通道只读工作树）。
 *
 * ── 硬边界 ──
 *   · 所有 git 命令都是**固定参数数组**、`--` 分隔、只用读子命令
 *     （`rev-parse` / `merge-base` / `diff`），绝不 add / commit / checkout；
 *   · 每个来源先经 `authorize`（主进程注入 `resolveFileContext`）确认目录，
 *     仓库根再授权一次；范围外的条目直接丢弃，不借 Git 泄露祖先根；
 *   · 路径经过 `normalizeReviewPath`，命令里带 `--literal-pathspecs`
 *     + `GIT_LITERAL_PATHSPECS=1`，不做 glob / 魔法；
 *   · 拿不到 git 或不在仓库里时返回可读错误，不静默回空列表。
 */
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { readChanges as defaultReadChanges, readFileDiff as defaultReadFileDiff } from '../git-inspect'
import type { AuthorizeReadCwd } from '../git-inspect'
import { gitRun, resolveRepo } from '../git-service'
import { readSessionPatch, readSessionTree, type SessionSourceDeps } from './session-source'
import type { GitChangeEntry, GitChangesResult, GitDiffResult } from '../../shared/git'
import {
  reviewChangeSetId,
  reviewScopeKey,
  stableHash,
  type ReviewChangeSource,
  type ReviewChangeSet,
  type ReviewChangeSetQuery,
  type ReviewFileEntry,
  type ReviewFileStatus,
  type ReviewUnavailableReason
} from '../../shared/review'

/** 注入的 git 执行（测试注入假实现，生产用 gitRun）。 */
export interface ReviewGitExec {
  run(
    cwd: string,
    args: string[],
    opts?: { timeoutMs?: number; env?: Record<string, string> }
  ): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string; timedOut?: boolean }>
}

/** 生产用的只读执行：复用 git-service 的参数数组与只读环境。 */
export function createGitRunExec(): ReviewGitExec {
  return {
    async run(cwd, args, opts) {
      const res = await gitRun(cwd, args, {
        allowFailure: true,
        ...(opts?.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
        ...(opts?.env ? { env: opts.env } : {})
      })
      return {
        ok: res.ok,
        stdout: res.stdout,
        stderr: res.stderr,
        ...(res.error ? { error: res.error } : {}),
        ...(res.timedOut !== undefined ? { timedOut: res.timedOut } : {})
      }
    }
  }
}

/** 可信的会话归属验证结果（主进程接线时给出）。 */
export interface ReviewSessionOwnership {
  sessionId: string
  /** 与检查点同一个会话键口径 */
  sessionKey: string
  /** 该会话所属的规范目录 */
  cwd: string
  sessionPath?: string
}

/**
 * 会话归属验证注入口。
 *
 * 渲染端自报的 `sessionId` 不构成授权：主进程注册时注入这个函数，由它用正式
 * 会话注册表核对「这个会话确实属于这个目录」。**缺失即 fail-closed**，绝不
 * 把 `session` 来源静默当成未提交改动。
 */
export type VerifyReviewSession = (input: {
  sessionId: string
  cwd: string
}) => Promise<{ ok: true; ownership: ReviewSessionOwnership } | { ok: false; error: string }>

export interface ReviewChangesDeps {
  /** 工作树只读读通道；缺省复用 `git-inspect.readChanges` */
  readWorkingChanges?(cwd: string, authorize: AuthorizeReadCwd): Promise<GitChangesResult>
  /** 工作树单文件补丁；缺省复用 `git-inspect.readFileDiff` */
  readWorkingDiff?(cwd: string, path: string, authorize: AuthorizeReadCwd): Promise<GitDiffResult>
  /** 范围 diff 的执行；缺省 gitRun */
  exec?: ReviewGitExec
  /** 解析仓库根；缺省 git-service.resolveRepo（测试注入假实现） */
  resolveRepo?: (cwd: string) => Promise<{ root: string } | null>
  /** 会话归属验证；缺失时会话来源 fail-closed */
  verifySession?: VerifyReviewSession
  /** 会话基线读取；缺省走影子仓库只读实现（测试注入假基线） */
  session?: SessionSourceDeps
}

const READ_ENV: Record<string, string> = { GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' }
const READ_GLOBALS = ['--no-optional-locks', '--no-pager', '--literal-pathspecs'] as const
const DIFF_FLAGS = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'] as const
const RANGE_TIMEOUT_MS = 20_000
const MAX_DIFF_BYTES = 1_500_000

function normSlashes(value: string): string {
  return value.replace(/\\/g, '/')
}

function pathKey(value: string): string {
  const normalized = normSlashes(value).replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isWithin(root: string, candidate: string): boolean {
  const r = pathKey(root)
  const c = pathKey(candidate)
  return c === r || c.startsWith(r + '/')
}

interface InspectScope {
  root: string
  scopeAbs: string
  scopeRel: string
}

type ScopeResult = { status: 'ok'; scope: InspectScope } | { status: 'notrepo' } | { status: 'denied'; error: string }

/** 授权 + 解析仓库 + 定出可读范围（与 git-inspect 同一套口径）。 */
async function resolveScope(
  cwd: string,
  authorize: AuthorizeReadCwd,
  resolveRepoFn: (cwd: string) => Promise<{ root: string } | null>
): Promise<ScopeResult> {
  const auth = await authorize(String(cwd ?? ''))
  if (!auth.ok) return { status: 'denied', error: auth.error }
  const realCwd = await realpath(auth.cwd).catch(() => resolve(auth.cwd))
  const repo = await resolveRepoFn(realCwd)
  if (!repo) return { status: 'notrepo' }
  const root = await realpath(repo.root).catch(() => repo.root)
  const rootAuth = await authorize(root)
  const scopeAbs = rootAuth.ok ? root : realCwd
  if (!isWithin(root, scopeAbs)) return { status: 'denied', error: '授权范围不在仓库里' }
  const relRaw = normSlashes(relative(root, scopeAbs))
  const scopeRel = !relRaw || relRaw === '.' ? '.' : relRaw
  if (scopeRel.startsWith('..')) return { status: 'denied', error: '授权范围不在仓库里' }
  return { status: 'ok', scope: { root, scopeAbs, scopeRel } }
}

/** `GitChangeEntry` → 评审文件状态。 */
export function statusOf(entry: GitChangeEntry): ReviewFileStatus {
  if (entry.unmerged) return 'unmerged'
  if (entry.untracked) return 'untracked'
  if (entry.origPath) return 'renamed'
  if (entry.x === 'A' || entry.y === 'A') return 'added'
  if (entry.x === 'D' || entry.y === 'D') return 'deleted'
  return 'modified'
}

function mapEntry(entry: GitChangeEntry): ReviewFileEntry {
  return {
    path: entry.path,
    status: statusOf(entry),
    ...(entry.origPath ? { origPath: entry.origPath } : {}),
    staged: entry.staged,
    unstaged: entry.unstaged,
    untracked: entry.untracked,
    added: 0,
    removed: 0,
    binary: false,
    annotations: 0
  }
}

export interface ReviewBranchDiff {
  ok: boolean
  error?: string
  files: ReviewFileEntry[]
  base: string | null
  branch: string | null
  head: string | null
  revision: string
}

/**
 * 解析分支比较的基准：显式 base → main → master → upstream。
 *
 * 返回 `{ ref, oid }`：`ref` 只用于显示与归属键，真正进 diff 范围的是
 * `oid`（解析后的提交），避免 diff 与 revision 绑定在可变 ref 上。
 */
async function resolveBase(
  exec: ReviewGitExec,
  root: string,
  explicit: string | undefined
): Promise<{ ref: string; oid: string } | null> {
  const candidates = explicit ? [explicit] : ['main', 'master', '@{upstream}']
  for (const candidate of candidates) {
    const res = await exec.run(root, [...READ_GLOBALS, 'rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], {
      timeoutMs: RANGE_TIMEOUT_MS,
      env: READ_ENV
    })
    const oid = res.ok ? res.stdout.trim() : ''
    if (/^[0-9a-f]{40}$/.test(oid)) return { ref: candidate, oid }
    if (explicit) return null
  }
  return null
}

/** 解析一个 ref 为提交 OID；解析不出来返回 null。 */
async function resolveCommitOid(exec: ReviewGitExec, root: string, ref: string): Promise<string | null> {
  const res = await exec.run(root, [...READ_GLOBALS, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    timeoutMs: RANGE_TIMEOUT_MS,
    env: READ_ENV
  })
  const oid = res.ok ? res.stdout.trim() : ''
  return /^[0-9a-f]{40}$/.test(oid) ? oid : null
}

/** 合并 `git diff --name-status` 与 `--numstat`，产出文件条目。 */
function mergeRangeEntries(
  nameStatus: { status: string; path: string }[],
  numstat: Map<string, { added: number; removed: number; binary: boolean }>
): ReviewFileEntry[] {
  const files: ReviewFileEntry[] = []
  for (const item of nameStatus) {
    const stats = numstat.get(item.path)
    const status: ReviewFileStatus =
      item.status === 'A' ? 'added' : item.status === 'D' ? 'deleted' : item.status.startsWith('R') ? 'renamed' : 'modified'
    files.push({
      path: item.path,
      status,
      staged: false,
      unstaged: false,
      untracked: false,
      added: stats?.added ?? 0,
      removed: stats?.removed ?? 0,
      binary: stats?.binary ?? false,
      annotations: 0
    })
  }
  return files
}

/**
 * 读一个范围 diff 的变更集（`base...HEAD`，即从共同祖先到 HEAD）。
 *
 * 只用只读子命令；范围限定在授权 scope 内，范围外的路径直接丢弃。
 */
export async function readRangeChanges(
  cwd: string,
  opts: { base?: string; branch?: string },
  authorize: AuthorizeReadCwd,
  exec: ReviewGitExec = createGitRunExec(),
  resolveRepoFn: (cwd: string) => Promise<{ root: string } | null> = resolveRepo
): Promise<ReviewBranchDiff> {
  const scoped = await resolveScope(cwd, authorize, resolveRepoFn)
  if (scoped.status === 'denied') {
    return { ok: false, error: scoped.error, files: [], base: null, branch: null, head: null, revision: '' }
  }
  if (scoped.status === 'notrepo') {
    return { ok: false, error: '这个目录不在 Git 仓库里', files: [], base: null, branch: null, head: null, revision: '' }
  }
  const scope = scoped.scope
  const base = await resolveBase(exec, scope.root, opts.base)
  if (!base) {
    return {
      ok: false,
      error: opts.base ? `找不到比较基准：${opts.base}` : '找不到主分支（main / master）或上游',
      files: [],
      base: null,
      branch: null,
      head: null,
      revision: ''
    }
  }
  const baseOid = base.oid
  const headRef = opts.branch ?? 'HEAD'
  const headOid = await resolveCommitOid(exec, scope.root, headRef)
  if (!headOid) {
    return {
      ok: false,
      error: `找不到要比较的提交：${headRef}`,
      files: [],
      base: base.ref,
      branch: null,
      head: null,
      revision: ''
    }
  }
  const range = `${baseOid}...${headOid}`

  const [nameStatusRes, numstatRes, branchRes] = await Promise.all([
    exec.run(scope.root, [...READ_GLOBALS, ...DIFF_FLAGS, '--name-status', '-z', range, '--'], {
      timeoutMs: RANGE_TIMEOUT_MS,
      env: READ_ENV
    }),
    exec.run(scope.root, [...READ_GLOBALS, ...DIFF_FLAGS, '--numstat', '-z', range, '--'], {
      timeoutMs: RANGE_TIMEOUT_MS,
      env: READ_ENV
    }),
    exec.run(scope.root, [...READ_GLOBALS, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: RANGE_TIMEOUT_MS, env: READ_ENV })
  ])
  if (!nameStatusRes.ok && !nameStatusRes.stdout) {
    return {
      ok: false,
      error: nameStatusRes.error ?? '读取分支差异失败',
      files: [],
      base: base.ref,
      branch: null,
      head: headOid,
      revision: ''
    }
  }

  const nameStatus = parseNameStatusZ(nameStatusRes.stdout)
    .map((item) => {
      const abs = resolve(scope.root, item.path)
      if (!isWithin(scope.scopeAbs, abs)) return null
      const rel = normSlashes(relative(scope.scopeAbs, abs))
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
      return { status: item.status, path: rel }
    })
    .filter((item): item is { status: string; path: string } => item !== null)

  const numstat = parseNumstatZ(numstatRes.stdout)
  const files = mergeRangeEntries(nameStatus, numstat)
  files.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN', { numeric: true, sensitivity: 'base' }))
  const branch = opts.branch ?? (branchRes.ok ? branchRes.stdout.trim() : null)
  const statShape = files.map((f) => `${f.path}:${f.status}:${f.added}:${f.removed}:${f.binary ? 'b' : 't'}`).join('|')
  return {
    ok: true,
    files,
    base: base.ref,
    branch: branch === 'HEAD' ? null : branch,
    head: headOid,
    // revision 绑定解析后的 base / head OID：ref 移动（force push、重建分支）会让版本失效
    revision: `${baseOid}-${headOid}-${stableHash(statShape)}`
  }
}

/**
 * 解析 `--name-status -z`：`STATUS\0path\0`（`--no-renames` 下无旧路径段）。
 * 同时服务于范围 diff 与会话基线 diff。
 */
export function parseNameStatusZ(stdout: string): { status: string; path: string }[] {
  const out: { status: string; path: string }[] = []
  const segs = stdout.split('\0')
  for (let i = 0; i < segs.length; i++) {
    const status = segs[i]
    if (!status) continue
    const path = segs[i + 1] ?? ''
    if (!path) continue
    out.push({ status, path })
    i += 1
  }
  return out
}

/** 解析 `git diff --numstat -z`：`added\tremoved\tpath\0`（`--no-renames` 下每文件一段）。 */
export function parseNumstatZ(stdout: string): Map<string, { added: number; removed: number; binary: boolean }> {
  const out = new Map<string, { added: number; removed: number; binary: boolean }>()
  for (const seg of stdout.split('\0')) {
    if (!seg) continue
    const first = seg.indexOf('\t')
    if (first < 0) continue
    const second = seg.indexOf('\t', first + 1)
    if (second < 0) continue
    const addedRaw = seg.slice(0, first)
    const removedRaw = seg.slice(first + 1, second)
    const path = seg.slice(second + 1)
    if (!path) continue
    const binary = addedRaw === '-' || removedRaw === '-'
    out.set(path, {
      added: binary ? 0 : Number(addedRaw) || 0,
      removed: binary ? 0 : Number(removedRaw) || 0,
      binary
    })
  }
  return out
}

/** 从补丁里取增删行数与二进制标记；供 working 来源的 revision 与统计使用。 */
function patchStats(patch: string): { added: number; removed: number; binary: boolean } {
  let added = 0
  let removed = 0
  let binary = false
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue
    if (
      line.startsWith('diff --git ') ||
      line.startsWith('index ') ||
      line.startsWith('@@') ||
      line.startsWith('new file mode ') ||
      line.startsWith('deleted file mode ') ||
      line.startsWith('old mode ') ||
      line.startsWith('new mode ') ||
      line.startsWith('similarity index ') ||
      line.startsWith('rename ') ||
      line.startsWith('Binary files ') ||
      line.startsWith('GIT binary patch')
    ) {
      if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) binary = true
      continue
    }
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) removed += 1
  }
  return { added, removed, binary }
}

/** 内容 revision 的读取上限：文件数与总字节都有界，超限时标记 partial。 */
const MAX_REVISION_FILES = 400
const MAX_REVISION_BYTES = 4_000_000
const REVISION_CONCURRENCY = 6

interface WorkingRevisionResult {
  files: ReviewFileEntry[]
  revision: string
  partial: boolean
}

/**
 * 读 working 来源的**内容** revision。
 *
 * 逐个改动文件走既有安全读通道（默认 `git-inspect.readFileDiff`）拿真实补丁，
 * 把「路径 + 状态 + 补丁摘要」一起哈希；因此同一文件改内容（即使 +/− 行数不变、
 * HEAD 与文件名都不变）revision 也会变。同时用补丁回填 added / removed / binary，
 * 使清单与正文同源。
 *
 * 有界：最多读 `MAX_REVISION_FILES` 个文件、总字节 `MAX_REVISION_BYTES`，
 * 并发上限 `REVISION_CONCURRENCY`；超限时 `partial` 为 true，调用方标记
 * `revisionPartial`，不假装 revision 覆盖了全部内容。
 */
async function readWorkingContentRevision(
  cwd: string,
  files: ReviewFileEntry[],
  head: string | null,
  readDiff: (cwd: string, path: string, authorize: AuthorizeReadCwd) => Promise<GitDiffResult>,
  authorize: AuthorizeReadCwd
): Promise<WorkingRevisionResult> {
  const limited = files.slice(0, MAX_REVISION_FILES)
  const enriched: ReviewFileEntry[] = files.map((file) => file)
  const digests: (string | undefined)[] = new Array(limited.length)
  let bytes = 0
  let budgetHit = false
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= limited.length || budgetHit) return
      const file = limited[index]
      let digest = 'unread'
      try {
        const diff = await readDiff(cwd, file.path, authorize)
        if (diff.ok) {
          bytes += diff.bytes
          if (bytes > MAX_REVISION_BYTES) budgetHit = true
          const stats = patchStats(diff.patch)
          digest = `${diff.binary ? 'b' : 't'}:${stableHash(diff.patch)}`
          enriched[index] = { ...file, added: stats.added, removed: stats.removed, binary: diff.binary || stats.binary }
        } else {
          digest = `error:${diff.error ?? 'diff'}`
        }
      } catch (error) {
        digest = `error:${error instanceof Error ? error.message : String(error)}`
      }
      digests[index] = `${file.path}\u0000${file.status}\u0000${file.staged ? 1 : 0}${file.unstaged ? 1 : 0}\u0000${digest}`
    }
  }
  await Promise.all(Array.from({ length: Math.min(REVISION_CONCURRENCY, limited.length) }, worker))
  const partial = files.length > MAX_REVISION_FILES || budgetHit
  const material = [`head:${head ?? 'none'}`, ...digests.filter((item): item is string => typeof item === 'string')]
  return { files: enriched, revision: `${head ?? 'no-head'}-${stableHash(material.join('|'))}`, partial }
}

/** 检查点基线的 name-status / numstat → 评审文件条目（同一快照）。 */
function mapCheckpointEntries(
  nameStatus: { status: string; path: string }[],
  numstat: Map<string, { added: number; removed: number; binary: boolean }>
): ReviewFileEntry[] {
  const statusMap: Record<string, ReviewFileStatus> = { A: 'added', D: 'deleted', M: 'modified', T: 'modified', U: 'unmerged', R: 'renamed' }
  const files = nameStatus.map((item) => {
    const stats = numstat.get(item.path)
    return {
      path: item.path,
      status: statusMap[item.status[0] ?? 'M'] ?? 'modified',
      staged: false,
      unstaged: true,
      untracked: false,
      added: stats?.added ?? 0,
      removed: stats?.removed ?? 0,
      binary: stats?.binary ?? false,
      annotations: 0
    } satisfies ReviewFileEntry
  })
  files.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN', { numeric: true, sensitivity: 'base' }))
  return files
}

function failChangeSet(error: string, meta: Partial<ReviewChangeSet>): ReviewChangeSet {
  return {
    ok: false,
    id: '',
    scopeKey: '',
    source: 'uncommitted',
    cwd: '',
    repoRoot: null,
    scope: '.',
    branch: null,
    base: null,
    head: null,
    revision: '',
    files: [],
    truncated: false,
    generatedAt: Date.now(),
    error,
    ...meta
  }
}

/**
 * 读一类变更集。四种来源各自的读法：
 *   · `session`：用已验证 cwd/sessionKey 的**首个 turn 检查点**作基线，读影子
 *     仓库的基线差异；无基线或验证缺失时返回明确 `unavailable`，**不回退**到
 *     未提交改动或主仓 HEAD；
 *   · `branch`：`base...head` 范围 diff，两端都解析成提交 OID；
 *   · `worktree` / `uncommitted`：复用既有 `git-inspect.readChanges`，revision 由
 *     逐文件真实补丁的内容摘要生成。
 */
export async function readReviewChangeSet(
  query: ReviewChangeSetQuery,
  authorize: AuthorizeReadCwd,
  deps: ReviewChangesDeps = {}
): Promise<ReviewChangeSet> {
  const readWorkingChanges = deps.readWorkingChanges ?? defaultReadChanges
  const exec = deps.exec ?? createGitRunExec()
  const resolveRepoFn = deps.resolveRepo ?? resolveRepo
  const cwd = String(query.cwd ?? '')
  const source: ReviewChangeSource = query.source

  if (source === 'session') {
    return readSessionChangeSet(query, authorize, deps)
  }

  if (source === 'branch') {
    const scoped = await resolveScope(cwd, authorize, resolveRepoFn)
    if (scoped.status === 'denied') return failChangeSet(scoped.error, { source, cwd })
    if (scoped.status === 'notrepo') return failChangeSet('这个目录不在 Git 仓库里', { source, cwd })
    const range = await readRangeChanges(cwd, { ...(query.base ? { base: query.base } : {}), ...(query.branch ? { branch: query.branch } : {}) }, authorize, exec, resolveRepoFn)
    if (!range.ok) return failChangeSet(range.error ?? '读取分支差异失败', { source, cwd })
    const repoRoot = scoped.scope.root
    const worktreePath = query.worktreePath
    const idInput = {
      source,
      repoRoot,
      cwd,
      ...(query.sessionId ? { sessionId: query.sessionId } : {}),
      base: range.base,
      ...(worktreePath ? { worktreePath } : {})
    }
    return {
      ok: true,
      id: reviewChangeSetId(idInput),
      scopeKey: reviewScopeKey(idInput),
      source,
      cwd,
      repoRoot,
      scope: scoped.scope.scopeRel,
      branch: range.branch,
      base: range.base,
      head: range.head,
      revision: range.revision,
      revisionKind: 'ref',
      files: range.files,
      truncated: range.files.length >= 2_000,
      generatedAt: Date.now(),
      ...(query.sessionId ? { sessionId: query.sessionId } : {}),
      ...(worktreePath ? { worktreePath } : {})
    }
  }

  const targetCwd = source === 'worktree' && query.worktreePath ? query.worktreePath : cwd
  const changes = await readWorkingChanges(targetCwd, authorize)
  if (!changes.ok) {
    return failChangeSet(changes.error ?? '读取改动失败', {
      source,
      cwd: targetCwd,
      ...(changes.root ? { repoRoot: changes.root } : {}),
      scope: changes.scope
    })
  }
  if (!changes.root) {
    const idInput = { source, repoRoot: null, cwd: targetCwd, ...(query.sessionId ? { sessionId: query.sessionId } : {}) }
    return {
      ok: true,
      id: reviewChangeSetId(idInput),
      scopeKey: reviewScopeKey(idInput),
      source,
      cwd: targetCwd,
      repoRoot: null,
      scope: '.',
      branch: null,
      base: null,
      head: null,
      revision: 'notrepo',
      files: [],
      truncated: false,
      generatedAt: Date.now(),
      ...(query.sessionId ? { sessionId: query.sessionId } : {})
    }
  }
  const mapped = changes.files.map(mapEntry)
  const readWorkingDiff = deps.readWorkingDiff ?? defaultReadFileDiff
  const content = await readWorkingContentRevision(targetCwd, mapped, changes.head, readWorkingDiff, authorize)
  const idInput = {
    source,
    repoRoot: changes.root,
    cwd: targetCwd,
    ...(query.sessionId ? { sessionId: query.sessionId } : {}),
    ...(query.worktreePath ? { worktreePath: query.worktreePath } : {})
  }
  const repoRoot = changes.root
  const worktreePath = query.worktreePath
  return {
    ok: true,
    id: reviewChangeSetId(idInput),
    scopeKey: reviewScopeKey(idInput),
    source,
    cwd: targetCwd,
    repoRoot,
    scope: changes.scope,
    branch: changes.branch,
    base: null,
    head: changes.head,
    revision: content.revision,
    revisionKind: 'content',
    ...(content.partial ? { revisionPartial: true } : {}),
    files: content.files,
    truncated: changes.truncated,
    generatedAt: Date.now(),
    ...(query.sessionId ? { sessionId: query.sessionId } : {}),
    ...(worktreePath ? { worktreePath } : {})
  }
}

/** 从不可用的会话来源构造明确失败结果（不静默同源）。 */
function failSessionUnavailable(
  unavailable: ReviewUnavailableReason,
  error: string,
  meta: Partial<ReviewChangeSet> & { sessionId?: string }
): ReviewChangeSet {
  return failChangeSet(error, { source: 'session', unavailable, ...meta })
}

/**
 * 「本会话改动」来源：用已验证 cwd/sessionKey 的首个 turn 检查点作基线。
 *
 * 渲染端自报的 `sessionId` 只是查询键；安装时由主进程注入 `verifySession` 核对
 * 会话归属。验证缺失 / 失败 / 无基线一律返回 `unavailable`，界面据此提示改看
 * 「未提交改动」；绝不拿主仓 HEAD 或未提交改动冒充会话开始。
 */
async function readSessionChangeSet(
  query: ReviewChangeSetQuery,
  authorize: AuthorizeReadCwd,
  deps: ReviewChangesDeps
): Promise<ReviewChangeSet> {
  const cwd = String(query.cwd ?? '')
  const sessionId = String(query.sessionId ?? '').trim()
  const withSession = sessionId ? { sessionId } : {}
  if (!sessionId) {
    return failSessionUnavailable('session-verification-failed', '缺少会话标识，无法确认会话归属', { cwd })
  }
  const verify = deps.verifySession
  if (!verify) {
    return failSessionUnavailable('session-verifier-missing', '会话来源尚未接线：缺少可信的会话归属验证，请改看「未提交改动」', {
      cwd,
      ...withSession
    })
  }
  let ownership: ReviewSessionOwnership
  try {
    const verified = await verify({ sessionId, cwd })
    if (!verified.ok) {
      return failSessionUnavailable('session-verification-failed', verified.error, { cwd, ...withSession })
    }
    ownership = verified.ownership
  } catch (error) {
    return failSessionUnavailable('session-verification-failed', error instanceof Error ? error.message : String(error), {
      cwd,
      ...withSession
    })
  }
  const auth = await authorize(String(ownership.cwd ?? ''))
  if (!auth.ok) {
    return failSessionUnavailable('session-verification-failed', auth.error, { cwd, ...withSession })
  }
  const realCwd = await realpath(auth.cwd).catch(() => resolve(auth.cwd))
  const tree = await readSessionTree(realCwd, ownership.sessionKey, deps.session)
  if (!tree.ok || !tree.baseline) {
    return failSessionUnavailable('session-baseline-missing', tree.error ?? '这个会话没有可用的起始快照', {
      cwd: realCwd,
      ...withSession
    })
  }
  const files = mapCheckpointEntries(parseNameStatusZ(tree.nameStatus), parseNumstatZ(tree.numstat))
  const revision = `${tree.baseline.sha}-${stableHash([tree.baseline.sha, tree.nameStatus, tree.numstat, tree.patch].join('\u0000'))}`
  const repo = await (deps.resolveRepo ?? resolveRepo)(realCwd).catch(() => null)
  const repoRoot = repo ? await realpath(repo.root).catch(() => repo.root) : null
  const idInput = { source: 'session' as const, repoRoot, cwd: realCwd, ...withSession }
  return {
    ok: true,
    id: reviewChangeSetId(idInput),
    scopeKey: reviewScopeKey(idInput),
    source: 'session',
    cwd: realCwd,
    repoRoot,
    scope: '.',
    branch: null,
    base: null,
    head: null,
    revision,
    revisionKind: 'content',
    ...(tree.patchTruncated ? { revisionPartial: true } : {}),
    sessionBaseline: { checkpointId: tree.baseline.id, sha: tree.baseline.sha, at: tree.baseline.at },
    files,
    truncated: files.length >= 2_000,
    generatedAt: Date.now(),
    ...withSession
  }
}

/** 校验会话 / 基线路径：拒绝绝对、盘符、NUL、空段、`.`、`..` 与 `-` 前缀。 */
function safeReviewRelPath(input: unknown): string | null {
  const raw = String(input ?? '')
  if (!raw || raw.length > 4_096 || raw.includes('\0')) return null
  if (/^[A-Za-z]:/.test(raw)) return null
  const rel = raw.replace(/\\/g, '/')
  if (rel.startsWith('/') || rel.startsWith('-')) return null
  const parts = rel.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null
  return parts.join('/')
}

function failDiff(path: string, error: string): GitDiffResult {
  return {
    ok: false,
    path,
    patch: '',
    truncated: false,
    binary: false,
    staged: false,
    unstaged: false,
    untracked: false,
    bytes: 0,
    error
  }
}

/**
 * 读单个文件的真实补丁，与变更集同一来源 / 版本：
 *   · `session`：同会话基线快照（需要已验证的 `sessionId`；验证缺失即拒绝）；
 *   · `branch`：两端都解析成提交 OID 后读范围 diff；
 *   · `worktree` / `uncommitted`：既有工作树读通道。
 */
export async function readReviewFileDiff(
  cwd: string,
  path: string,
  source: ReviewChangeSource,
  opts: { base?: string; branch?: string; sessionId?: string },
  authorize: AuthorizeReadCwd,
  deps: ReviewChangesDeps = {}
): Promise<GitDiffResult> {
  if (source === 'session') {
    const sessionId = String(opts.sessionId ?? '').trim()
    if (!sessionId) return failDiff(path, '会话来源的差异需要已验证的会话标识')
    const verify = deps.verifySession
    if (!verify) return failDiff(path, '会话来源尚未接线：缺少可信的会话归属验证')
    let ownership: ReviewSessionOwnership
    try {
      const verified = await verify({ sessionId, cwd })
      if (!verified.ok) return failDiff(path, verified.error)
      ownership = verified.ownership
    } catch (error) {
      return failDiff(path, error instanceof Error ? error.message : String(error))
    }
    const auth = await authorize(String(ownership.cwd ?? ''))
    if (!auth.ok) return failDiff(path, auth.error)
    const realCwd = await realpath(auth.cwd).catch(() => resolve(auth.cwd))
    const rel = safeReviewRelPath(path)
    if (!rel) return failDiff(path, '路径不合法')
    const diff = await readSessionPatch(realCwd, ownership.sessionKey, rel, deps.session)
    if (!diff.ok) return failDiff(rel, diff.error ?? '会话基线差异不可用')
    return {
      ok: true,
      path: diff.path,
      patch: diff.patch,
      truncated: diff.truncated,
      binary: diff.binary,
      staged: false,
      unstaged: true,
      untracked: false,
      bytes: diff.bytes
    }
  }
  if (source !== 'branch') {
    const readWorkingDiff = deps.readWorkingDiff ?? defaultReadFileDiff
    return readWorkingDiff(cwd, path, authorize)
  }
  const exec = deps.exec ?? createGitRunExec()
  const resolveRepoFn = deps.resolveRepo ?? resolveRepo
  const scoped = await resolveScope(cwd, authorize, resolveRepoFn)
  if (scoped.status !== 'ok') return failDiff(path, scoped.status === 'denied' ? scoped.error : '这个目录不在 Git 仓库里')
  const rel = safeReviewRelPath(path)
  if (!rel) return failDiff(path, '路径不合法')
  const abs = resolve(scoped.scope.scopeAbs, rel)
  if (!isWithin(scoped.scope.scopeAbs, abs)) return failDiff(rel, '路径超出授权范围')
  const base = await resolveBase(exec, scoped.scope.root, opts.base)
  if (!base) return failDiff(rel, '找不到比较基准')
  const headOid = await resolveCommitOid(exec, scoped.scope.root, opts.branch ?? 'HEAD')
  if (!headOid) return failDiff(rel, '找不到要比较的提交')
  const res = await exec.run(scoped.scope.root, [...READ_GLOBALS, ...DIFF_FLAGS, `${base.oid}...${headOid}`, '--', rel], {
    timeoutMs: RANGE_TIMEOUT_MS,
    env: READ_ENV
  })
  if (!res.ok && !res.stdout) return failDiff(rel, res.error ?? '读取补丁失败')
  const patch = capUtf8(res.stdout, MAX_DIFF_BYTES)
  return {
    ok: true,
    path: rel,
    patch: patch.text,
    truncated: patch.truncated,
    binary: /(^|\n)(Binary files .+? differ|GIT binary patch)\s*(\n|$)/.test(patch.text),
    staged: false,
    unstaged: false,
    untracked: false,
    bytes: Buffer.byteLength(res.stdout, 'utf8')
  }
}

function capUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return { text, truncated: false }
  let cut = buf.subarray(0, maxBytes).lastIndexOf(0x0a)
  if (cut <= 0) cut = maxBytes
  return { text: buf.subarray(0, cut).toString('utf8'), truncated: true }
}

/** 合并批注计数到文件条目（service 用）。 */
export function applyAnnotationCounts(files: ReviewFileEntry[], counts: Map<string, number>): ReviewFileEntry[] {
  return files.map((file) => ({ ...file, annotations: counts.get(file.path) ?? 0 }))
}

