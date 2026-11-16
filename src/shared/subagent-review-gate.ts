import type { SubagentRun } from './subagent-run'

type SubagentReviewBlock =
  | 'not-worktree'
  | 'running'
  | 'no-worktree'
  | 'nothing-to-review'
  | 'no-patch'

interface SubagentReviewGate {
  canReview: boolean
  canPatch: boolean
  canDiscard: boolean
  blocked: SubagentReviewBlock | null
}

type ReviewableRun = Pick<SubagentRun, 'isolation' | 'review' | 'status' | 'diff'>

export function subagentReviewGate(run: ReviewableRun): SubagentReviewGate {
  const worktree = run.isolation === 'worktree'
  const running = run.status === 'starting' || run.status === 'running'
  const files = run.diff?.files ?? 0
  const hasPatch = !!run.diff?.patchPath && files > 0
  const reviewing = run.review === 'pending' || run.review === 'conflict' || (run.review === 'archived' && hasPatch)
  const canPatch = worktree && !running && reviewing && hasPatch
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
