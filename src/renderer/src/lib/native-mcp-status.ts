export function isNativeMcpStatus(text: string): boolean {
  return /^No MCP servers configured\./.test(text) ||
    /^(?:[\w-]+: (?:connected|connecting|starting|disconnected|disabled|needs-auth|needs sign-in|error|failed)\b|config error: |overridden: )/m.test(text)
}
