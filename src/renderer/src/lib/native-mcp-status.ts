/** pi RPC 的 /mcp 返回普通通知；只认领原生状态文本，不吞掉其它扩展通知。 */
export function isNativeMcpStatus(text: string): boolean {
  return /^No MCP servers configured\./.test(text) ||
    /^(?:[\w-]+: (?:connected|connecting|starting|disconnected|disabled|needs-auth|needs sign-in|error|failed)\b|config error: |overridden: )/m.test(text)
}
