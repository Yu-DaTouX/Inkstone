/** 动态导入失败时的自动恢复。
 *
 * 开发版从 out/ 加载构建产物，重新构建会换掉带哈希的 chunk 文件；已经打开的窗口
 * 在第一次点开懒加载页面（设置、用量、协作、终端等）时会请求到已不存在的旧文件，
 * 动态导入因此抛错。Vite 在 window 上派发 `vite:preloadError`，这里自动重载一次，
 * 让窗口换上新的产物；短时间内重复失配则不再自动重载，交给界面提示。
 */

const STALE_CHUNK_PATTERNS = [
  'failed to fetch dynamically imported module',
  'importing a module script failed',
  'error loading dynamically imported module',
  'unable to preload css'
]

export const PRELOAD_RELOAD_KEY = 'yan:preload-reload-at'

/** 两次自动重载的最小间隔：避免产物本身坏掉时反复刷新。 */
export const PRELOAD_RELOAD_MIN_INTERVAL_MS = 60_000

/** 判断一个错误是否是「chunk 已经不在了」这类可自动恢复的加载失败。 */
export function isStaleChunkError(message: string): boolean {
  const text = message.toLowerCase()
  return STALE_CHUNK_PATTERNS.some((pattern) => text.includes(pattern))
}

export interface PreloadRecoveryDeps {
  /** 注册 `vite:preloadError` 的处理器，由调用方负责 preventDefault。 */
  onPreloadError: (handler: () => void) => void
  reload: () => void
  now: () => number
  read: (key: string) => string | null
  write: (key: string, value: string) => void
}

export function installPreloadRecovery(deps: PreloadRecoveryDeps): void {
  deps.onPreloadError(() => {
    const last = Number(deps.read(PRELOAD_RELOAD_KEY) ?? 0)
    const now = deps.now()
    if (Number.isFinite(last) && last > 0 && now - last < PRELOAD_RELOAD_MIN_INTERVAL_MS) return
    try {
      deps.write(PRELOAD_RELOAD_KEY, String(now))
    } catch {
      // 存不下就不限频：宁可多刷一次，也不要停在错误页
    }
    deps.reload()
  })
}

export function installBrowserPreloadRecovery(): void {
  installPreloadRecovery({
    onPreloadError: (handler) => {
      window.addEventListener('vite:preloadError', (event) => {
        ;(event as Event).preventDefault()
        handler()
      })
    },
    reload: () => window.location.reload(),
    now: () => Date.now(),
    read: (key) => {
      try {
        return window.sessionStorage.getItem(key)
      } catch {
        return null
      }
    },
    write: (key, value) => {
      try {
        window.sessionStorage.setItem(key, value)
      } catch {
        // 隐私模式等场景拿不到 sessionStorage：退化成每次重载
      }
    }
  })
}
