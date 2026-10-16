/**
 * 托管 MCP 代理通道的原生探针（验收用）。
 *
 * 与 `mcp-guard-probe.mjs` 同一手法：现场加载在 `mcp-app-proxy.js` 旁边，用真实
 * 随包 pi 1.2.0 记录 `pi.getAllTools()` 里每个工具的 `name` / `annotations` /
 * `parameters` / `description` / `exposure`，证明扩展 `registerTool()` 注册的注解
 * 能被 `danger-guard.js` 依赖的 `getAllTools()` 看见（否则不能假装审批同口径成立）。
 *
 * 只追加 JSONL 到 `MCP_APP_PROXY_PROBE_LOG`，不改参数、不改结果。
 */
import { appendFileSync } from 'node:fs'

export default function mcpAppProxyProbe(pi) {
  const file = process.env.MCP_APP_PROXY_PROBE_LOG
  if (!file) return

  const snapshot = () => {
    try {
      const tools = pi.getAllTools?.()
      if (!Array.isArray(tools)) return { error: 'getAllTools did not return an array' }
      return tools
        .filter((tool) => typeof tool?.name === 'string' && tool.name.startsWith('mcp__'))
        .map((tool) => ({
          name: tool.name,
          annotations: tool.annotations ?? null,
          parameters: tool.parameters ?? null,
          description: tool.description ?? null,
          exposure: tool.exposure ?? null
        }))
    } catch (error) {
      return { error: String(error?.message ?? error) }
    }
  }

  pi.on('session_start', () => {
    try {
      appendFileSync(file, `${JSON.stringify({ kind: 'session_start', tools: snapshot() })}\n`)
    } catch {
      /* 探针绝不能影响会话 */
    }
  })
}
