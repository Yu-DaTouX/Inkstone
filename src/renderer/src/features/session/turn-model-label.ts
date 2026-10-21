interface TurnModelCatalogEntry {
  provider: string
  id: string
  name?: string
}

interface TurnModelLabel {
  label: string
  identity: string
}

export function turnModelLabel(identity: string, catalog: readonly TurnModelCatalogEntry[]): TurnModelLabel {
  const separator = identity.indexOf('/')
  const provider = separator > 0 ? identity.slice(0, separator) : null
  const id = separator > 0 ? identity.slice(separator + 1) : identity
  const model = catalog.find((item) => `${item.provider}/${item.id}` === identity)
    ?? catalog.find((item) => item.id === identity)
    ?? (provider !== null ? catalog.find((item) => item.provider === provider && item.id === id) : undefined)
    ?? catalog.find((item) => item.id === id)
  return { label: model?.name || id, identity }
}
