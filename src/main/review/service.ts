/**
 * 评审服务（§10.2 / WP-50）：把变更集读取、批注存储、评审 Agent 契约与
 * Git 写适配拼成**一个**类型化入口，供 IPC 与后续 UI 使用。
 *
 * 依赖以窄接口注入（`authorize` / 存储 / git 适配 / Agent 协调器），所以
 * 用临时目录 + fake exec 就能直接单测，不依赖 Electron、不碰真实仓库。
 */
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
  /** 只读目录授权（主进程注入 `resolveFileContext`） */
  authorize: AuthorizeReadCwd
  annotations?: ReviewAnnotationStore
  changes?: ReviewChangesDeps
  /**
   * 可信的会话归属验证（主进程注册时注入）。`session` 来源必须经过它；
   * 缺失时会话来源返回 `unavailable`，不静默当未提交改动。
   */
  verifySession?: VerifyReviewSession
  /** Git 写适配（含窄目标确认钩子）；缺省时写方法返回未接线 */
  git?: ReviewGitAdapter
  /** 评审 Agent 协调器；缺省时 startReview 返回未接线 */
  agent?: ReviewAgentCoordinator
}

export interface ReviewDiffQuery {
  source: ReviewChangeSetQuery['source']
  cwd: string
  path: string
  base?: string
  branch?: string
  /** session 来源：已验证的会话 id */
  sessionId?: string
}

export class ReviewService {
  private readonly authorize: AuthorizeReadCwd
  private readonly annotations: ReviewAnnotationStore
  private readonly changes?: ReviewChangesDeps
  private readonly verifySession?: VerifyReviewSession
  private readonly git?: ReviewGitAdapter
  private readonly agent?: ReviewAgentCoordinator
  /** changeSetId → 最近一次读到的内容 revision；用于拒绝锚到过期版本的批注写入 */
  private readonly revisions = new Map<string, string>()
  /** 缓存上限，防止长时间运行后无限增长 */
  private readonly maxRevisionEntries = 400

  constructor(deps: ReviewServiceDeps) {
    this.authorize = deps.authorize
    this.annotations = deps.annotations ?? new ReviewAnnotationStore()
    this.changes = deps.changes
    this.verifySession = deps.verifySession
    this.git = deps.git
    this.agent = deps.agent
  }

  /** 变更集读取的全部依赖（合并注入的会话验证注入口）。 */
  private changeDeps(): ReviewChangesDeps | undefined {
    if (!this.changes && !this.verifySession) return undefined
    return {
      ...(this.changes ?? {}),
      ...(this.verifySession ? { verifySession: this.verifySession } : {})
    }
  }

  /** 读变更集并把已有批注数合并到文件条目上。 */
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

  /**
   * 新增批注。
   *
   * 若带了 `anchorRevision` 且与主进程最近一次读到的内容 revision 不一致，
   * 拒绝写入并标 `stale` —— 代码已经变过，不允许把批注继续锚在旧版本上。
   */
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

  /** 把某变更集的全部批注整理成一条结构化消息（不发送）。 */
  async annotationTask(changeSet: ReviewChangeSet): Promise<ReviewAnnotationTask> {
    const listed = await this.annotations.list(changeSet.id, changeSet.scopeKey)
    if (!listed.ok) return { ok: false, error: listed.error ?? '读批注失败', count: 0 }
    return buildAnnotationTask(changeSet, listed.annotations)
  }

  /**
   * 取本次评审要嵌入任务文本的有界补丁。
   *
   * 逐个文件走与变更集同一 revision 来源的只读 diff 通道（`diff`），并发上限
   * 6；单文件按 `REVIEW_MAX_PATCH_BYTES` 截断，累计到
   * `REVIEW_MAX_TOTAL_PATCH_BYTES` 后其余文件标 `omitted`。二进制只列名；
   * 读取失败标 `error`，**不中断评审**（提示里会写明未取得补丁）。
   */
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

  /** 启动只读评审运行；R 编号由正式编号存储发出，执行交宿主 port。 */
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

  /** 测试 / 退出收尾。 */
  whenIdle(): Promise<void> {
    return this.annotations.whenIdle()
  }
}

export type { ReviewAgentCoordinatorDeps }
