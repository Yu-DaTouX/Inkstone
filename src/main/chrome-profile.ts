import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, cpSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export function chromeUserDataRoot(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string {
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Google', 'Chrome', 'User Data')
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Google', 'Chrome')
  }
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'google-chrome')
}

export interface ChromeProfileLocation {
  root: string
  name: string
  dir: string
}

export function pickProfileName(entries: string[], env: NodeJS.ProcessEnv = process.env, lastUsed?: string): string | null {
  const override = env.YAN_CHROME_PROFILE?.trim()
  if (override && entries.includes(override)) return override
  if (entries.includes('Default')) return 'Default'
  const profiles = entries.filter((e) => /^Profile \d+$/.test(e))
  if (lastUsed && profiles.includes(lastUsed)) return lastUsed
  return profiles.sort((a, b) => Number(a.slice(8)) - Number(b.slice(8))).at(-1) ?? null
}

export function findChromeProfile(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): ChromeProfileLocation | null {
  const root = chromeUserDataRoot(platform, env, home)
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return null
  }
  let lastUsed: string | undefined
  try {
    const state = JSON.parse(readFileSync(join(root, 'Local State'), 'utf8')) as { profile?: { last_used?: unknown } }
    if (typeof state.profile?.last_used === 'string') lastUsed = state.profile.last_used
  } catch { }
  const name = pickProfileName(entries, env, lastUsed)
  if (!name) return null
  const dir = join(root, name)
  try {
    if (!statSync(dir).isDirectory()) return null
  } catch {
    return null
  }
  return { root, name, dir }
}

export const SYNC_ITEMS: { rel: string; dir?: boolean; optional?: boolean }[] = [
  { rel: '{p}/History' },
  { rel: '{p}/History-journal', optional: true },
  { rel: '{p}/Bookmarks', optional: true },
  { rel: '{p}/Local Storage', dir: true, optional: true }
]

export const COOKIE_ITEMS: { rel: string; optional?: boolean }[] = [
  { rel: '{p}/Network/Cookies' },
  { rel: '{p}/Network/Cookies-journal', optional: true }
]

export const COOKIE_KEY_ITEM = { rel: 'Local State' }

export interface ChromeSyncReport {
  found: boolean
  source?: string
  target?: string
  copied: string[]
  failed: { item: string; reason: string }[]
  chromeRunning: boolean
  cookiesSynced: boolean
}

export function isChromeRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const [cmd, args] =
      process.platform === 'win32'
        ? ['tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH']]
        : ['pgrep', ['-x', process.platform === 'darwin' ? 'Google Chrome' : 'chrome']]
    execFile(cmd, args, { timeout: 4000, windowsHide: true }, (err, stdout) => {
      if (err && process.platform === 'win32') return resolve(false)
      if (process.platform === 'win32') return resolve(/chrome\.exe/i.test(String(stdout)))
      resolve(!err)
    })
  })
}

function copyOne(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
}

export function syncChromeProfile(targetProfileDir: string, location: ChromeProfileLocation, options: { skipCookies?: boolean } = {}): Omit<ChromeSyncReport, 'chromeRunning' | 'cookiesSynced'> {
  const copied: string[] = []
  const failed: { item: string; reason: string }[] = []
  mkdirSync(targetProfileDir, { recursive: true })

  const copyItem = (item: { rel: string; dir?: boolean; optional?: boolean }): boolean => {
    const rel = item.rel.replace('{p}', location.name)
    const from = join(location.root, rel)
    const to = join(targetProfileDir, item.rel.replace('{p}', 'Default'))
    if (!existsSync(from)) {
      if (!item.optional) failed.push({ item: rel, reason: '源文件不存在' })
      return false
    }
    try {
      if (item.dir) cpSync(from, to, { recursive: true, force: true })
      else copyOne(from, to)
      copied.push(rel)
      return true
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? ''
      const reason =
        code === 'EBUSY' || code === 'EPERM'
          ? 'Chrome 正在运行，文件被占用（退出 Chrome 后重试）'
          : code || (e instanceof Error ? e.message : String(e))
      failed.push({ item: rel, reason })
      return false
    }
  }

  for (const item of SYNC_ITEMS) copyItem(item)

  let cookieOk = !options.skipCookies
  if (options.skipCookies) {
    failed.push({ item: 'Cookies / Local State', reason: 'Chrome 正在运行；退出后可同步 Cookie 与解密密钥' })
  }
  for (const item of options.skipCookies ? [] : COOKIE_ITEMS) {
    const okOne = copyItem(item)
    if (!item.optional && !okOne) cookieOk = false
  }
  if (cookieOk) {
    copyItem(COOKIE_KEY_ITEM)
  } else if (!options.skipCookies) {
    failed.push({ item: COOKIE_KEY_ITEM.rel, reason: 'Cookie 未能同步，密钥一并跳过（否则会弄坏本已可用的 cookie）' })
  }

  return { found: true, source: location.root, target: targetProfileDir, copied, failed }
}

export async function syncLocalChromeData(targetProfileDir: string): Promise<ChromeSyncReport> {
  if (process.env.YAN_CHROME_SYNC === '0') {
    return { found: false, copied: [], failed: [], chromeRunning: false, cookiesSynced: false }
  }
  const chromeRunning = await isChromeRunning()
  const location = findChromeProfile()
  if (!location) {
    return {
      found: false,
      copied: [],
      failed: [{ item: '本机 Chrome profile', reason: '没找到本机 Chrome 的用户数据（未安装或从未登录过）' }],
      chromeRunning,
      cookiesSynced: false
    }
  }
  const base = syncChromeProfile(targetProfileDir, location, { skipCookies: chromeRunning })
  const cookiesSynced = false
  return { ...base, chromeRunning, cookiesSynced }
}
