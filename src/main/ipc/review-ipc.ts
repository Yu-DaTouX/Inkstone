/**
 * 评审 IPC 适配（`yan:review:*`，§10.2 / WP-50）。
 *
 * 与 `src/main/review/**` 的分工：service 负责数据与安全边界，本文件只做
 * 「渲染端来的不可信输入 → 逐字段取值 → 调 service」的转换，并把结果原样
 * 交回。**不信任渲染端送来的变更集对象**：`annotationTask` 与 `startReview`
 * 都带查询参数，由主进程重新读一遍变更集，避免伪造 cwd / scopeKey 让评审
 * 运行跑到别的目录。
 *
 * 依赖以窄接口注入；本文件不 import Electron，也不 import 主进程入口，
 * 可用临时目录 fixture 直接单测（见 scripts/test-v3-review-service.mjs）。
 */
import type { IpcRegistrar } from './registrar'
import type { ReviewService } from '../review'
import type {
  ReviewAnnotationInput,
  ReviewAnnotationPatch,
  ReviewChangeSetQuery,
  ReviewPullRequestInput,
  ReviewPushInput
} from '../../shared/review'

export interface ReviewIpcDeps {
  service: ReviewService
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function optionalStr(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function parseChangeSetQuery(raw: unknown): ReviewChangeSetQuery {
  const o = asRecord(raw)
  const source = str(o.source)
  const allowed = source === 'session' || source === 'branch' || source === 'worktree' || source === 'uncommitted'
  return {
    source: allowed ? source : 'uncommitted',
    cwd: str(o.cwd),
    ...(optionalStr(o.base) ? { base: String(o.base) } : {}),
    ...(optionalStr(o.branch) ? { branch: String(o.branch) } : {}),
    ...(optionalStr(o.worktreePath) ? { worktreePath: String(o.worktreePath) } : {}),
    ...(optionalStr(o.sessionId) ? { sessionId: String(o.sessionId) } : {})
  }
}

export function registerReviewIpc(ipc: IpcRegistrar, deps: ReviewIpcDeps): void {
  const { handle } = ipc
  const service = deps.service

  handle('yan:review:changes', async (raw: unknown) => service.changeSet(parseChangeSetQuery(raw)))

  handle('yan:review:diff', async (raw: unknown) => {
    const o = asRecord(raw)
    const source = str(o.source)
    const allowed = source === 'session' || source === 'branch' || source === 'worktree' || source === 'uncommitted'
    return service.diff({
      source: allowed ? source : 'uncommitted',
      cwd: str(o.cwd),
      path: str(o.path),
      ...(optionalStr(o.base) ? { base: String(o.base) } : {}),
      ...(optionalStr(o.branch) ? { branch: String(o.branch) } : {}),
      ...(optionalStr(o.sessionId) ? { sessionId: String(o.sessionId) } : {})
    })
  })

  handle('yan:review:annotations', async (changeSetId: unknown, scopeKey: unknown) =>
    service.listAnnotations(str(changeSetId), str(scopeKey))
  )

  handle('yan:review:annotationAdd', async (raw: unknown) => {
    const o = asRecord(raw)
    const input: ReviewAnnotationInput = {
      changeSetId: str(o.changeSetId),
      scopeKey: str(o.scopeKey),
      path: str(o.path),
      side: o.side === 'old' || o.side === 'file' ? o.side : 'new',
      lineStart: Number(o.lineStart),
      lineEnd: Number.isFinite(Number(o.lineEnd)) ? Number(o.lineEnd) : Number(o.lineStart),
      body: str(o.body),
      ...(optionalStr(o.anchorRevision) ? { anchorRevision: String(o.anchorRevision) } : {}),
      author: o.author === 'agent' ? 'agent' : 'user'
    }
    return service.addAnnotation(input)
  })

  handle('yan:review:annotationUpdate', async (raw: unknown) => {
    const o = asRecord(raw)
    const patch: ReviewAnnotationPatch = {
      ...(o.body !== undefined ? { body: str(o.body) } : {}),
      ...(o.side === 'old' || o.side === 'file' || o.side === 'new' ? { side: o.side } : {}),
      ...(o.lineStart !== undefined && Number.isFinite(Number(o.lineStart)) ? { lineStart: Number(o.lineStart) } : {}),
      ...(o.lineEnd !== undefined && Number.isFinite(Number(o.lineEnd)) ? { lineEnd: Number(o.lineEnd) } : {})
    }
    return service.updateAnnotation(str(o.changeSetId), str(o.scopeKey), str(o.id), patch)
  })

  handle('yan:review:annotationRemove', async (raw: unknown) => {
    const o = asRecord(raw)
    return service.removeAnnotation(str(o.changeSetId), str(o.scopeKey), str(o.id))
  })

  handle('yan:review:annotationClear', async (raw: unknown) => {
    const o = asRecord(raw)
    return service.clearAnnotations(str(o.changeSetId), str(o.scopeKey))
  })

  /* 两个「按查询重读变更集」的入口：不能信渲染端送来的 changeSet 对象。 */
  handle('yan:review:annotationTask', async (raw: unknown) => {
    const o = asRecord(raw)
    const changeSet = await service.changeSet(parseChangeSetQuery(o.query))
    if (!changeSet.ok) return { ok: false, error: changeSet.error ?? '变更集不可用', count: 0 }
    return service.annotationTask(changeSet)
  })

  handle('yan:review:start', async (raw: unknown) => {
    const o = asRecord(raw)
    const changeSet = await service.changeSet(parseChangeSetQuery(o.query))
    if (!changeSet.ok) return { ok: false, changeSetId: changeSet.id, error: changeSet.error ?? '变更集不可用' }
    return service.startReview(changeSet, {
      ...(optionalStr(o.model) ? { model: String(o.model) } : {}),
      ...(optionalStr(o.sessionId) ? { sessionId: String(o.sessionId) } : {}),
      ...(optionalStr(o.sessionPath) ? { sessionPath: String(o.sessionPath) } : {}),
      ...(optionalStr(o.projectId) ? { projectId: String(o.projectId) } : {})
    })
  })

  handle('yan:review:ghStatus', async (cwd: unknown) => service.ghStatus(str(cwd)))

  handle('yan:review:commit', async (raw: unknown) => {
    const o = asRecord(raw)
    return service.commit({ cwd: str(o.cwd), message: str(o.message) })
  })

  handle('yan:review:push', async (raw: unknown) => {
    const o = asRecord(raw)
    const input: ReviewPushInput = {
      cwd: str(o.cwd),
      remote: optionalStr(o.remote) ? String(o.remote) : null,
      branch: optionalStr(o.branch) ? String(o.branch) : null,
      setUpstream: o.setUpstream === true
    }
    return service.push(input)
  })

  handle('yan:review:pr', async (raw: unknown) => {
    const o = asRecord(raw)
    const input: ReviewPullRequestInput = {
      cwd: str(o.cwd),
      base: str(o.base),
      head: optionalStr(o.head) ? String(o.head) : null,
      title: str(o.title),
      body: str(o.body),
      draft: o.draft === true,
      remote: optionalStr(o.remote) ? String(o.remote) : null
    }
    return service.createPullRequest(input)
  })
}
