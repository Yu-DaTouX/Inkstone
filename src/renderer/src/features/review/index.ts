/**
 * v3 评审页入口（WP-50 界面部分）。
 *
 * 独立可挂载模块，正式调用 `window.yan.review`（`ReviewBridge`）。
 * 导航入口由外壳（ShellV3 / Sidebar）统一接线，本目录不自行改路由。
 */
export { ReviewPage, ReviewFindingsPanel, ReviewAnnotationList, type ReviewPageProps, type ReviewFindingsLoader, type ReviewFindingsPanelProps, type ReviewAnnotationListProps } from './ReviewPage'
export {
  ReviewRequestGate,
  annotationIsStale,
  changeSetUsable,
  classifyGitOutcome,
  ghStatusDegrade,
  groupAnnotationsByPath,
  guardedLoad,
  parseFindingsText,
  reviewLineAnchors,
  reviewOwnerKey,
  reviewQueryForSource,
  reviewSourceOptions,
  sameReviewOwner,
  suggestedCommitMessage,
  suggestedPullRequestTitle,
  validateReviewAnchor,
  type ReviewOwner,
  type ReviewQueryExtras,
  type ReviewSourceOption
} from './review-model'
export { reviewBridge } from './review-client'
export { reviewText, type ReviewUiText } from './review-text'
