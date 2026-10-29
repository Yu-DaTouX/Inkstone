export interface LocalServerInfo {
  url: string
  port: number
  host: string
  pid?: number
  processName?: string
  title?: string
}

export interface LocalServerSnapshot {
  servers: LocalServerInfo[]
}
