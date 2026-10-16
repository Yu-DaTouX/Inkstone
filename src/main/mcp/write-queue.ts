/**
 * MCP 配置落盘的**唯一串行链**。
 *
 * `native-import.ts` 与 `host-switch.ts` 会写同一批文件（pi 的 `mcp.json` 与砚的
 * `mcp-servers.json`）。如果各自持有一条队列，两个任务并发时仍会互相覆盖对方读到的
 * 内容。所以串行链必须共享：本模块只放这一件事，不含任何业务判断。
 *
 * 语义与 `native-import.ts` 原来的实现一致：操作永远排在队尾，前一步失败不阻塞后一步；
 * 队列本身不抛错给后来的调用者。
 */
let writeTail: Promise<unknown> = Promise.resolve()

/** 把一次读改写操作排进共享串行链；返回本次操作的结果或异常。 */
export function serializedWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeTail.then(operation, operation)
  writeTail = result.catch(() => undefined)
  return result
}
