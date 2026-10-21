export interface ApiKeyView {
  id: string
  label: string
  masked: string
  active: boolean
}

export type ApiKeyPools = Record<string, ApiKeyView[]>

export interface StoredApiKey {
  id: string
  label: string
  key: string
  addedAt: number
}

export const CURRENT_KEY_ID = 'current'

export function maskApiKey(key: string): string {
  const k = key.trim()
  if (k.length <= 8) return '••••'
  return `${k.slice(0, 3)}…${k.slice(-4)}`
}

export function nextKeyLabel(list: readonly { label: string }[]): string {
  const used = new Set(list.map((k) => k.label))
  for (let n = list.length + 1; ; n++) if (!used.has(`Key ${n}`)) return `Key ${n}`
}

export function withCurrentKey(list: readonly StoredApiKey[], current: string | undefined, id: () => string, now = Date.now()): StoredApiKey[] {
  if (!current || list.some((k) => k.key === current)) return [...list]
  return [{ id: id(), label: nextKeyLabel(list), key: current, addedAt: now }, ...list]
}

export function poolView(list: readonly StoredApiKey[], current: string | undefined): ApiKeyView[] {
  const views = list.map((k) => ({ id: k.id, label: k.label, masked: maskApiKey(k.key), active: !!current && k.key === current }))
  if (current && !list.some((k) => k.key === current)) {
    views.unshift({ id: CURRENT_KEY_ID, label: nextKeyLabel(list), masked: maskApiKey(current), active: true })
  }
  return views
}
