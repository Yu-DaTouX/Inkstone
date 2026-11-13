import { uiText } from '../../i18n/ui-text'
import { updateSessionRuntime } from '../session-runtime'
import type { Store } from '../store'
import { runtimeForState } from './runtime'
import { pushNotice, type SliceContext } from './shared'

export type UiRequestsSlice = Pick<Store, 'approvals' | 'uiRequests' | 'questionLogs' | 'approvalLogs' | 'uiCollapsed' | 'uiDrafts' | 'answerApproval' | 'answerUi' | 'setUiCollapsed' | 'setUiDraft' | 'extendUi' | 'startUiTimer' | 'dismissRequest'>

export function createUiRequestsSlice({ set, get }: SliceContext): UiRequestsSlice {
  return {
  approvals: [],
  uiRequests: [],
  questionLogs: {},
  approvalLogs: {},
  uiCollapsed: false,
  uiDrafts: {},
  answerApproval: async (id, choice, identity, feedback) => {
    if (!get().approvals.some((item) => item.id === id)) return false
    set({ approvals: get().approvals.filter((item) => item.id !== id) })
    const reconcile = async (): Promise<boolean> => {
      try {
        const pending = await window.yan.pendingApprovals()
        const have = new Set(get().approvals.map((item) => item.id))
        const back = pending.filter((item) => !have.has(item.id))
        if (back.length) set({ approvals: [...get().approvals, ...back].sort((a, b) => a.createdAt - b.createdAt) })
        return pending.some((item) => item.id === id)
      } catch {
        return false
      }
    }
    const failed = async (): Promise<boolean> => {
      const stillPending = await reconcile()
      if (stillPending) set({ notices: pushNotice(get().notices, 'error', uiText('state.error.approvalAnswerFailed')) })
      return false
    }
    try {
      const res = await window.yan.answerApproval(id, choice, identity, feedback)
      if (!res || res.ok !== true) return await failed()
      return true
    } catch {
      return await failed()
    }
  },
  answerUi: async (res) => {
    const result = await window.yan.respondUi(res).catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    if (!result || result.ok !== true) {
      set({ notices: pushNotice(get().notices, 'error', result?.error || uiText('state.error.answerFailed')) })
      return false
    }
    const drafts = { ...get().uiDrafts }
    delete drafts[res.id]
    const next = get().uiRequests.filter((r) => r.id !== res.id)
    const runtime = runtimeForState(get())
    set({
      uiRequests: next,
      uiDrafts: drafts,
      ...(runtime
        ? { sessionRuntimes: updateSessionRuntime(get().sessionRuntimes, runtime, { uiRequests: next }) }
        : {})
    })
    return true
  },
  setUiCollapsed: (v) => set({ uiCollapsed: v }),
  setUiDraft: (id, value) => set({ uiDrafts: { ...get().uiDrafts, [id]: value } }),
  extendUi: async (id, extraMs) => {
    const res = await window.yan.extendUi(id, extraMs)
    if (!res.ok) return false
    if (res.deadline) {
      set({
        uiRequests: get().uiRequests.map((r) =>
          r.id === id ? { ...r, timeout: res.timeout ?? r.timeout, deadline: res.deadline } : r
        )
      })
    }
    return true
  },
  startUiTimer: async (id) => {
    const res = await window.yan.startUiTimer(id).catch(() => null)
    if (!res?.ok || !res.deadline) return false
    set({
      uiRequests: get().uiRequests.map((r) =>
        r.id === id ? { ...r, timeout: res.timeout ?? r.timeout, deadline: res.deadline } : r
      )
    })
    return true
  },
  dismissRequest: (id) => {
    const drafts = { ...get().uiDrafts }
    delete drafts[id]
    const next = get().uiRequests.filter((r) => r.id !== id)
    const runtime = runtimeForState(get())
    set({
      uiRequests: next,
      uiDrafts: drafts,
      ...(runtime
        ? { sessionRuntimes: updateSessionRuntime(get().sessionRuntimes, runtime, { uiRequests: next }) }
        : {})
    })
  },
  }
}
