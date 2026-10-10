export interface MarketPackage {
  name: string
  version: string
  description: string
  source: string
  publisher: string
  /** npm package page; always present for a valid entry. */
  npmUrl: string
  /** Repository or homepage declared by the publisher, https only. */
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
}
