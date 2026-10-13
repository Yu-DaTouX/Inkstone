import { useEffect, useState } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Button } from '../ui'

/**
 * 额度用尽错误行上的续跑操作：等当前账号恢复，或（ChatGPT 订阅且保存了多个账号时）换号继续。
 * 只在当前会话最后一个回合上出现；登记后同一位置换成等待状态，可随时取消。
 */
export function QuotaResumeAction() {
  const t = useT()
  const wait = useStore((s) => s.quotaResume)
  const sessionId = useStore((s) => s.session?.sessionId)
  const provider = useStore((s) => s.session?.model?.provider)
  const failover = useStore((s) => s.quotaFailover)
  const arm = useStore((s) => s.armQuotaResume)
  const cancel = useStore((s) => s.cancelQuotaResume)
  const switchAccount = useStore((s) => s.failoverQuota)
  const cancelFailover = useStore((s) => s.cancelQuotaFailover)
  const [busy, setBusy] = useState(false)
  const [accounts, setAccounts] = useState(0)

  useEffect(() => {
    if (provider !== 'openai-codex') return
    let live = true
    void window.yan.codexAccounts().then((list) => { if (live) setAccounts(list.length) }).catch(() => undefined)
    return () => { live = false }
  }, [provider])

  if (wait && wait.sessionId === sessionId) {
    /* 自动换号时另一个账号可能更早恢复，显示先到的那个 */
    const times = [wait.resetAt, wait.failoverAt].filter((x): x is number => x !== undefined)
    const at = times.length ? Math.min(...times) : undefined
    const when = at
      ? new Date(at).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : ''
    return (
      <span className="msg-error-action">
        <span>{when ? t('quota.resume.waitingAt', { time: when }) : t('quota.resume.waiting')}</span>
        <Button size="sm" variant="ghost" onClick={cancel}>{t('quota.resume.cancel')}</Button>
      </span>
    )
  }
  const run = (task: () => Promise<unknown>) => {
    setBusy(true)
    void task().finally(() => setBusy(false))
  }
  return (
    <span className="msg-error-action">
      <Button size="sm" disabled={busy} title={t('quota.resume.hint')} onClick={() => run(arm)}>
        {t('quota.resume.arm')}
      </Button>
      {provider === 'openai-codex' && accounts > 1 ? (
        <Button size="sm" disabled={busy} title={t('quota.failover.hint')} onClick={() => run(switchAccount)}>
          {t('quota.failover.arm')}
        </Button>
      ) : null}
      {failover && failover.sessionId === sessionId ? (
        <Button size="sm" variant="ghost" onClick={cancelFailover}>{t('quota.failover.stop')}</Button>
      ) : null}
    </span>
  )
}
