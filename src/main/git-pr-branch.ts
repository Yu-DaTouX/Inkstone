import { validateBranchName } from '../shared/git-actions'

export interface PrCheckoutOptions {
  headRef: string
  headRepoUrl: string | null
  baseRepoUrl: string
  maintainerCanModify?: boolean
}

export interface ExistingBranch {
  exists: boolean
  tip: string | null
  merge: string | null
  remoteUrl: string | null
  descendantOfTip: boolean
}

export type PrBranchDecision = 'create' | 'reuse' | 'fast-forward' | 'skip'

export function normalizeRepoKey(value: string | null | undefined): string | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const scp = /^(?:[^@/]+@)?([^/:@]+):(?!\/\/)(.+)$/.exec(raw)
  let host = ''
  let path = ''
  if (scp && !/^[a-zA-Z]:[\\/]/.test(raw)) {
    host = scp[1]
    path = scp[2]
  } else {
    try {
      const url = new URL(raw)
      host = url.hostname
      path = url.pathname
    } catch {
      return null
    }
  }
  const trimmed = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
  return host && trimmed ? `${host}/${trimmed}`.toLowerCase() : null
}

export function prBranchCandidates(headRef: string, number: number): string[] {
  const base = headRef.trim()
  const names = !base || validateBranchName(base) || base.startsWith('+') ? [`pr-${number}`] : [base, `${base}-pr${number}`]
  return [...new Set(names.filter((name) => !validateBranchName(name)))]
}

export function decidePrBranch(existing: ExistingBranch, headOid: string, headRef: string, headRepoUrl: string | null): PrBranchDecision {
  if (!existing.exists) return 'create'
  if (existing.tip === headOid) return 'reuse'
  const sameRemote = !!headRepoUrl && normalizeRepoKey(existing.remoteUrl) === normalizeRepoKey(headRepoUrl)
  if (sameRemote && existing.merge === `refs/heads/${headRef}` && existing.descendantOfTip) return 'fast-forward'
  return 'skip'
}

export function pushRightsNote(options: PrCheckoutOptions): string {
  const fork = normalizeRepoKey(options.headRepoUrl) !== normalizeRepoKey(options.baseRepoUrl)
  if (!fork) return ''
  if (!options.headRepoUrl) return '该 PR 的来源仓库已不存在，无法推回。'
  return options.maintainerCanModify === true
    ? '该 PR 来自 fork；推回需要你对 fork 有写权限或作者允许维护者修改，被拒绝时不会强推。'
    : '该 PR 来自 fork，作者没有允许维护者修改，推回大概率会被拒绝；不会强推，可改为向作者的 fork 提 PR。'
}
