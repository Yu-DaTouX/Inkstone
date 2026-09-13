/**
 * CDP 通道的公共接口。
 *
 * 为什么抽这一层：内置浏览器用的是 Electron 的 `webContents.debugger`，
 * 而要驱动**本机 Chrome** 时必须走一条原生 WebSocket（见 RawCdp.ts）。
 * Observer / InputController / geometry 只用到 `send`，把它们绑到
 * Electron 的具体实现上会让「换通道」变成改算法。
 *
 * 只要实现这个接口，同一套「观察 → 解析 ref → 点击/输入」逻辑既能跑在
 * WebContentsView 上，也能跑在外部 Chrome 上。
 */
export interface CdpChannel {
  /** 建立连接并打开常用域（幂等） */
  attach(): Promise<void>
  /** 发一条 CDP 命令，按 id 关联响应 */
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>
  /** 截当前页面（PNG） */
  screenshot(): Promise<Buffer>
  /** 断开（幂等） */
  detach(): Promise<void>
}

/** attach 时要打开的域名。两条通道共用，避免各写一份漏项。 */
export const CDP_DOMAINS = [
  'Page.enable',
  'DOM.enable',
  'DOMSnapshot.enable',
  'Accessibility.enable',
  'Runtime.enable'
] as const
