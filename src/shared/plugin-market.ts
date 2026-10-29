export interface MarketPackage {
  name: string
  version: string
  description: string
  source: string
  publisher: string
  npmUrl: string
  homepage?: string
}
export interface MarketSearchResult {
  ok: boolean
  entries: MarketPackage[]
  total: number
  error?: string
}
export interface CodegraphStatus {
  cliInstalled: boolean
  configured: boolean
  cwd?: string
  indexed?: boolean
}
export interface MinecraftPluginStatus {
  installed: boolean
  configured: boolean
  conflict: boolean
  skill: boolean
  pluginDir: string
  installedVersion?: string
  latestVersion?: string
}
export interface MinecraftPluginResult {
  ok: boolean
  path?: string
  error?: string
  status?: MinecraftPluginStatus
}
export interface PluginExportResult {
  ok: boolean
  cancelled?: boolean
  path?: string
  error?: string
  existed?: boolean
}
