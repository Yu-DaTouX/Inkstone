import type { Attachment, RuntimeEnvelope } from '../../../../shared/ipc'
import { uiText } from '../../i18n/ui-text'
import { composerDraftKey, planComposerRecovery } from '../composer-recovery'
import { mergeQueueAttachments, planQueueRecovery, type QueueImageRef } from '../queue-images'
import { viewingSessionId } from '../push-routing'
import {
  sessionRuntimeKey,
  updateSessionRuntimeAt,
  type SessionRuntimeDataPatch,
  type SessionRuntimeMap
} from '../session-runtime'
import type { Store } from '../store'
import { pushNotice } from './shared'

export const MAX_ATTACHMENTS = 20

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

const QUEUE_ATTACHMENT_LIMITS = { maxCount: MAX_ATTACHMENTS, maxImageBytes: MAX_IMAGE_BYTES }

export function draftSeedRuntime(state: Store, key: string): RuntimeEnvelope {
  const cached = state.sessionRuntimes[key]
  if (cached) return cached.runtime
  const runner = state.runners.find(
    (item) =>
      item.sessionId === key ||
      `run:${item.runId ?? item.id}` === key ||
      (item.sessionFile ? `file:${item.sessionFile.replace(/\\/g, '/').toLowerCase()}` === key : false)
  )
  return {
    sessionId: key.startsWith('file:') ? '' : key,
    runId: runner?.runId ?? runner?.id ?? key,
    projectId: runner?.projectId,
    generation: runner?.generation ?? 0
  }
}

export function writeDraftAttachments(
  state: Store,
  key: string,
  attachments: Attachment[]
): SessionRuntimeMap {
  if (!key) return state.sessionRuntimes
  return updateSessionRuntimeAt(state.sessionRuntimes, key, { draftAttachments: attachments }, draftSeedRuntime(state, key))
}

export function applyQueueRecovery(
  current: Store,
  input: {
    sessionId?: string
    text: string
    images?: QueueImageRef[]
    attachments?: Attachment[]
    idPrefix: string
    notice?: string
    sameSession?: boolean
    draftRuntime?: RuntimeEnvelope
    draftKey?: string
  }
): Partial<Store> {
  const sameSession = input.sameSession ?? current.session?.sessionId === input.sessionId
  let recovery: { queueRestore: string | null; attachments: Attachment[]; cacheAttachments?: Attachment[] }
  let restoredCount: number
  let droppedCount: number
  if (input.attachments) {
    const plan = planComposerRecovery({
      sameView: sameSession,
      text: input.text,
      attachments: input.attachments,
      existing: current.attachments,
      limits: QUEUE_ATTACHMENT_LIMITS
    })
    recovery = plan
    restoredCount = plan.restoredAttachments
    droppedCount = plan.droppedAttachments
  } else {
    const plan = planQueueRecovery({
      sameSession,
      text: input.text,
      images: input.images,
      existing: current.attachments,
      limits: QUEUE_ATTACHMENT_LIMITS,
      idPrefix: input.idPrefix
    })
    recovery = plan
    restoredCount = plan.restoredImages
    droppedCount = plan.droppedImages
  }

  const crossKey = sameSession
    ? ''
    : input.draftKey || (input.draftRuntime ? sessionRuntimeKey(input.draftRuntime) : input.sessionId || '')
  let crossRuntimes: SessionRuntimeMap | undefined
  if (crossKey) {
    const cached = current.sessionRuntimes[crossKey]
    const seed = cached?.runtime ?? input.draftRuntime ?? draftSeedRuntime(current, crossKey)
    const dataPatch: SessionRuntimeDataPatch = {}
    if (recovery.queueRestore) {
      dataPatch.draft = [recovery.queueRestore, cached?.draft].filter(Boolean).join('\n')
    }
    if (recovery.cacheAttachments?.length) {
      const merged = mergeQueueAttachments(cached?.draftAttachments ?? [], recovery.cacheAttachments, QUEUE_ATTACHMENT_LIMITS)
      dataPatch.draftAttachments = merged.attachments
      droppedCount += merged.skipped
    }
    if (Object.keys(dataPatch).length) {
      crossRuntimes = updateSessionRuntimeAt(current.sessionRuntimes, crossKey, dataPatch, seed)
    }
  }

  let notices = current.notices
  if (droppedCount > 0) {
    notices = input.attachments
      ? pushNotice(notices, 'error', uiText('state.recover.attachmentsDropped', { count: droppedCount }))
      : pushNotice(notices, 'error', uiText('state.recover.imagesDropped', { count: droppedCount }))
  } else if (sameSession && input.notice && (recovery.queueRestore || restoredCount > 0)) {
    notices = pushNotice(notices, 'info', input.notice)
  }

  if (sameSession) {
    const patch: Partial<Store> = {}
    if (recovery.queueRestore) {
      patch.queueRestore = current.queueRestore ? `${recovery.queueRestore}\n${current.queueRestore}` : recovery.queueRestore
    }
    if (recovery.attachments !== current.attachments) {
      patch.attachments = recovery.attachments
      const key = composerDraftKey(current)
      if (key) patch.sessionRuntimes = writeDraftAttachments(current, key, recovery.attachments)
    }
    if (notices !== current.notices) patch.notices = notices
    return patch
  }

  const patch: Partial<Store> = {}
  if (crossRuntimes) patch.sessionRuntimes = crossRuntimes
  if (notices !== current.notices) patch.notices = notices
  return patch
}

export interface QueueReclaim {
  text: string
  images: QueueImageRef[]
  idPrefix: string
  notice: string
}

export const heldQueueReclaims = new Map<string, QueueReclaim>()

export function holdQueueReclaim(sessionId: string, recovery: QueueReclaim): void {
  const held = heldQueueReclaims.get(sessionId)
  heldQueueReclaims.set(
    sessionId,
    held
      ? { ...recovery, text: [held.text, recovery.text].filter(Boolean).join('\n'), images: [...held.images, ...recovery.images] }
      : recovery
  )
}

export function takeHeldQueueReclaim(state: Store): Partial<Store> | null {
  const viewing = viewingSessionId(state)
  if (!viewing) return null
  const held = heldQueueReclaims.get(viewing)
  if (!held) return null
  heldQueueReclaims.delete(viewing)
  return applyQueueRecovery(state, { ...held, sessionId: viewing, sameSession: true, notice: undefined })
}
