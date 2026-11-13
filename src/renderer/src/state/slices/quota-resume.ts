import type { QuotaWindow } from '../../../../shared/ipc'
import { blockedQuotaWindows, decideQuotaResume, QUOTA_RESUME_POLL_MS, QUOTA_RESUME_PROMPT } from '../../../../shared/quota-resume'
import { uiText } from '../../i18n/ui-text'
import { useStore, type Store } from '../store'
import { pushNotice, type SliceContext } from './shared'

let quotaResumeGen = 0

let quotaResumeTimer: ReturnType<typeof setTimeout> | undefined

export async function stopRetryWhenQuotaWindowFull(): Promise<void> {
  const state = useStore.getState()
  const provider = state.session?.model?.provider
  if (!provider) return
  const snapshot = await window.yan
    .providerQuota(provider, state.settings?.providerBudgets?.[provider])
    .catch(() => null)
  if (!snapshot?.windows?.length || snapshot.staleError) return
  if (!blockedQuotaWindows(snapshot.windows).length) return
  if (useStore.getState().session?.sessionId !== state.session?.sessionId) return
  await useStore.getState().abortRetry()
}

async function runQuotaResumeCheck(gen: number, known?: QuotaWindow[]): Promise<void> {
  const wait = useStore.getState().quotaResume
  if (gen !== quotaResumeGen || !wait) return
  let windows = known
  if (!windows) {
    try {
      const next = await window.yan.providerQuota(wait.provider, useStore.getState().settings?.providerBudgets?.[wait.provider])
      if (gen !== quotaResumeGen) return
      if (!next.supported) {
        quotaResumeGen++
        useStore.setState((s) => ({ quotaResume: null, notices: pushNotice(s.notices, 'info', uiText('state.quota.noWindows')) }))
        return
      }
      windows = next.staleError ? undefined : next.windows
    } catch {
      windows = undefined
    }
  }
  if (!windows?.length) {
    quotaResumeTimer = setTimeout(() => void runQuotaResumeCheck(gen), QUOTA_RESUME_POLL_MS)
    return
  }
  const decision = decideQuotaResume(windows, Date.now())
  if (!decision.ready) {
    useStore.setState({ quotaResume: { ...wait, resetAt: decision.resetAt } })
    quotaResumeTimer = setTimeout(() => void runQuotaResumeCheck(gen), Math.max(1000, decision.nextCheckAt - Date.now()))
    return
  }
  quotaResumeGen++
  useStore.setState({ quotaResume: null })
  if (useStore.getState().session?.sessionId !== wait.sessionId) {
    if (!wait.sessionFile) return
    await useStore.getState().switchSession(wait.sessionFile)
    if (useStore.getState().session?.sessionId !== wait.sessionId) return
  }
  if (useStore.getState().session?.isAgentRunning || useStore.getState().session?.isStreaming) return
  await useStore.getState().send(QUOTA_RESUME_PROMPT)
}

export type QuotaResumeSlice = Pick<Store, 'quotaResume' | 'armQuotaResume' | 'cancelQuotaResume'>

export function createQuotaResumeSlice({ set, get }: SliceContext): QuotaResumeSlice {
  return {
  quotaResume: null,
  armQuotaResume: async (ifWindowFull = false) => {
    const session = get().session
    const provider = session?.model?.provider
    if (!session || !provider) return false
    if (get().quotaResume) return true
    const armGen = quotaResumeGen
    const snapshot = await window.yan
      .providerQuota(provider, get().settings?.providerBudgets?.[provider])
      .catch(() => null)
    if (armGen !== quotaResumeGen) return !!get().quotaResume
    if (ifWindowFull) {
      if (!snapshot?.windows?.length || snapshot.staleError || !blockedQuotaWindows(snapshot.windows).length) return false
      if (get().quotaResume) return true
      await get().abortRetry()
    }
    if (!snapshot) {
      set({ notices: pushNotice(get().notices, 'error', uiText('state.error.unknownError')) })
      return false
    }
    if (!snapshot.windows?.length || snapshot.staleError) {
      set({ notices: pushNotice(get().notices, 'error', snapshot.staleError ?? snapshot.error ?? uiText('state.quota.noWindows')) })
      return false
    }
    const gen = ++quotaResumeGen
    set({
      quotaResume: {
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
        provider,
        armedAt: Date.now(),
        resetAt: decideQuotaResume(snapshot.windows, Date.now()).resetAt
      }
    })
    void runQuotaResumeCheck(gen, snapshot.windows)
    return true
  },
  cancelQuotaResume: () => {
    quotaResumeGen++
    clearTimeout(quotaResumeTimer)
    set({ quotaResume: null })
  },
  }
}
