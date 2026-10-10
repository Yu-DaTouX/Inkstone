import { useEffect, useMemo, useState } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { HEAT_WEEKS, heatLevels, type UsageRange } from '../../../../shared/usage-stats'
import type { UsageStatsResult } from '../../../../shared/ipc'

/**
 * 启动页的本机用量：会话、消息、token、活跃天数、高峰时段、最常用模型，近半年热力图；
 * 切到「模型」看各模型占比。数据来自本机会话文件（主进程增量统计），不联网。
 * 取不到或没有历史时整段不显示，不影响开始新会话。
 *
 * 排版与智能界面一致：不加底色与外框，指标只靠间距成组，数值比正文大一级。
 */

/** 热力图显示的周数：放得进右栏（23rem）不截断 */
const HEAT_SHOWN = 20

/* 本次运行内记住上次结果：回到空会话时先显示旧值，后台刷新 */
const memo = new Map<UsageRange, UsageStatsResult>()

export function compactNumber(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
  if (n >= 1e4) return `${(n / 1e3).toFixed(0)}K`
  return n.toLocaleString()
}

export function useUsageStats(range: UsageRange): UsageStatsResult | null {
  const [stats, setStats] = useState<UsageStatsResult | null>(() => memo.get(range) ?? null)
  useEffect(() => {
    let alive = true
    setStats(memo.get(range) ?? null)
    window.yan
      .usageStats(range)
      .then((next) => {
        memo.set(range, next)
        if (alive) setStats(next)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [range])
  return stats
}

/** 安静的文字切换：选中项正文色 + 下划强调线，其余淡色（不用分段控件的底块） */
function Toggle<T extends string>({ value, options, onChange, label, testId }: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
  label: string
  testId?: string
}) {
  return (
    <div className="start-toggle" role="group" aria-label={label} data-testid={testId}>
      {options.map((o) => (
        <button type="button" key={o.value} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function UsageOverview() {
  const t = useT()
  const [tab, setTab] = useState<'overview' | 'models'>('overview')
  const [range, setRange] = useState<UsageRange>('all')
  const stats = useUsageStats(range)
  const models = useStore((s) => s.models)

  /* provider/model → 菜单里的显示名；找不到就取最后一段 id。同名的补上供应商以区分 */
  const names = useMemo(() => {
    const base = (key: string): string => {
      const slash = key.indexOf('/')
      const provider = key.slice(0, slash)
      const id = key.slice(slash + 1)
      const hit = models.find((m) => m.provider === provider && m.id === id) ?? models.find((m) => m.id === id)
      return hit?.name || id.replace(/^.*\//, '')
    }
    const keys = stats?.models.map((m) => m.key) ?? []
    const out = new Map<string, { name: string; provider: string }>()
    for (const key of keys) {
      const name = base(key)
      const dup = keys.some((k) => k !== key && base(k) === name)
      out.set(key, { name, provider: dup ? key.slice(0, key.indexOf('/')) : '' })
    }
    return out
  }, [stats, models])

  const levels = useMemo(() => heatLevels(stats?.heat.map((d) => d.tokens) ?? []), [stats])
  if (!stats || (stats.sessions === 0 && range === 'all')) return null

  /* Token 总数单独做主数字；其余只留一行三项（最常用模型在「模型」页） */
  const tiles: Array<[string, string]> = [
    [t('usage.sessions'), stats.sessions.toLocaleString()],
    [t('usage.messages'), compactNumber(stats.messages)],
    [t('usage.activeDays'), String(stats.activeDays)]
  ]
  /* 热力图只画近 HEAT_SHOWN 周：序列从周一开始，去掉更早的整周即可保持对齐 */
  const skip = Math.max(0, (HEAT_WEEKS - HEAT_SHOWN) * 7)
  const heat = stats.heat.slice(skip)
  const total = stats.models.reduce((sum, m) => sum + m.tokens, 0)

  return (
    <aside className="start-sec start-usage" data-testid="usage-overview" aria-label={t('usage.title')}>
      <div className="start-usage-head">
        <h2 className="start-label">{t('usage.title')}</h2>
        <span className="start-spacer" />
        <Toggle
          label={t('usage.title')}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'overview', label: t('usage.overview') },
            { value: 'models', label: t('usage.models') }
          ]}
        />
      </div>
      <div className="start-usage-head">
        <Toggle
          label={t('usage.range')}
          value={range}
          onChange={setRange}
          testId="usage-range"
          options={[
            { value: 'all', label: t('usage.all') },
            { value: '30d', label: t('usage.days', { n: 30 }) },
            { value: '7d', label: t('usage.days', { n: 7 }) }
          ]}
        />
      </div>

      {tab === 'overview' ? (
        <>
          <div className="start-hero">
            <span className="start-hero-num" data-testid="usage-tokens">{compactNumber(stats.tokens)}</span>
            <span className="start-label">{t('usage.tokens')}</span>
          </div>
          <dl className="start-stats">
            {tiles.map(([label, value]) => (
              <div className="start-stat" key={label}>
                <dt>{label}</dt>
                <dd title={value} data-long={value.length > 12 ? '' : undefined}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          <div className="start-heat" role="img" aria-label={t('usage.heatLabel')}>
            {heat.map((d, i) => (
              <span key={d.date} className="start-cell" data-level={levels[i + skip]} title={`${d.date} · ${compactNumber(d.tokens)} token`} />
            ))}
          </div>
        </>
      ) : (
        <ol className="start-models">
          {stats.models.length ? (
            stats.models.map((m) => {
              const share = total > 0 ? m.tokens / total : 0
              const name = names.get(m.key)
              return (
                <li key={m.key} className="start-model" title={m.key}>
                  <span className="start-model-name">
                    {name?.name ?? m.key}
                    {name?.provider ? <span className="start-model-provider"> · {name.provider}</span> : null}
                  </span>
                  <span className="start-model-bar" aria-hidden>
                    <span style={{ width: `${Math.max(0.5, share * 100)}%` }} />
                  </span>
                  <span className="start-model-num">{compactNumber(m.tokens)}</span>
                  <span className="start-model-num">{share >= 0.01 ? `${Math.round(share * 100)}%` : '<1%'}</span>
                </li>
              )
            })
          ) : (
            <li className="start-hint">{t('usage.noModels')}</li>
          )}
        </ol>
      )}
    </aside>
  )
}
