import { NativeEventEmitter, NativeModules, Platform } from 'react-native'
import { pick } from '../../src/shared/ui-lang'

const LATEST_RELEASE = 'https://api.github.com/repos/Yu-DaTouX/Inkstone/releases/latest'
const ASSET = /^Inkstone-mobile-(\d+\.\d+\.\d+)\.apk$/

interface UpdateNative {
  version?: string
  getConstants?(): { version?: string }
  download(url: string, version: string): Promise<string>
  install(path: string): Promise<'permission' | 'started'>
}

const native = Platform.OS === 'android' ? (NativeModules.InkstoneAppUpdate as UpdateNative | undefined) : undefined

export interface AppUpdate {
  version: string
  url: string
  size: number
  notes: string
}

interface ReleaseAsset {
  name?: unknown
  browser_download_url?: unknown
  size?: unknown
}

export function updatesSupported(): boolean {
  return !!native
}

export function currentVersion(): string {
  return native?.getConstants?.().version ?? native?.version ?? ''
}

export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let i = 0; i < 3; i++) if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) - (right[i] ?? 0)
  return 0
}

export function pickUpdate(release: unknown, current: string): AppUpdate | null {
  if (!release || typeof release !== 'object') return null
  const data = release as { assets?: unknown; body?: unknown; draft?: unknown; prerelease?: unknown }
  if (data.draft || data.prerelease || !Array.isArray(data.assets)) return null
  let best: AppUpdate | null = null
  for (const asset of data.assets as ReleaseAsset[]) {
    const match = typeof asset?.name === 'string' ? ASSET.exec(asset.name) : null
    if (!match || typeof asset.browser_download_url !== 'string' || !asset.browser_download_url.startsWith('https://github.com/')) continue
    if (compareVersions(match[1], current) <= 0 || (best && compareVersions(match[1], best.version) <= 0)) continue
    best = { version: match[1], url: asset.browser_download_url, size: typeof asset.size === 'number' ? asset.size : 0, notes: typeof data.body === 'string' ? data.body.slice(0, 4000) : '' }
  }
  return best
}

export async function checkForUpdate(): Promise<AppUpdate | null> {
  const current = currentVersion()
  if (!native || !current) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12_000)
  try {
    const response = await fetch(LATEST_RELEASE, { headers: { accept: 'application/vnd.github+json' }, signal: controller.signal })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(pick(`检查更新失败（${response.status}）`, `Update check failed (${response.status})`))
    return pickUpdate(await response.json(), current)
  } catch (error) {
    if ((error as { name?: string })?.name === 'AbortError') throw new Error(pick('检查更新超时，请检查网络', 'Update check timed out. Check your network.'))
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function downloadUpdate(update: AppUpdate, onProgress: (fraction: number) => void): Promise<string> {
  if (!native) throw new Error(pick('这台设备不支持应用内更新', 'In-app updates are not supported on this device'))
  const events = new NativeEventEmitter(NativeModules.InkstoneAppUpdate)
  const subscription = events.addListener('InkstoneUpdateProgress', (event: { received?: number; total?: number }) => {
    const total = event.total && event.total > 0 ? event.total : update.size
    if (total > 0 && typeof event.received === 'number') onProgress(Math.min(1, event.received / total))
  })
  try {
    return await native.download(update.url, update.version)
  } finally {
    subscription.remove()
  }
}

export async function installUpdate(path: string): Promise<'permission' | 'started'> {
  if (!native) throw new Error(pick('这台设备不支持应用内更新', 'In-app updates are not supported on this device'))
  return native.install(path)
}
