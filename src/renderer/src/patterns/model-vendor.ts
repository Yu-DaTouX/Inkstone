import { modelBrand, type ModelBrand } from '../../../shared/model-brand'
import type { ModelInfo } from '../../../shared/ipc'

export function brandOfModel(model: Pick<ModelInfo, 'provider' | 'id'>): ModelBrand {
  return modelBrand({ provider: model.provider, id: model.id })
}
