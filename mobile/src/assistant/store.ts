import * as Keychain from 'react-native-keychain'

export type AssistantProvider = {
  id: string
  label: string
  baseUrl: string
  model: string
  apiKey: string
  temperature?: number
}

export type AssistantSettings = {
  providers: AssistantProvider[]
  activeProviderId: string | null
  remember: boolean
}

export const EMPTY_SETTINGS: AssistantSettings = { providers: [], activeProviderId: null, remember: true }

const SERVICE = 'inkstone.assistant.settings'

function normalize(raw: unknown): AssistantSettings {
  if (!raw || typeof raw !== 'object') return EMPTY_SETTINGS
  const value = raw as Partial<AssistantSettings>
  const providers = Array.isArray(value.providers)
    ? value.providers.filter((p): p is AssistantProvider => !!p && typeof p === 'object' && typeof (p as AssistantProvider).baseUrl === 'string' && typeof (p as AssistantProvider).model === 'string')
    : []
  const activeProviderId = typeof value.activeProviderId === 'string' && providers.some((p) => p.id === value.activeProviderId) ? value.activeProviderId : providers[0]?.id ?? null
  return { providers, activeProviderId, remember: value.remember !== false }
}

export async function loadSettings(): Promise<AssistantSettings> {
  try {
    const entry = await Keychain.getGenericPassword({ service: SERVICE })
    if (!entry) return EMPTY_SETTINGS
    return normalize(JSON.parse(entry.password))
  } catch {
    return EMPTY_SETTINGS
  }
}

export async function saveSettings(settings: AssistantSettings): Promise<void> {
  await Keychain.setGenericPassword('assistant', JSON.stringify(settings), {
    service: SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY
  })
}

export async function clearSettings(): Promise<void> {
  await Keychain.resetGenericPassword({ service: SERVICE })
}

export function maskKey(apiKey: string): string {
  const tail = apiKey.slice(-4)
  return apiKey.length <= 4 ? '****' : `****${tail}`
}

export function activeProvider(settings: AssistantSettings): AssistantProvider | null {
  return settings.providers.find((p) => p.id === settings.activeProviderId) ?? null
}
