import type { SubagentRun } from '../../../../shared/ipc'

export type SubagentReviewAction = 'merge' | 'discard'

export type SubagentReviewBlock =
  | 'not-worktree'
  | 'running'
  | 'no-worktree'
  | 'nothing-to-review'
  | 'no-patch'

export interface SubagentReviewGate {
  canReview: boolean
  canPatch: boolean
  canDiscard: boolean
  blocked: SubagentReviewBlock | null
}

export type ReviewableRun = Pick<SubagentRun, 'isolation' | 'review' | 'status' | 'diff'>

export function subagentReviewGate(run: ReviewableRun): SubagentReviewGate {
  const worktree = run.isolation === 'worktree'
  const running = run.status === 'starting' || run.status === 'running'
  const reviewing = run.review === 'pending' || run.review === 'conflict'
  const files = run.diff?.files ?? 0
  const canPatch = worktree && !running && reviewing && !!run.diff?.patchPath && files > 0
  const canDiscard = worktree && !running && reviewing
  const canReview = canPatch || canDiscard
  let blocked: SubagentReviewBlock | null = null
  if (!canReview) {
    if (!worktree) blocked = 'not-worktree'
    else if (running) blocked = 'running'
    else if (!reviewing) blocked = run.review === 'archived' ? 'no-worktree' : 'nothing-to-review'
    else blocked = 'no-patch'
  } else if (!canPatch) {
    blocked = 'no-patch'
  }
  return { canReview, canPatch, canDiscard, blocked }
}

export interface SubagentPatch {
  patch: string
  truncated: boolean
}

export interface SubagentPatchIo {
  describeFiles(paths: string[]): Promise<Array<{ ok: boolean; path?: string; error?: string }>>
  readFileText(path: string): Promise<{ ok: boolean; text?: string; truncated?: boolean; error?: string }>
}

export async function loadSubagentPatch(patchPath: string, io?: SubagentPatchIo): Promise<SubagentPatch> {
  const api = io ?? (typeof window !== 'undefined' ? (window.yan as SubagentPatchIo | undefined) : undefined)
  if (!api?.describeFiles || !api.readFileText) throw new Error('宿主文件接口不可用')
  const granted = await api.describeFiles([patchPath])
  const first = granted[0]
  if (!first?.ok) throw new Error(first?.error ?? '补丁文件不可读')
  const res = await api.readFileText(first.path ?? patchPath)
  if (!res.ok || typeof res.text !== 'string') throw new Error(res.error ?? '补丁读取失败')
  return { patch: res.text, truncated: res.truncated === true }
}

export interface SubagentActionResult {
  ok: boolean
  error?: string
}

export interface SubagentActionIo {
  merge(id: string): Promise<SubagentActionResult>
  discard(id: string): Promise<SubagentActionResult>
}

function subagentActionIo(io?: SubagentActionIo): SubagentActionIo {
  if (io) return io
  const api = typeof window !== 'undefined' ? window.yan?.subagents : undefined
  if (!api?.merge || !api?.discard) throw new Error('子 Agent 处置接口不可用')
  return { merge: (id) => api.merge(id), discard: (id) => api.discard(id) }
}

export async function mergeSubagentResult(id: string, io?: SubagentActionIo): Promise<void> {
  const res = await subagentActionIo(io).merge(id)
  if (!res?.ok) throw new Error(res?.error ?? '合并子代理结果失败')
}

export async function discardSubagentResult(id: string, io?: SubagentActionIo): Promise<void> {
  const res = await subagentActionIo(io).discard(id)
  if (!res?.ok) throw new Error(res?.error ?? '放弃子代理结果失败')
}
