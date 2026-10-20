export const MAX_PREVIEW_BINDINGS = 5
export const MAX_PREVIEW_TABS = 8
export const PREVIEW_BINDINGS_STORAGE_KEY = 'yan.preview.bindings'
export const MAX_PERSISTED_PREVIEW_OWNERS = MAX_PREVIEW_BINDINGS

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

function trimPreviewTabs(tabs: string[], keep: readonly (string | null | undefined)[]): string[] {
  if (tabs.length <= MAX_PREVIEW_TABS) return tabs
  const kept = new Set(keep.filter((path): path is string => !!path))
  const next = tabs.slice()
  while (next.length > MAX_PREVIEW_TABS) {
    const index = next.findIndex((tab) => !kept.has(tab))
    if (index < 0) break
    next.splice(index, 1)
  }
  return next
}

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
  tabs = trimPreviewTabs(tabs, [path, preview])
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

export function movePreviewTab(
  bindings: PreviewBindings,
  ownerKey: string | null,
  path: string,
  toIndex: number
): PreviewBindings {
  if (!ownerKey) return bindings
  const current = bindings.get(ownerKey)
  if (!current || !Number.isInteger(toIndex)) return bindings
  const from = current.tabs.indexOf(path)
  if (from < 0) return bindings
  const to = Math.max(0, Math.min(current.tabs.length - 1, toIndex))
  if (to === from) return bindings
  const tabs = current.tabs.slice()
  const [moved] = tabs.splice(from, 1)
  tabs.splice(to, 0, moved)
  return withBinding(bindings, ownerKey, compose(tabs, current.active, current.preview, current.target))
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

export function previewTabDirectory(path: string, cwd: string): string | undefined {
  const relative = previewTabDetail(path, cwd)
  const index = relative.lastIndexOf('/')
  if (index < 0) return undefined
  return relative.slice(0, index) || '/'
}

export interface PreviewBindingsStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function parsePreviewBinding(value: unknown): PreviewTabs | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as { tabs?: unknown; active?: unknown; preview?: unknown }
  if (!Array.isArray(raw.tabs)) return null
  const tabs: string[] = []
  for (const tab of raw.tabs) {
    if (validPath(tab) && !tabs.includes(tab)) tabs.push(tab)
  }
  if (!tabs.length) return null
  const trimmed = tabs.slice(0, MAX_PREVIEW_TABS)
  const active = validPath(raw.active) && trimmed.includes(raw.active) ? raw.active : trimmed[0]
  const preview = validPath(raw.preview) && trimmed.includes(raw.preview) ? raw.preview : null
  return compose(trimmed, active, preview, undefined)
}

export function parsePreviewBindings(raw: string | null | undefined): PreviewBindings {
  if (!raw) return new Map()
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return new Map()
  }
  if (!data || typeof data !== 'object') return new Map()
  const owners = (data as { owners?: unknown }).owners
  if (!owners || typeof owners !== 'object') return new Map()
  const out = new Map<string, PreviewTabs>()
  for (const [key, value] of Object.entries(owners as Record<string, unknown>)) {
    if (!key) continue
    const binding = parsePreviewBinding(value)
    if (binding) out.set(key, binding)
  }
  while (out.size > MAX_PERSISTED_PREVIEW_OWNERS) {
    const oldest = out.keys().next().value
    if (oldest === undefined) break
    out.delete(oldest)
  }
  return out
}

export function serializePreviewBindings(bindings: PreviewBindings): string {
  const owners: Record<string, { tabs: string[]; active: string; preview?: string }> = {}
  for (const [key, value] of bindings) {
    if (!key || !value.tabs.length) continue
    owners[key] = {
      tabs: value.tabs.slice(0, MAX_PREVIEW_TABS),
      active: value.active,
      ...(value.preview ? { preview: value.preview } : {})
    }
  }
  return JSON.stringify({ version: 1, owners })
}

export function readPreviewBindings(storage: PreviewBindingsStorage | null): PreviewBindings {
  if (!storage) return new Map()
  try {
    return parsePreviewBindings(storage.getItem(PREVIEW_BINDINGS_STORAGE_KEY))
  } catch {
    return new Map()
  }
}

export function writePreviewBindings(storage: PreviewBindingsStorage | null, bindings: PreviewBindings): void {
  if (!storage) return
  try {
    storage.setItem(PREVIEW_BINDINGS_STORAGE_KEY, serializePreviewBindings(bindings))
  } catch {}
}
