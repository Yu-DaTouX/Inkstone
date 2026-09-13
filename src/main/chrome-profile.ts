/**
 * 把**本机真实 Chrome 的登录状态与历史**导入到我们托管的那份 profile。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要这个文件
 * ══════════════════════════════════════════════════════════════════
 * 「接入本机 Chrome」功能用的是一个**独立 profile**（见 chrome.ts 顶部注释）：
 * Chrome 136 起，对默认配置目录开 `--remote-debugging-port` 会被安全策略拒绝，
 * 所以只能另起一个目录。代价是那个 profile 是空白的 —— 用户看到的
 * 「cookie 和历史没有共享」就是这个原因，不是 bug 而是那条安全策略的后果。
 *
 * 既然不能直接用默认目录，退而求其次：**把默认目录里的关键数据复制过去**。
 * 复制完，托管的 Chrome 就带着用户的登录态和历史，而真实 profile 一个字节都不动。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么有些文件现在就能拷、有些必须等 Chrome 退出
 * ══════════════════════════════════════════════════════════════════
 * 实测（Windows / Chrome 152）在 Chrome **正在运行**时逐个试过：
 *
 *   Local State        ✅ 可读      （Cookie 的解密密钥就在里面）
 *   History            ✅ 可读      （27MB，SQLite）
 *   Bookmarks          ✅ 可读
 *   Preferences        ✅ 可读
 *   Web Data           ✅ 可读
 *   Network/Cookies    ❌ 独占锁    （EBUSY，打不开、也拷不走）
 *
 * 所以历史/admin 数据随时能同步；**Cookie 必须等 Chrome 退出**。
 * 这不是我们能让步的地方：那是 Chrome 对 Cookies 库加的独占锁。
 * 与其拷一份半成品让用户以为登录态同步了，不如如实报告哪几项没同步。
 *
 * ══════════════════════════════════════════════════════════════════
 * 关于 cookie 解密（为什么一定要连 `Local State` 一起拷）
 * ══════════════════════════════════════════════════════════════════
 * Chrome 的 cookie 值不是明文，密钥存在 `Local State` 的 `os_crypt` 里。
 * 只拷 `Network/Cookies` 而不拷 `Local State`，拿到的是**解不开的密文** ——
 * 这正是很多同类工具「拷了 cookie 却还是要登录」的原因。
 * `os_crypt.app_bound_encrypted_key` 那一层由 Windows 按「同一个用户 +
 * 同一个 chrome.exe」保护，我们是同一台机器上同一个 Chrome，所以能解开；
 * 但也因此**换机器/换 Chrome 安装位置会失效**（这里不做跨机迁移）。
 */
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, cpSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 真实 Chrome 用户数据根目录（跨平台） */
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
  /** 用户数据根目录 */
  root: string
  /** 子 profile 名（Default / Profile 1 …） */
  name: string
  /** 子 profile 的绝对路径 */
  dir: string
}

/**
 * 选一个子 profile。
 *
 * 为什么要有优先级而不是无脑 `Default`：多账号用户的常用号常常在
 * `Profile 1/2/…`。选择顺序：
 *   ① 环境变量 `YAN_CHROME_PROFILE` 指定（测试与高级用户）
 *   ② `Default` 存在就用它
 *   ③ 否则取 `Profile *` 里**最近修改**的那个（最可能是常用号）
 * 纯函数：传入 readdir 结果，便于单测，不自己碰文件系统。
 */
export function pickProfileName(entries: string[], env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.YAN_CHROME_PROFILE?.trim()
  if (override && entries.includes(override)) return override
  if (entries.includes('Default')) return 'Default'
  const profiles = entries.filter((e) => /^Profile \d+$/.test(e))
  return profiles.length ? profiles[0] : null
}

/** 定位真实 Chrome profile；找不到返回 null（没装 Chrome 或没登录过） */
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
  const name = pickProfileName(entries, env)
  if (!name) return null
  const dir = join(root, name)
  try {
    if (!statSync(dir).isDirectory()) return null
  } catch {
    return null
  }
  return { root, name, dir }
}

/**
 * 随时可同步的条目（相对用户数据根目录）：不依赖 cookie 解密密钥，
 * Chrome 开着也能读。
 */
export const SYNC_ITEMS: { rel: string; dir?: boolean; optional?: boolean }[] = [
  /* 历史（用户明确要求共享的一项） */
  { rel: '{p}/History' },
  { rel: '{p}/History-journal', optional: true },
  /* 书签（顺带，成本极低） */
  { rel: '{p}/Bookmarks', optional: true },
  /* 很多 SPA（含 ChatGPT）把会话放 localStorage；不拷这项会「cookie 在、还是要登录」 */
  { rel: '{p}/Local Storage', dir: true, optional: true }
]

/**
 * Cookie 本体。和 `Local State` 是**一对**：cookie 值用 Local State 里的密钥加密，
 * 两者版本不匹配就是一堆解不开的密文。分开放是为了能原子地一起拷/一起跳过。
 */
export const COOKIE_ITEMS: { rel: string; optional?: boolean }[] = [
  { rel: '{p}/Network/Cookies' },
  { rel: '{p}/Network/Cookies-journal', optional: true }
]

/** cookie 解密密钥所在（根目录） */
export const COOKIE_KEY_ITEM = { rel: 'Local State' }

export interface ChromeSyncReport {
  /** 找到真实 profile 了吗（没找到时下面字段都为空） */
  found: boolean
  /** 真实 profile 路径 */
  source?: string
  /** 托管 profile 路径 */
  target?: string
  /** 成功同步的条目（展示用，相对路径） */
  copied: string[]
  /** 失败/跳过及原因 */
  failed: { item: string; reason: string }[]
  /** 是否探测到 Chrome 正在运行（决定 cookie 能不能同步） */
  chromeRunning: boolean
  /** cookie 是否成功同步 —— UI 据此决定要不要提示「请先退出 Chrome」 */
  cookiesSynced: boolean
}

/** Chrome 是否在运行。决定「能不能同步 cookie」，所以单独探测。 */
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

/** 单文件复制；目标目录不存在就建 */
function copyOne(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
}

/**
 * 把真实 profile 同步进托管 profile。
 *
 * 设计原则：**逐项容错**。任何一项失败都不能让整体失败 ——
 * 历史同步成功、cookie 因为 Chrome 没关而失败，是完全正常且有用的一半结果。
 * 返回值逐项说明，UI 才能给出准确的提示，而不是一句笼统的「同步失败」。
 */
export function syncChromeProfile(targetProfileDir: string, location: ChromeProfileLocation): Omit<ChromeSyncReport, 'chromeRunning' | 'cookiesSynced'> {
  const copied: string[] = []
  const failed: { item: string; reason: string }[] = []
  mkdirSync(targetProfileDir, { recursive: true })

  /** 复制一项；返回是否成功。失败原因写进 failed（可选缺失除外）。 */
  const copyItem = (item: { rel: string; dir?: boolean; optional?: boolean }): boolean => {
    const rel = item.rel.replace('{p}', location.name)
    const from = join(location.root, rel)
    const to = join(targetProfileDir, rel)
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
      /*
       * EBUSY / EPERM 几乎总是「Chrome 正开着，这个库被独占锁住」。
       * 把它翻译成用户能行动的话，而不是把 errno 甩到界面上。
       */
      const code = (e as NodeJS.ErrnoException).code ?? ''
      const reason =
        code === 'EBUSY' || code === 'EPERM'
          ? 'Chrome 正在运行，文件被占用（退出 Chrome 后重试）'
          : code || (e instanceof Error ? e.message : String(e))
      failed.push({ item: rel, reason })
      return false
    }
  }

  /* ① 与 cookie 无关的：历史 / 书签 / localStorage —— 随时能同步 */
  for (const item of SYNC_ITEMS) copyItem(item)

  /*
   * ② cookie 与它的解密密钥必须**成对**处理。
   *
   * 为什么不能各自独立地拷：`Local State` 里是 cookie 的解密密钥，
   * 如果 cookie 没拷成（Chrome 开着）而 Local State 拷了，
   * 托管 profile 里**原有的** cookie 会因为密钥变了而全部解不开 ——
   * 那是把「没同步」变成「本来能用的也坏了」。所以 cookie 拿不到时，
   * Local State 也一并跳过，并如实说明。
   */
  let cookieOk = true
  for (const item of COOKIE_ITEMS) {
    const okOne = copyItem(item)
    if (!item.optional && !okOne) cookieOk = false
  }
  if (cookieOk) {
    copyItem(COOKIE_KEY_ITEM)
  } else {
    failed.push({ item: COOKIE_KEY_ITEM.rel, reason: 'Cookie 未能同步，密钥一并跳过（否则会弄坏本已可用的 cookie）' })
  }

  return { found: true, source: location.root, target: targetProfileDir, copied, failed }
}

/** 同步入口：探测 → 定位 → 复制，返回完整报告（供 IPC / UI 直接用） */
export async function syncLocalChromeData(targetProfileDir: string): Promise<ChromeSyncReport> {
  /*
   * 隔离开关：自动化测试里设 YAN_CHROME_SYNC=0，避免探针去读真实 Chrome 的
   * 浏览历史与 cookie（功能本身可以，但测试不该碰真实用户数据）。
   */
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
  const base = syncChromeProfile(targetProfileDir, location)
  const cookiesSynced = base.copied.some((c) => c.endsWith('Network/Cookies'))
  return { ...base, chromeRunning, cookiesSynced }
}
