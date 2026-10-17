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
export interface PluginExportResult {
  ok: boolean
  cancelled?: boolean
  path?: string
  error?: string
  existed?: boolean
}
