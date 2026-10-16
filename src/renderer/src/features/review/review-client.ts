/**
 * 评审桥接的渲染端访问层（WP-50 界面部分）。
 *
 * `window.yan.review` 由 preload 的 V1 补丁暴露（`shared/review.ts` 的
 * `ReviewBridge`）。这里只做两件事：
 *   · 拿桥并校验最低方法集，缺通道时返回 null（界面显示「未提供」而不伪造）；
 *   · 把页面动作逐一转发到正式方法，方法名与参数不在这里发明第二套。
 *
 * 所有网络 / Git / `gh` / 模型执行都在主进程侧；本文件不发起任何真实动作，
 * 页面只在用户明确点击后才调用它。
 */
import type {
  GitDiffResult
} from '../../../../shared/git'
import type {
  ReviewAnnotationInput,
  ReviewAnnotationPatch,
  ReviewAnnotationResult,
  ReviewAnnotationTask,
  ReviewBridge,
  ReviewChangeSet,
  ReviewChangeSetQuery,
  ReviewGhStatusView,
  ReviewGitOutcome,
  ReviewPullRequestInput,
  ReviewPushInput,
  ReviewRun
} from '../../../../shared/review'

interface ReviewWindow {
  yan?: { review?: ReviewBridge }
}

/** 取正式评审桥；缺失或方法不全时返回 null。 */
export function reviewBridge(): ReviewBridge | null {
  if (typeof window === 'undefined') return null
  const review = (window as unknown as ReviewWindow).yan?.review
  if (!review || typeof review.changeSet !== 'function' || typeof review.commit !== 'function') return null
  return review
}

/** 解析传入的桥或回退到 `window.yan.review`；两者都没有时返回 null。 */
export function resolveReviewBridge(injected?: ReviewBridge | null): ReviewBridge | null {
  return injected ?? reviewBridge()
}

export interface ReviewDiffQueryInput {
  source: ReviewChangeSetQuery['source']
  cwd: string
  path: string
  base?: string
  branch?: string
  /** session 来源的可信验证凭证；缺它时 fail-closed，不回退到未提交 / 主仓。 */
  sessionId?: string
}

export function fetchChangeSet(bridge: ReviewBridge, query: ReviewChangeSetQuery): Promise<ReviewChangeSet> {
  return bridge.changeSet(query)
}

export function fetchAnnotationList(
  bridge: ReviewBridge,
  changeSetId: string,
  scopeKey: string
): Promise<{ ok: boolean; error?: string; annotations: ReviewAnnotationResultList; revision: number }> {
  return bridge.annotations(changeSetId, scopeKey)
}

export type ReviewAnnotationResultList = Awaited<ReturnType<ReviewBridge['annotations']>>['annotations']

export function fetchDiff(bridge: ReviewBridge, query: ReviewDiffQueryInput): Promise<GitDiffResult> {
  /* session 正文必须带会话归属凭证；缺凭证时不发请求（fail-closed），不把别的来源当它。 */
  if (query.source === 'session' && !query.sessionId) {
    return Promise.resolve({
      ok: false,
      path: query.path,
      patch: '',
      truncated: false,
      binary: false,
      staged: false,
      unstaged: false,
      untracked: false,
      bytes: 0,
      error: '会话来源的差异查询缺少会话归属，已阻止读取'
    })
  }
  return bridge.diff(query)
}

export function addAnnotation(bridge: ReviewBridge, input: ReviewAnnotationInput): Promise<ReviewAnnotationResult> {
  return bridge.annotationAdd(input)
}

export function updateAnnotation(
  bridge: ReviewBridge,
  changeSetId: string,
  scopeKey: string,
  id: string,
  patch: ReviewAnnotationPatch
): Promise<ReviewAnnotationResult> {
  return bridge.annotationUpdate({ changeSetId, scopeKey, id, patch })
}

export function removeAnnotation(
  bridge: ReviewBridge,
  changeSetId: string,
  scopeKey: string,
  id: string
): Promise<ReviewAnnotationResult> {
  return bridge.annotationRemove({ changeSetId, scopeKey, id })
}

export function clearAnnotations(bridge: ReviewBridge, changeSetId: string, scopeKey: string): Promise<ReviewAnnotationResult> {
  return bridge.annotationClear({ changeSetId, scopeKey })
}

/** 「让 Agent 按批注修改」：只生成消息，不发送（发送走既有会话输入）。 */
export function requestAnnotationTask(bridge: ReviewBridge, query: ReviewChangeSetQuery): Promise<ReviewAnnotationTask> {
  return bridge.annotationTask(query)
}

export function startReviewRun(
  bridge: ReviewBridge,
  req: Parameters<ReviewBridge['start']>[0]
): Promise<ReviewRun> {
  return bridge.start(req)
}

export function fetchGhStatus(bridge: ReviewBridge, cwd: string): Promise<ReviewGhStatusView> {
  return bridge.ghStatus(cwd)
}

export function commitChanges(bridge: ReviewBridge, cwd: string, message: string): Promise<ReviewGitOutcome> {
  return bridge.commit({ cwd, message })
}

export function pushChanges(bridge: ReviewBridge, input: ReviewPushInput): Promise<ReviewGitOutcome> {
  return bridge.push(input)
}

export function createPullRequest(bridge: ReviewBridge, input: ReviewPullRequestInput): Promise<ReviewGitOutcome> {
  return bridge.pullRequest(input)
}
