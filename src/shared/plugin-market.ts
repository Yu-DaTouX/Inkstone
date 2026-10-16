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
export interface PluginExportResult {
  ok: boolean
  cancelled?: boolean
  path?: string
  error?: string
  existed?: boolean
}
