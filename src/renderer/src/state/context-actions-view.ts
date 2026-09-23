/**
 * 三类整理的界面投影（实施-11 C-2b）。
 *
 * 三类动作的**来源不同**，界面必须如实区分，不能混成一句“整理过上下文”：
 *   · `tool-sweep` / `episode-fold` —— 扩展写的动作账本（`yan contextActions`），
 *     它们**不产生** pi 的 `compaction_*` 事件；
 *   · `compaction` —— pi 自己的事件（`session.lastCompaction`），不重抄一份账本。
 *
 * `savedTokens` 是扩展侧**估算**，不是供应商口径；文案里写“约”，
 * 与压缩回收百分比那种“待测就不写”的口径区分开。
 */
import type { TFunc } from '../i18n'
import type { ContextActionSummary } from '../../../shared/context-actions'
import type { CompactionRun } from '../../../shared/ipc'
import { compactionSummary } from './compaction-view'

export interface ContextActionRow {
  kind: 'tool-sweep' | 'episode-fold' | 'compaction'
  labelKey: string
  /** 次数文案（如「3 次」）；没发生过为 null，界面写「未发生」 */
  countText: string | null
  /** 细节行（整理条数 / 省下的估算 token / 跳过原因） */
  detail: string | null
  /** 这一行是不是来自账本（false = 来自 pi 事件） */
  fromLedger: boolean
}

/** 估算 token 的粗显示：只给两位有效数字，避免把估算说得太精确 */
function approxTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 1000) return String(Math.round(value))
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/**
 * 三行：清扫 / 状态刷新 / 整轮压缩。
 * 前两行没发生过时**仍然显示**（写「未发生」）—— 这正是要区分三类的原因：
 * 用户要能看出“清扫跑了但状态没刷新”，而不是一片空白。
 */
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
