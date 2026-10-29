interface TurnModelCatalogEntry {
  provider: string
  id: string
  name?: string
}

interface TurnModelLabel {
  label: string
  identity: string
}

function bareId(identity: string): string {
  const separator = identity.indexOf('/')
  return separator > 0 ? identity.slice(separator + 1) : identity
}

export function findTurnModel<T extends TurnModelCatalogEntry>(identity: string, catalog: readonly T[]): T | undefined {
  const separator = identity.indexOf('/')
  const provider = separator > 0 ? identity.slice(0, separator) : null
  const id = bareId(identity)
  return catalog.find((item) => `${item.provider}/${item.id}` === identity)
    ?? catalog.find((item) => item.id === identity)
    ?? (provider !== null ? catalog.find((item) => item.provider === provider && item.id === id) : undefined)
    ?? catalog.find((item) => item.id === id)
}

export function turnModelLabel(identity: string, catalog: readonly TurnModelCatalogEntry[]): TurnModelLabel {
  return { label: findTurnModel(identity, catalog)?.name || bareId(identity), identity }
}

export function modelShiftTurnIds(turns: readonly { kind: string; id: string; model?: string }[]): ReadonlySet<string> {
  const ids = new Set<string>()
  let last: string | null = null
  for (const turn of turns) {
    if (turn.kind !== 'assistant' || !turn.model) continue
    if (last !== null && turn.model !== last) ids.add(turn.id)
    last = turn.model
  }
  return ids
}
