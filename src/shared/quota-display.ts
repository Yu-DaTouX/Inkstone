/**
 * 额度分区的「是否渲染」判定（纯逻辑，状态栏与右栏共用）。
 *
 * 背景：状态栏额度段与右栏「额度」共用 QuotaSection。旧逻辑只在
 * 「有主值 / 有窗口 / 有月预算」时才渲染，其余一概 `return null`——
 * 包括**查询失败、接口没返回窗口、凭证缺失**这些本应说明原因的态。
 * 结果用户看到整段凭空消失：分不清是「额度为 0」还是「查询失败 / 没配上」，
 * 也点不开错误行（错误行明明已经写好了，却因为整块不渲染而不可达）。
 * Command Code 是订阅制、额度全靠接口，这种无声消失正是部分用户报告的
 * 「用 Command Code 模型时状态栏和右栏都没有额度段」。
 *
 * 规则：
 *   · 没有 provider（没有会话/模型）→ 不渲染；
 *   · provider 明确不支持（supported === false，例如自定义 API）→ 不渲染，
 *     不占位（保持旧行为：自定义服务不该凭空多出一块）；
 *   · 正在查询 → 渲染（显示占位，避免闪烁）；
 *   · **本次查询已经出错**（hasError，不论后端是「resolved 带 error」还是
 *     Promise 直接 reject 导致 supported 还没回来）→ 渲染错误行；
 *   · 有主值 / 有窗口 / 有月预算控件 → 渲染；
 *   · 以上都没有，但后端**确认该 provider 支持额度接口**（supported === true）
 *     → 渲染，让「查询失败 / 未返回窗口」如实显示。
 *
 * 纯函数便于定向测试；组件只负责把当前状态映射进来。
 */
export interface QuotaRenderInput {
  provider: string
  loading: boolean
  /** 后端是否确认该 provider 支持额度接口；null = 还没查过 */
  supported: boolean | null
  /**
   * 本次查询是否已经出错。
   *
   * 与 `supported` 分开：调用方 Promise 直接 reject 时（IPC 断、主进程抛错）
   * 拿不到 `supported`，`supported` 会停在 null —— 只看它就会把「已经发生的
   * 错误」也挡在渲染之外。只要有错误就必须留下，让用户看得见。
   */
  hasError: boolean
  /** 是否已有主值（金额或百分比） */
  hasMainText: boolean
  /** 可分窗口数量 */
  windowCount: number
  /** 是否有月预算等控件 */
  hasBudget: boolean
}

export function shouldRenderQuotaSection(input: QuotaRenderInput): boolean {
  if (!input.provider) return false
  /* 明确不支持（例如自定义 API）恒不占位，即使它报错也不铺空块。 */
  if (input.supported === false) return false
  if (input.loading) return true
  if (input.hasError || input.hasMainText || input.windowCount > 0 || input.hasBudget) return true
  return input.supported === true
}

/**
 * 展示用的额度快照必须属于当前 provider。
 *
 * 主进程的「上次成功」缓存已按 provider 分区，但渲染端自己的 `quota` state
 * 在切换供应商后到重置 effect 跑完之间还有一个渲染帧 —— 那一帧不能把上一个
 * 供应商的旧数字当成当前供应商的（AGENTS：后台事件必须核对归属）。
 * 比较时忽略大小写与首尾空白（主进程统一返回小写 provider）。
 */
export function quotaSnapshotMatchesProvider(
  snapshotProvider: string | undefined,
  provider: string
): boolean {
  if (!snapshotProvider) return false
  return snapshotProvider.trim().toLowerCase() === provider.trim().toLowerCase()
}
