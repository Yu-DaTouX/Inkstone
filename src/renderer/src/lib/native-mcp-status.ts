export function isNativeMcpStatus(text: string): boolean {
  return /^No MCP servers configured\./.test(text) ||
    /^(?:[\w-]+: (?:connected|connecting|starting|disconnected|disabled|needs-auth|needs sign-in|error|failed)\b|config error: |overridden: )/m.test(text)
}

export function isNativeMcpActionResult(text: string): boolean {
  return /\bMCP\b/.test(text) || /^Sign-in cancelled\./.test(text)
}

export function isNativeMcpSignInPrompt(text: string): boolean {
  return /^Sign in to MCP server ".*" in your browser:/.test(text)
}
