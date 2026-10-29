import { MODEL_BRANDS, modelBrand, type ModelBrand } from '../../../shared/model-brand'
import type { ModelInfo } from '../../../shared/ipc'

const BRAND_LABELS: Record<ModelBrand, string> = {
  claude: 'Claude',
  codex: 'OpenAI',
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  gemini: 'Gemini',
  kimi: 'Kimi',
  glm: 'GLM',
  grok: 'Grok',
  pi: ''
}

export function brandOfModel(model: Pick<ModelInfo, 'provider' | 'id'>): ModelBrand {
  return modelBrand({ provider: model.provider, id: model.id })
}

export function brandLabel(brand: ModelBrand, otherLabel: string): string {
  return BRAND_LABELS[brand] || otherLabel
}

export function brandsOf(models: readonly Pick<ModelInfo, 'provider' | 'id'>[]): ModelBrand[] {
  const present = new Set(models.map(brandOfModel))
  return MODEL_BRANDS.filter((brand) => present.has(brand))
}
