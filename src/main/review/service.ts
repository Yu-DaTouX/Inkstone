import type { AuthorizeReadCwd } from '../git-inspect'
import type { GitDiffResult } from '../../shared/git'
import { applyAnnotationCounts, readReviewChangeSet, readReviewFileDiff, type ReviewChangesDeps, type VerifyReviewSession } from './changes'
import { truncateReviewPatch, REVIEW_MAX_TOTAL_PATCH_BYTES } from '../../shared/review'
import { ReviewAnnotationStore } from './annotations'
import { ReviewAgentCoordinator, buildAnnotationTask, type ReviewAgentCoordinatorDeps } from './agent'
import { ReviewGitAdapter } from './git'
import type {
  ReviewAnnotation,
  ReviewAnnotationInput,
  ReviewAnnotationPatch,
  ReviewAnnotationResult,
  ReviewAnnotationTask,
  ReviewChangeSet,
  ReviewChangeSetQuery,
  ReviewFileEntry,
  ReviewGitOutcome,
  ReviewGhStatusView,
  ReviewPullRequestInput,
  ReviewPushInput,
  ReviewPromptPatch,
  ReviewRun
} from '../../shared/review'

export interface ReviewServiceDeps {
  authorize: AuthorizeReadCwd
  annotations?: ReviewAnnotationStore
  changes?: ReviewChangesDeps
  verifySession?: VerifyReviewSession
  git?: ReviewGitAdapter
  agent?: ReviewAgentCoordinator
}

export interface ReviewDiffQuery {
  source: ReviewChangeSetQuery['source']
  cwd: string
  path: string
  base?: string
  branch?: string
  sessionId?: string
}

export class ReviewService {
  private readonly authorize: AuthorizeReadCwd
  private readonly annotations: ReviewAnnotationStore
  private readonly changes?: ReviewChangesDeps
  private readonly verifySession?: VerifyReviewSession
  private readonly git?: ReviewGitAdapter
  private readonly agent?: ReviewAgentCoordinator
  private readonly revisions = new Map<string, string>()
  private readonly maxRevisionEntries = 400

  constructor(deps: ReviewServiceDeps) {
    this.authorize = deps.authorize
    this.annotations = deps.annotations ?? new ReviewAnnotationStore()
    this.changes = deps.changes
    this.verifySession = deps.verifySession
    this.git = deps.git
    this.agent = deps.agent
  }

  private changeDeps(): ReviewChangesDeps | undefined {
    if (!this.changes && !this.verifySession) return undefined
    return {
      ...(this.changes ?? {}),
      ...(this.verifySession ? { verifySession: this.verifySession } : {})
    }
  }

  async changeSet(query: ReviewChangeSetQuery): Promise<ReviewChangeSet> {
    const changeSet = await readReviewChangeSet(query, this.authorize, this.changeDeps())
    if (!changeSet.ok) return changeSet
    this.rememberRevision(changeSet.id, changeSet.revision)
    const counts = await this.annotations.countsByPath(changeSet.id, changeSet.scopeKey)
    const files: ReviewFileEntry[] = applyAnnotationCounts(changeSet.files, counts)
    return { ...changeSet, files }
  }

  private rememberRevision(changeSetId: string, revision: string): void {
    if (!changeSetId || !revision) return
    this.revisions.delete(changeSetId)
    this.revisions.set(changeSetId, revision)
    if (this.revisions.size > this.maxRevisionEntries) {
      const oldest = this.revisions.keys().next().value
      if (oldest !== undefined) this.revisions.delete(oldest)
    }
  }

  async diff(query: ReviewDiffQuery): Promise<GitDiffResult> {
    return readReviewFileDiff(
      query.cwd,
      query.path,
      query.source,
      {
        ...(query.base ? { base: query.base } : {}),
        ...(query.branch ? { branch: query.branch } : {}),
        ...(query.sessionId ? { sessionId: query.sessionId } : {})
      },
      this.authorize,
      this.changeDeps()
    )
  }

  listAnnotations(changeSetId: string, scopeKey: string): Promise<{ ok: boolean; error?: string; annotations: ReviewAnnotation[]; revision: number }> {
    return this.annotations.list(changeSetId, scopeKey)
  }

  addAnnotation(input: ReviewAnnotationInput): Promise<ReviewAnnotationResult> {
    const anchored = String(input.anchorRevision ?? '').trim()
    const current = this.revisions.get(String(input.changeSetId ?? ''))
    if (anchored && current && anchored !== current) {
      return Promise.resolve({
        ok: false,
        stale: true,
        error: '变更集内容已变化，这个批注的锚点已过期；请刷新后重新定位'
      })
    }
    return this.annotations.create(input)
  }

  updateAnnotation(changeSetId: string, scopeKey: string, id: string, patch: ReviewAnnotationPatch): Promise<ReviewAnnotationResult> {
    return this.annotations.update(changeSetId, scopeKey, id, patch)
  }

  removeAnnotation(changeSetId: string, scopeKey: string, id: string): Promise<ReviewAnnotationResult> {
    return this.annotations.remove(changeSetId, scopeKey, id)
  }

  clearAnnotations(changeSetId: string, scopeKey: string): Promise<ReviewAnnotationResult> {
    return this.annotations.clear(changeSetId, scopeKey)
  }

  async annotationTask(changeSet: ReviewChangeSet): Promise<ReviewAnnotationTask> {
    const listed = await this.annotations.list(changeSet.id, changeSet.scopeKey)
    if (!listed.ok) return { ok: false, error: listed.error ?? '读批注失败', count: 0 }
    return buildAnnotationTask(changeSet, listed.annotations)
  }

  async reviewPatches(changeSet: ReviewChangeSet): Promise<ReviewPromptPatch[]> {
    const files = changeSet.files
    const out: ReviewPromptPatch[] = new Array(files.length)
    let total = 0
    let budgetHit = false
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= files.length) return
        const file = files[index]
        if (file.binary) {
          out[index] = { path: file.path, patch: '', truncated: false, binary: true }
          continue
        }
        if (budgetHit) {
          out[index] = { path: file.path, patch: '', truncated: true, binary: false, omitted: true }
          continue
        }
        try {
          const diff = await this.diff({
            source: changeSet.source,
            cwd: changeSet.cwd,
            path: file.path,
            ...(changeSet.base ? { base: changeSet.base } : {}),
            ...(changeSet.branch ? { branch: changeSet.branch } : {}),
            ...(changeSet.sessionId ? { sessionId: changeSet.sessionId } : {})
          })
          if (!diff.ok) {
            out[index] = { path: file.path, patch: '', truncated: false, binary: false, error: diff.error ?? '读取补丁失败' }
            continue
          }
          if (diff.binary) {
            out[index] = { path: file.path, patch: '', truncated: false, binary: true }
            continue
          }
          const bounded = truncateReviewPatch(diff.patch)
          out[index] = { path: file.path, patch: bounded.text, truncated: bounded.truncated || diff.truncated, binary: false }
          total += Buffer.byteLength(bounded.text, 'utf8')
          if (total >= REVIEW_MAX_TOTAL_PATCH_BYTES) budgetHit = true
        } catch (error) {
          out[index] = {
            path: file.path,
            patch: '',
            truncated: false,
            binary: false,
            error: error instanceof Error ? error.message : String(error)
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, files.length) }, worker))
    return out
  }

  async startReview(
    changeSet: ReviewChangeSet,
    options: { model?: string; sessionId?: string; sessionPath?: string; projectId?: string } = {}
  ): Promise<ReviewRun> {
    if (!this.agent) {
      return Promise.resolve({
        ok: false,
        changeSetId: changeSet.id,
        error: '评审运行尚未接线',
        requiredWiring: ['ReviewAgentCoordinator（评审 Agent port）']
      })
    }
    const patches = await this.reviewPatches(changeSet)
    return this.agent.start({ changeSet, patches, ...options })
  }

  async ghStatus(cwd: string): Promise<ReviewGhStatusView> {
    if (!this.git) return { ok: false, installed: false, authenticated: false, message: 'Git 写适配尚未接线' }
    const status = await this.git.ghStatus(cwd)
    return { ok: status.installed && status.authenticated, installed: status.installed, authenticated: status.authenticated, ...(status.version ? { version: status.version } : {}), ...(status.message ? { message: status.message } : {}), ...(status.hint ? { hint: status.hint } : {}) }
  }

  commit(input: { cwd: string; message: string }): Promise<ReviewGitOutcome> {
    if (!this.git) return Promise.resolve({ ok: false, code: 'failed', message: 'Git 写适配尚未接线', recoverable: false })
    return this.git.commit(input)
  }

  push(input: ReviewPushInput): Promise<ReviewGitOutcome> {
    if (!this.git) return Promise.resolve({ ok: false, code: 'failed', message: 'Git 写适配尚未接线', recoverable: false })
    return this.git.push(input)
  }

  createPullRequest(input: ReviewPullRequestInput): Promise<ReviewGitOutcome> {
    if (!this.git) return Promise.resolve({ ok: false, code: 'failed', message: 'Git 写适配尚未接线', recoverable: false })
    return this.git.createPullRequest(input)
  }

  whenIdle(): Promise<void> {
    return this.annotations.whenIdle()
  }
}

export type { ReviewAgentCoordinatorDeps }
