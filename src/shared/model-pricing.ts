import { catalogKey, cleanModelCost, type ModelCost, type PiModelCatalog } from './custom-provider'

let catalog: PiModelCatalog = {}

export function setPricingCatalog(next: PiModelCatalog): void {
  catalog = next
}

export function priceOf(model: string | undefined): ModelCost | undefined {
  if (!model) return undefined
  return cleanModelCost(catalog[catalogKey(model)]?.cost)
}

export interface TokenCounts {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export function estimateCost(model: string | undefined, tokens: TokenCounts): number | undefined {
  const price = priceOf(model)
  if (!price) return undefined
  return (tokens.input * price.input + tokens.output * price.output + tokens.cacheRead * price.cacheRead + tokens.cacheWrite * price.cacheWrite) / 1_000_000
}
