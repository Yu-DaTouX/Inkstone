import { useCallback, useEffect, useRef, useState } from 'react'
import { ANTIGRAVITY_QUOTA_REFRESH_MS, antigravityQuotaFailure, type AntigravityModel, type AntigravityQuotaGroup, type AntigravityQuotaSnapshot, type AntigravityQuotaWindow } from '../../../../shared/antigravity'
import { pick } from '../../../../shared/ui-lang'
import { IconButton, Notice } from '../../ui'
import { RefreshCw } from '../../ui/icons'

export function useAntigravityQuota(enabled: boolean, running: boolean) {
  const [snapshot, setSnapshot] = useState<AntigravityQuotaSnapshot>()
  const [loading, setLoading] = useState(false)
  const pending = useRef<Promise<void> | undefined>(undefined)
  const refresh = useCallback((force = false) => {
    if (pending.current) return pending.current
    setLoading(true)
    const request = Promise.resolve().then(() => window.yan.antigravity.quota(force)).then(setSnapshot, () => {
      const checkedAt = Date.now()
      const error = pick('无法刷新 Antigravity 额度。请重试。', 'Could not refresh Antigravity allowance. Try again.')
      setSnapshot((previous) => antigravityQuotaFailure(previous, checkedAt, error))
    }).finally(() => {
      pending.current = undefined
      setLoading(false)
    })
    pending.current = request
    return request
  }, [])

  useEffect(() => {
    if (enabled && !running) void refresh()
  }, [enabled, running, refresh])
  useEffect(() => {
    if (!enabled) return undefined
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, ANTIGRAVITY_QUOTA_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [enabled, refresh])

  return { snapshot, loading, refresh }
}

function percent(fraction: number, lang: string): string {
  if (fraction > 0 && fraction < 0.001) return '<0.1%'
  return new Intl.NumberFormat(lang, { style: 'percent', maximumFractionDigits: 1 }).format(fraction)
}

function periodLabel(window: AntigravityQuotaWindow, en: boolean): string {
  return window.period === '5h' ? '5h' : window.period === 'weekly' ? (en ? 'Wk' : '每周') : window.name
}

function orderedWindows(group: AntigravityQuotaGroup): AntigravityQuotaWindow[] {
  return [...group.windows.filter(({ period }) => period === '5h'), ...group.windows.filter(({ period }) => period !== '5h')]
}

export function antigravityQuotaSummary(snapshot: AntigravityQuotaSnapshot | undefined, model: AntigravityModel | undefined, lang: string): string | undefined {
  const groups = snapshot?.groups
  if (!groups?.length) return undefined
  const en = lang === 'en-US'
  const matchKey = (name: string) => name.trim().toLowerCase().replace(/[\s._-]+/g, '-')
  const keys = new Set([model?.id, model?.name].filter((value): value is string => !!value).map(matchKey))
  const direct = groups.find((group) => keys.has(matchKey(group.name)))
  const chosen = direct ?? groups.find((group) => group.models.some((name) => keys.has(matchKey(name))))
  const summary = chosen
    ? orderedWindows(chosen).slice(0, 2).map((window) => `${periodLabel(window, en)} ${percent(window.remainingFraction, lang)}`).join(' · ')
    : en ? `${groups.length} groups` : `${groups.length} 组`
  return snapshot?.staleSince === undefined ? summary : `${summary} · ${en ? 'Stale' : '旧数据'}`
}

function windowTone(fraction: number): 'ok' | 'ask' | 'fail' {
  if (fraction <= 0) return 'fail'
  if (fraction <= 0.2) return 'ask'
  return 'ok'
}

function shortReset(resetAt: number | undefined, lang: string): string | undefined {
  if (resetAt === undefined || !Number.isFinite(resetAt) || resetAt < Date.UTC(2020, 0, 1)) return undefined
  const date = new Date(resetAt)
  if (!Number.isFinite(date.getTime())) return undefined
  const sameDay = date.toDateString() === new Date().toDateString()
  return new Intl.DateTimeFormat(lang, {
    ...(sameDay ? {} : { month: 'numeric', day: 'numeric' }),
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(date)
}

export function AntigravityQuotaDetails({ quota, lang }: {
  quota: ReturnType<typeof useAntigravityQuota>
  lang: string
}) {
  const { snapshot, loading, refresh } = quota
  const en = lang === 'en-US'
  const groups = snapshot?.groups ?? []
  const refreshLabel = en ? 'Refresh quota' : '刷新额度'
  const refreshButton = (
    <IconButton
      size="sm"
      variant="ghost"
      aria-label={refreshLabel}
      tooltip={refreshLabel}
      data-testid="antigravity-quota-refresh"
      isDisabled={loading}
      isPending={loading}
      onPress={() => void refresh(true)}
    >
      <RefreshCw size={12} aria-hidden />
    </IconButton>
  )
  return (
    <div className="wb-ov-quota" data-testid="rail-antigravity-quota">
      {groups.map((group, index) => {
        const windows = orderedWindows(group).map((window) => ({
          window, name: periodLabel(window, en), reset: shortReset(window.resetAt, lang)
        }))
        const primary = windows.find(({ reset }) => reset !== undefined)
        return (
          <div key={`${group.name}:${index}`} className="wb-ov-qmain" title={group.models.length ? `${group.name}: ${group.models.join(', ')}` : group.name}>
            <div className="wb-ov-ctx-head">
              <span className="wb-ov-qmain-name">
                <span className="wb-ov-qmain-label">{group.name}</span>
              </span>
              <span className="wb-ov-qmain-side">
                {primary ? `${windows.length > 1 ? `${primary.name} ` : ''}${en ? 'Reset ' : '重置 '}${primary.reset}` : null}
                {index === 0 ? refreshButton : null}
              </span>
            </div>
            <ul className="wb-ov-qminis">
              {windows.map(({ window, name, reset }) => {
                const used = Math.round(Math.min(100, Math.max(0, (1 - window.remainingFraction) * 100)))
                const left = percent(window.remainingFraction, lang)
                const tip = [
                  `${group.name} · ${name}`,
                  `${en ? 'Remaining' : '剩余'} ${left} (${used}% ${en ? 'used' : '已用'})`,
                  reset ? `${en ? 'Resets' : '重置'} ${reset}` : ''
                ].filter(Boolean).join('\n')
                return (
                  <li key={window.id} className="wb-ov-qmini" data-tone={windowTone(window.remainingFraction)} title={tip}>
                    <span className="wb-ov-qmini-name">{name}</span>
                    <div className="wb-ov-ctx-meter">
                      <div className="wb-ctx-bar" role="img" aria-label={`${group.name} ${name} ${left}`}>
                        {used > 0 ? <i className="wb-ov-qfill" style={{ width: `${used}%` }} /> : null}
                      </div>
                    </div>
                    <span className="wb-ov-qmini-num">{left}</span>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
      {snapshot?.staleSince !== undefined && snapshot.error ? (
        <Notice tone="ask" compact>{en ? 'Showing the last successful allowance. ' : '正在显示上次成功查询的额度。'}{snapshot.error}</Notice>
      ) : null}
      {!groups.length ? (
        <div className="wb-ov-ctx-head">
          <Notice tone="ask" compact>{snapshot?.error ?? (loading
            ? (en ? 'Checking allowance…' : '正在查询额度…')
            : (en ? 'Allowance unavailable.' : '暂时无法读取额度。'))}</Notice>
          {refreshButton}
        </div>
      ) : null}
    </div>
  )
}
