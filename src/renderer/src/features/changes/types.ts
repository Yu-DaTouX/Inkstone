import type {
  GitChangeEntry,
  GitChangePatch,
  GitChangesScope,
  GitImageSide,
  GitRepoState,
  GitStatusEntry
} from '../../../../shared/git'
import type { GitActionExpected } from '../../../../shared/git-actions'
import type { WorkspaceOwner } from '../workbench/types'

export type ChangesOwner = WorkspaceOwner

export interface GitStateView {
  repo: GitRepoState | null
  expected?: GitActionExpected
  error?: string
}

export interface ChangesSnapshot {
  files: GitChangeEntry[]
  head: string | null
  scopeKind: GitChangesScope['kind']
  baseRef: string | null
  baseSha: string | null
  targetSha: string | null
  added: number | null
  removed: number | null
  pathScope?: string | null
  patches: Record<string, GitChangePatch>
}

export interface ChangesQuery {
  scope: GitChangesScope
  patches: boolean
}

export interface ChangesGitSource {
  state(cwd: string): Promise<GitStateView>
  untracked(cwd: string): Promise<string[]>
  entries?(cwd: string): Promise<GitStatusEntry[]>
  changes?(cwd: string, query: ChangesQuery): Promise<ChangesSnapshot>
}

export interface ChangesImagePair {
  before: GitImageSide
  after: GitImageSide
}

export interface ChangesPatch {
  patch: string
  truncated?: boolean
  binary?: boolean
  image?: ChangesImagePair
}

export interface PatchRequest {
  scope?: GitChangesScope
  images?: boolean
}

export type PatchLoader = (cwd: string, path: string, request?: PatchRequest) => Promise<ChangesPatch>

export interface ChangeItem {
  path: string
  status: string
  untracked: boolean
  origPath?: string
  added?: number
  removed?: number
}

