/**
 * 桌面端专属设置（窗口尺寸、主题、语言、cwd、记忆排序）。
 *
 * 刻意**不写 pi 的 settings.json** —— 那是 TUI 和扩展的领地，
 * 桌面端改它会污染用户的 pi 配置。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AppSettings } from '../shared/ipc'
import { YAN_DIR } from './memory'

// 与记忆共用目录（YAN_DATA_DIR 可覆盖，测试用隔离目录）
const DIR = YAN_DIR
const FILE = join(DIR, 'desktop.json')

const DEFAULTS: AppSettings = {
  cwd: homedir(),
  theme: 'dark',
  lang: 'zh-CN',
  memoryOrder: ['soul', 'about', 'impressions', 'people', 'projects', 'status'],
  recentCwds: []
}

let cached: AppSettings | null = null

export async function getSettings(): Promise<AppSettings> {
  if (cached) return cached
  try {
    const raw = await readFile(FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    cached = { ...DEFAULTS, ...parsed }
    if (!Array.isArray(cached.memoryOrder) || cached.memoryOrder.length === 0) {
      cached.memoryOrder = [...DEFAULTS.memoryOrder]
    }
    if (!Array.isArray(cached.recentCwds)) cached.recentCwds = []
  } catch {
    cached = { ...DEFAULTS }
  }
  return cached
}

export async function patchSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const cur = await getSettings()
  const next: AppSettings = { ...cur, ...patch }

  if (patch.recentCwds) {
    // 去重、保留最近 8 个
    next.recentCwds = [...new Set(patch.recentCwds)].slice(0, 8)
  }
  if (next.cwd && next.cwd !== cur.cwd) {
    next.recentCwds = [next.cwd, ...next.recentCwds.filter((p) => p !== next.cwd)].slice(0, 8)
  }

  cached = next
  try {
    await mkdir(DIR, { recursive: true })
    await writeFile(FILE, JSON.stringify(next, null, 2), 'utf8')
  } catch (e) {
    console.error('[settings] 写入失败：', e)
  }
  return next
}
