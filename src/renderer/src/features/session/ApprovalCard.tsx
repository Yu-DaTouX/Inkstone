import { useCallback, useEffect, useRef, type JSX, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { isModalOpen } from '../../lib/modalLayer'
import { formatCountdown } from '../../../../shared/ui-timeout'
import type { ApprovalChoice } from '../../../../shared/approval'
import { Badge, Button } from '../../ui'
import { Icon, type SessionIconName } from './Icon'
import {
  allowsPointerPress,
  classifyApprovalShortcut,
  createApprovalGate,
  isActivationKey,
  ownsApproval,
  type ApprovalGate
} from './approval-keys'

export function ApprovalCard(): JSX.Element | null {
  const t = useT()
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

  const answer = useCallback(
    (choice: ApprovalChoice): void => {
      const id = current?.id
      if (!id) return
      if (!ownsApproval(useStore.getState().approvals, id)) return
      const gate = gateRef.current
      if (!gate || !gate.begin(id)) return
      let result: Promise<unknown>
      try {
        result = Promise.resolve(answerApproval(id, choice))
      } catch {
        gate.release(id)
        return
      }
      void result.catch(() => undefined).finally(() => gate.release(id))
    },
    [current, answerApproval]
  )

  useEffect(() => {
    if (!current) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (!cardRef.current?.contains(document.activeElement)) return
      event.preventDefault()
      answer('deny')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, answer])

  useEffect(() => {
    if (!current) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || !event.altKey || !['y', 'n'].includes(event.key.toLowerCase())) return
      const overlayOpen = isModalOpen() || [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="menu"], [role="listbox"]')]
        .some((element) => element.getClientRects().length > 0 && !cardRef.current?.contains(element))
      const chosen = classifyApprovalShortcut(event, overlayOpen)
      if (!chosen) return
      event.preventDefault()
      answer(chosen)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, answer])

  const onKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const native = event.nativeEvent
    if (!isActivationKey({ key: event.key, isComposing: native.isComposing, keyCode: native.keyCode })) return
    event.preventDefault()
    event.stopPropagation()
  }

  if (!current) return null

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
  const isShell = current.tool === 'bash' || current.tool === 'powershell'
  const icon: SessionIconName = risky ? 'alert' : isShell ? 'terminal' : 'shield'
  const rememberLabel = current.kind === 'outside' ? t('approval.rememberDirs') : ''
  const waited = current.createdAt ? formatCountdown(Math.max(0, Date.now() - current.createdAt)) : ''
  const clickOnly = (action: () => void) => (event: { pointerType?: string | null }): void => {
    if (!allowsPointerPress(event.pointerType)) return
    action()
  }

  return (
    <div className={`v3-approval ${risky ? 'risky' : ''}`} role="alertdialog" aria-label={current.title} data-testid="v3-approval" data-kind={current.kind} ref={cardRef} onKeyDownCapture={onKeyDownCapture}>
      <div className="v3-approval-head">
        <Icon name={icon} size={14} />
        <span className="v3-approval-title">{current.title}</span>
        {waited ? <span className="v3-approval-wait"><Icon name="clock" size={12} />{waited}</span> : null}
        {approvals.length > 1 ? <Badge data-testid="v3-approval-count">{t('approval.more', { n: approvals.length - 1 })}</Badge> : null}
      </div>

      <div className="v3-approval-source" data-testid="v3-approval-source">
        <span>{t('approval.source', { name: sourceName })}</span>
        {current.subagentId ? <span>{t('approval.childSource', { name: child?.model || current.subagentId })}</span> : null}
        {sourcePath ? <Button size="sm" variant="ghost" data-testid="v3-approval-view-source" onPress={() => void viewSource()}>{t('approval.viewSource')}</Button> : null}
      </div>

      {child?.task ? (
        <div className="v3-approval-why" data-testid="v3-approval-task" title={child.task}>
          <span className="v3-approval-why-label">{zh ? '子 Agent 任务' : 'Subagent task'}</span>
          <span>{child.task.split('\n').find((line) => line.trim())?.trim() ?? child.task}</span>
        </div>
      ) : null}

      {current.detail ? <pre className="v3-approval-detail" data-testid="v3-approval-detail" title={current.detail}>{current.detail}</pre> : null}

      {current.reasons.length ? (
        <div className="v3-approval-why-label" data-testid="v3-approval-reasons-label">{zh ? '为什么需要确认' : 'Why this needs approval'}</div>
      ) : null}
      {current.reasons.length ? (
        <ul className="v3-approval-reasons">
          {current.reasons.map((reason, i) => <li key={i}>{reason}</li>)}
        </ul>
      ) : null}

      {current.rememberDirs?.length ? <div className="v3-approval-dirs" title={current.rememberDirs.join('\n')}>{current.rememberDirs.join('  ·  ')}</div> : null}

      <div className="v3-approval-foot">
        <span className="v3-approval-cwd" title={current.cwd}>{current.cwd}</span>
        <span className="v3-approval-keys" aria-hidden>Alt+Y / Alt+N</span>
        <Button size="sm" data-testid="v3-approval-deny" onPress={clickOnly(() => answer('deny'))}>{t('approval.deny')}</Button>
        {current.canRemember && rememberLabel ? (
          <Button size="sm" data-testid="v3-approval-remember" onPress={clickOnly(() => answer('remember'))}>{rememberLabel}</Button>
        ) : null}
        <Button size="sm" variant="primary" data-testid="v3-approval-once" onPress={clickOnly(() => answer('once'))}>{t('approval.once')}</Button>
      </div>
    </div>
  )
}
