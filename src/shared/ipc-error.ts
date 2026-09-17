/**
 * 剥掉 Electron IPC 异常的包装前缀。
 *
 * 渲染端从 `ipcRenderer.invoke` 拿到的异常长这样：
 *
 *   `Error invoking remote method 'yan:browser:open': Error: 只允许打开 http(s) 网页`
 *
 * 前半段是传输细节，用户只需要后半句 —— 提示条和日志里带着它，看起来像内部故障。
 * 主进程抛出的消息本身可能也以 `Error:` 开头，所以只剥**最外层一次**，
 * 不去动消息正文。
 *
 * 为什么抽成共享纯函数：主进程侧（`piCall`）与各处直接 `try/catch` 的调用点
 * 都要用同一套规则。实现分叉过一次 —— 结果是同一条错误在两处提示不一样。
 */
const IPC_ERROR_PREFIX = /^Error invoking remote method '[^']+':\s*(Error:\s*)?/

export function stripIpcErrorPrefix(raw: string): string {
  return raw.replace(IPC_ERROR_PREFIX, '')
}
