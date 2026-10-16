import type { GitRepoState, GitStatusEntry } from '../../../../shared/git'
import type { WorkspaceOwner } from '../workbench/types'

export type ChangesOwner = WorkspaceOwner

export interface GitStateView {
  repo: GitRepoState | null
  error?: string
}

export interface ChangesGitSource {
  state(cwd: string): Promise<GitStateView>
  untracked(cwd: string): Promise<string[]>
  entries?(cwd: string): Promise<GitStatusEntry[]>
}

export interface ChangesPatch {
  patch: string
  truncated?: boolean
  binary?: boolean
}

export type PatchLoader = (cwd: string, path: string) => Promise<ChangesPatch>

export interface ChangeItem {
  path: string
  status: string
  untracked: boolean
}
