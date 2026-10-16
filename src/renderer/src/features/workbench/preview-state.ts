export const MAX_PREVIEW_BINDINGS = 5

export function bindPreviewPath(
  bindings: ReadonlyMap<string, string>,
  ownerKey: string | null,
  path: string
): ReadonlyMap<string, string> {
  if (!ownerKey) return bindings
  const next = new Map(bindings)
  next.delete(ownerKey)
  next.set(ownerKey, path)
  while (next.size > MAX_PREVIEW_BINDINGS) {
    const oldest = next.keys().next().value
    if (oldest === undefined) break
    next.delete(oldest)
  }
  return next
}

export function previewPathFor(bindings: ReadonlyMap<string, string>, ownerKey: string | null): string | undefined {
  if (!ownerKey) return undefined
  return bindings.get(ownerKey)
}
