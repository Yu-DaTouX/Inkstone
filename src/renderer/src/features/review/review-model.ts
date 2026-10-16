/**
 * v3 评审页的纯模型（WP-50 界面部分）。
 *
 * 这里没有 React、没有 IO：来源选择、归属键、迟到响应闸门、真实行锚校验、
 * 批注过期判定、评审意见解析与 Git 结果归类都是纯函数，能被
 * `scripts/test-v3-review-ui.mjs` 直接编译后跑。
 *
 * 数据来源仍是 `shared/review.ts` 的 `ReviewBridge` 契约（V1 已提供），
 * 本文件只做「渲染端要知道的派生」，不复制后端校验规则。
 */
import type {
  ReviewAnnotation,
  ReviewChangeSet,
  ReviewChangeSetQuery,
  ReviewChangeSource,
  ReviewFinding,
  ReviewGitErrorCode,
  ReviewGitOutcome
} from '../../../../shared/review'
import { parseReviewFindings } from '../../../../shared/review'
import { parsePatch } from '../diff/parse'

/* ── owner / 归属 ───────────────────────────────────────── */

/**
 * 评审页的归属绑定。
 *
 * 与右栏 `WorkspaceOwner` 同源但更窄：评审只关心「哪个目录 / 项目 / 会话」，
 * 不新建 PTY 或原生资源。`key` 变了（切换会话 / 运行实例）就必须丢弃所有
 * 在途的 changeSet / diff / annotations 结果。
 */
export interface ReviewOwner {
  key: string
  cwd: string
  projectId?: string
  sessionId?: string
  sessionPath?: string
  /** 当前会话已在 pi 侧激活；false 时仍可只读评审，只是不能写。 */
  active?: boolean
}

export function reviewOwnerKey(owner: ReviewOwner): string {
  return [owner.key, owner.cwd, owner.projectId ?? '', owner.sessionId ?? ''].join('|')
}

export function sameReviewOwner(a: ReviewOwner, b: ReviewOwner): boolean {
  return reviewOwnerKey(a) === reviewOwnerKey(b)
}

/* ── 来源 ───────────────────────────────────────────────── */

export interface ReviewSourceOption {
  source: ReviewChangeSource
  /** 该来源在当前环境下是否可用（缺 cwd 时一律不可用）。 */
  available: boolean
  /**
   * `sessionShare`：本会话来源与「未提交改动」在服务端同源，只是 scopeKey 不同；
   * 界面必须照实说明，不能宣称精确的「本会话修改归因」。
   * `worktreeNeedsPath`：worktree 来源需要用户给出目录。
   */
  note?: 'sessionShare' | 'worktreeNeedsPath'
}

/** 四种来源按方案 §10.2；能力对齐 `src/main/review/changes.ts` 的真实实现。 */
export function reviewSourceOptions(owner: Pick<ReviewOwner, 'cwd'>): ReviewSourceOption[] {
  const hasCwd = !!owner.cwd
  return [
    { source: 'session', available: hasCwd, note: 'sessionShare' },
    { source: 'branch', available: hasCwd },
    { source: 'worktree', available: hasCwd, note: 'worktreeNeedsPath' },
    { source: 'uncommitted', available: hasCwd }
  ]
}

export interface ReviewQueryExtras {
  base?: string
  branch?: string
  worktreePath?: string
}

/** 构造正式桥接的查询对象；`sessionId` 只在会话来源带上，作归属凭证。 */
export function reviewQueryForSource(
  source: ReviewChangeSource,
  owner: ReviewOwner,
  extras: ReviewQueryExtras = {}
): ReviewChangeSetQuery {
  return {
    source,
    cwd: owner.cwd,
    ...(source === 'session' && owner.sessionId ? { sessionId: owner.sessionId } : {}),
    ...(extras.base ? { base: extras.base } : {}),
    ...(extras.branch ? { branch: extras.branch } : {}),
    ...(extras.worktreePath ? { worktreePath: extras.worktreePath } : {})
  }
}

/**
 * 单文件 diff 的查询对象：与变更集查询同形，补上路径。
 *
 * `session` 来源的正文只认可信会话凭证（V4 的归属边界）：owner 没有 `sessionId` 时
 * 返回 null，调用方据此 fail-closed，不把「未提交 / 主仓」当成「本会话改动」的正文。
 */
export function reviewDiffQueryForChangeSet(
  changeSet: Pick<ReviewChangeSet, 'source' | 'cwd' | 'base' | 'branch'>,
  owner: ReviewOwner,
  path: string
): (ReviewChangeSetQuery & { path: string }) | null {
  if (changeSet.source === 'session' && !owner.sessionId) return null
  return {
    source: changeSet.source,
    cwd: changeSet.cwd,
    path,
    ...(changeSet.base ? { base: changeSet.base } : {}),
    ...(changeSet.branch ? { branch: changeSet.branch } : {}),
    ...(changeSet.source === 'session' && owner.sessionId ? { sessionId: owner.sessionId } : {})
  }
}

/* ── 迟到响应闸门 ───────────────────────────────────────── */

/**
 * 请求闸门：领号与对号分开（见 `components/review/useGitReview.ts` 的教训）。
 * 切换来源 / 会话时 `invalidate()` 一次，之后回来的旧号一律判为迟到。
 */
export class ReviewRequestGate {
  private seq = 0
  next(): number {
    this.seq += 1
    return this.seq
  }
  current(): number {
    return this.seq
  }
  invalidate(): void {
    this.seq += 1
  }
  isCurrent(token: number): boolean {
    return token === this.seq
  }
}

export interface GuardedResult<T> {
  /** true = 响应回来时闸门已翻页，调用方必须丢弃它（不改任何界面状态）。 */
  stale: boolean
  value?: T
  error?: string
}

/** 执行一次可被闸门作废的异步请求；`isCurrent` 在 await 之后才判定。 */
export async function guardedLoad<T>(isCurrent: () => boolean, work: () => Promise<T>): Promise<GuardedResult<T>> {
  try {
    const value = await work()
    return isCurrent() ? { stale: false, value } : { stale: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return isCurrent() ? { stale: false, error: message } : { stale: true }
  }
}

/* ── 杂项 / 派生 ─────────────────────────────────────────── */

/** 变更集是否可继续操作（非 Git 目录 / 读失败时 false）。 */
export function changeSetUsable(changeSet: ReviewChangeSet | null): boolean {
  return !!changeSet && changeSet.ok && !!changeSet.repoRoot
}

/** 把批注按文件路径分组；界面按文件显示数量与列表。 */
export function groupAnnotationsByPath(annotations: readonly ReviewAnnotation[]): Map<string, ReviewAnnotation[]> {
  const map = new Map<string, ReviewAnnotation[]>()
  for (const annotation of annotations) {
    const list = map.get(annotation.path)
    if (list) list.push(annotation)
    else map.set(annotation.path, [annotation])
  }
  for (const list of map.values()) list.sort((a, b) => a.lineStart - b.lineStart || a.lineEnd - b.lineEnd)
  return map
}

/** 批注锚在写它时的版本；与当前变更集版本不同说明代码已经变过。 */
export function annotationIsStale(annotation: ReviewAnnotation, changeSetRevision: string | undefined): boolean {
  if (!changeSetRevision) return false
  if (!annotation.anchorRevision) return false
  return annotation.anchorRevision !== changeSetRevision
}

export interface ReviewLineAnchors {
  newLines: number[]
  oldLines: number[]
  minNew: number
  maxNew: number
  minOld: number
  maxOld: number
  binary: boolean
}

/** 从真实补丁里取「有行号的行」。没有行号的补丁不给出假锚点。 */
export function reviewLineAnchors(patch: string): ReviewLineAnchors {
  const parsed = parsePatch(patch ?? '')
  const newSet = new Set<number>()
  const oldSet = new Set<number>()
  let binary = false
  for (const file of parsed.files) {
    if (file.binary) binary = true
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.newLine !== null) newSet.add(line.newLine)
        if (line.oldLine !== null) oldSet.add(line.oldLine)
      }
    }
  }
  const newLines = [...newSet].sort((a, b) => a - b)
  const oldLines = [...oldSet].sort((a, b) => a - b)
  return {
    newLines,
    oldLines,
    minNew: newLines[0] ?? 0,
    maxNew: newLines[newLines.length - 1] ?? 0,
    minOld: oldLines[0] ?? 0,
    maxOld: oldLines[oldLines.length - 1] ?? 0,
    binary
  }
}

export interface AnchorValidation {
  ok: boolean
  error?: string
}

/**
 * 校验行范围批注是否锚在真实改动上。
 *
 * `side='file'` 是整文件批注，不要求行号落在补丁里；`new` / `old` 要求起始与
 * 结束行都真实出现在补丁的对应侧 —— 这样旧文件 / 假行号不会被当成合法锚。
 */
export function validateReviewAnchor(
  anchors: ReviewLineAnchors,
  side: ReviewAnnotation['side'],
  lineStart: number,
  lineEnd: number
): AnchorValidation {
  if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd)) return { ok: false, error: 'invalidLine' }
  if (lineStart < 1 || lineEnd < lineStart) return { ok: false, error: 'invalidRange' }
  if (side === 'file') return { ok: true }
  const list = side === 'old' ? anchors.oldLines : anchors.newLines
  if (list.length === 0) return { ok: false, error: 'noTextLines' }
  if (!list.includes(lineStart) || !list.includes(lineEnd)) return { ok: false, error: 'notAnAnchor' }
  return { ok: true }
}

/* ── 评审意见 ───────────────────────────────────────────── */

export interface ParsedFindings {
  findings: ReviewFinding[]
  error?: string
}

/** 解析评审 Agent 的文本输出；解析不出时把原因交回，界面不猜。 */
export function parseFindingsText(text: string): ParsedFindings {
  return parseReviewFindings(text)
}

/** 文件条目里已合并的批注计数直接读后端值，不在这里重算。 */
export function fileAnnotationCount(changeSet: ReviewChangeSet, path: string): number {
  return changeSet.files.find((file) => file.path === path)?.annotations ?? 0
}

/* ── Git 写动作 ─────────────────────────────────────────── */

/** 提交信息建议：只取材变更集里真实存在的事实（分支 + 文件清单）。 */
export function suggestedCommitMessage(changeSet: ReviewChangeSet): string {
  if (!changeSet.ok || changeSet.files.length === 0) return ''
  const scope = changeSet.branch ? `${changeSet.branch}: ` : ''
  const names = changeSet.files.slice(0, 6).map((file) => file.path)
  const more = changeSet.files.length > names.length ? ` 等 ${changeSet.files.length} 个文件` : ''
  return `${scope}更新 ${names.join('、')}${more}`
}

export function suggestedPullRequestTitle(changeSet: ReviewChangeSet): string {
  if (changeSet.branch) return changeSet.branch
  const first = changeSet.files[0]?.path
  return first ? `评审：${first}` : ''
}

/** Git 写动作结果归类；界面按 code 给不同的降级文案。 */
export type ReviewGitOutcomeKind =
  | 'ok'
  | 'gh-missing'
  | 'gh-not-authenticated'
  | 'network'
  | 'timeout'
  | 'not-confirmed'
  | 'invalid'
  | 'failed'

export function classifyGitOutcome(outcome: ReviewGitOutcome): ReviewGitOutcomeKind {
  if (outcome.ok) return 'ok'
  const code: ReviewGitErrorCode | undefined = outcome.code
  switch (code) {
    case 'gh-missing':
      return 'gh-missing'
    case 'gh-not-authenticated':
      return 'gh-not-authenticated'
    case 'network':
      return 'network'
    case 'timeout':
      return 'timeout'
    case 'not-confirmed':
      return 'not-confirmed'
    case 'invalid-input':
    case 'not-a-repo':
    case 'no-remote':
      return 'invalid'
    default:
      return 'failed'
  }
}

/** `gh` 状态是否可直接建 PR；缺一个都给出引导，不自动安装或登录。 */
export function ghStatusDegrade(status: { ok: boolean; installed: boolean; authenticated: boolean } | null): 'ready' | 'missing' | 'unauthenticated' | 'unknown' {
  if (!status) return 'unknown'
  if (!status.installed) return 'missing'
  if (!status.authenticated) return 'unauthenticated'
  return status.ok ? 'ready' : 'unknown'
}
