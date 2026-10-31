import { findTurnModel } from '../features/session/turn-model-label'

export interface ModelNameEntry {
  provider: string
  id: string
  name?: string
}

const UPPER_WORDS = new Set(['gpt', 'glm', 'ai', 'vl', 'api'])

function prettifyModelId(identity: string): string {
  const last = identity.split('/').filter(Boolean).pop() ?? identity
  const base = last.replace(/:[a-z]+$/i, '').replace(/-\d{8}$/, '')
  const words = base
    .replace(/(\d)-(\d)/g, '$1.$2')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase()
      if (UPPER_WORDS.has(lower)) return lower.toUpperCase()
      if (/^[a-z]\d/i.test(word)) return word.toUpperCase()
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
  return words.join(' ') || identity
}

export function modelDisplayName(identity: string, catalog: readonly ModelNameEntry[]): string {
  const raw = identity.trim()
  if (!raw) return raw
  const parts = raw.split('/')
  const direct = findTurnModel(raw, catalog)
  if (direct?.name) return direct.name
  for (let index = 1; index < parts.length; index++) {
    const tail = parts.slice(index).join('/')
    const hit = catalog.find((model) => model.id === tail && model.name)
    if (hit?.name) return hit.name
  }
  return prettifyModelId(raw)
}
