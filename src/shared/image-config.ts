export const IMAGE_SERVICES = ['codex', 'compatible', 'openai', 'google', 'doubao', 'local'] as const
export type ImageService = (typeof IMAGE_SERVICES)[number]
export type ImageProviderChoice = ImageService | 'auto'
export type ImageModelService = Exclude<ImageService, 'local' | 'codex'>
export type ImageComplexity = 'low' | 'medium' | 'high'
export type ImageKeyService = ImageModelService

export const IMAGE_KEY_SERVICES: readonly ImageKeyService[] = ['compatible', 'openai', 'google', 'doubao']
export const IMAGE_MODEL_SERVICES: readonly ImageModelService[] = ['compatible', 'openai', 'google', 'doubao']
export const IMAGE_COMPLEXITIES: readonly ImageComplexity[] = ['low', 'medium', 'high']

export interface ImageConfigFile {
  provider?: ImageProviderChoice
  models?: Partial<Record<ImageModelService, string>>
  baseUrl?: string
  complexity?: ImageComplexity
  keys?: Partial<Record<ImageKeyService, string>>
}

export type ImageKeySource = 'file' | 'other'

export interface ImageConfigView {
  provider: ImageProviderChoice
  models: Partial<Record<ImageModelService, string>>
  baseUrl: string
  complexity: ImageComplexity | 'default'
  keys: Partial<Record<ImageKeyService, ImageKeySource>>
  codex: boolean
  local: boolean
  defaults: Record<ImageModelService, string>
  resolved: ImageProviderChoice | 'unavailable' | 'mock'
}

export interface ImageConfigPatch {
  provider?: ImageProviderChoice
  model?: { service: ImageModelService; value: string }
  baseUrl?: string
  complexity?: ImageComplexity | 'default'
}

export function isImageChoice(value: unknown): value is ImageProviderChoice {
  return value === 'auto' || (typeof value === 'string' && (IMAGE_SERVICES as readonly string[]).includes(value))
}
