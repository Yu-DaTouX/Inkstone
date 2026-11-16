import { pick } from '../../../src/shared/ui-lang'
import { useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import type { RemoteQuota, RemoteUsage } from '../../../src/shared/remote-protocol'
import { capabilityAllowed } from '../../../src/shared/capability-negotiation'
import { quotaPercent, resetText } from '../activity'
import { compactCount, costText } from '../format'
import { useRemote } from '../state'
import { font, mono, radius, space, usePalette, weight } from '../theme'
import { Button, Meta, SectionTitle } from '../ui'

const RANGES: Array<{ value: '7d' | '30d' | 'all'; label: () => string }> = [
  { value: '7d', label: () => pick('近 7 天', '7 days') },
  { value: '30d', label: () => pick('近 30 天', '30 days') },
  { value: 'all', label: () => pick('全部', 'All') }
]

export function QuotaSection() {
  const p = usePalette()
  const { client, info } = useRemote()
  const quotaAllowed = capabilityAllowed(info, 'quota')
  const usageAllowed = capabilityAllowed(info, 'usage')
  const [quota, setQuota] = useState<RemoteQuota | null>(null)
  const [usage, setUsage] = useState<RemoteUsage | null>(null)
  const [range, setRange] = useState<'7d' | '30d' | 'all'>('7d')
  const [pending, setPending] = useState(0)
  const busy = pending > 0
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  const run = useCallback(async (task: () => Promise<void>) => {
    setPending((count) => count + 1); setError(null)
    try { await task() }
    catch (err) { if (alive.current) setError(err instanceof Error ? err.message : pick('读取失败', 'Load failed')) }
    finally { if (alive.current) setPending((count) => Math.max(0, count - 1)) }
  }, [])
  const loadQuota = useCallback(() => run(async () => {
    if (!quotaAllowed) return
    const next = await client.quota()
    if (alive.current) setQuota(next)
  }), [client, quotaAllowed, run])
  const loadUsage = useCallback(() => run(async () => {
    if (!usageAllowed) return
    const next = await client.usage(range)
    if (alive.current) setUsage(next)
  }), [client, range, run, usageAllowed])
  const load = () => Promise.all([loadQuota(), loadUsage()])
  useEffect(() => { void loadQuota() }, [loadQuota])
  useEffect(() => { void loadUsage() }, [loadUsage])
  if (!quotaAllowed && !usageAllowed) return null
  const now = Date.now()
  return <>
    <SectionTitle>{pick('额度与用量', 'Quota and usage')}</SectionTitle>
    <View style={[styles.card, { borderColor: p.borderSoft, backgroundColor: p.bg1 }]}>
      {quota?.cards.length ? quota.cards.map((card) => <View key={card.key} style={{ gap: 4 }}>
        <View style={styles.row}>
          <Text numberOfLines={1} style={{ flex: 1, color: p.fg, fontSize: font.base, fontWeight: card.active ? weight.strong : undefined }}>{card.title}</Text>
          <Text style={{ color: card.status === 'ok' ? p.fgMute : p.warn, fontSize: font.xs }}>{[card.plan, card.status === 'limited' ? pick('已到上限', 'Limited') : card.status === 'expired' ? pick('已过期', 'Expired') : card.status === 'error' ? pick('读取失败', 'Error') : ''].filter(Boolean).join(' · ')}</Text>
        </View>
        {card.windows.map((window) => {
          const percent = quotaPercent(window)
          return <View key={window.label} style={{ gap: 2 }}>
            <View style={styles.row}>
              <Text style={{ flex: 1, color: p.fgDim, fontSize: font.xs }}>{window.label}</Text>
              <Text style={{ color: window.exceeded ? p.err : p.fgDim, fontSize: font.xs, fontFamily: mono }}>{percent === null ? '—' : `${percent}%`}</Text>
            </View>
            {percent !== null ? <View style={[styles.meter, { backgroundColor: p.borderSoft }]}><View style={[styles.meterFill, { width: `${Math.max(2, percent)}%`, backgroundColor: window.exceeded || percent >= 90 ? p.err : percent >= 75 ? p.warn : p.accent }]} /></View> : null}
            {window.resetAt ? <Text style={{ color: p.fgMute, fontSize: font.xs }}>{resetText(window.resetAt, now)}</Text> : null}
          </View>
        })}
        {card.balance ? <Text style={{ color: p.fgDim, fontSize: font.xs }}>{card.balance.label} {card.balance.amount} {card.balance.currency}</Text> : null}
        {card.error ? <Text style={{ color: p.warn, fontSize: font.xs }}>{card.error}</Text> : null}
      </View>) : quota ? <Meta style={{ fontSize: font.sm }}>{pick('电脑上没有可查额度的账号', 'No accounts with quota on the desktop')}</Meta> : null}
      {usageAllowed ? <View style={{ gap: space[2] }}>
        <View style={[styles.row, { gap: space[2] }]}>{RANGES.map((item) => <Button key={item.value} compact label={item.label()} variant={range === item.value ? 'primary' : 'secondary'} disabled={busy} onPress={() => setRange(item.value)} />)}</View>
        {usage ? <>
          <Text style={{ color: p.fg, fontSize: font.base, fontFamily: mono }}>{compactCount(usage.tokens)} tokens{costText(usage.cost) ? ` · ${costText(usage.cost)}` : ''}</Text>
          <Text style={{ color: p.fgMute, fontSize: font.xs }}>{pick(`${usage.sessions} 个会话 · ${usage.messages} 条消息 · 活跃 ${usage.activeDays} 天`, `${usage.sessions} sessions · ${usage.messages} messages · ${usage.activeDays} active days`)}</Text>
          {usage.models.map((model) => <View key={model.name} style={styles.row}><Text numberOfLines={1} style={{ flex: 1, color: p.fgDim, fontSize: font.xs, fontFamily: mono }}>{model.name}</Text><Text style={{ color: p.fgMute, fontSize: font.xs, fontFamily: mono }}>{compactCount(model.tokens)}</Text></View>)}
        </> : null}
      </View> : null}
      {error ? <Text accessibilityLiveRegion="polite" style={{ color: p.err, fontSize: font.sm }}>{error}</Text> : null}
      <Button label={busy ? pick('正在读取…', 'Loading…') : pick('刷新', 'Refresh')} busy={busy} onPress={() => void load()} />
    </View>
  </>
}

const styles = StyleSheet.create({
  card: { padding: space[4], borderWidth: 1, borderRadius: radius.lg, gap: space[3] },
  row: { flexDirection: 'row', alignItems: 'center' },
  meter: { height: 4, borderRadius: 2, overflow: 'hidden' },
  meterFill: { height: 4, borderRadius: 2 }
})
