import type { FileRequestContext } from './ipc'

export interface FileNameSearchRequest extends FileRequestContext {
  requestId: string
  query: string
  scope?: string
  limit?: number
}

export interface FileNameMatch {
  path: string
  name: string
  directory: boolean
  positions: number[]
  score: number
}

export type FileNameSearchErrorCode = 'superseded' | 'busy' | 'timeout' | 'invalid' | 'failed'

export type FileNameSearchSource = 'git' | 'walk' | 'none'

export interface FileNameSearchResult {
  request: FileNameSearchRequest
  matches: FileNameMatch[]
  truncated: boolean
  source: FileNameSearchSource
  scanned: number
  error?: { code: FileNameSearchErrorCode; message?: string }
}
