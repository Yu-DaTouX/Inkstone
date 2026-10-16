/**
 * 迷你小窗的条目投影（v3 WP-12）。
 *
 * 输入是 AttentionService 已经算好的汇总（`src/main/attention/summary.ts`），
 * 这里只把它折成小窗要渲染的一行行数据 —— 不再重新解释运行状态，也不持有状态。
 * 纯函数，可在不启动 Electron 的单测里用合成快照覆盖（见 scripts/test-v3-aux-windows.mjs）。
 *
 * 排序沿用设计规范 §4.6：等你确认 → 停滞 → 失败未读 → 运行中 → 排队 → 完成未读。
 * 同一类里，尚在进行中的按等待时间从早到晚（等得久的更急），终态按时间从新到旧。
 */
import type { RunPhase, RunSnapshot } from '../../shared/runs'
import type { AttentionSummary } from '../attention/summary'
import type { MiniItem, MiniStatusKey } from './aux-types'

/** 阶段时间：终态用 `at`，其余用 `since`（与 attention/summary 的判定一致）。 */
function phaseTime(phase: RunPhase): number {
  if (phase.kind === 'failed' || phase.kind === 'done' || phase.kind === 'stopped') return phase.at
  return phase.since
}

function toItem(statusKey: MiniStatusKey, run: RunSnapshot): MiniItem {
  const phase = run.phase
  const unread = (phase.kind === 'failed' || phase.kind === 'done') && !phase.seen
  return {
    runId: run.runId,
    code: run.code,
    title: run.title,
    statusKey,
    since: phaseTime(phase),
    unread,
    sessionId: run.sessionId,
    ...(run.sessionPath ? { sessionPath: run.sessionPath } : {}),
    ...(run.projectId ? { projectId: run.projectId } : {})
  }
}

const bySinceAsc = (a: MiniItem, b: MiniItem): number => a.since - b.since || a.runId.localeCompare(b.runId)
const bySinceDesc = (a: MiniItem, b: MiniItem): number => b.since - a.since || a.runId.localeCompare(b.runId)

/** 把注意汇总折成迷你小窗的条目列表（去重，按优先级排序）。 */
export function attentionItems(summary: AttentionSummary): MiniItem[] {
  const queued: MiniItem[] = []
  const running: MiniItem[] = []
  for (const run of summary.active) {
    if (run.phase.kind === 'queued') queued.push(toItem('queued', run))
    else if (run.phase.kind === 'running') running.push(toItem('running', run))
  }
  return [
    ...summary.needsYou.map((run) => toItem('needs-you', run)).sort(bySinceAsc),
    ...summary.stalled.map((run) => toItem('stalled', run)).sort(bySinceAsc),
    ...summary.failed.map((run) => toItem('failed', run)).sort(bySinceDesc),
    ...running.sort(bySinceAsc),
    ...queued.sort(bySinceAsc),
    ...summary.doneUnread.map((run) => toItem('done', run)).sort(bySinceDesc)
  ]
}
