export const MAX_PREVIEW_SCOPES = 5

export interface PreviewScopeOwner {
  readonly key: string
  readonly cwd?: string
}

export interface PreviewSelectionEntry {
  readonly path: string
  readonly external: string | null
}

export interface ResolvedPreviewPath {
  readonly path: string | null
  readonly externalChanged: boolean
}

export function previewScopeKey(owner: PreviewScopeOwner): string {
  return [owner.key, owner.cwd ?? ''].join('\u0000')
}

export function recordPreviewSelection(
  selections: ReadonlyMap<string, PreviewSelectionEntry>,
  scopeKey: string,
  path: string,
  external: string | null
): ReadonlyMap<string, PreviewSelectionEntry> {
  const next = new Map(selections)
  next.delete(scopeKey)
  next.set(scopeKey, { path, external })
  while (next.size > MAX_PREVIEW_SCOPES) {
    const oldest = next.keys().next().value
    if (oldest === undefined) break
    next.delete(oldest)
  }
  return next
}

export function dropPreviewSelection(
  selections: ReadonlyMap<string, PreviewSelectionEntry>,
  scopeKey: string
): ReadonlyMap<string, PreviewSelectionEntry> {
  if (!selections.has(scopeKey)) return selections
  const next = new Map(selections)
  next.delete(scopeKey)
  return next
}

export function resolvePreviewPath(
  entry: PreviewSelectionEntry | undefined,
  externalPath: string | null
): ResolvedPreviewPath {
  if (!entry) return { path: externalPath, externalChanged: false }
  if (entry.external !== externalPath) return { path: externalPath, externalChanged: true }
  return { path: entry.path, externalChanged: false }
}

export function previewViewKey(scopeKey: string, path: string | null, reload: number): string | null {
  return path ? [scopeKey, path, String(reload)].join('\u0000') : null
}

export function previewBaseName(path: string): string {
  return path.replace(/^.*[\\/]/, '')
}
