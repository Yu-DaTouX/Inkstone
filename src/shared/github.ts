export type GhPrListState = 'open' | 'closed' | 'merged' | 'all'

export const GH_PR_LIST_STATES: readonly GhPrListState[] = ['open', 'closed', 'merged', 'all']

export function isGhPrListState(value: unknown): value is GhPrListState {
  return typeof value === 'string' && (GH_PR_LIST_STATES as readonly string[]).includes(value)
}

export interface GhAuthorJson {
  login?: string
  name?: string | null
}

export interface GhCheckNodeJson {
  __typename?: string
  name?: string
  status?: string
  conclusion?: string
  detailsUrl?: string
  context?: string
  state?: string
  targetUrl?: string
  description?: string | null
}

export interface GhPrFileJson {
  path?: string
  additions?: number
  deletions?: number
  changeType?: string
}

export interface GhPrCommitJson {
  oid?: string
  messageHeadline?: string
  committedDate?: string
  authors?: GhAuthorJson[]
}

export interface GhPrCommentJson {
  id?: string
  author?: GhAuthorJson | null
  body?: string
  createdAt?: string
  url?: string
}

export interface GhPrReviewJson {
  id?: string
  author?: GhAuthorJson | null
  body?: string
  state?: string
  submittedAt?: string
  url?: string
}

export interface GhPrListItemJson {
  number?: number
  title?: string
  author?: GhAuthorJson | null
  state?: string
  isDraft?: boolean
  headRefName?: string
  baseRefName?: string
  updatedAt?: string
  reviewDecision?: string | null
  statusCheckRollup?: GhCheckNodeJson[] | null
  labels?: GhPrLabelJson[] | null
  additions?: number
  deletions?: number
  url?: string
}

export interface GhPrLabelJson {
  name?: string
  color?: string
  description?: string
}

export interface GhPrReviewRequestJson {
  __typename?: string
  login?: string
  name?: string
  slug?: string
}

export interface GhPrDetailJson extends GhPrListItemJson {
  body?: string
  createdAt?: string
  mergedAt?: string | null
  closedAt?: string | null
  changedFiles?: number
  labels?: GhPrLabelJson[] | null
  reviewRequests?: GhPrReviewRequestJson[] | null
  latestReviews?: GhPrReviewJson[] | null
  files?: GhPrFileJson[] | null
  commits?: GhPrCommitJson[] | null
  comments?: GhPrCommentJson[] | null
  reviews?: GhPrReviewJson[] | null
}

export interface GithubRepoRef {
  nameWithOwner: string
  url: string
}

export interface GithubStatus {
  installed: boolean
  authed: boolean
  repo: GithubRepoRef | null
  error?: string
}

export interface GhPrListResult {
  ok: boolean
  items: GhPrListItemJson[]
  error?: string
  failure?: GhPrFailure
  limit?: number
  hasMore?: boolean
}

export interface GhPrDetailResult {
  ok: boolean
  pr: GhPrDetailJson | null
  error?: string
}

export interface GhPrDiffResult {
  ok: boolean
  patch: string
  truncated: boolean
  bytes: number
  error?: string
}

export type GhPrFailureCode =
  | 'gh-missing' | 'not-authenticated' | 'forbidden' | 'pr-not-found'
  | 'not-mergeable' | 'checks-rejected' | 'timeout' | 'invalid-input'
  | 'confirmation-required' | 'cwd-rejected' | 'git-failed' | 'other'

export interface GhPrFailure {
  code: GhPrFailureCode
  message: string
  hint: string
  retrySafe: boolean
  gitFailure?: import('./git-actions').GitFailure
}

export interface GhPrListOptions {
  state?: GhPrListState
  author?: string
  labels?: string[]
  draft?: boolean
  review?: 'none' | 'required' | 'approved' | 'changes_requested'
  sort?: 'created' | 'updated' | 'comments'
  direction?: 'asc' | 'desc'
  limit?: number
}

export type GhPrActionRequest =
  | { kind: 'create'; title: string; body: string; base: string; head: string; draft?: boolean; pushFirst?: { remote?: string; setUpstream?: boolean } }
  | { kind: 'edit'; number: number; title?: string; body?: string; addReviewers?: string[]; removeReviewers?: string[]; addLabels?: string[]; removeLabels?: string[] }
  | { kind: 'comment'; number: number; body: string }
  | { kind: 'reply'; number: number; commentId: number; body: string }
  | { kind: 'merge'; number: number; method: 'merge' | 'squash' | 'rebase'; autoMerge?: boolean; deleteBranch?: boolean; confirmed: true }
  | { kind: 'ready' | 'draft' | 'reopen' | 'checkout'; number: number }
  | { kind: 'close' | 'delete-branch'; number: number; confirmed: true }
  | { kind: 'review'; number: number; event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'; body: string; comments?: GhPrInlineComment[] }

export interface GhPrInlineComment {
  path: string
  line: number
  side: 'LEFT' | 'RIGHT'
  body: string
}

export interface GhPrActionResult {
  ok: boolean
  number?: number
  url?: string
  pr?: GhPrDetailJson | null
  refreshRequired?: boolean
  branchDeletion?: 'deleted' | 'pending'
  completedSteps?: string[]
  failure?: GhPrFailure
  refreshFailure?: GhPrFailure
  gitResult?: import('./git-actions').GitActionResult
}

export interface GhPrCandidatesRequest {
  kind: 'reviewers' | 'labels'
  page?: number
  perPage?: number
}

export interface GhPrCandidatesResult {
  ok: boolean
  reviewers?: GhAuthorJson[]
  labels?: GhPrLabelJson[]
  page?: number
  hasMore?: boolean
  failure?: GhPrFailure
}

export interface GithubBridge {
  status(cwd: string): Promise<GithubStatus>
  list(cwd: string, options: GhPrListState | GhPrListOptions): Promise<GhPrListResult>
  action(cwd: string, request: GhPrActionRequest): Promise<GhPrActionResult>
  candidates(cwd: string, request: GhPrCandidatesRequest): Promise<GhPrCandidatesResult>
  detail(cwd: string, number: number): Promise<GhPrDetailResult>
  diff(cwd: string, number: number): Promise<GhPrDiffResult>
  openUrl(url: string): Promise<{ ok: boolean; error?: string }>
}
