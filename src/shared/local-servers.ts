export interface LocalServerInfo {
  url: string
  port: number
  host: string
  pid?: number
  processName?: string
  title?: string
  agentStarted?: boolean
}

export interface LocalServerSnapshot {
  servers: LocalServerInfo[]
}

export type LocalServerStopCode = 'gone' | 'not-agent' | 'failed'

export interface LocalServerStopResult {
  ok: boolean
  code?: LocalServerStopCode
}
