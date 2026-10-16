/**
 * 评审后端（§10.2 / WP-50）的唯一出口。
 *
 * 主进程只从这里 import：变更集读取、批注存储、评审 Agent 契约、Git 写适配
 * 分文件实现，避免一个好用的门面后面长出一堆互相 import 的细节。
 */
export { ReviewAnnotationStore, annotationFileName, annotationsDir } from './annotations'
export type { ReviewAnnotationStoreOptions } from './annotations'
export {
  applyAnnotationCounts,
  createGitRunExec,
  parseNameStatusZ,
  parseNumstatZ,
  readRangeChanges,
  readReviewChangeSet,
  readReviewFileDiff
} from './changes'
export type { ReviewBranchDiff, ReviewChangesDeps, ReviewGitExec } from './changes'
export { ReviewAgentCoordinator, buildAnnotationTask } from './agent'
export type { ReviewAgentCoordinatorDeps, ReviewAgentPort, ReviewAgentRunInput } from './agent'
export { ReviewGitAdapter, createNodeGhExec } from './git'
export type { ReviewConfirmPort, ReviewGhExec, ReviewGhStatus, ReviewGitAdapterOptions } from './git'
export { ReviewService } from './service'
export type { ReviewDiffQuery, ReviewServiceDeps } from './service'
export { createReviewRunProducer, reviewRunModel, reviewRunScopeId } from './review-runs'
export type { ReviewRunInput, ReviewRunOutcome, ReviewRunProducer, ReviewRunProducerOptions } from './review-runs'
