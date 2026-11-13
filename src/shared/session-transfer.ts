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
  exportSession(sessionPath?: string): Promise<SessionExportResult>
  importSession(): Promise<SessionImportResult>
}
