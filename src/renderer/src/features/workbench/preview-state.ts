export const MAX_PREVIEW_BINDINGS = 5

export interface PreviewTarget {
  path: string
  line: number
  lineEnd?: number
  nonce: number
}

export interface PreviewTabs {
  tabs: string[]
  active: string
  preview?: string | null
  target?: PreviewTarget
}

export interface PreviewOpenOptions {
  preview?: boolean
  line?: number
  lineEnd?: number
}

export type PreviewBindings = ReadonlyMap<string, PreviewTabs>

let targetNonce = 0

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

function compose(tabs: string[], active: string, preview: string | null | undefined, target: PreviewTarget | undefined): PreviewTabs {
  const keptPreview = preview && tabs.includes(preview) ? preview : null
  const keptTarget = target && tabs.includes(target.path) ? target : undefined
  return {
    tabs,
    active,
    ...(keptPreview ? { preview: keptPreview } : {}),
    ...(keptTarget ? { target: keptTarget } : {})
  }
}

export function openPreviewTab(
  bindings: PreviewBindings,
  ownerKey: string | null,
  path: string,
  options: PreviewOpenOptions = {}
): PreviewBindings {
  if (!ownerKey || !path) return bindings
  const current = bindings.get(ownerKey)
  const existing = current?.tabs ?? []
  const asPreview = options.preview === true
  let tabs: string[]
  let preview = current?.preview ?? null
  if (existing.includes(path)) {
    tabs = existing
    if (!asPreview && preview === path) preview = null
  } else if (asPreview && preview && existing.includes(preview)) {
    tabs = existing.map((tab) => (tab === preview ? path : tab))
    preview = path
  } else {
    tabs = [...existing, path]
    if (asPreview) preview = path
  }
  const target =
    typeof options.line === 'number' && options.line > 0
      ? {
          path,
          line: options.line,
          ...(typeof options.lineEnd === 'number' && options.lineEnd > options.line ? { lineEnd: options.lineEnd } : {}),
          nonce: (targetNonce += 1)
        }
      : current?.target && current.target.path !== path
        ? current.target
        : undefined
  return withBinding(bindings, ownerKey, compose(tabs, path, preview, target))
}

export function selectPreviewTab(bindings: PreviewBindings, ownerKey: string | null, path: string): PreviewBindings {
  if (!ownerKey) return bindings
  const current = bindings.get(ownerKey)
  if (!current || !current.tabs.includes(path)) return bindings
  return withBinding(bindings, ownerKey, compose(current.tabs, path, current.preview, current.target))
}

export function keepPreviewTab(bindings: PreviewBindings, ownerKey: string | null, path: string): PreviewBindings {
  if (!ownerKey) return bindings
  const current = bindings.get(ownerKey)
  if (!current || current.preview !== path) return bindings
  return withBinding(bindings, ownerKey, compose(current.tabs, current.active, null, current.target))
}

export function keepAllPreviewTabs(bindings: PreviewBindings): PreviewBindings {
  let changed = false
  const map = new Map<string, PreviewTabs>()
  for (const [key, value] of bindings) {
    if (value.preview) {
      changed = true
      map.set(key, compose(value.tabs, value.active, null, value.target))
    } else map.set(key, value)
  }
  return changed ? map : bindings
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
  return withBinding(bindings, ownerKey, compose(tabs, active, current.preview, current.target))
}

export function closeOtherPreviewTabs(bindings: PreviewBindings, ownerKey: string | null, keep: string): PreviewBindings {
  if (!ownerKey) return bindings
  const current = bindings.get(ownerKey)
  if (!current || !current.tabs.includes(keep)) return bindings
  return withBinding(bindings, ownerKey, compose([keep], keep, current.preview, current.target))
}

export function previewTabsToRight(tabs: readonly string[], path: string): string[] {
  const index = tabs.indexOf(path)
  return index < 0 ? [] : tabs.slice(index + 1)
}

export function closePreviewTabsToRight(bindings: PreviewBindings, ownerKey: string | null, path: string): PreviewBindings {
  if (!ownerKey) return bindings
  const current = bindings.get(ownerKey)
  if (!current) return bindings
  const index = current.tabs.indexOf(path)
  if (index < 0 || index === current.tabs.length - 1) return bindings
  const tabs = current.tabs.slice(0, index + 1)
  const active = tabs.includes(current.active) ? current.active : path
  return withBinding(bindings, ownerKey, compose(tabs, active, current.preview, current.target))
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

export function previewTabDetail(path: string, cwd: string): string {
  const abs = path.replace(/\\/g, '/')
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  const relative = root && abs.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? abs.slice(root.length + 1) : abs
  return relative
}
