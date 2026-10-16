/**
 * MCP Apps 宿主主题（02 §5.11）。
 *
 * 把 `design/tokens.json` 生成的 MCP Apps 标准变量解析成**当前明确主题**下的具体值，
 * 并组装成 `ui/initialize` 返回的 hostContext。这里只做主题合成：不碰 App RPC 授权、
 * 协议方法、资源来源与帧归属。
 *
 * 两条硬约束：
 *   · `light-dark()` 只接受颜色，宿主必须按明确主题解析后再下发；阴影变量里嵌的
 *     `light-dark()` 不是有效 box-shadow 文本，也必须先解析（阴影另按主题取值）。
 *   · 只合并 `styles.variables`：platform / displayMode 等保留宿主 provider 的字段，
 *     不被主题覆盖；不透传任意 `styles.css`，避免把可注入样式带进第三方 App。
 */
import {
  APP_THEME_SHADOW_VARIABLES,
  APP_THEME_VARIABLES
} from '../../shared/mcp-app-theme.generated'

export type McpAppTheme = 'light' | 'dark'

/** 宿主拿不到主题时的兜底：与桌面设置默认主题一致（深色），不默认浅色。 */
export const MCP_APP_DEFAULT_THEME: McpAppTheme = 'dark'

export function isMcpAppTheme(value: unknown): value is McpAppTheme {
  return value === 'light' || value === 'dark'
}

/**
 * 把设置里的主题**偏好**解析成宿主明确主题。
 *
 * `'system'` 用调用方给出的系统当前明暗（主进程 `nativeTheme.shouldUseDarkColors`）；
 * 未知 / 缺失一律回退 `MCP_APP_DEFAULT_THEME`。绝不能把 `'system'` 当明确主题下发。
 */
export function resolveMcpAppThemePreference(
  preference: unknown,
  systemPrefersDark: boolean
): McpAppTheme {
  if (preference === 'light' || preference === 'dark') return preference
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light'
  return MCP_APP_DEFAULT_THEME
}

/** 拆分顶层逗号（忽略括号内），用于取 light-dark(a, b) 的两侧。 */
function splitTopLevel(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    else if (ch === ',' && depth === 0) {
      parts.push(value.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(value.slice(start).trim())
  return parts
}

/**
 * 把一条值里的所有 `light-dark(浅, 深)` 解析成当前主题的具体值。
 * 精确匹配嵌套括号；形状不合法时原样返回，不猜测、不拼接。
 */
export function resolveMcpAppThemeValue(value: string, theme: McpAppTheme): string {
  const marker = 'light-dark('
  let out = value
  let index = out.indexOf(marker)
  while (index !== -1) {
    let depth = 1
    let end = -1
    for (let i = index + marker.length; i < out.length; i += 1) {
      const ch = out[i]
      if (ch === '(') depth += 1
      else if (ch === ')') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end === -1) return out
    const parts = splitTopLevel(out.slice(index + marker.length, end))
    if (parts.length !== 2) return out
    const picked = theme === 'light' ? parts[0] : parts[1]
    out = out.slice(0, index) + picked + out.slice(end + 1)
    index = out.indexOf(marker)
  }
  return out
}

/** 按明确主题把标准变量解析成具体值（含浅 / 深两套阴影）。 */
export function resolveMcpAppThemeVariables(theme: McpAppTheme): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(APP_THEME_VARIABLES)) {
    out[name] = resolveMcpAppThemeValue(value, theme)
  }
  for (const [name, value] of Object.entries(APP_THEME_SHADOW_VARIABLES[theme])) {
    out[name] = value
  }
  return out
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

const VARIABLE_NAME = /^--[A-Za-z0-9_-]+$/
const VARIABLE_VALUE_MAX = 512

/** 只收 CSS 自定义属性名 + 字符串值；拒绝分号 / 换行，避免把任意 CSS 片段注入 App。 */
function sanitizeVariables(value: unknown): Record<string, string> {
  const record = asRecord(value)
  if (!record) return {}
  const out: Record<string, string> = {}
  for (const [name, raw] of Object.entries(record)) {
    if (!VARIABLE_NAME.test(name)) continue
    if (typeof raw !== 'string' || raw.length > VARIABLE_VALUE_MAX) continue
    if (raw.includes(';') || raw.includes('\n') || raw.includes('\r')) continue
    out[name] = raw
  }
  return out
}

/** 宿主的桌面默认值；provider 没给时才补，已有值不覆盖。 */
const HOST_CONTEXT_DEFAULTS: Readonly<Record<string, unknown>> = {
  platform: 'desktop',
  displayMode: 'inline',
  availableDisplayModes: ['inline', 'fullscreen', 'pip']
}

export interface McpAppHostContextInput {
  theme: McpAppTheme
  /** 宿主注入的其余上下文；platform / displayMode 等以它为准，不被主题覆盖。 */
  provider?: Record<string, unknown> | null
}

/**
 * 组装 `ui/initialize` 的 hostContext：保留 provider 的字段（尤其 platform / displayMode），
 * 合并 provider 的 `styles.variables` 后再覆盖标准主题变量；`styles` 只回传 variables。
 */
export function buildMcpAppHostContext(input: McpAppHostContextInput): Record<string, unknown> {
  const provider = input.provider ?? {}
  const context: Record<string, unknown> = { ...provider }
  for (const [key, value] of Object.entries(HOST_CONTEXT_DEFAULTS)) {
    if (!(key in context)) context[key] = Array.isArray(value) ? [...value] : value
  }
  const providerStyles = asRecord(provider.styles)
  const variables = {
    ...sanitizeVariables(providerStyles?.variables),
    ...resolveMcpAppThemeVariables(input.theme)
  }
  context.theme = input.theme
  context.styles = { variables }
  return context
}
