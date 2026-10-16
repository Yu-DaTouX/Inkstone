/**
 * MCP App 已打开实例的动态主题跟读（M2）。
 *
 * 只做一件事：检测「已解析主题」（`<html data-theme>`，缺省时看系统配色偏好）是否
 * 变化，并在变化时回调「该重新取一次宿主上下文了」。它**不**生成主题值、不碰 iframe、
 * 不直接 `postMessage`；真正的 `hostContext` 由主进程按 instance / owner / generation
 * 下发（`YanBridge.mcpApps.hostContext`），所以渲染端本地主题只触发读取、不充当身份。
 *
 * 依赖全部可注入（documentElement / observer / matchMedia），便于在 Node 里用假对象
 * 直接测；不依赖 React、不读真实窗口。
 */

export type McpAppResolvedTheme = 'light' | 'dark'

/** 系统配色偏好查询串；与 `Theme` / `data-theme` 一致的唯一深色判定。 */
export const MCP_APP_DARK_QUERY = '(prefers-color-scheme: dark)'

export interface McpAppThemeDocumentLike {
  getAttribute(name: string): string | null
}

/** `window.matchMedia(...)` 返回物的最小形状（兼容 addListener 旧实现）。 */
export interface McpAppMediaQueryListLike {
  matches: boolean
  addEventListener?(type: 'change', listener: () => void): void
  removeEventListener?(type: 'change', listener: () => void): void
  addListener?(listener: () => void): void
  removeListener?(listener: () => void): void
}

/** `MutationObserver` 的最小形状；只观察 `data-theme` 属性。 */
export interface McpAppMutationObserverLike {
  observe(target: unknown, options: { attributes: boolean; attributeFilter: string[] }): void
  disconnect(): void
}

export interface McpAppThemeWatcherDeps {
  documentElement: McpAppThemeDocumentLike
  /** 监听 `data-theme` 属性变化的观察器工厂；缺省不监听属性。 */
  createObserver?(callback: () => void): McpAppMutationObserverLike | null
  /** 系统配色偏好查询；缺省不监听系统变化。 */
  matchMedia?(query: string): McpAppMediaQueryListLike | null
}

/**
 * 读取「已解析」主题：优先 `data-theme`（App.tsx 已把设置解析成 light/dark 并落在此），
 * 缺省回落到系统偏好；两者都没有按浅色。
 */
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

/**
 * 订阅主题变化：**只在解析出的主题真的变了**时回调一次（初值不算变化）。
 * `dispose()` 必须同时移除属性观察器与 matchMedia 监听；重复 dispose 是幂等的。
 */
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
