/** Desktop preferences identify a model by provider and id, never credentials. */
export interface ModelChoice { provider: string; id: string; name?: string }

export function modelKey(model: Pick<ModelChoice, 'provider' | 'id'>): string {
  return JSON.stringify([model.provider, model.id])
}

export function cleanModelChoice(value: unknown): ModelChoice | undefined {
  if (!value || typeof value !== 'object') return undefined
  const m = value as Partial<ModelChoice>
  if (typeof m.provider !== 'string' || typeof m.id !== 'string' || !m.provider.trim() || !m.id.trim()
    || m.provider.length > 256 || m.id.length > 512 || /[\u0000-\u001f]/.test(m.provider + m.id)) return undefined
  if (m.provider === 'unknown' || m.id === 'unknown') return undefined
  return { provider: m.provider, id: m.id, ...(typeof m.name === 'string' ? { name: m.name.slice(0, 256) } : {}) }
}

export function cleanModelFavorites(value: unknown): ModelChoice[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.map(cleanModelChoice).filter((m): m is ModelChoice => {
    if (!m || seen.has(modelKey(m))) return false
    seen.add(modelKey(m)); return true
  }).slice(0, 256)
}

/** User-defined provider order for model menus; unknown providers keep alphabetical order after it. */
export function cleanProviderOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 200))].slice(0, 128)
}
