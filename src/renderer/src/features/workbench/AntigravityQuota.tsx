import { Fragment, useCallback, useEffect, useState } from 'react'
import { ANTIGRAVITY_QUOTA_REFRESH_MS, type AntigravityModel, type AntigravityQuotaGroup, type AntigravityQuotaSnapshot, type AntigravityQuotaWindow } from '../../../../shared/antigravity'
import { Button, Notice, RailRow } from '../../ui'

export function useAntigravityQuota(enabled: boolean, running: boolean) {
  const [snapshot, setSnapshot] = useState<AntigravityQuotaSnapshot>()
  const [loading, setLoading] = useState(false)
  const refresh = useCallback(async (force = false) => {
    setLoading(true)
    try {
      setSnapshot(await window.yan.antigravity.quota(force))
    } catch {
      setSnapshot({ checkedAt: Date.now(), groups: [] })
    } finally {
      setLoading(false)
    }
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
  return window.period === '5h' ? (en ? '5 hours' : '5 小时') : window.period === 'weekly' ? (en ? 'Weekly' : '每周') : window.name
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
  if (!chosen) return en ? `${groups.length} quota groups` : `${groups.length} 个额度组`
  return orderedWindows(chosen).slice(0, 2).map((window) => `${periodLabel(window, en)} ${percent(window.remainingFraction, lang)}`).join(' · ')
}

export function AntigravityQuotaDetails({ quota, turnTokens, lang }: {
  quota: ReturnType<typeof useAntigravityQuota>
  turnTokens?: string
  lang: string
}) {
  const { snapshot, loading, refresh } = quota
  const en = lang === 'en-US'
  const date = new Intl.DateTimeFormat(lang, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return (
    <>
      <ul className="wb-ov-items" data-testid="rail-antigravity-quota">
        <RailRow label={en ? 'Subscription allowance' : '订阅剩余额度'} action={
          <Button variant="ghost" size="sm" data-testid="antigravity-quota-refresh" isDisabled={loading} onPress={() => void refresh(true)}>
            {loading ? (en ? 'Reading…' : '查询中…') : (en ? 'Refresh' : '刷新')}
          </Button>
        } />
        {snapshot?.groups.map((group, index) => (
          <Fragment key={`${group.name}:${index}`}>
            <RailRow label={group.name} title={group.models.length ? group.models.join(', ') : group.name} />
            {orderedWindows(group).map((window) => {
              const name = periodLabel(window, en)
              const reset = window.resetAt === undefined ? undefined : `${en ? 'Resets' : '重置'} ${date.format(window.resetAt)}`
              return <RailRow key={window.id} label={name} hint={reset} title={`${group.name} · ${name}${reset ? ` · ${reset}` : ''}`} value={percent(window.remainingFraction, lang)} />
            })}
          </Fragment>
        ))}
        {turnTokens !== undefined ? <RailRow label={en ? 'Latest reported turn' : '最近已上报回合'} value={`${turnTokens} tok`} /> : null}
      </ul>
      {snapshot && !snapshot.groups.length ? <Notice tone="ask" compact>{snapshot.error ?? (en ? 'Allowance unavailable.' : '暂时无法读取订阅额度。')}</Notice> : null}
    </>
  )
}
