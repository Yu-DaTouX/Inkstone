export const OPENCODE_PROXY_PLUGIN_ID = 'opencode-proxy'
export const OPENCODE_PROXY_PROVIDER = 'yan-opencode'
export const OPENCODE_PROXY_REPO = 'jasonxu114514/opencode2api'
export const OPENCODE_PROXY_LICENSE = 'GPL-3.0'
export const OPENCODE_PROXY_BASE_URL = `https://github.com/${OPENCODE_PROXY_REPO}`
export const OPENCODE_PROXY_RELEASES_URL = `${OPENCODE_PROXY_BASE_URL}/releases`

export interface OpenCodeProxyStatus {
  installed: boolean
  version: string
  running: boolean
  managed: boolean
  port: number
  consolePort: number
  baseUrl: string
  consoleUrl: string
  apiKey: string
  consoleUser: string
  consolePassword: string
  models: string[]
  providerLinked: boolean
  autoStart: boolean
  installDir: string
  configPath: string
  log: string[]
}

export interface OpenCodeProxyResult {
  ok: boolean
  status?: OpenCodeProxyStatus
  error?: string
  detail?: string
}

export interface OpenCodeProxyBridge {
  status(): Promise<OpenCodeProxyStatus>
  install(): Promise<OpenCodeProxyResult>
  start(): Promise<OpenCodeProxyResult>
  stop(): Promise<OpenCodeProxyResult>
  refresh(): Promise<OpenCodeProxyResult>
  uninstall(): Promise<OpenCodeProxyResult>
  autoStart(enabled: boolean): Promise<OpenCodeProxyResult>
}
