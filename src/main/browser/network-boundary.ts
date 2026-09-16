/**
 * 内置浏览器的网络边界判定（纯函数，不 import electron）。
 *
 * 抽出来的原因：这段逻辑决定了「远程页面能不能借道访问本机服务」，
 * 是安全相关的行为，必须有**可以反复跑的单测**；直接写在
 * `webRequest` 回调里就只能靠真窗口碰运气验证（而且失败时还看不出是
 * 判定错了还是环境不对）。
 *
 * 判定结果只有三种取值，对应 `browser.ts` 里的三个分支：
 *   · `allow`        —— 直接放行
 *   · `block-private` —— 目标是内网地址且不是用户/agent 明确要求的顶层导航
 *   · `check-dns`    —— 地址看着是公网，但仍要解析一次（DNS 重绑定）
 */
import { isPrivateAddress } from './network-policy'

export type BoundaryDecision = 'allow' | 'block-private' | 'check-dns'

/** 私有 / 本地地址（用于「本地预览边界」） */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return (
    isPrivateAddress(h) ||
    h === 'localhost' ||
    h === '0.0.0.0' ||
    h === '[::1]' ||
    h.endsWith('.localhost') ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  )
}

/**
 * link-local 地址（169.254/16、fe80::/10）。
 *
 * 单独拎出来：云上的实例元数据服务（169.254.169.254）住在这里，
 * 而“本地预览”没有任何正当理由去访问它 —— 所以即使是用户/agent 明确要求的
 * 顶层导航也不放行（用户敲地址栏的代价只是打不开，而 agent 被诱导后
 * 读到的可能是实例凭证）。
 */
export function isLinkLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().trim().replace(/^\[|\]$/g, '').split('%', 1)[0]
  if (/^169\.254\./.test(h)) return true
  return /^fe[89ab][0-9a-f]:/.test(h)
}

/** 发起方本身是不是本地页面 */
export function isLoopbackOrigin(value: string): boolean {
  try {
    return isPrivateHost(new URL(value).hostname)
  } catch {
    return false
  }
}

/**
 * 判定一次请求该不该拦。
 *
 * @param targetHost   请求目标的主机名（不是完整 URL —— 路径与查询参数不参与判定）
 * @param initiatorUrl **已提交**的文档地址（不是导航目标；见 browser.ts 的 `committedUrl`）
 * @param requestedByUs 这次顶层导航是不是用户/agent 明确要求的
 * @param resourceType Electron 给的资源类型（只有 `mainFrame` 才可能是“明确要求的导航”）
 */
export function decideRequestBoundary(input: {
  targetHost: string
  initiatorUrl: string
  requestedByUs: boolean
  resourceType?: string
}): BoundaryDecision {
  const { targetHost, initiatorUrl, requestedByUs, resourceType } = input
  /*
   * 拿不到已提交文档（新标签的第一次导航）或发起方本来就是本地页面时放行：
   * 宁可少拦，也不要把本地预览、正常图片/字体请求误杀。
   *
   * ⚠️ link-local 是例外（云 metadata）：它跟“谁发起的”无关，一律拦。
   */
  if (isLinkLocalHost(targetHost)) return 'block-private'
  if (!initiatorUrl || isLoopbackOrigin(initiatorUrl)) return 'allow'
  if (!isPrivateHost(targetHost)) return 'check-dns'
  /*
   * 地址本身就是内网时：只有「用户/agent 明确要求打开的顶层导航」才放行
   *（那正是本地预览的用法）。页面自己发起的导航、子资源、XHR 一律拦。
   */
  return requestedByUs && resourceType === 'mainFrame' ? 'allow' : 'block-private'
}
