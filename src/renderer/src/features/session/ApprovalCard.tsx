import { useCallback, useEffect, useRef, type JSX, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { isModalOpen } from '../../lib/modalLayer'
import { formatCountdown } from '../../../../shared/ui-timeout'
import type { ApprovalChoice } from '../../../../shared/approval'
import { Badge, Button, Kbd } from '../../ui'
import { Icon } from './Icon'
import { useSessionText } from './text'
import { useApprovalSlotClaimed, useClaimApprovalSlot } from './approval-slot'
import {
  allowsPointerPress,
  classifyApprovalShortcut,
  createApprovalGate,
  isActivationKey,
  isApprovalCommitKey,
  isEditableElement,
  ownsApproval,
  type ApprovalGate
} from './approval-keys'

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
  const gateRef = useRef<ApprovalGate | null>(null)
  if (!gateRef.current) gateRef.current = createApprovalGate()
  useClaimApprovalSlot(inline ? current?.id : null)
  const claimed = useApprovalSlotClaimed(current?.id)
  const active = !!current && (inline || !claimed)

  const answer = useCallback(
    (choice: ApprovalChoice): void => {
      const request = current
      const id = request?.id
      if (!id) return
      if (!ownsApproval(useStore.getState().approvals, id)) return
      const gate = gateRef.current
      if (!gate || !gate.begin(id)) return
      const identity = request.owner || request.revision !== undefined
        ? { ...(request.owner ? { owner: request.owner } : {}), ...(request.revision !== undefined ? { revision: request.revision } : {}) }
        : undefined
      let result: Promise<unknown>
      try {
        result = Promise.resolve(answerApproval(id, choice, identity))
      } catch {
        gate.release(id)
        return
      }
      void result.catch(() => undefined).finally(() => gate.release(id))
    },
    [current, answerApproval]
  )

  useEffect(() => {
    if (!active) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      const card = cardRef.current
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
    if (!isActivationKey({ key: event.key, isComposing: native.isComposing, keyCode: native.keyCode })) return
    event.preventDefault()
    event.stopPropagation()
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
  const waited = current.createdAt ? formatCountdown(Math.max(0, Date.now() - current.createdAt)) : ''
  const showSource = !inline || !isCurrent || !!current.subagentId
  const clickOnly = (action: () => void) => (event: { pointerType?: string | null }): void => {
    if (!allowsPointerPress(event.pointerType)) return
    action()
  }

  return (
    <div
      className={`v3-approval ${risky ? 'risky' : ''}`}
      role="alertdialog"
      aria-label={current.title}
      data-testid="v3-approval"
      data-kind={current.kind}
      data-inline={inline ? '1' : undefined}
      ref={cardRef}
      onKeyDownCapture={onKeyDownCapture}
    >
      <div className="v3-approval-head">
        {risky ? <Icon name="alert" size={14} /> : null}
        <span className="v3-approval-title">{current.title}</span>
        {waited ? <span className="v3-approval-wait"><Icon name="clock" size={12} />{waited}</span> : null}
        {approvals.length > 1 ? <Badge data-testid="v3-approval-count">{t('approval.more', { n: approvals.length - 1 })}</Badge> : null}
      </div>

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

      {current.reasons.length ? (
        <ul className="v3-approval-reasons" data-testid="v3-approval-reasons" aria-label={zh ? '为什么需要确认' : 'Why this needs approval'}>
          {current.reasons.map((reason, i) => <li key={i}>{reason}</li>)}
        </ul>
      ) : null}

      {current.cwd ? <div className="v3-approval-cwd" title={current.cwd}>{tt('approvalCwd', { cwd: current.cwd })}</div> : null}

      {current.detail ? <pre className="v3-approval-detail" data-testid="v3-approval-detail" title={current.detail}>{current.detail}</pre> : null}

      {current.rememberDirs?.length ? <div className="v3-approval-dirs" title={current.rememberDirs.join('\n')}>{current.rememberDirs.join('  ·  ')}</div> : null}

      <div className="v3-approval-foot">
        <Button data-testid="v3-approval-deny" aria-keyshortcuts="Alt+N" onPress={clickOnly(() => answer('deny'))}>{t('approval.deny')}</Button>
        <span className="v3-approval-sp" />
        {current.canRemember && rememberLabel ? (
          <Button data-testid="v3-approval-remember" onPress={clickOnly(() => answer('remember'))}>{rememberLabel}</Button>
        ) : null}
        <Button variant="primary" data-testid="v3-approval-once" aria-keyshortcuts="Control+Enter Alt+Y" onPress={clickOnly(() => answer('once'))}>
          {t('approval.once')}
          <Kbd className="v3-approval-kbd">Ctrl ↵</Kbd>
        </Button>
      </div>
    </div>
  )
}
