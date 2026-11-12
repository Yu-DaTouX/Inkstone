import { useCallback, useEffect, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { isModalOpen } from '../../lib/modalLayer'
import { formatCountdown } from '../../../../shared/ui-timeout'
import { localizeApprovalText } from './approval-reason-text'
import { approvalHeadline, type ApprovalAnswerIdentity, type ApprovalChoice, type ApprovalRequest } from '../../../../shared/approval'
import { Button, Kbd } from '../../ui'
import { Card, CardActions, CardBody, CardCode, CardHead, CardMeta, CardStatus, CardTitle } from '../../ui/Card'
import { Icon } from './Icon'
import { useSessionText } from './text'
import { useApprovalSlotClaimed, useClaimApprovalSlot } from './approval-slot'
import {
  allowsPointerPress,
  APPROVAL_ARM_MS,
  classifyApprovalShortcut,
  createApprovalArming,
  createApprovalGate,
  isActivationKey,
  isApprovalCommitKey,
  isApprovalDetailRead,
  isApprovingChoice,
  isEditableElement,
  ownsApproval,
  requiresApprovalReadGate,
  revealHiddenChars,
  type ApprovalArming,
  type ApprovalGate
} from './approval-keys'
import { cardFocusKeysText, useTypingDeferredFocus } from './typing-guard'
import { isMacPlatform } from '../../app/shortcuts'
import { useTicker } from './subagent-actions'
import './approval.css'

function approvalFocusTarget(card: HTMLElement): HTMLElement {
  return card.querySelector<HTMLElement>('[data-testid="v3-approval-deny"]') ?? card
}

function approvalIdentity(request: ApprovalRequest): ApprovalAnswerIdentity | undefined {
  return request.owner || request.revision !== undefined
    ? { ...(request.owner ? { owner: request.owner } : {}), ...(request.revision !== undefined ? { revision: request.revision } : {}) }
    : undefined
}

function shortCwd(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : cwd
}

function hasMoreBelow(node: HTMLElement): boolean {
  return node.scrollHeight - node.scrollTop - node.clientHeight > 2
}

function overlayOutside(card: HTMLElement | null): boolean {
  return isModalOpen() || [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="menu"], [role="listbox"]')]
    .some((element) => element.getClientRects().length > 0 && !card?.contains(element))
}

export function ApprovalCard({ inline = false }: { inline?: boolean } = {}): JSX.Element | null {
  const t = useT()
  const tt = useSessionText()
  const zh = useI18n().lang !== 'en-US'
  const approvals = useStore((s) => s.approvals)
  const answerApproval = useStore((s) => s.answerApproval)
  const session = useStore((s) => s.session)
  const sessions = useStore((s) => s.sessions)
  const runners = useStore((s) => s.runners)
  const subagents = useStore((s) => s.subagents)
  const titles = useStore((s) => s.titles)
  const manualTitles = useStore((s) => s.manualTitles)
  const switchSession = useStore((s) => s.switchSession)
  const current = approvals[0]
  const cardRef = useRef<HTMLDivElement>(null)
  const detailRef = useRef<HTMLPreElement>(null)
  const feedbackRef = useRef<HTMLTextAreaElement>(null)
  const [bodyMore, setBodyMore] = useState(false)
  const gateRef = useRef<ApprovalGate | null>(null)
  if (!gateRef.current) gateRef.current = createApprovalGate()
  const armingRef = useRef<ApprovalArming | null>(null)
  if (!armingRef.current) armingRef.current = createApprovalArming()
  const [armed, setArmed] = useState(false)
  const [readId, setReadId] = useState<string | null>(null)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  useClaimApprovalSlot(inline ? current?.id : null)
  const claimed = useApprovalSlotClaimed(current?.id)
  const active = !!current && (inline || !claimed)
  const gated = !!current && active && requiresApprovalReadGate(current)
  const readThrough = !!current && readId === current.id
  const allowBlocked = gated && !readThrough
  const visibleDetail = revealHiddenChars(current?.detail ?? '')
  const batchable = current ? approvals.filter((item) => item.id === current.id || !requiresApprovalReadGate(item)) : []
  const deferred = useTypingDeferredFocus(cardRef, active ? current?.id : null, approvalFocusTarget, false)
  const now = useTicker(active && !!current?.createdAt)

  const answer = useCallback(
    (choice: ApprovalChoice, reason?: string): void => {
      const request = current
      const id = request?.id
      if (!id) return
      if (!ownsApproval(useStore.getState().approvals, id)) return
      if (isApprovingChoice(choice) && !armingRef.current?.isArmed(id)) return
      if (isApprovingChoice(choice) && requiresApprovalReadGate(request) && readId !== id) return
      const gate = gateRef.current
      if (!gate || !gate.begin(id)) return
      let result: Promise<unknown>
      try {
        result = Promise.resolve(answerApproval(id, choice, approvalIdentity(request), reason))
      } catch {
        gate.release(id)
        return
      }
      void result.catch(() => undefined).finally(() => gate.release(id))
    },
    [current, answerApproval, readId]
  )

  const allowBatch = useCallback((): void => {
    const request = current
    const id = request?.id
    if (!id) return
    const live = new Set(useStore.getState().approvals.map((item) => item.id))
    const batch = approvals.filter((item) => live.has(item.id) && (item.id === id || !requiresApprovalReadGate(item)))
    if (batch.length < 2 || !ownsApproval(batch, id)) return
    if (!armingRef.current?.isArmed(id)) return
    if (requiresApprovalReadGate(request) && readId !== id) return
    const gate = gateRef.current
    if (!gate) return
    for (const item of batch) {
      if (!gate.begin(item.id)) continue
      void Promise.resolve(answerApproval(item.id, 'once', approvalIdentity(item)))
        .catch(() => undefined)
        .finally(() => gate.release(item.id))
    }
  }, [current, approvals, answerApproval, readId])

  useEffect(() => {
    if (!active) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      const card = cardRef.current
      if (feedbackRef.current && event.target instanceof Node && feedbackRef.current.contains(event.target)) return
      if (event.key === 'Escape') {
        if (!card?.contains(document.activeElement)) return
        event.preventDefault()
        answer('deny')
        return
      }
      if (isApprovalCommitKey(event, {
        modalOpen: overlayOutside(card),
        insideCard: !!card?.contains(document.activeElement),
        editableFocus: isEditableElement(document.activeElement)
      })) {
        event.preventDefault()
        answer('once')
        return
      }
      if (!event.altKey || !['y', 'n'].includes(event.key.toLowerCase())) return
      const chosen = classifyApprovalShortcut(event, overlayOutside(card))
      if (!chosen) return
      event.preventDefault()
      answer(chosen)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, answer])

  const onKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const native = event.nativeEvent
    if (event.ctrlKey || event.metaKey) return
    if (isEditableElement(event.target as Element)) return
    if (!isActivationKey({ key: event.key, isComposing: native.isComposing, keyCode: native.keyCode })) return
    event.preventDefault()
    event.stopPropagation()
  }

  const armId = current?.id
  useEffect(() => {
    armingRef.current?.arm(armId)
    setArmed(false)
    setFeedbackOpen(false)
    setFeedback('')
    if (!armId) return undefined
    const timer = setTimeout(() => setArmed(true), APPROVAL_ARM_MS + 16)
    return () => clearTimeout(timer)
  }, [armId])

  const detailKey = current?.detail ?? ''
  useEffect(() => {
    if (!armId) return undefined
    if (!gated) {
      setReadId(armId)
      return undefined
    }
    const frame = requestAnimationFrame(() => {
      const node = detailRef.current
      if (!node || isApprovalDetailRead(node)) setReadId(armId)
    })
    return () => cancelAnimationFrame(frame)
  }, [gated, armId, detailKey])

  useEffect(() => {
    const node = cardRef.current?.querySelector<HTMLElement>('.v3-approval-body')
    if (!node) return undefined
    const measure = (): void => setBodyMore(hasMoreBelow(node))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    for (const child of node.children) observer.observe(child)
    return () => observer.disconnect()
  }, [armId, feedbackOpen, active])

  const onDetailScroll = (event: React.UIEvent<HTMLPreElement>): void => {
    if (armId && isApprovalDetailRead(event.currentTarget)) setReadId(armId)
  }

  if (!current || !active) return null

  const child = current.subagentId ? subagents.find((run) => run.id === current.subagentId) : undefined
  const originRunId = child?.parentRunId ?? current.runId
  const runner = runners.find((run) => originRunId && (run.runId ?? run.id) === originRunId)
  const originSessionId = child?.parentSessionId ?? current.sessionId
  const isCurrent = !!originSessionId && [session?.sessionId, session?.conversationId].includes(originSessionId)
  const source = sessions.find((item) => (originSessionId && item.id === originSessionId) || (runner?.sessionFile && item.path === runner.sessionFile))
  const sourcePath = source?.path ?? runner?.sessionFile ?? (isCurrent ? session?.conversationFile ?? session?.sessionFile : undefined)
  const sourceName = source
    ? manualTitles[source.id] || titles[source.id] || source.title
    : isCurrent ? t('approval.currentSource') : t('approval.unknownSource')
  const viewSource = async (): Promise<void> => {
    if (!sourcePath) return
    if (sourcePath !== (session?.conversationFile ?? session?.sessionFile)) await switchSession(sourcePath)
  }

  const risky = current.kind === 'danger' || current.kind === 'outside' || current.kind === 'delete'
  const rememberLabel = current.kind === 'outside' ? t('approval.rememberDirs') : ''
  const waited = current.createdAt ? formatCountdown(Math.max(0, now - current.createdAt)) : ''
  const showSource = !isCurrent || !!current.subagentId
  const lang = zh ? 'zh-CN' : 'en-US'
  const headline = localizeApprovalText(approvalHeadline(current), lang)
  const reasons = (approvalHeadline(current) === current.title ? current.reasons : current.reasons.slice(1)).map((reason) => localizeApprovalText(reason, lang))
  const clickOnly = (action: () => void) => (event: { pointerType?: string | null }): void => {
    if (!allowsPointerPress(event.pointerType)) return
    action()
  }
  const denyWithFeedback = (): void => {
    answer('deny', feedback.trim() || undefined)
  }

  return (
    <Card
      ref={cardRef}
      padding="md"
      tone={risky ? 'ask' : undefined}
      className={`v3-approval ${risky ? 'risky' : ''}`}
      role="alertdialog"
      aria-label={headline}
      data-testid="v3-approval"
      data-kind={current.kind}
      data-inline={inline ? '1' : undefined}
      data-armed={armed ? '1' : '0'}
      data-read={allowBlocked ? '0' : '1'}
      onKeyDownCapture={onKeyDownCapture}
    >
      <CardHead className="v3-approval-head">
        <CardStatus tone="ask" icon={<Icon name={risky ? 'alert' : 'shield'} size={14} />}>{tt('awaitApproval')}</CardStatus>
        <CardTitle className="v3-approval-title" title={headline === current.title ? undefined : `${current.title}\n${current.reasons[0]}`}>{headline}</CardTitle>
        {waited || approvals.length > 1 ? (
          <CardMeta>
            {waited ? <span className="v3-approval-wait"><Icon name="clock" size={12} /><span className="ui-num">{waited}</span></span> : null}
            {approvals.length > 1 ? <span data-testid="v3-approval-count">{t('approval.more', { n: approvals.length - 1 })}</span> : null}
          </CardMeta>
        ) : null}
      </CardHead>

      <CardBody className="v3-approval-body" data-more={bodyMore || undefined} onScroll={(event) => setBodyMore(hasMoreBelow(event.currentTarget))}>
        {showSource ? (
          <div className="v3-approval-source" data-testid="v3-approval-source">
            <span>{t('approval.source', { name: sourceName })}</span>
            {current.subagentId ? <span>{t('approval.childSource', { name: child?.model || current.subagentId })}</span> : null}
            {sourcePath && !isCurrent ? <Button size="sm" variant="ghost" data-testid="v3-approval-view-source" onPress={() => void viewSource()}>{t('approval.viewSource')}</Button> : null}
          </div>
        ) : null}

        {child?.task ? (
          <div className="v3-approval-why" data-testid="v3-approval-task" title={child.task}>
            <span className="v3-approval-why-label">{zh ? '子 Agent 任务' : 'Subagent task'}</span>
            <span>{child.task.split('\n').find((line) => line.trim())?.trim() ?? child.task}</span>
          </div>
        ) : null}

        {reasons.length ? (
          <ul className="v3-approval-reasons" data-testid="v3-approval-reasons" aria-label={zh ? '为什么需要确认' : 'Why this needs approval'}>
            {reasons.map((reason, i) => <li key={i}>{reason}</li>)}
          </ul>
        ) : null}

        {current.cwd ? <div className="v3-approval-cwd" title={current.cwd}>{tt('approvalCwd', { cwd: shortCwd(current.cwd) })}</div> : null}

        {current.detail ? (
          <CardCode
            ref={detailRef}
            tone={risky ? 'ask' : undefined}
            className="v3-approval-detail"
            data-testid="v3-approval-detail"
            title={visibleDetail}
            tabIndex={allowBlocked ? 0 : undefined}
            onScroll={onDetailScroll}
          >
            {visibleDetail}
          </CardCode>
        ) : null}

        {allowBlocked ? (
          <p className="v3-approval-read-hint" role="status" data-testid="v3-approval-read-hint">
            {t('approval.readHint')}
          </p>
        ) : null}

        {deferred ? (
          <p className="v3-typing-defer" role="status" data-testid="v3-typing-defer">
            {t('session.typingDefer.hint', { keys: cardFocusKeysText(isMacPlatform()) })}
          </p>
        ) : null}

        {current.rememberDirs?.length ? <div className="v3-approval-dirs" title={current.rememberDirs.join('\n')}>{current.rememberDirs.join('  ·  ')}</div> : null}

        {feedbackOpen ? (
          <div className="v3-approval-feedback" data-testid="v3-approval-feedback">
            <textarea
              ref={feedbackRef}
              autoFocus
              className="v3-approval-feedback-input"
              value={feedback}
              rows={3}
              spellCheck={false}
              aria-label={t('approval.feedbackLabel')}
              placeholder={t('approval.feedbackPh')}
              data-testid="v3-approval-feedback-input"
              onChange={(event) => setFeedback(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
                if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  setFeedbackOpen(false)
                  return
                }
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault()
                  event.stopPropagation()
                  denyWithFeedback()
                }
              }}
            />
            <div className="v3-approval-feedback-actions">
              <Button data-testid="v3-approval-feedback-deny" onPress={clickOnly(denyWithFeedback)}>{t('approval.feedbackDeny')}</Button>
              <Button
                variant="ghost"
                data-testid="v3-approval-feedback-cancel"
                onPress={() => {
                  setFeedback('')
                  setFeedbackOpen(false)
                }}
              >
                {t('approval.feedbackCancel')}
              </Button>
            </div>
          </div>
        ) : null}
      </CardBody>

      <CardActions
        className="v3-approval-foot"
        lead={
          <>
            {feedbackOpen ? null : (
              <Button data-testid="v3-approval-deny" aria-keyshortcuts="Alt+N" onPress={clickOnly(denyWithFeedback)}>{t('approval.deny')}</Button>
            )}
            {feedbackOpen ? null : (
              <Button
                variant="ghost"
                data-testid="v3-approval-feedback-open"
                title={t('approval.feedbackTip')}
                onPress={() => setFeedbackOpen(true)}
              >
                {t('approval.feedback')}
              </Button>
            )}
          </>
        }
      >
        {current.canRemember && rememberLabel ? (
          <Button data-testid="v3-approval-remember" isDisabled={allowBlocked} onPress={clickOnly(() => answer('remember'))}>{rememberLabel}</Button>
        ) : null}
        {batchable.length > 1 ? (
          <Button
            data-testid="v3-approval-batch"
            title={batchable.map((item) => item.title).join('\n')}
            isDisabled={allowBlocked}
            onPress={clickOnly(allowBatch)}
          >
            {t('approval.allowBatch')}
          </Button>
        ) : null}
        {current.kind !== 'move' ? (
          <Button data-testid="v3-approval-session" isDisabled={allowBlocked} onPress={clickOnly(() => answer('session'))}>{t('approval.session')}</Button>
        ) : null}
        <Button variant="primary" data-testid="v3-approval-once" aria-keyshortcuts="Control+Enter Alt+Y" isDisabled={allowBlocked} onPress={clickOnly(() => answer('once'))}>
          {t('approval.once')}
          <Kbd className="v3-approval-kbd">Ctrl ↵</Kbd>
        </Button>
      </CardActions>
    </Card>
  )
}
