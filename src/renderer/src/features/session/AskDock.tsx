import { useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useStore } from '../../state/store'
import { Badge, Button } from '../../ui'
import { motionAllowed } from '../../ui/motion-hooks'
import { Icon } from './Icon'
import { useSessionText } from './text'
import { ComposerBanner } from '../../t3/components/chat/ComposerBanner'
import { ApprovalCard } from './ApprovalCard'
import { BrowserHandoffCard } from './BrowserHandoffCard'
import { QuestionCard } from './QuestionCard'
import { approvalMatchesView, sessionViewIdentity, viewMatchesProjectedSession } from './view-state'

export const ASK_DOCK_SELECTOR = '[data-ask-dock]'
const ASK_DOCK_OVERLAP = 17

const ASK_FOCUS_ORDER = ['.v3-qoption-row', '.v3-qoption', 'textarea', 'input', '.ui-card [tabindex]', 'button:not([disabled])']

export function focusAskDock(): void {
  const store = useStore.getState()
  if (store.uiCollapsed) store.setUiCollapsed(false)
  requestAnimationFrame(() => {
    const dock = document.querySelector<HTMLElement>(ASK_DOCK_SELECTOR)
    if (!dock) return
    const target = ASK_FOCUS_ORDER.map((selector) => dock.querySelector<HTMLElement>(selector)).find((node) => !!node)
    target?.focus({ preventScroll: true })
  })
}

const FOCUS_SETTLE_MAX_MS = 1500

export function focusAskDockFor(sessionId: string): void {
  const started = performance.now()
  const check = (): void => {
    if (useStore.getState().session?.sessionId === sessionId && document.querySelector(ASK_DOCK_SELECTOR)) {
      focusAskDock()
      return
    }
    if (performance.now() - started < FOCUS_SETTLE_MAX_MS) window.setTimeout(check, 50)
  }
  check()
}

export function AskDock(): JSX.Element | null {
  const session = useStore((s) => s.session)
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const peekedPath = useStore((s) => s.peekedPath)
  const approval = useStore((s) => s.approvals[0])
  const approvalSubagentParent = useStore((s) => {
    const id = s.approvals[0]?.subagentId
    return id ? (s.subagents.find((run) => run.id === id)?.parentSessionId ?? null) : null
  })
  const asking = useStore((s) => s.uiRequests.length > 0)
  const view = useMemo(
    () => sessionViewIdentity({ peekedSessionId, peekedPath, session }),
    [peekedSessionId, peekedPath, session]
  )
  const viewActive = viewMatchesProjectedSession(view, session)
  const handoff = useStore((s) => {
    const browser = (view.sessionId ? s.browserStates?.[view.sessionId] : undefined) ?? s.browserState
    const request = browser?.userControl ? browser.userControlRequest : undefined
    return !!request && (!request.sessionId || request.sessionId === view.sessionId)
  })
  const showApproval =
    !!approval &&
    (viewActive ||
      approvalMatchesView(
        approval,
        approval.subagentId && approvalSubagentParent ? [{ id: approval.subagentId, parentSessionId: approvalSubagentParent }] : [],
        view
      ))
  const showQuestion = viewActive && asking
  const showHandoff = viewActive && handoff
  const shown = showApproval || showQuestion || showHandoff
  const lastHeight = useRef(0)
  const wasShown = useRef(false)
  const [leaving, setLeaving] = useState<number | null>(null)
  const [leaveGen, setLeaveGen] = useState(0)
  useLayoutEffect(() => {
    if (shown) {
      wasShown.current = true
      lastHeight.current = document.querySelector<HTMLElement>(ASK_DOCK_SELECTOR)?.offsetHeight ?? lastHeight.current
      setLeaving(null)
      return
    }
    if (!wasShown.current) return
    wasShown.current = false
    if (lastHeight.current > 0 && motionAllowed()) {
      setLeaving(lastHeight.current)
      setLeaveGen((n) => n + 1)
    }
  })
  useLayoutEffect(() => {
    if (leaving === ASK_DOCK_OVERLAP) {
      const timer = window.setTimeout(() => setLeaving(null), 400)
      return () => window.clearTimeout(timer)
    }
    if (leaving === null) return
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => setLeaving(ASK_DOCK_OVERLAP)))
    return () => cancelAnimationFrame(frame)
  }, [leaveGen, leaving])
  if (!shown) {
    if (leaving === null) return null
    return <div key={leaveGen} className="ask-dock-leave" data-composer-banner-surface="attached" style={{ height: leaving }} aria-hidden="true" onTransitionEnd={() => setLeaving(null)} />
  }
  return (
    <ComposerBanner.Root className="ask-dock" data-ask-dock="true" data-testid="v3-ask-dock">
      <span className="ask-dock-edge" aria-hidden="true" />
      <div className="ask-dock-list">
        {showApproval ? <ApprovalCard /> : null}
        {showQuestion ? <QuestionCard /> : null}
        {showHandoff ? <BrowserHandoffCard sessionId={view.sessionId} /> : null}
      </div>
    </ComposerBanner.Root>
  )
}

export function AskPill({ kind, title }: { kind: 'answer' | 'approval'; title?: string }): JSX.Element {
  const tt = useSessionText()
  return (
    <Button size="xs" variant="ghost" className="v3-ask-pill" data-kind={kind} data-testid="v3-ask-pill" onPress={focusAskDock}>
      {kind === 'approval'
        ? <Badge tone="ask" role="img" aria-label={tt('awaitApproval')} title={tt('awaitApproval')}><Icon name="shield" size={12} /></Badge>
        : <Badge tone="ask">{tt('awaitAnswer')}</Badge>}
      {title ? <span className="v3-ask-pill-title">{title}</span> : null}
      <span aria-hidden="true">↓</span>
    </Button>
  )
}
