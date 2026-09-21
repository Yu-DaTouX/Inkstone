/**
 * 额度使用率的颜色分级（唯一真源）。
 *
 * 2026-09-21 用户口径：**<70% 绿、70–95% 黄、≥95% 红**，
 * 两个边界都算进更严的一档（70% 起黄、95% 起红）。
 *
 * ⚠️ 别和上下文水位那套（85% 黄 / 95% 红）混起来：那套是压缩策略的阈值，
 * 与「额度还能用多久」是两件事，各自演进。放在 shared 里是为了让渲染组件与
 * 单测用同一个函数 —— 阈值写两遍必然会漂。
 */
export type QuotaTone = 'ok' | 'warn' | 'err'

/** 黄线：到这个百分比就开始提醒 */
export const QUOTA_WARN_PCT = 70
/** 红线：离撞线只剩一点 */
export const QUOTA_ERR_PCT = 95

/**
 * @param usedPct 已用百分比（0–100，可以 >100 —— 如实显示）
 * @param exceeded 供应商自己报的「已超限」；它比百分比更权威（恒红）
 */
export function quotaTone(usedPct: number, exceeded = false): QuotaTone {
  if (exceeded) return 'err'
  /* 拿不到比例（NaN）时不要瞎标红：宁可当绿色，也不制造假警报 */
  if (!Number.isFinite(usedPct)) return 'ok'
  if (usedPct >= QUOTA_ERR_PCT) return 'err'
  return usedPct >= QUOTA_WARN_PCT ? 'warn' : 'ok'
}
