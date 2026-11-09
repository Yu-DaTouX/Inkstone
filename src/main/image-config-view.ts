import { IMAGE_KEY_SERVICES, type ImageConfigView, type ImageKeyService } from '../shared/image-config'
import { hostImageCredentials } from './image-credentials'
import { IMAGE_MODEL_DEFAULTS, detectImageProviders, resolveImageProvider } from './image-generation'
import { imageConfigSnapshot, imageFileKey, refreshImageConfig } from './image-config'

export async function imageConfigView(): Promise<ImageConfigView> {
  const file = await refreshImageConfig()
  const availability = await detectImageProviders()
  const keys: ImageConfigView['keys'] = {}
  for (const service of IMAGE_KEY_SERVICES as readonly ImageKeyService[]) {
    if (imageFileKey(service)) keys[service] = 'file'
    else if (await hostImageCredentials.secret(service)) keys[service] = 'other'
  }
  return {
    provider: file.provider ?? 'auto',
    models: { ...imageConfigSnapshot().models },
    baseUrl: file.baseUrl ?? '',
    complexity: file.complexity ?? 'default',
    keys,
    codex: availability.codex,
    local: !!availability.local,
    defaults: { ...IMAGE_MODEL_DEFAULTS },
    resolved: resolveImageProvider(undefined, availability)
  }
}
