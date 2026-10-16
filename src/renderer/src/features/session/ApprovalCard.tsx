/**
 * 批准卡片（危险操作确认）。
 *
 * 与 v2 `chat/ApprovalCard.tsx` 的**安全语义逐条对齐**（CONTRACT 要求）：
 *   · `Enter` / `Space` 的默认激活在卡片容器的捕获阶段就被拦掉，按钮聚焦也不会误放行；
 *     允许 / 拒绝只能由明确点击（或 `Alt+Y` / `Alt+N`）触发，不能只靠「不注册回调」保证；
 *   · 没有「全部允许」；
 *   · 归属按请求自带的 `sessionId` / `runId` 匹配并显示来源，不拿当前焦点会话去猜；
 *   · 一次只显示最早的一条，其余在角上计数；关不掉，避免误当答复；
 *   · 「允许并记住此目录」只在 `canRemember` 且为项目外写入时出现。
 */
import { useCallback, useEffect, useRef, type JSX, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { isModalOpen } from '../../lib/modalLayer'
import { formatCountdown } from '../../../../shared/ui-timeout'
import type { ApprovalChoice } from '../../../../shared/approval'
import { Button } from '../../ui'
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
  /* 在途闸门：同一条请求答复期间不能再次答复（连按 / 键重复） */
  const gateRef = useRef<ApprovalGate | null>(null)
  if (!gateRef.current) gateRef.current = createApprovalGate()

  /*
   * 唯一答复入口：先用 store 里的当前请求核对归属（只认最早那条，相邻卡片不跳号），
   * 再过在途闸门去重。答复失败只释放闸门，不自动允许也不撤销。
   */
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

  /* Esc 只在焦点位于卡片内时等于「拒绝」；输入框焦点时 Esc 留给中止运行 */
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

  /* Alt+Y / Alt+N：全局可用；模态 / 弹窗打开时不响应；**不**注册任何 Enter / 单键 Y/N */
  useEffect(() => {
    if (!current) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || !event.altKey || !['y', 'n'].includes(event.key.toLowerCase())) return
      // 非模态的运行浮层/菜单同样不能让快捷键穿透到背后的批准卡。
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

  /*
   * Enter / Space 的默认激活在捕获阶段直接拦掉：preventDefault 挡浏览器原生 click，
   * stopPropagation 让按钮自己的键盘 press 也不触发。这样即使「允许」按钮已聚焦、
   * 或 press 的 pointerType 判不出来，也不会用键盘误放行；键盘路径只剩 Alt+Y / Alt+N。
   */
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
  /*
   * 只接受**明确点击**：键盘触发的 press（`pointerType === 'keyboard'`）一律忽略。
   * 读屏 / `element.click()` 的 `virtual` 仍算明确点击。键盘路径只有 `Alt+Y` / `Alt+N`；
   * `Enter` / `Space` 另有捕获阶段拦截兜底。
   */
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
        {approvals.length > 1 ? <span className="v3-badge" data-testid="v3-approval-count">{t('approval.more', { n: approvals.length - 1 })}</span> : null}
      </div>

      <div className="v3-approval-source" data-testid="v3-approval-source">
        <span>{t('approval.source', { name: sourceName })}</span>
        {current.subagentId ? <span>{t('approval.childSource', { name: child?.model || current.subagentId })}</span> : null}
        {sourcePath ? <Button size="sm" variant="ghost" data-testid="v3-approval-view-source" onPress={() => void viewSource()}>{t('approval.viewSource')}</Button> : null}
      </div>

      {child?.task ? (
        <div className="v3-approval-why" data-testid="v3-approval-task" title={child.task}>
          <span className="v3-approval-why-label">{zh ? '子 Agent 任务' : 'Sub-agent task'}</span>
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
        <span className="v3-code-sp" />
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
