import { setPricingCatalog } from '../shared/model-pricing'
import { readPiModelCatalog } from './pi-model-catalog'

let loading: Promise<void> | undefined

export function loadModelPricing(): Promise<void> {
  loading ??= readPiModelCatalog().then(setPricingCatalog).catch(() => undefined)
  return loading
}
