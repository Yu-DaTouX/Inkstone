/**
 * 提交失败后的草稿归属恢复（提交时钉住「正在看的会话」身份）。
 *
 * 背景（主审 2026-10-15）：`!` 直执行 / 普通发送失败时，`restoreText` 只
 * `setValue`、`restoreAttachments` 只并进顶层 store，都没校验「提交时看的是
 * 哪条会话」。await 期间用户从 A 切到 B，失败的那条 A 命令就落进了 B 的
 * 输入框 / 附件区 —— 另一条会话凭空多出一条没发出去的草稿。
 *
 * 这里只做两件纯事：
 *   ① 把「提交那一刻正在看的会话」钉成稳定身份。只读浏览（deferred）时
 *      视图看的会话与 active runner 不是同一条，不能只看 `activeRunnerId`；
 *   ② 异步失败回来时判断现在是否还在同一条会话 —— 是就把文字 / 附件还给
 *      当前输入框，不是就把文字**与完整附件**都写回**原会话**的草稿缓存
 *      （按草稿键切回去能完整取回图片与 fileRef），附件不塞进当前会话。
 *
 * 只借用两处既有边界：文字与附件进 `sessionRuntimes` 的草稿缓存
 *（session-cache，`draft` / `draftAttachments`），附件合并复用 `queue-images`
 * 的上限与去重规则。不引入新的状态管理。
 */
import type { Attachment, RuntimeEnvelope, SessionState } from '../../../shared/ipc'
import { mergeQueueAttachments, type AttachmentLimits } from './queue-images'
import type { SessionRuntimeMap } from './session-runtime'

/**
 * 提交时钉住的视图身份。
 *
 * `draftKey` 是当时 Composer 读写草稿用的缓存键；`sessionId` / `path` 是
 * 「正在看」的会话身份（peek 优先）；`runId` + `generation` 用来核对
 * pending→uuid 的过渡以及运行实例被复用到新会话的情况。
 */
export interface ComposerSubmitIdentity {
  draftKey: string
  sessionId?: string
  path?: string
  runId?: string
  generation?: number
}

/**
 * 从 store 里取身份需要的视图切片。
 *
 * 只声明用到的字段，避免把整个 Store 类型拖进纯逻辑测试。
 */
export interface ComposerRecoveryView {
  peekedSessionId?: string | null
  peekedPath?: string | null
  session?: Pick<SessionState, 'sessionId' | 'sessionFile'> | null
  activeRunnerId?: string | null
  runners: {
    id: string
    runId?: string
    sessionId?: string
    sessionFile?: string
    projectId?: string
    generation?: number
  }[]
  sessionRuntimes?: SessionRuntimeMap
}

const normPath = (p?: string | null): string => (p ?? '').replace(/\\/g, '/').toLowerCase()
const samePath = (a?: string | null, b?: string | null): boolean => !!a && !!b && normPath(a) === normPath(b)

/** 只读浏览 / 草稿尚未落盘时的薄路径键：不伪造成运行实例，只作草稿缓存。 */
const pathDraftKey = (path?: string | null): string => (path ? `file:${normPath(path)}` : '')

/** `pending:<runId>`：身份尚未落定，不能拿它和后来的真实 uuid 做等值比较。 */
export function isPendingSessionId(id?: string): boolean {
  return !!id && id.startsWith('pending:')
}

/** 当前视图正在看哪条会话：与 push-routing 的 `viewingSessionId` 同序（peek 优先）。 */
const viewingSession = (view: ComposerRecoveryView): string | undefined =>
  view.peekedSessionId ?? view.session?.sessionId ?? undefined

/** 当前视图正在看哪条会话文件（身份未落定时用它兜底）。 */
const viewingPath = (view: ComposerRecoveryView): string | undefined =>
  view.peekedPath ?? view.session?.sessionFile ?? undefined

/** 提交时钉住「正在看的会话」。 */
export function composerSubmitIdentity(view: ComposerRecoveryView): ComposerSubmitIdentity {
  const sessionId = viewingSession(view)
  const path = viewingPath(view)
  let runner = sessionId && !isPendingSessionId(sessionId)
    ? view.runners.find((item) => item.sessionId === sessionId)
    : undefined
  if (!runner && path) runner = view.runners.find((item) => samePath(item.sessionFile, path))
  if (!runner && isPendingSessionId(sessionId)) {
    const runId = sessionId!.slice('pending:'.length)
    runner = view.runners.find((item) => (item.runId ?? item.id) === runId)
  }
  /* 身份完全没落定（启动早期）：退回到 active runner 的临时 run 键。 */
  if (!runner && !sessionId && !path) {
    runner = view.runners.find((item) => (item.runId ?? item.id) === view.activeRunnerId)
  }
  const draftKey = sessionId || runner?.sessionId || pathDraftKey(path) || (view.activeRunnerId ? `run:${view.activeRunnerId}` : '')
  return {
    draftKey,
    sessionId: sessionId || undefined,
    path: path || undefined,
    runId: runner?.runId ?? runner?.id,
    generation: runner?.generation
  }
}

/**
 * 当前**正在看**哪条会话的草稿键（Composer 读写草稿用）。
 *
 * 与 `composerSubmitIdentity().draftKey` 同一套映射：peek 优先于活动运行实例，
 * 只有路径时用薄路径键 `file:<path>`，都不落定时才退回活动实例的 `run:` 键 ——
 * 不能因为 deferred 就把别条会话的附件/草稿写进 active runner。
 */
export function composerDraftKey(view: ComposerRecoveryView): string {
  return composerSubmitIdentity(view).draftKey
}

/** 从会话缓存里取**某条草稿键**的文字与附件；没有缓存就是空草稿。 */
export function composerDraftForView(
  view: ComposerRecoveryView,
  key: string
): { text: string; attachments: Attachment[] } {
  const entry = key ? view.sessionRuntimes?.[key] : undefined
  return { text: entry?.draft ?? '', attachments: entry?.draftAttachments ?? [] }
}

/**
 * 现在是否还在提交时那条会话。
 *
 * 先按明确 sessionId 比；pending 身份改按同一实例 + 同代次比（覆盖
 * `pending:<runId>` → 真实 uuid 的正常过渡）；只有路径时按路径比；
 * 只剩实例身份时要求实例还在、代次一致，且视图没有换到别的明确会话。
 */
export function sameComposerView(view: ComposerRecoveryView, id: ComposerSubmitIdentity): boolean {
  const current = viewingSession(view)
  /*
   * 明确的非 pending sessionId 只要和当前视图不一致，就不再往下用 runId/代次兜底：
   * 运行实例会被复用到别的会话，同 runId 同代次也不能当成原会话。
   * 例外只有路径证明是同一条稳定会话文件（sessionId 过渡）时才继续算原会话。
   */
  if (id.sessionId && !isPendingSessionId(id.sessionId)) {
    if (current === id.sessionId) return true
    if (id.path && samePath(viewingPath(view), id.path)) return true
    return false
  }

  if (isPendingSessionId(id.sessionId) && id.runId) {
    const runner = view.runners.find((item) => (item.runId ?? item.id) === id.runId)
    if (!runner) return false
    if ((runner.generation ?? 0) !== (id.generation ?? 0)) return false
    /* 视图已经换成别的明确会话 → 不算原会话；仍空或就是该实例的会话 → 算。 */
    return !current || current === runner.sessionId
  }

  if (id.path && samePath(viewingPath(view), id.path)) return true

  if (id.runId) {
    /* 代次缺失就无法区分「同一实例」与「实例被复用到新会话」，不按旧 run 认新会话。 */
    if (id.generation === undefined) return false
    const runner = view.runners.find((item) => (item.runId ?? item.id) === id.runId)
    if (!runner) return false
    if ((runner.generation ?? 0) !== id.generation) return false
    if (current) return current === runner.sessionId
    return !view.peekedPath
  }
  return false
}

/**
 * 跨会话回填文字时，原会话现在应该写到哪个运行实例的草稿缓存。
 *
 * pending→uuid 时同一 runId 的实例已经拿到真实 sessionId，要写到新键，
 * 切回去才读得到；只有路径时从缓存快照里按会话文件找。
 */
export function recoveryRuntimeFor(
  view: ComposerRecoveryView,
  id: ComposerSubmitIdentity
): RuntimeEnvelope | null {
  if (id.runId) {
    const runner = view.runners.find((item) => (item.runId ?? item.id) === id.runId)
    /*
     * 代次缺失就不按这个 runId 认会话：实例可能已被复用到新会话，
     * 旧 run 对不上新 session。此时退到路径匹配。
     * 已落定的非 pending sessionId 只接受同一 sessionId 的实例；
     * pending→uuid 才允许同一实例换真实 sessionId。
     */
    const stableMatches =
      !id.sessionId || isPendingSessionId(id.sessionId) || runner?.sessionId === id.sessionId
    if (
      runner &&
      stableMatches &&
      id.generation !== undefined &&
      (runner.generation ?? 0) === id.generation &&
      runner.sessionId
    ) {
      return {
        sessionId: runner.sessionId,
        runId: id.runId,
        projectId: runner.projectId,
        generation: runner.generation ?? 0
      }
    }
  }
  if (id.path) {
    const snapshot = Object.values(view.sessionRuntimes ?? {}).find((item) =>
      samePath(item.session?.sessionFile, id.path)
    )
    if (snapshot) return snapshot.runtime
  }
  if (id.sessionId && !isPendingSessionId(id.sessionId)) {
    return { sessionId: id.sessionId, runId: id.runId ?? id.sessionId, generation: id.generation ?? 0 }
  }
  if (id.runId) return { sessionId: '', runId: id.runId, generation: id.generation ?? 0 }
  return null
}

export interface ComposerRecoveryInput {
  /** 异步回来时是否还停在发起提交的那条会话。 */
  sameView: boolean
  text: string
  /** 提交时读到的原视图附件（含 fileRef）。 */
  attachments: Attachment[]
  /** 当前输入框已有附件。 */
  existing: Attachment[]
  limits: AttachmentLimits
}

export interface ComposerRecoveryPlan {
  sameView: boolean
  /** 放回输入框的文字；同视图时由 `queueRestore` 追加，不走覆盖。 */
  queueRestore: string | null
  /** 回填后的附件；同视图外原样返回 `existing`。 */
  attachments: Attachment[]
  /** 跨会话时写回原会话草稿缓存的附件；同视图为 undefined（附件已进输入框）。 */
  cacheAttachments?: Attachment[]
  restoredAttachments: number
  /** 仅真正超出上限而没放回/没缓存的数量；跨会话不再算丢弃。 */
  droppedAttachments: number
}

/** 按 id 去重，保留首次出现的一份。 */
function dedupeById(list: Attachment[]): Attachment[] {
  const seen = new Set<string>()
  const out: Attachment[] = []
  for (const item of list) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}

/**
 * 一次失败恢复的完整决策：文字进草稿 / queueRestore，附件合并进输入框。
 *
 * 同视图：按 id 去重后复用 `mergeQueueAttachments` 的上限裁剪，图片与 fileRef
 * 一视同仁（fileRef 也保留，不能只恢复图片）。跨会话：不动当前视图附件，
 * 文字与附件都写回**原会话**缓存（由调用方落进 `sessionRuntimes`），切回去
 * 能完整取回；超出上限的那部分才算 dropped。
 */
export function planComposerRecovery(input: ComposerRecoveryInput): ComposerRecoveryPlan {
  const text = input.text ?? ''
  if (!input.sameView) {
    const cacheAttachments = dedupeById(input.attachments)
    return {
      sameView: false,
      queueRestore: text || null,
      attachments: input.existing,
      cacheAttachments,
      restoredAttachments: cacheAttachments.length,
      droppedAttachments: input.attachments.length - cacheAttachments.length
    }
  }
  const present = new Set(input.existing.map((item) => item.id))
  const fresh = input.attachments.filter((item) => !present.has(item.id))
  const { attachments, skipped } = mergeQueueAttachments(input.existing, fresh, input.limits)
  return {
    sameView: true,
    queueRestore: text || null,
    attachments,
    restoredAttachments: fresh.length - skipped,
    droppedAttachments: skipped
  }
}
