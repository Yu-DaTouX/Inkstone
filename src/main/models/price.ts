import { cleanModelCost } from '../../shared/custom-provider'

export interface ModelPrice {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

export function modelPriceOf(raw: unknown): ModelPrice | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const cost = cleanModelCost((raw as { cost?: unknown }).cost)
  if (!cost) return undefined
  return { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite }
}

export function attachModelPrice<T extends object>(
  model: T | undefined,
  raw: unknown
): (T & { cost?: ModelPrice }) | undefined {
  if (!model) return undefined
  const price = modelPriceOf(raw)
  if (!price) return model
  return { ...model, cost: price }
}
