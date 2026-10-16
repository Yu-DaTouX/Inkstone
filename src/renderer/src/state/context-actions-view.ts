import type { TFunc } from '../i18n'
import type { ContextActionSummary } from '../../../shared/context-actions'
import type { CompactionRun } from '../../../shared/ipc'
import { compactionSummary } from './compaction-view'

export interface ContextActionRow {
  kind: 'tool-sweep' | 'episode-fold' | 'compaction'
  labelKey: string
  countText: string | null
  detail: string | null
  fromLedger: boolean
}

function approxTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 1000) return String(Math.round(value))
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

export function contextActionRows(
  t: TFunc,
  summary: ContextActionSummary | null | undefined,
  lastCompaction: CompactionRun | null | undefined
): ContextActionRow[] {
  const kinds = summary?.kinds ?? []
  const byKind = new Map(kinds.map((item) => [item.kind, item]))
  const rows: ContextActionRow[] = []

  for (const kind of ['tool-sweep', 'episode-fold'] as const) {
    const item = byKind.get(kind)
    const count = item?.count ?? 0
    const labelKey = kind === 'tool-sweep' ? 'ctx.actionSweep' : 'ctx.actionFold'
    if (!item || count === 0) {
      rows.push({ kind, labelKey, countText: null, detail: null, fromLedger: true })
      continue
    }
    const parts: string[] = []
    if (item.reclaimed > 0) parts.push(t('ctx.actionReclaimed', { n: item.reclaimed }))
    if (item.savedTokens > 0) parts.push(t('ctx.actionSaved', { tokens: approxTokens(item.savedTokens) }))
    if (item.skipped > 0) {
      parts.push(
        t('ctx.actionSkipped', { n: item.skipped, reason: item.lastReason ?? t('ctx.actionNoReason') })
      )
    }
    rows.push({
      kind,
      labelKey,
      countText: t('ctx.actionTimes', { n: count }),
      detail: parts.length ? parts.join(' · ') : null,
      fromLedger: true
    })
  }

  rows.push({
    kind: 'compaction',
    labelKey: 'ctx.actionCompact',
    countText: lastCompaction ? compactionSummary(t, lastCompaction) : null,
    detail: null,
    fromLedger: false
  })

  return rows
}
