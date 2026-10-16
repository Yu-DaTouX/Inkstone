/**
 * 注意状态汇总（v3 WP-12）。
 *
 * 把运行注册表的快照折成「应用外」需要的一个小投影：谁在等你、谁失败了、
 * 谁完成了但你还没看。这里是纯函数，不碰 Electron，也不持有任何状态，
 * 便于用运行快照直接覆盖（见 scripts/test-v3-attention.mjs）。
 *
 * 「进行中」= queued / running / needs-you / stalled；`stopped` 是用户自己停的，
 * 不进入注意列表。
 */
import type { RunSnapshot } from '../../shared/runs'

export interface AttentionSummary {
  /** 等你确认 / 回答的运行，按等待时间从早到晚 */
  needsYou: RunSnapshot[]
  /** 失败且尚未查看的运行，按时间从新到旧 */
  failed: RunSnapshot[]
  /** 完成但尚未查看的运行，按时间从新到旧 */
  doneUnread: RunSnapshot[]
  /** 停滞中的运行，按停滞时间从早到晚 */
  stalled: RunSnapshot[]
  /** 所有进行中的运行，按开始时间从早到晚 */
  active: RunSnapshot[]
  /** 有运行在等你确认 / 回答 */
  waiting: boolean
  /** 有运行在进行中 */
  busy: boolean
  /** needs-you + failed(未读) + done(未读) */
  attentionCount: number
  /** 当前登记的全部运行数（含已读终态） */
  total: number
}

/** 阶段时间：终态用 `at`，其余用 `since`。 */
function phaseTime(run: RunSnapshot): number {
  const phase = run.phase
  if (phase.kind === 'failed' || phase.kind === 'done' || phase.kind === 'stopped') return phase.at
  return phase.since
}

const byTimeAsc = (a: RunSnapshot, b: RunSnapshot): number =>
  phaseTime(a) - phaseTime(b) || a.code.localeCompare(b.code)

const byTimeDesc = (a: RunSnapshot, b: RunSnapshot): number =>
  phaseTime(b) - phaseTime(a) || a.code.localeCompare(b.code)

export function summarizeAttention(runs: readonly RunSnapshot[]): AttentionSummary {
  const needsYou: RunSnapshot[] = []
  const failed: RunSnapshot[] = []
  const doneUnread: RunSnapshot[] = []
  const stalled: RunSnapshot[] = []
  const active: RunSnapshot[] = []

  for (const run of runs) {
    const phase = run.phase
    switch (phase.kind) {
      case 'needs-you':
        needsYou.push(run)
        active.push(run)
        break
      case 'stalled':
        stalled.push(run)
        active.push(run)
        break
      case 'queued':
      case 'running':
        active.push(run)
        break
      case 'failed':
        if (!phase.seen) failed.push(run)
        break
      case 'done':
        if (!phase.seen) doneUnread.push(run)
        break
      case 'stopped':
        /* 用户主动停止：不是需要提醒的事。 */
        break
    }
  }

  needsYou.sort(byTimeAsc)
  stalled.sort(byTimeAsc)
  active.sort(byTimeAsc)
  failed.sort(byTimeDesc)
  doneUnread.sort(byTimeDesc)

  return {
    needsYou,
    failed,
    doneUnread,
    stalled,
    active,
    waiting: needsYou.length > 0,
    busy: active.length > 0,
    attentionCount: needsYou.length + failed.length + doneUnread.length,
    total: runs.length
  }
}
