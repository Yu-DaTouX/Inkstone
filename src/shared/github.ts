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
  additions?: number
  deletions?: number
  url?: string
}

export interface GhPrDetailJson extends GhPrListItemJson {
  body?: string
  createdAt?: string
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

export interface GithubBridge {
  status(cwd: string): Promise<GithubStatus>
  list(cwd: string, state: GhPrListState): Promise<GhPrListResult>
  detail(cwd: string, number: number): Promise<GhPrDetailResult>
  diff(cwd: string, number: number): Promise<GhPrDiffResult>
  openUrl(url: string): Promise<{ ok: boolean; error?: string }>
}
