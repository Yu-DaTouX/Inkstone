import type { Attachment, RuntimeEnvelope, SessionState } from '../../../shared/ipc'
import { mergeQueueAttachments, type AttachmentLimits } from './queue-images'
import type { SessionRuntimeMap } from './session-runtime'

export interface ComposerSubmitIdentity {
  draftKey: string
  sessionId?: string
  path?: string
  runId?: string
  generation?: number
}

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

const pathDraftKey = (path?: string | null): string => (path ? `file:${normPath(path)}` : '')

export function isPendingSessionId(id?: string): boolean {
  return !!id && id.startsWith('pending:')
}

const viewingSession = (view: ComposerRecoveryView): string | undefined =>
  view.peekedSessionId ?? view.session?.sessionId ?? undefined

const viewingPath = (view: ComposerRecoveryView): string | undefined =>
  view.peekedPath ?? view.session?.sessionFile ?? undefined

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

export function composerDraftKey(view: ComposerRecoveryView): string {
  return composerSubmitIdentity(view).draftKey
}

export function composerDraftForView(
  view: ComposerRecoveryView,
  key: string
): { text: string; attachments: Attachment[] } {
  const entry = key ? view.sessionRuntimes?.[key] : undefined
  return { text: entry?.draft ?? '', attachments: entry?.draftAttachments ?? [] }
}

export function sameComposerView(view: ComposerRecoveryView, id: ComposerSubmitIdentity): boolean {
  const current = viewingSession(view)
  if (id.sessionId && !isPendingSessionId(id.sessionId)) {
    if (current === id.sessionId) return true
    if (id.path && samePath(viewingPath(view), id.path)) return true
    return false
  }

  if (isPendingSessionId(id.sessionId) && id.runId) {
    const runner = view.runners.find((item) => (item.runId ?? item.id) === id.runId)
    if (!runner) return false
    if ((runner.generation ?? 0) !== (id.generation ?? 0)) return false
    return !current || current === runner.sessionId
  }

  if (id.path && samePath(viewingPath(view), id.path)) return true

  if (id.runId) {
    if (id.generation === undefined) return false
    const runner = view.runners.find((item) => (item.runId ?? item.id) === id.runId)
    if (!runner) return false
    if ((runner.generation ?? 0) !== id.generation) return false
    if (current) return current === runner.sessionId
    return !view.peekedPath
  }
  return false
}

export function recoveryRuntimeFor(
  view: ComposerRecoveryView,
  id: ComposerSubmitIdentity
): RuntimeEnvelope | null {
  if (id.runId) {
    const runner = view.runners.find((item) => (item.runId ?? item.id) === id.runId)
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
  sameView: boolean
  text: string
  attachments: Attachment[]
  existing: Attachment[]
  limits: AttachmentLimits
}

export interface ComposerRecoveryPlan {
  sameView: boolean
  queueRestore: string | null
  attachments: Attachment[]
  cacheAttachments?: Attachment[]
  restoredAttachments: number
  droppedAttachments: number
}

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
