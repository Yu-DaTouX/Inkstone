import type { NativeMcpImportPreview } from '../../../../../shared/mcp-native-import'

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

export interface ImportPreviewLabels {
  sourceTitle: string
  nativeName: string
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
