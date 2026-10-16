/**
 * pi 原生 MCP 导入预览的脱敏摘要（纯逻辑，无 React / store / DOM）。
 *
 * 确认框只允许展示白名单字段：env 仅键名、URL 仅 http(s) origin、args 仅个数；
 * 未知字段与嵌套值（例如 headers / 任何未来扩展）一概不展示，绝不回退成
 * `JSON.stringify(serverEntry)`。这里只**读** preview，不修改它，也不参与 commit ——
 * 主进程仍按原令牌与授权落盘，导入的仍是完整条目。
 */
import type { NativeMcpImportPreview } from '../../../../../shared/mcp-native-import'

/** 只取 http/https 的 origin（协议 + 主机 + 端口），剔除 userinfo / query / path / hash。 */
export function httpOriginOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return url.origin
}

export interface NativeEntrySummary {
  description: string | null
  transport: 'stdio' | 'http' | 'other'
  command: string | null
  argCount: number
  envKeys: string[]
  urlOrigin: string | null
}

/**
 * 从原生条目提取白名单摘要。只读已知字段：
 *   · description / command（可读的文本，不是凭证）；
 *   · args 只保留个数，不保留内容；
 *   · env 只保留排序后的键名，不含任何值；
 *   · url 只保留 http(s) origin。
 * 未知字段（含嵌套对象）不进入摘要。
 */
export function summarizeNativeEntry(entry: Record<string, unknown>): NativeEntrySummary {
  const env = entry.env
  const envObject =
    env && typeof env === 'object' && !Array.isArray(env) ? (env as Record<string, unknown>) : null
  const args = Array.isArray(entry.args) ? entry.args : []
  const command = typeof entry.command === 'string' && entry.command.trim() !== '' ? entry.command : null
  const transport: NativeEntrySummary['transport'] =
    typeof entry.url === 'string' ? 'http' : command ? 'stdio' : 'other'
  return {
    description:
      typeof entry.description === 'string' && entry.description.trim() !== '' ? entry.description : null,
    transport,
    command,
    argCount: args.length,
    envKeys: envObject ? Object.keys(envObject).sort() : [],
    urlOrigin: httpOriginOf(entry.url)
  }
}

/** 组装确认框细节文本所需的外部文案（i18n 键 + 本目录 text.ts 的新短文案）。 */
export interface ImportPreviewLabels {
  sourceTitle: string
  nativeName: string
  /** 已解析好的范围标签（全局 / 项目）。 */
  scope: string
  targetPath: string
  entry: string
  warnings: string
  description: string
  transport: string
  command: string
  args: string
  envKeys: string
  url: string
}

/**
 * 组装确认框细节文本。所有来自 preview 的条目字段都经 `summarizeNativeEntry` 白名单化；
 * `targetPath` 是主进程给出的落盘位置，按约定可展示。token、完整文件 content 与未知
 * 字段一律不展示。warnings / reauthNotice 是主进程生成的提示文案（只含服务 id 与
 * authRef 引用名，不含条目里的凭证值），原样带出。
 */
export function formatImportPreviewDetail(
  preview: NativeMcpImportPreview,
  sourceTitle: string,
  labels: ImportPreviewLabels
): string {
  const summary = summarizeNativeEntry(preview.serverEntry)
  const lines = [
    `${labels.sourceTitle}: ${sourceTitle}`,
    `${labels.nativeName}: ${preview.nativeName}`,
    labels.scope,
    `${labels.targetPath}: ${preview.targetPath}`,
    '',
    `${labels.entry}:`
  ]
  if (summary.description) lines.push(`${labels.description}: ${summary.description}`)
  lines.push(`${labels.transport}: ${summary.transport}`)
  if (summary.command) lines.push(`${labels.command}: ${summary.command}`)
  if (summary.argCount > 0) lines.push(`${labels.args}: ${summary.argCount}`)
  if (summary.envKeys.length > 0) lines.push(`${labels.envKeys}: ${summary.envKeys.join(', ')}`)
  if (summary.urlOrigin) lines.push(`${labels.url}: ${summary.urlOrigin}`)

  const notes = [...preview.warnings]
  if (preview.reauthNotice) notes.push(preview.reauthNotice)
  if (notes.length > 0) lines.push('', `${labels.warnings}:`, ...notes.map((note) => `- ${note}`))
  return lines.join('\n')
}
