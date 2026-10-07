import { useEffect, useRef } from 'react'
import { Icon, type IconName } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Button } from '../ui'

/**
 * 批准卡片：宿主要问用户时，在输入框上方内嵌出现（取代原生弹窗）。
 *
 * 一次只显示最早的一条，其余排队并在角上计数。没有「点外面关闭」：
 * 关不掉的卡片才不会被误当成答复；Esc 等同于「拒绝」（失败方向安全）。
 * 不抢输入框焦点：用户可能正在打字，卡片靠 role=alertdialog 与视觉强调引起注意。
 */
export function ApprovalCard() {
  const t = useT()
  const approvals = useStore((s) => s.approvals)
  const answerApproval = useStore((s) => s.answerApproval)
  const current = approvals[0]
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!current) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      /* 只在焦点位于卡片内时响应，避免与输入框里的 Esc（中止运行）抢键 */
      if (!cardRef.current?.contains(document.activeElement)) return
      event.preventDefault()
      void answerApproval(current.id, 'deny')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, answerApproval])

  if (!current) return null

  const risky = current.kind === 'danger' || current.kind === 'outside' || current.kind === 'delete'
  const isShell = current.tool === 'bash' || current.tool === 'powershell'
  const icon: IconName = risky ? 'alert-circle' : isShell ? 'terminal' : 'shield-check'
  const rememberLabel = current.kind === 'outside' ? t('approval.rememberDirs') : ''

  return (
    <div
      className={`approval-card ${risky ? 'risky' : ''}`}
      role="alertdialog"
      aria-label={current.title}
      data-testid="approval-card"
      data-kind={current.kind}
      ref={cardRef}
    >
      <div className="approval-head">
        <Icon name={icon} size={14} className="approval-icon" />
        <span className="approval-title">{current.title}</span>
        {approvals.length > 1 ? (
          <span className="approval-count" data-testid="approval-count">
            {t('approval.more', { n: approvals.length - 1 })}
          </span>
        ) : null}
      </div>

      {current.detail ? (
        <pre className="approval-detail" data-testid="approval-detail" title={current.detail}>
          {current.detail}
        </pre>
      ) : null}

      {current.reasons.length ? (
        <ul className="approval-reasons">
          {current.reasons.map((reason, index) => (
            <li key={index}>{reason}</li>
          ))}
        </ul>
      ) : null}

      {current.rememberDirs?.length ? (
        <div className="approval-dirs" title={current.rememberDirs.join('\n')}>
          {current.rememberDirs.join('  ·  ')}
        </div>
      ) : null}

      <div className="approval-actions">
        <span className="approval-cwd" title={current.cwd}>
          {current.cwd}
        </span>
        <Button type="button" size="sm" data-testid="approval-deny" onClick={() => void answerApproval(current.id, 'deny')}>
          {t('approval.deny')}
        </Button>
        {current.canRemember && rememberLabel ? (
          <Button type="button" size="sm" data-testid="approval-remember" onClick={() => void answerApproval(current.id, 'remember')}>
            {rememberLabel}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="primary"
          data-testid="approval-once"
          onClick={() => void answerApproval(current.id, 'once')}
        >
          {t('approval.once')}
        </Button>
      </div>
    </div>
  )
}
