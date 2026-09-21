/**
 * 人读时长的**唯一**实现。
 *
 * 为什么单独一个文件：回合页脚、图片生成进度、子代理列表都要把毫秒说成
 * 「1m 30s」这种写法。之前 TurnView 与 SubagentList 各写了一份，同一个 90 秒
 * 在消息里是 `1m 30s`、在子代理行里是 `1m30s` —— 用户看起来像是两种度量。
 * 这里只保留一种写法，其它地方一律调用。
 *
 * 口径：
 *   · 秒以下四舍五入；不足 1 秒由 `minSeconds` 决定下限（子代理刚启动时
 *     不该显示 `0s`，所以传 1；图片进度允许 0）；
 *   · 负数（时钟回拨、乱序事件）钳到下限，不显示 `-1s`；
 *   · 非有限值（NaN / Infinity）当作 0，不抛异常 —— 这里的输入来自
 *     事件流与持久化数据，脏值是可能的。
 */
export function formatDuration(ms: number, options: { minSeconds?: number } = {}): string {
  const min = Math.max(0, Math.floor(options.minSeconds ?? 0))
  const raw = Number.isFinite(ms) ? ms : 0
  const seconds = Math.max(min, Math.round(raw / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
