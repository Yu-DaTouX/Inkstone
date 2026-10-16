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

export function reviewBridge(): ReviewBridge | null {
  if (typeof window === 'undefined') return null
  const review = (window as unknown as ReviewWindow).yan?.review
  if (!review || typeof review.changeSet !== 'function' || typeof review.commit !== 'function') return null
  return review
}

export function resolveReviewBridge(injected?: ReviewBridge | null): ReviewBridge | null {
  return injected ?? reviewBridge()
}

export interface ReviewDiffQueryInput {
  source: ReviewChangeSetQuery['source']
  cwd: string
  path: string
  base?: string
  branch?: string
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
