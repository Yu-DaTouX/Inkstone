import { useCallback, useEffect, useMemo, useState } from 'react'
import type { UIMessage } from '../../../../shared/ipc'
import { useStore, type Store } from '../../state/store'
import { displayedSessionOf, sameSplitSession, type SplitSessionRef } from '../../state/split-view'
import { newestMessages } from '../../state/split-snapshots'
import { sameComposerView, type ComposerSubmitIdentity } from '../../state/composer-recovery'
import type { TurnSubagentScope } from '../../state/subagent-view'
import type { TurnScope } from './turn-scope'
import type { SessionViewIdentity } from './view-state'

export interface SessionPaneBinding {
  target: SplitSessionRef
  live: boolean
}

export type SessionViewData = Pick<
  Store,
  | 'messages'
  | 'session'
  | 'questionLog'
  | 'questionLogSession'
  | 'approvalLog'
  | 'approvalLogSession'
  | 'runTail'
  | 'peekedSessionId'
  | 'peekedPath'
  | 'settings'
  | 'switchLoading'
  | 'submittingMessages'
>

export interface SessionViewSource extends SessionViewData {
  readOnly: boolean
  ownsSubmission: (identity: ComposerSubmitIdentity) => boolean
  view?: SessionViewIdentity
  scrollKey?: string
  streamingId?: string
  subagentScope?: TurnSubagentScope
  turnScope: TurnScope | null
}

const NO_MESSAGES: UIMessage[] = []
const NO_QUESTION_LOG: Store['questionLog'] = []
const NO_APPROVAL_LOG: Store['approvalLog'] = []
const ownsStoreSubmission = (identity: ComposerSubmitIdentity): boolean => sameComposerView(useStore.getState(), identity)

const paneKey = (target: SplitSessionRef): string => target.path ?? target.sessionId ?? ''

function storeOwnsPane(state: Store, target: SplitSessionRef, peerHasMessages: boolean): boolean {
  if (state.peekedSessionId || state.peekedPath) return true
  if (!sameSplitSession(displayedSessionOf(state), target)) return false
  return !state.switchLoading || !peerHasMessages
}

export function useSessionViewSource(pane?: SessionPaneBinding): SessionViewSource {
  const hasPane = !!pane
  const target = pane?.target
  const live = pane?.live ?? true
  const runtime = useStore((s) => (target?.sessionId ? s.sessionRuntimes[target.sessionId] : undefined))
  const cached = runtime?.messages
  const [history, setHistory] = useState<UIMessage[] | null>(null)
  const peerMessages = useMemo(() => newestMessages(cached, history ?? undefined) ?? NO_MESSAGES, [cached, history])
  const peerHasMessages = peerMessages.length > 0
  const fromStore = useStore((s) => !hasPane || (live && !!target && storeOwnsPane(s, target, peerHasMessages)))

  const targetPath = target?.path
  useEffect(() => {
    if (!hasPane || fromStore || cached?.length || !targetPath) return undefined
    let alive = true
    void window.yan
      .peekSession(targetPath)
      .then((peek) => { if (alive) setHistory(peek?.messages ?? []) })
      .catch(() => { if (alive) setHistory([]) })
    return () => { alive = false }
  }, [hasPane, fromStore, cached?.length, targetPath])

  const messages = useStore((s) => (fromStore ? s.messages : NO_MESSAGES))
  const session = useStore((s) => (fromStore ? s.session : null))
  const questionLog = useStore((s) => (fromStore ? s.questionLog : NO_QUESTION_LOG))
  const questionLogSession = useStore((s) => (fromStore ? s.questionLogSession : null))
  const approvalLog = useStore((s) => (fromStore ? s.approvalLog : NO_APPROVAL_LOG))
  const approvalLogSession = useStore((s) => (fromStore ? s.approvalLogSession : null))
  const runTail = useStore((s) => (fromStore ? s.runTail : null))
  const peekedSessionId = useStore((s) => (fromStore ? s.peekedSessionId : null))
  const peekedPath = useStore((s) => (fromStore ? s.peekedPath : null))
  const switchLoading = useStore((s) => (fromStore ? s.switchLoading : false))
  const settings = useStore((s) => s.settings)
  const submittingMessages = useStore((s) => s.submittingMessages)

  const targetId = target?.sessionId
  const ownsPeerSubmission = useCallback(
    (identity: ComposerSubmitIdentity) => sameSplitSession(identity, { sessionId: targetId, path: targetPath }),
    [targetId, targetPath]
  )
  const peerSession = runtime?.session ?? null
  const summaryCwd = useStore((s) => {
    if (!target) return undefined
    const summary = s.sessions.find((item) => !!target.sessionId && item.id === target.sessionId) ?? s.sessions.find((item) => !!target.path && sameSplitSession({ path: item.path }, { path: target.path }))
    return summary?.cwd
  })
  const peerCwd = peerSession?.cwd ?? summaryCwd
  const turnScope = useMemo<TurnScope>(() => ({ messages: peerMessages, session: peerSession, ...(peerCwd ? { cwd: peerCwd } : {}) }), [peerMessages, peerSession, peerCwd])
  const running = !!peerSession?.isAgentRunning || !!peerSession?.isStreaming
  const peerView = useMemo<SessionViewIdentity | undefined>(
    () => (target ? { sessionId: target.sessionId ?? null, sessionFile: target.path ?? null, key: paneKey(target) } : undefined),
    [target?.sessionId, target?.path]
  )
  const peerScope = useMemo<TurnSubagentScope | undefined>(
    () => (targetId ? { sessionIds: [targetId] } : undefined),
    [targetId]
  )

  return useMemo<SessionViewSource>(() => {
    if (!hasPane || !target || !peerView) {
      return { messages, session, questionLog, questionLogSession, approvalLog, approvalLogSession, runTail, peekedSessionId, peekedPath, settings, switchLoading, submittingMessages, readOnly: false, ownsSubmission: ownsStoreSubmission, turnScope: null }
    }
    if (fromStore) {
      return { messages, session, questionLog, questionLogSession, approvalLog, approvalLogSession, runTail, peekedSessionId, peekedPath, settings, switchLoading, submittingMessages, readOnly: false, ownsSubmission: ownsStoreSubmission, scrollKey: paneKey(target), turnScope: null }
    }
    return {
      messages: peerMessages,
      session: peerSession,
      questionLog: NO_QUESTION_LOG,
      questionLogSession: null,
      approvalLog: NO_APPROVAL_LOG,
      approvalLogSession: null,
      runTail: null,
      peekedSessionId: null,
      peekedPath: null,
      settings,
      switchLoading: false,
      submittingMessages,
      readOnly: true,
      ownsSubmission: ownsPeerSubmission,
      view: peerView,
      scrollKey: paneKey(target),
      streamingId: running && peerMessages.length ? peerMessages[peerMessages.length - 1].id : undefined,
      subagentScope: peerScope,
      turnScope
    }
  }, [hasPane, target, fromStore, messages, session, questionLog, questionLogSession, approvalLog, approvalLogSession, runTail, peekedSessionId, peekedPath, settings, switchLoading, submittingMessages, peerMessages, peerSession, running, ownsPeerSubmission, peerView, peerScope, turnScope])
}
