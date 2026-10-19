export const MAX_PREVIEW_BINDINGS = 5

export interface PreviewTabs {
  tabs: string[]
  active: string
}

export type PreviewBindings = ReadonlyMap<string, PreviewTabs>

function withBinding(
  bindings: PreviewBindings,
  ownerKey: string | null,
  next: PreviewTabs | null
): PreviewBindings {
  if (!ownerKey) return bindings
  const map = new Map(bindings)
  map.delete(ownerKey)
  if (next && next.tabs.length) map.set(ownerKey, next)
  while (map.size > MAX_PREVIEW_BINDINGS) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
  return map
}

export function openPreviewTab(bindings: PreviewBindings, ownerKey: string | null, path: string): PreviewBindings {
  if (!ownerKey || !path) return bindings
  const current = bindings.get(ownerKey)
  const tabs = current?.tabs.includes(path) ? current.tabs : [...(current?.tabs ?? []), path]
  return withBinding(bindings, ownerKey, { tabs, active: path })
}

export function selectPreviewTab(bindings: PreviewBindings, ownerKey: string | null, path: string): PreviewBindings {
  if (!ownerKey) return bindings
  const current = bindings.get(ownerKey)
  if (!current || !current.tabs.includes(path)) return bindings
  return withBinding(bindings, ownerKey, { tabs: current.tabs, active: path })
}

export function closePreviewTab(bindings: PreviewBindings, ownerKey: string | null, path: string): PreviewBindings {
  if (!ownerKey) return bindings
  const current = bindings.get(ownerKey)
  if (!current) return bindings
  const index = current.tabs.indexOf(path)
  if (index < 0) return bindings
  const tabs = current.tabs.filter((tab) => tab !== path)
  if (!tabs.length) return withBinding(bindings, ownerKey, null)
  const active = current.active === path ? tabs[Math.min(index, tabs.length - 1)] : current.active
  return withBinding(bindings, ownerKey, { tabs, active })
}

export function closeOtherPreviewTabs(bindings: PreviewBindings, ownerKey: string | null, keep: string): PreviewBindings {
  if (!ownerKey) return bindings
  const current = bindings.get(ownerKey)
  if (!current || !current.tabs.includes(keep)) return bindings
  return withBinding(bindings, ownerKey, { tabs: [keep], active: keep })
}

export function closeAllPreviewTabs(bindings: PreviewBindings, ownerKey: string | null): PreviewBindings {
  return withBinding(bindings, ownerKey, null)
}

export function previewTabsFor(bindings: PreviewBindings, ownerKey: string | null): PreviewTabs | undefined {
  if (!ownerKey) return undefined
  return bindings.get(ownerKey)
}

export function previewPathFor(bindings: PreviewBindings, ownerKey: string | null): string | undefined {
  return previewTabsFor(bindings, ownerKey)?.active
}

export function previewTabLabel(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return segments[segments.length - 1] ?? path
}
