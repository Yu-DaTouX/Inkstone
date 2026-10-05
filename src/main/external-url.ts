/**
 * 交给系统打开的外部地址白名单。
 *
 * `shell.openExternal` 会按系统注册的协议处理器启动程序；`file:`、`ms-*:`、
 * 自定义协议都可能执行本机程序。窗口弹出与应用内导航只放行网页与邮件链接，
 * 其余一律不交给系统。
 */
const OPENABLE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** 返回规范化后的地址；协议不在白名单或无法解析时返回 null。 */
export function openableExternalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value || value.length > 8192) return null
  try {
    const url = new URL(value)
    return OPENABLE_PROTOCOLS.has(url.protocol) ? url.toString() : null
  } catch {
    return null
  }
}

/** 登录流程里 pi 给出的授权页只接受 https。 */
export function openableAuthUrl(raw: unknown): string | null {
  const url = openableExternalUrl(raw)
  return url && url.startsWith('https:') ? url : null
}
