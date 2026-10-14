/** Resolve a persisted provider/model key against the current model catalog. */
export interface TurnModelCatalogEntry {
  provider: string
  id: string
  name?: string
}

export interface TurnModelDisplay {
  label: string
  identity: string
}

export function resolveTurnModelDisplay(
  identity: string,
  catalog: readonly TurnModelCatalogEntry[]
): TurnModelDisplay {
  const separator = identity.indexOf('/')
  if (separator <= 0) return { label: identity, identity }
  const provider = identity.slice(0, separator)
  const id = identity.slice(separator + 1)
  const model = catalog.find((item) => item.provider === provider && item.id === id)
  return { label: model?.name || id, identity }
}
