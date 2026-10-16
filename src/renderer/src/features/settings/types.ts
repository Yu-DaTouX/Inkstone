/**
 * v3 设置的分区与「旧深链接 → v3 页」映射（纯逻辑，无 React / store / DOM 依赖）。
 *
 * 为什么单独一份：v3 设置只保留实际做出来的分区（外观 / 上下文 / 模型与服务 / 能力 / 用量 / 快捷键），
 * 而 `useStore.openSettings(tab)` 里还散落着 v2 的旧页名（auth / voice / packages / devices…）。
 * 映射必须是可单测的纯函数，界面层才能在拿不到对应 v3 页时如实提示旧界面，而不是静默吞掉导航。
 */

import { GENERAL_LEGACY_MAP } from './general/general-model'

export type SettingsSectionId =
  | 'appearance'
  | 'session'
  | 'notifications'
  | 'context'
  | 'models'
  | 'capabilities'
  | 'security'
  | 'devices'
  | 'data'
  | 'usage'
  | 'shortcuts'
  | 'about'
  | 'sync'

export interface SettingsSectionDef {
  readonly id: SettingsSectionId
  /** 外观图标由界面层从 lucide-react 解析，这里只给稳定 id */
  readonly icon:
    | 'moon'
    | 'clock'
    | 'bell'
    | 'gauge'
    | 'key'
    | 'sparkles'
    | 'shield'
    | 'smartphone'
    | 'hard-drive'
    | 'chart'
    | 'keyboard'
    | 'info'
    | 'refresh'
}

/** 导航顺序按 02 §10.6：外观、会话、通知、上下文、模型、能力、权限、设备、数据、用量、快捷键、关于，同步追加在最后。 */
export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  { id: 'appearance', icon: 'moon' },
  { id: 'session', icon: 'clock' },
  { id: 'notifications', icon: 'bell' },
  { id: 'context', icon: 'gauge' },
  { id: 'models', icon: 'key' },
  { id: 'capabilities', icon: 'sparkles' },
  { id: 'security', icon: 'shield' },
  { id: 'devices', icon: 'smartphone' },
  { id: 'data', icon: 'hard-drive' },
  { id: 'usage', icon: 'chart' },
  { id: 'shortcuts', icon: 'keyboard' },
  { id: 'about', icon: 'info' },
  { id: 'sync', icon: 'refresh' }
]

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'appearance'

export function isSettingsSectionId(value: unknown): value is SettingsSectionId {
  return (
    value === 'appearance' ||
    value === 'session' ||
    value === 'notifications' ||
    value === 'context' ||
    value === 'models' ||
    value === 'capabilities' ||
    value === 'security' ||
    value === 'devices' ||
    value === 'data' ||
    value === 'usage' ||
    value === 'shortcuts' ||
    value === 'about' ||
    value === 'sync'
  )
}

/**
 * 旧 v2 SettingsTab → v3 分区。
 *
 * 只映射已经有 v3 页的旧名；通用分区（会话 / 设备 / 关于）的映射单一来源在
 * `general/general-model.ts` 的 `GENERAL_LEGACY_MAP`。`voice` / `knowledge` 仍归能力。
 */
const LEGACY_VIEW_TO_SECTION: Record<string, SettingsSectionId> = {
  appearance: 'appearance',
  input: 'appearance',
  sound: 'appearance',
  context: 'context',
  auth: 'models',
  models: 'models',
  capabilities: 'capabilities',
  voice: 'capabilities',
  knowledge: 'capabilities',
  packages: 'capabilities',
  market: 'capabilities',
  usage: 'usage',
  ...GENERAL_LEGACY_MAP
}

/** v2 `SettingsTab` 的完整旧页名（含未迁移的），用来区分「旧页但没搬」和「完全不认识」。 */
const KNOWN_V2_VIEWS: readonly string[] = [
  'auth',
  'appearance',
  'input',
  'workspace',
  'capabilities',
  'voice',
  'devices',
  'about',
  'sound',
  'status',
  'knowledge',
  'packages',
  'market',
  'remote',
  'peer',
  'usage'
]

export type LegacyViewResolution =
  | { kind: 'section'; view: string; section: SettingsSectionId }
  | { kind: 'unmigrated'; view: string }
  | { kind: 'unknown'; view: string }

/** 解析一个旧页名：能落到 v3 分区就落，落不到就如实说明。 */
export function resolveLegacyView(view: string | null | undefined): LegacyViewResolution {
  const name = typeof view === 'string' ? view.trim() : ''
  if (isSettingsSectionId(name)) return { kind: 'section', view: name, section: name }
  const mapped = LEGACY_VIEW_TO_SECTION[name]
  if (mapped) return { kind: 'section', view: name, section: mapped }
  if (KNOWN_V2_VIEWS.includes(name)) return { kind: 'unmigrated', view: name }
  return { kind: 'unknown', view: name }
}
