export const SESSION_EXPORT_FORMATS = ['markdown', 'html', 'bundle'] as const

export type SessionExportFormat = (typeof SESSION_EXPORT_FORMATS)[number]

export const SESSION_EXPORT_EXTENSIONS: Record<SessionExportFormat, string> = {
  markdown: '.md',
  html: '.html',
  bundle: '.inkstone-session.json'
}

export function isSessionExportFormat(value: unknown): value is SessionExportFormat {
  return SESSION_EXPORT_FORMATS.includes(value as SessionExportFormat)
}

export interface SessionExportOptions {
  format?: SessionExportFormat
  title?: string
  reveal?: boolean
  html?: string
}

export interface SessionMarkdownResult {
  ok: boolean
  markdown?: string
  error?: string
}

export interface SessionExportResult {
  ok: boolean
  path?: string
  bytes?: number
  cancelled?: boolean
  error?: string
}

export interface SessionImportResult {
  ok: boolean
  path?: string
  sessionId?: string
  cancelled?: boolean
  error?: string
}

export interface SessionTransferBridge {
  exportSession(sessionPath?: string, options?: SessionExportOptions): Promise<SessionExportResult>
  importSession(filePath?: string): Promise<SessionImportResult>
  sessionMarkdown(sessionPath: string, title?: string): Promise<SessionMarkdownResult>
}
