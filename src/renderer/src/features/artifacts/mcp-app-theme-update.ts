export type McpAppResolvedTheme = 'light' | 'dark'

export const MCP_APP_DARK_QUERY = '(prefers-color-scheme: dark)'

export interface McpAppThemeDocumentLike {
  getAttribute(name: string): string | null
}

export interface McpAppMediaQueryListLike {
  matches: boolean
  addEventListener?(type: 'change', listener: () => void): void
  removeEventListener?(type: 'change', listener: () => void): void
  addListener?(listener: () => void): void
  removeListener?(listener: () => void): void
}

export interface McpAppMutationObserverLike {
  observe(target: unknown, options: { attributes: boolean; attributeFilter: string[] }): void
  disconnect(): void
}

export interface McpAppThemeWatcherDeps {
  documentElement: McpAppThemeDocumentLike
  createObserver?(callback: () => void): McpAppMutationObserverLike | null
  matchMedia?(query: string): McpAppMediaQueryListLike | null
}

export function readMcpAppResolvedTheme(
  documentElement: McpAppThemeDocumentLike,
  systemPrefersDark = false
): McpAppResolvedTheme {
  const attr = documentElement.getAttribute('data-theme')
  if (attr === 'light' || attr === 'dark') return attr
  return systemPrefersDark ? 'dark' : 'light'
}

export interface McpAppThemeWatcher {
  current(): McpAppResolvedTheme
  dispose(): void
}

export function createMcpAppThemeWatcher(
  deps: McpAppThemeWatcherDeps,
  onChange: (theme: McpAppResolvedTheme) => void
): McpAppThemeWatcher {
  const media = deps.matchMedia ? deps.matchMedia(MCP_APP_DARK_QUERY) : null
  let current = readMcpAppResolvedTheme(deps.documentElement, media?.matches === true)
  let disposed = false

  const evaluate = (): void => {
    if (disposed) return
    const next = readMcpAppResolvedTheme(deps.documentElement, media?.matches === true)
    if (next === current) return
    current = next
    onChange(next)
  }

  const observer = deps.createObserver ? deps.createObserver(evaluate) : null
  observer?.observe(deps.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  if (media) {
    if (media.addEventListener) media.addEventListener('change', evaluate)
    else if (media.addListener) media.addListener(evaluate)
  }

  return {
    current: () => current,
    dispose(): void {
      if (disposed) return
      disposed = true
      observer?.disconnect()
      if (media) {
        if (media.removeEventListener) media.removeEventListener('change', evaluate)
        else if (media.removeListener) media.removeListener(evaluate)
      }
    }
  }
}
