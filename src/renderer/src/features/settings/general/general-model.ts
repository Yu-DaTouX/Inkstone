/**
 * v3 设置「通用分区」（会话 / 通知 / 权限安全 / 设备同步 / 数据 / 关于）的纯逻辑。
 *
 * 这里只放不依赖 React / store / DOM 的取值、格式化与归一化，方便 Node 侧直接断言；
 * 组件负责把真实 store 字段与既有 IPC 接进这些函数，不新造设置字段或权限档。
 */
import type { SoundSettings } from '../../../../../shared/ipc'
import type { PermissionMode } from '../../../../../shared/approval'

export type GeneralSectionId = 'session' | 'notifications' | 'security' | 'devices' | 'data' | 'about'

/**
 * 旧 `openSettings(name)` 页名 → 通用分区。
 *
 * 只映射**本轮真正落盘的**分区；`sound` / `input` 仍归外观（那里已有声音总开关与音量），
 * `voice` / `knowledge` 仍归能力。这份映射由 `types.ts` 的补丁引入，单一来源在这里，
 * 避免两处各写一份。
 */
export const GENERAL_LEGACY_MAP: Readonly<Record<string, GeneralSectionId>> = {
  workspace: 'session',
  devices: 'devices',
  remote: 'devices',
  peer: 'devices',
  about: 'about',
  status: 'about'
}

/** 分区顺序按 02 §10.6：会话、通知与提醒、权限与安全、设备与同步、数据、关于。 */
export const GENERAL_SECTION_ORDER: readonly GeneralSectionId[] = [
  'session',
  'notifications',
  'security',
  'devices',
  'data',
  'about'
]

/** 缺省声音设置，与主进程 DEFAULTS 同形（设置还没读完时的兜底）。 */
export const DEFAULT_SOUND_SETTINGS: SoundSettings = {
  enabled: false,
  volume: 0.4,
  notifications: true,
  events: { done: true, question: true, error: true }
}

/** 数据体积：≥1GB 用 GB，否则四舍五入到 MB；非法值当 0。 */
export function bytesText(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${Math.round(bytes / 1024 ** 2)} MB`
}

/** 时间戳 → 本地时间；缺失 / 非法显示为「从未」这类占位词。 */
export function formatWhen(at: number | null | undefined, never: string, lang: string): string {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return never
  try {
    return new Date(at).toLocaleString(lang === 'en-US' ? 'en-US' : 'zh-CN')
  } catch {
    return never
  }
}

/** 合并声音设置：事件开关逐项合并，避免整段替换丢掉未动的项。 */
export function mergeSound(base: SoundSettings, patch: Partial<SoundSettings>): SoundSettings {
  return {
    ...base,
    ...patch,
    events: { ...base.events, ...(patch.events ?? {}) }
  }
}

/** 从允许目录里移除一条（不改其它项）。 */
export function removeAllowRoot(roots: readonly string[], path: string): string[] {
  return roots.filter((item) => item !== path)
}

/** 切到「不受限制」需要一次确认；切回「危险批准」不需要。 */
export function permissionNeedsConfirm(next: PermissionMode): boolean {
  return next === 'all'
}

/** pi 来源的显示标签（供关于页用；未知来源不猜）。 */
export function piSourceLabel(source: string | undefined): string {
  switch (source) {
    case 'bundled':
      return 'bundled'
    case 'global':
      return 'global'
    case 'override':
      return 'override'
    case 'env':
      return 'env'
    case 'path':
      return 'path'
    case 'shell':
      return 'shell'
    default:
      return '—'
  }
}
