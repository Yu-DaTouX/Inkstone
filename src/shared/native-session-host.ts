export type NativeSessionHostAction =
  | 'tree' | 'entries' | 'navigate' | 'reload'
  | 'scoped-models' | 'set-scoped-models'
  | 'trust' | 'set-trust'
  | 'import' | 'export-jsonl' | 'share' | 'new-session'

export interface NativeSessionHostRequest {
  action: NativeSessionHostAction
  expectedSessionId: string
  args?: string
  entryId?: string
  since?: string
  modelIds?: string[]
  trusted?: boolean
  parentSession?: string
}

export interface NativeSessionHostResult {
  ok: boolean
  error?: string
  cancelled?: boolean
  path?: string
  url?: string
  leafId?: string | null
  tree?: unknown[]
  entries?: Record<string, unknown>[]
  models?: Array<{ id: string; provider: string; name: string }>
  scopedModelIds?: string[]
  cwd?: string
  trusted?: boolean
  trustEntry?: string | null
  requiresReload?: boolean
  requiresTrust?: boolean
}
