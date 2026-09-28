import { useCallback, useEffect, useState } from 'react'
import { useT } from '../../i18n'
import { Badge, Button, EmptyState } from '../ui'
import type { ConsentEntryView } from '../../../../shared/tool-consent'

function formatTime(at: number | undefined): string {
  if (!at) return '—'
  return new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(at)
}

/**
 * 设置 · 能力 ·「自动调用依据」（需求稿 4.3）。
 *
 * 列出每一类普通工具操作的真实答复统计、当前判断（自动 / 询问）和原因；
 * 用户可以把某一类设为始终询问、恢复按记录判断，或清空这一类的记录。
 */
export function ConsentSection() {
  const t = useT()
  const [entries, setEntries] = useState<ConsentEntryView[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setEntries(await window.yan.consent.list())
    } catch {
      setEntries([])
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const change = async (key: string, action: 'always-ask' | 'allow-auto' | 'forget'): Promise<void> => {
    setBusy(key)
    try {
      setEntries(await window.yan.consent.change(key, action))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="set-row col" data-testid="consent-section">
      <div className="set-label">
        <div className="set-name">{t('consent.title')}</div>
        <div className="set-desc">{t('consent.desc')}</div>
      </div>
      {entries && entries.length === 0 ? <EmptyState>{t('consent.empty')}</EmptyState> : null}
      {entries?.map((entry) => {
        const { parts, verdict } = entry
        return (
          <div className="consent-entry" key={entry.key} data-testid="consent-entry">
            <div className="consent-head">
              <span className="set-name">
                {parts.capability} · {parts.action}
              </span>
              {verdict.mode === 'auto' ? <Badge tone="ok">{t('consent.auto')}</Badge> : <Badge>{t('consent.ask')}</Badge>}
              {verdict.danger ? <Badge tone="warn">{verdict.danger}</Badge> : null}
              {entry.override ? <Badge tone="accent">{t('consent.alwaysAsk')}</Badge> : null}
            </div>
            <div className="set-desc">
              <span className="set-path">{parts.resource}</span>
            </div>
            <div className="set-desc">
              {t('consent.stats', { allows: verdict.stats.allows, denies: verdict.stats.denies, last: formatTime(entry.lastAnswerAt), auto: formatTime(entry.lastAutoAt) })}
            </div>
            <div className="set-desc">{verdict.reason}</div>
            <div className="btn-row">
              {entry.override ? (
                <Button size="sm" disabled={busy === entry.key} onClick={() => void change(entry.key, 'allow-auto')}>
                  {t('consent.restore')}
                </Button>
              ) : (
                <Button size="sm" disabled={busy === entry.key} onClick={() => void change(entry.key, 'always-ask')}>
                  {t('consent.setAlwaysAsk')}
                </Button>
              )}
              <Button size="sm" variant="ghost" disabled={busy === entry.key} onClick={() => void change(entry.key, 'forget')}>
                {t('consent.forget')}
              </Button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
