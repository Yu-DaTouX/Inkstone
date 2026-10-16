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
  catalog: readonly TurnModelCatalogEntry[],
  fallbackCatalog: readonly TurnModelCatalogEntry[] = []
): TurnModelDisplay {
  const separator = identity.indexOf('/')
  const provider = separator > 0 ? identity.slice(0, separator) : undefined
  const id = provider ? identity.slice(separator + 1) : identity
  const exact = (entry: TurnModelCatalogEntry) => entry.provider === provider && entry.id === id
  const model = provider ? catalog.find(exact) ?? fallbackCatalog.find(exact) : undefined
  if (model) return { label: model.name || model.id, identity }

  const entries = new Map<string, TurnModelCatalogEntry>()
  for (const entry of [...catalog, ...fallbackCatalog]) {
    const key = JSON.stringify([entry.provider, entry.id])
    if (!entries.has(key)) entries.set(key, entry)
  }
  const names = new Set([...entries.values()].filter(entry => entry.id === identity).map(entry => entry.name || entry.id))
  return { label: names.size === 1 ? [...names][0] : id, identity }
}

export function resolveSubagentModelDisplay(
  identity: string,
  catalog: readonly TurnModelCatalogEntry[],
  fallbackCatalog: readonly TurnModelCatalogEntry[] = []
): TurnModelDisplay {
  const display = resolveTurnModelDisplay(identity, catalog, fallbackCatalog)
  const separator = identity.indexOf('/')
  return {
    ...display,
    label: separator > 0 ? `${display.label} · ${identity.slice(0, separator)}` : display.label
  }
}
