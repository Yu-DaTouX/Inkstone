import type { Attachment, ExpectedRuntimeOwner, QueueItem, QueueState } from '../../../../shared/ipc'
import { stripIpcErrorPrefix } from '../../../../shared/ipc-error'
import { uiText } from '../../i18n/ui-text'
import type { QueueOp } from '../../features/composer/queue-plan'
import { markStopRequested } from '../../features/session/stop-intent'
import { requestStopConfirm, runStopFlow } from '../../features/session/stop-with-background'
import { composerSubmitIdentity, recoveryRuntimeFor, sameComposerView } from '../composer-recovery'
import type { SubmittingMessage } from '../submitting-messages'
import { terminalJobsForView, useTerminalJobs } from '../terminal-jobs'
import { viewIdentityOf } from '../view-identity'
import type { Store } from '../store'
import { applyQueueRecovery } from './queue-recovery'
import { EMPTY_QUEUE, hasComposerIdentity, nav, sessionActionTarget, submitRuntimeFor } from './runtime'
import { piCall, pushNotice, type SliceContext } from './shared'

export type PendingSend = {
  id: string
  sessionId: string | null
  ownerKey?: string
  navSeq?: number
  text: string
  images?: { data: string; mimeType: string }[]
}

export function blankViewKey(s: { activeRunnerId?: string | null }): string {
  return s.activeRunnerId ? `run:${s.activeRunnerId}` : ''
}

export function pendingSendsForView(
  s: Pick<Store, 'pendingSends' | 'peekedSessionId' | 'peekedPath' | 'session'> & { activeRunnerId?: string | null }
): PendingSend[] {
  const identity = viewIdentityOf(s)
  if (identity.sessionId) return s.pendingSends.filter((item) => item.sessionId === identity.sessionId)
  if (identity.peeked) return []
  const key = blankViewKey(s)
  return s.pendingSends.filter((item) => item.sessionId === null && (item.ownerKey ?? '') === key)
}

async function imageFingerprint(base64: string): Promise<string | null> {
  try {
    const at = globalThis.atob
    if (typeof at !== 'function') return null
    const bin = at(String(base64 ?? ''))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 32)
  } catch {
    return null
  }
}

async function collectSourceIds(attachments: Attachment[], sessionId: string): Promise<string[]> {
  const files: string[] = []
  const prints: Promise<string | null>[] = []
  for (const a of attachments) {
    if (a.kind === 'file') {
      if (a.path && !a.isDirectory) files.push(a.path)
      continue
    }
    if (!a.data) continue
    prints.push(imageFingerprint(a.data))
  }
  const out: string[] = []
  for (const fp of await Promise.all(prints)) if (fp) out.push(`image:${fp}`)
  if (files.length) {
    try {
      const refs = await window.yan.sources.verifyFiles({
        sessionId,
        entries: files.map((path) => ({ path }))
      })
      for (const r of refs) if (r?.sourceId) out.push(r.sourceId)
    } catch {
    }
  }
  return [...new Set(out)]
}

type QueueEditArg = QueueState | QueueOp

type QueueEditResult = { ok: boolean; error?: string; dropped?: QueueItem[] }

function queueEditRequest(arg: QueueEditArg, expected: ExpectedRuntimeOwner): Promise<QueueEditResult> {
  return (window.yan.queueEdit as unknown as (arg: QueueEditArg, expected: ExpectedRuntimeOwner) => Promise<QueueEditResult>)(arg, expected)
}

export type SendSlice = Pick<Store, 'queue' | 'pendingSends' | 'pendingSourceLinks' | 'submittingMessages' | 'send' | 'holdSend' | 'releaseSend' | 'discardSend' | 'restoreSend' | 'steerQueued' | 'removeQueued' | 'recoverComposerInput' | 'applyQueueOrder' | 'applyQueueOp' | 'abort' | 'abortTurn' | 'runBash' | 'abortBash'>

export function createSendSlice({ set, get }: SliceContext): SendSlice {
  const releasingSends = new Set<PendingSend>()
  const settleQueueEdit = async (sessionId: string | undefined, res: QueueEditResult): Promise<void> => {
    if (res.ok) return
    const dropped = res.dropped ?? []
    if (dropped.length) {
      const current = get()
      set(applyQueueRecovery(current, {
        sessionId,
        text: dropped.map((item) => item.text ?? '').filter((text) => text).join('\n'),
        images: dropped.flatMap((item) => item.images ?? []),
        idPrefix: 'queue-image',
        notice: uiText('state.queue.editFailedRestored')
      }))
    }
    set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.queueEditFailed')) })
  }
  return {
  queue: EMPTY_QUEUE,
  pendingSends: [],
  pendingSourceLinks: [],
  submittingMessages: [],
  send: async (text, images, mode) => {
    const target = composerSubmitIdentity(get())
    const attachments = get().attachments
    const submission: SubmittingMessage = {
      identity: target,
      message: { id: `submitting-${crypto.randomUUID()}`, role: 'user', text, images, timestamp: Date.now(), sourceCwd: get().session?.cwd },
      previousIds: get().messages.map((message) => message.id)
    }
    set({ submittingMessages: [...get().submittingMessages, submission] })
    try {
      const guardView = hasComposerIdentity(target)
      const earlySessionId = attachments.length && !get().pendingActivation ? get().session?.sessionId : undefined
      const earlySourceIds = earlySessionId ? collectSourceIds(attachments, earlySessionId) : null
      if (!(await get().ensureActivated(target))) return false
      if (guardView && !sameComposerView(get(), target)) return false
      const sessionId = get().session?.sessionId
      const sourceIds = !sessionId
        ? []
        : earlySourceIds && sessionId === earlySessionId
          ? await earlySourceIds
          : await collectSourceIds(attachments, sessionId)
      if (guardView && !sameComposerView(get(), target)) return false
      if (sourceIds.length) {
        set({ pendingSourceLinks: [...get().pendingSourceLinks, { sessionId: sessionId!, sourceIds }] })
      }
      const expected = await submitRuntimeFor(get, target)
      if (guardView && !sameComposerView(get(), target)) return false
      const res = expected === null
        ? { ok: false, error: uiText('state.error.sessionNotActivated') }
        : await piCall(() => window.yan.send(text, images, mode, expected))
      if (!res.ok) {
        if (sourceIds.length) {
          set({ pendingSourceLinks: get().pendingSourceLinks.filter((x) => x.sourceIds !== sourceIds) })
        }
        set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.sendFailed')) })
        return false
      }
      return true
    } finally {
      set({ submittingMessages: get().submittingMessages.filter((item) => item !== submission) })
    }
  },
  holdSend: (text, images) => {
    const list = get().pendingSends
    const sessionId = viewIdentityOf(get()).sessionId
    set({
      pendingSends: [
        ...list,
        {
          id: `ps-${Date.now().toString(36)}-${list.length}`,
          sessionId,
          ...(sessionId ? {} : { ownerKey: blankViewKey(get()), navSeq: nav.seq }),
          text,
          images
        }
      ]
    })
  },
  releaseSend: async (id, mode) => {
    const item = pendingSendsForView(get()).find((p) => p.id === id)
    if (!item) return
    if (releasingSends.has(item)) return
    releasingSends.add(item)
    try {
      const ok = await get().send(item.text, item.images, mode)
      if (ok) set({ pendingSends: get().pendingSends.filter((p) => p !== item) })
    } finally {
      releasingSends.delete(item)
    }
  },
  discardSend: (id) => {
    set({ pendingSends: get().pendingSends.filter((p) => p.id !== id) })
  },
  restoreSend: (id) => {
    const item = pendingSendsForView(get()).find((p) => p.id === id)
    if (!item || releasingSends.has(item)) return
    const sessionId = get().session?.sessionId
    const current = get()
    set({
      pendingSends: current.pendingSends.filter((p) => p.id !== id),
      ...applyQueueRecovery(current, {
        sessionId,
        text: item.text,
        images: item.images,
        idPrefix: 'pending-image'
      })
    })
  },
  steerQueued: async (queueId) => {
    const target = await sessionActionTarget(get)
    if (!target) {
      set({ notices: pushNotice(get().notices, 'error', uiText('state.error.sessionNotActivated')) })
      return
    }
    const res = await piCall(() => window.yan.steerQueued(queueId, target.expected))
    if (!res.ok) {
      set({
        notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.steerFailed'))
      })
    }
  },
  removeQueued: async (queueId) => {
    const sessionId = get().session?.sessionId
    const target = await sessionActionTarget(get)
    if (!target) {
      set({ notices: pushNotice(get().notices, 'error', uiText('state.error.sessionNotActivated')) })
      return
    }
    const res = await piCall(() => window.yan.removeQueued(queueId, target.expected))
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.removeQueuedFailed')) })
      return
    }
    const current = get()
    set(applyQueueRecovery(current, {
      sessionId,
      text: res.text ?? '',
      images: res.images,
      idPrefix: 'queue-image',
      notice: uiText('state.queue.withdrawn')
    }))
  },
  recoverComposerInput: (input) => {
    const current = get()
    const sameView = sameComposerView(current, input.identity)
    const draftRuntime = sameView ? undefined : recoveryRuntimeFor(current, input.identity) ?? undefined
    const draftKey = sameView ? undefined : draftRuntime ? undefined : input.identity.draftKey
    set(applyQueueRecovery(current, {
      sessionId: input.identity.sessionId,
      text: input.text,
      attachments: input.attachments,
      idPrefix: input.idPrefix ?? 'composer-recover',
      notice: input.notice,
      sameSession: sameView,
      draftRuntime,
      draftKey
    }))
  },
  applyQueueOrder: async (next) => {
    const sessionId = get().session?.sessionId
    const target = await sessionActionTarget(get)
    if (!target) return settleQueueEdit(sessionId, { ok: false, error: uiText('state.error.sessionNotActivated') })
    await settleQueueEdit(sessionId, await piCall(() => window.yan.queueEdit(next, target.expected)))
  },
  applyQueueOp: async (op) => {
    const sessionId = get().session?.sessionId
    const target = await sessionActionTarget(get)
    if (!target) return settleQueueEdit(sessionId, { ok: false, error: uiText('state.error.sessionNotActivated') })
    await settleQueueEdit(sessionId, await piCall(() => queueEditRequest(op, target.expected)))
  },
  abort: async () => {
    await runStopFlow({
      jobs: async () => {
        await useTerminalJobs.getState().load().catch(() => undefined)
        const { peekedSessionId, peekedPath, session } = get()
        return terminalJobsForView(useTerminalJobs.getState().jobs, { peekedSessionId, peekedPath, session })
      },
      confirm: requestStopConfirm,
      abortTurn: () => get().abortTurn(),
      stopJob: (id) => window.yan.terminal.stopJob(id)
    })
  },
  abortTurn: async () => {
    const sessionId = get().session?.sessionId
    markStopRequested(sessionId)
    try {
      const expected = await submitRuntimeFor(get, composerSubmitIdentity(get()))
      if (expected === null) return
      const cleared = await window.yan.abort(expected)
      if (cleared.error) set({ notices: pushNotice(get().notices, 'error', cleared.error) })
      const back = [...cleared.steering, ...cleared.followUp].filter(Boolean)
      const items = [...(cleared.items?.steering ?? []), ...(cleared.items?.followUp ?? [])]
      const current = get()
      const texts = items.length ? items.map((item) => item.text ?? '').filter((text) => text) : back
      if (texts.length || items.some((item) => item.images?.length)) {
        set(applyQueueRecovery(current, {
          sessionId,
          text: texts.join('\n'),
          images: items.flatMap((item) => item.images ?? []),
          idPrefix: 'queue-image',
          notice: uiText('state.queue.restored', { count: texts.length })
        }))
      }
    } catch (error) {
      set({ notices: pushNotice(get().notices, 'error', error instanceof Error && error.message ? stripIpcErrorPrefix(error.message) : uiText('state.error.unknownError')) })
    }
  },
  runBash: async (command, options) => {
    const target = composerSubmitIdentity(get())
    const guardView = hasComposerIdentity(target)
    if (!(await get().ensureActivated(target))) return { ok: false, error: uiText('state.error.sessionNotActivated') }
    if (guardView && !sameComposerView(get(), target)) return { ok: false, error: uiText('state.error.sessionSwitchedCommandSkipped') }
    const expected = await submitRuntimeFor(get, target)
    if (guardView && !sameComposerView(get(), target)) return { ok: false, error: uiText('state.error.sessionSwitchedCommandSkipped') }
    const res = expected === null
      ? { ok: false, error: uiText('state.error.sessionNotActivated') }
      : await piCall(() => window.yan.runBash(command, options, expected))
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.commandFailed')) })
    }
    return res
  },
  abortBash: async () => {
    const target = await sessionActionTarget(get)
    if (!target) return
    await window.yan.abortBash(target.expected)
    if (!target.current()) return
  },
  }
}
