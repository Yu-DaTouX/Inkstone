/**
 * 宿主动作表与键位判定（命令面板 / 快捷键表 / 全局按键分发的**唯一**纯数据源）。
 *
 * 为什么放在一个不依赖 React / store / DOM 的模块里：
 *   · 命令面板（Ctrl+K 的 `>` 模式）与快捷键表（Ctrl+/）必须用同一份清单，
 *     否则两处各维护一份，迟早对不上；
 *   · 键位分发、可用性判定、搜索过滤是纯逻辑，可以在 Node 里直接验证，
 *     不必启动 Electron（见 `scripts/test-command-palette.mjs`）。
 *
 * 这里**只做决策**：`runHostAction` 通过传入的 `HostActionRuntime` 调用各入口的
 * 正式动作，不 import store，也不自己写第二套事件或状态。
 */
import type { TFunc } from '../i18n'

export type HostT = TFunc

/** 面板与快捷键表共用的键位绑定。`keys` 是逐键显示，顺序即按法。 */
export type ShortcutBindingId =
  | 'openSettings'
  | 'shortcutSheet'
  | 'toggleRail'
  | 'focusComposer'
  | 'copyLastReply'
  | 'openSessionSwitcher'
  | 'newSession'
  | 'cycleModel'
  | 'cycleModelBack'
  | 'cycleThinking'

export interface KeyBinding {
  keys: string[]
  /** 快捷键表分组；面板/表同源，这里只放全局组 */
  group: 'global'
  labelKey: string
}

/**
 * 键位表：既是快捷键表「全局」组的数据，也是宿主动作行右侧键位的来源。
 * 改键位只改这里；真正的拦截逻辑在 `resolveShortcut`。
 */
export const KEY_BINDINGS: Record<ShortcutBindingId, KeyBinding> = {
  openSettings: { keys: ['Ctrl', ','], group: 'global', labelKey: 'sheet.openSettings' },
  shortcutSheet: { keys: ['Ctrl', '/'], group: 'global', labelKey: 'sheet.shortcutSheet' },
  toggleRail: { keys: ['Ctrl', 'B'], group: 'global', labelKey: 'sheet.toggleRail' },
  focusComposer: { keys: ['Ctrl', 'L'], group: 'global', labelKey: 'sheet.focusComposer' },
  copyLastReply: { keys: ['Ctrl', 'Shift', 'C'], group: 'global', labelKey: 'sheet.copyLastReply' },
  openSessionSwitcher: { keys: ['Ctrl', 'K'], group: 'global', labelKey: 'sheet.sessionSwitcher' },
  newSession: { keys: ['Ctrl', 'N'], group: 'global', labelKey: 'sheet.newSession' },
  cycleModel: { keys: ['Ctrl', 'P'], group: 'global', labelKey: 'sheet.cycleModel' },
  cycleModelBack: { keys: ['Ctrl', 'Shift', 'P'], group: 'global', labelKey: 'sheet.cycleModelBack' },
  cycleThinking: { keys: ['Shift', 'Tab'], group: 'global', labelKey: 'sheet.cycleThinking' }
}

export type HostActionId =
  | 'newSession'
  | 'newSessionProject'
  | 'openSettings'
  | 'settingsAuth'
  | 'settingsAppearance'
  | 'settingsWorkspace'
  | 'settingsCapabilities'
  | 'settingsMarket'
  | 'settingsDevices'
  | 'settingsAbout'
  | 'openShortcutSheet'
  | 'themeDark'
  | 'themeLight'
  | 'toggleRail'
  | 'permissionDanger'
  | 'permissionAll'
  | 'launchFiles'
  | 'launchBrowser'
  | 'launchTerminal'
  | 'launchTasks'
  | 'launchAgents'
  | 'launchLogs'
  | 'launchAccounts'
  | 'copyLastReply'
  | 'stopRun'

export type HostActionSection = 'session' | 'settings' | 'view' | 'tools' | 'ops'

export interface HostActionAvailability {
  running: boolean
  hasLastReply: boolean
  hasProject: boolean
  permission: 'danger' | 'all'
  theme: 'dark' | 'light'
  browserOpen: boolean
}

export interface HostActionDef {
  id: HostActionId
  section: HostActionSection
  labelKey: string
  /** 面板里键位：指向 KEY_BINDINGS */
  binding?: ShortcutBindingId
  /** 侧栏工具磁贴的 kind；`runHostAction` 走工作区启动入口 */
  tool?: 'files' | 'browser' | 'terminal' | 'tasks' | 'agents' | 'logs' | 'accounts'
  /** 设置页导航 ID */
  settingsTab?: string
}

/** 前端固定宿主动作表（唯一一份）。 */
export const HOST_ACTIONS: HostActionDef[] = [
  { id: 'newSession', section: 'session', labelKey: 'action.newSession', binding: 'newSession' },
  { id: 'newSessionProject', section: 'session', labelKey: 'action.newSessionProject' },
  { id: 'openSettings', section: 'settings', labelKey: 'action.openSettings', binding: 'openSettings' },
  { id: 'settingsAuth', section: 'settings', labelKey: 'action.settingsAuth', settingsTab: 'auth' },
  { id: 'settingsAppearance', section: 'settings', labelKey: 'action.settingsAppearance', settingsTab: 'appearance' },
  { id: 'settingsWorkspace', section: 'settings', labelKey: 'action.settingsWorkspace', settingsTab: 'workspace' },
  { id: 'settingsCapabilities', section: 'settings', labelKey: 'action.settingsCapabilities', settingsTab: 'capabilities' },
  { id: 'settingsMarket', section: 'settings', labelKey: 'action.settingsMarket', settingsTab: 'market' },
  { id: 'settingsDevices', section: 'settings', labelKey: 'action.settingsDevices', settingsTab: 'devices' },
  { id: 'settingsAbout', section: 'settings', labelKey: 'action.settingsAbout', settingsTab: 'about' },
  { id: 'openShortcutSheet', section: 'settings', labelKey: 'action.shortcutSheet', binding: 'shortcutSheet' },
  { id: 'themeDark', section: 'view', labelKey: 'action.themeDark' },
  { id: 'themeLight', section: 'view', labelKey: 'action.themeLight' },
  { id: 'toggleRail', section: 'view', labelKey: 'action.toggleRail', binding: 'toggleRail' },
  { id: 'permissionDanger', section: 'view', labelKey: 'action.permissionDanger' },
  { id: 'permissionAll', section: 'view', labelKey: 'action.permissionAll' },
  { id: 'launchFiles', section: 'tools', labelKey: 'action.launchFiles', tool: 'files' },
  { id: 'launchBrowser', section: 'tools', labelKey: 'action.launchBrowser', tool: 'browser' },
  { id: 'launchTerminal', section: 'tools', labelKey: 'action.launchTerminal', tool: 'terminal' },
  { id: 'launchTasks', section: 'tools', labelKey: 'action.launchTasks', tool: 'tasks' },
  { id: 'launchAgents', section: 'tools', labelKey: 'action.launchAgents', tool: 'agents' },
  { id: 'launchLogs', section: 'tools', labelKey: 'action.launchLogs', tool: 'logs' },
  { id: 'launchAccounts', section: 'tools', labelKey: 'action.launchAccounts', tool: 'accounts' },
  { id: 'copyLastReply', section: 'ops', labelKey: 'action.copyLastReply', binding: 'copyLastReply' },
  { id: 'stopRun', section: 'ops', labelKey: 'action.stopRun' }
]

/** 空输入时给的三条常用动作提示。 */
export const QUICK_ACTION_IDS: HostActionId[] = ['newSession', 'openSettings', 'launchTerminal']

export const HOST_SECTION_ORDER: HostActionSection[] = ['session', 'settings', 'view', 'tools', 'ops']

export function hostSectionKey(section: HostActionSection): string {
  return `action.section.${section}`
}

export function hostActionById(id: HostActionId): HostActionDef | undefined {
  return HOST_ACTIONS.find((action) => action.id === id)
}

/** 不可用原因（i18n key）；返回 undefined 表示可用。 */
export function hostActionDisabledReason(
  action: HostActionDef,
  avail: HostActionAvailability
): string | undefined {
  switch (action.id) {
    case 'newSessionProject':
      return avail.hasProject ? undefined : 'action.needProject'
    case 'themeDark':
      return avail.theme === 'dark' ? 'action.alreadyTheme' : undefined
    case 'themeLight':
      return avail.theme === 'light' ? 'action.alreadyTheme' : undefined
    case 'permissionDanger':
      return avail.permission === 'danger' ? 'action.alreadyPermission' : undefined
    case 'permissionAll':
      return avail.permission === 'all' ? 'action.alreadyPermission' : undefined
    case 'copyLastReply':
      return avail.hasLastReply ? undefined : 'action.noLastReply'
    case 'stopRun':
      return avail.running ? undefined : 'action.notRunning'
    default:
      return undefined
  }
}

export function isHostActionDisabled(action: HostActionDef, avail: HostActionAvailability): boolean {
  return hostActionDisabledReason(action, avail) !== undefined
}

/* ───────────────────────── 搜索：沿用会话切换器的 token 过滤 ───────────────────────── */

/** 把查询拆成词；全部出现才算命中（与会话切换器同一实现）。 */
export function tokensOf(query: string): string[] {
  return [...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 6)
}

export function matchesTokens(haystack: string, tokens: string[]): boolean {
  if (!tokens.length) return true
  const hay = haystack.toLowerCase()
  return tokens.every((token) => hay.includes(token))
}

/** 按顺序过滤宿主动作；labelOf 给出已翻译的名称。 */
export function filterHostActions(
  query: string,
  labelOf: (action: HostActionDef) => string,
  actions: HostActionDef[] = HOST_ACTIONS
): HostActionDef[] {
  const tokens = tokensOf(query)
  if (!tokens.length) return actions
  return actions.filter((action) => matchesTokens(labelOf(action), tokens))
}

/** 按段落顺序分组（面板渲染用）。 */
export function groupHostActions(actions: HostActionDef[]): { section: HostActionSection; actions: HostActionDef[] }[] {
  return HOST_SECTION_ORDER.map((section) => ({
    section,
    actions: actions.filter((action) => action.section === section)
  })).filter((group) => group.actions.length > 0)
}

/* ───────────────────────── 执行：只调用各入口的正式动作 ───────────────────────── */

export interface HostActionResult {
  ok: boolean
  error?: string
}

export interface HostActionRuntime {
  openSettings(tab?: string): void
  newSession(): void | Promise<unknown>
  newSessionProject(): void | Promise<unknown>
  setPermission(mode: 'danger' | 'all'): void | Promise<unknown>
  setTheme(theme: 'dark' | 'light'): void | Promise<unknown>
  toggleRail(): void
  launchTool(kind: 'files' | 'browser' | 'terminal' | 'tasks' | 'agents' | 'logs' | 'accounts'): void
  copyLastReply(): void | Promise<unknown>
  stopRun(): void | Promise<unknown>
  openShortcutSheet(): void
}

/**
 * 执行一个宿主动作。成功/失败只表达「有没有抛出」，具体反馈由各正式动作负责。
 * 异步动作的会话 / runner 归属由调用方在动作前后核对（见命令面板）。
 */
export async function runHostAction(id: HostActionId, rt: HostActionRuntime): Promise<HostActionResult> {
  const def = hostActionById(id)
  if (!def) return { ok: false, error: 'unknown-action' }
  try {
    if (def.settingsTab) {
      rt.openSettings(def.settingsTab)
      return { ok: true }
    }
    if (def.tool) {
      rt.launchTool(def.tool)
      return { ok: true }
    }
    switch (id) {
      case 'newSession':
        await rt.newSession()
        return { ok: true }
      case 'newSessionProject':
        await rt.newSessionProject()
        return { ok: true }
      case 'openSettings':
        rt.openSettings()
        return { ok: true }
      case 'openShortcutSheet':
        rt.openShortcutSheet()
        return { ok: true }
      case 'themeDark':
        await rt.setTheme('dark')
        return { ok: true }
      case 'themeLight':
        await rt.setTheme('light')
        return { ok: true }
      case 'toggleRail':
        rt.toggleRail()
        return { ok: true }
      case 'permissionDanger':
        await rt.setPermission('danger')
        return { ok: true }
      case 'permissionAll':
        await rt.setPermission('all')
        return { ok: true }
      case 'copyLastReply':
        await rt.copyLastReply()
        return { ok: true }
      case 'stopRun':
        await rt.stopRun()
        return { ok: true }
      default:
        return { ok: false, error: 'unhandled-action' }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/* ───────────────────────── 全局按键判定 ───────────────────────── */

export type ShortcutId =
  | 'openSettings'
  | 'shortcutSheet'
  | 'toggleRail'
  | 'focusComposer'
  | 'copyLastReply'
  | 'openSessionSwitcher'
  | 'newSession'
  | ShortcutBindingId

export interface KeyState {
  key: string
  ctrl: boolean
  meta: boolean
  alt: boolean
  shift: boolean
  /** 输入法组合态：Enter / 方向键等归输入法，不能当快捷键 */
  composing: boolean
  /** 长按重复触发：只执行一次 */
  repeat: boolean
  /** AltGraph（欧洲键盘的 AltGr 组合）不能被当成 Ctrl+Alt */
  altGraph: boolean
  /** 焦点在终端内：让给 xterm */
  inTerminal: boolean
  /** 有模态层打开：全局分发让位，只由最上层处理 */
  modalOpen: boolean
}

/**
 * 把一次 keydown 归纳为一个动作 ID；不适用时返回 null。
 *
 * 与 `App.tsx` 主进程 before-input-event 的关系：那边只拦 Ctrl+P / Ctrl+Shift+P /
 * Shift+Tab，且带模态守卫；这里只在按键真的到达渲染端时执行，并按 250ms 时间锁
 * 与主进程那条路去重（见 App.tsx）。新加的键（Ctrl+, / Ctrl+B / Ctrl+L /
 * Ctrl+Shift+C / Ctrl+/）主进程不拦，只走这里。
 */
export function resolveShortcut(state: KeyState): ShortcutId | null {
  if (state.composing || state.repeat || state.altGraph || state.modalOpen || state.alt) return null
  const ctrl = state.ctrl || state.meta
  const key = state.key.toLowerCase()
  for (const id of Object.keys(KEY_BINDINGS) as ShortcutBindingId[]) {
    const keys = KEY_BINDINGS[id].keys
    if (ctrl !== keys.includes('Ctrl') || state.shift !== keys.includes('Shift')) continue
    if (key !== keys[keys.length - 1]?.toLowerCase()) continue
    // 终端持有这些操作；其余既有宿主键位保持原分发。
    if (state.inTerminal && ['toggleRail', 'focusComposer', 'copyLastReply', 'openSessionSwitcher'].includes(id)) continue
    return id
  }
  return null
}

/* ───────────────────────── 快捷键表的其余分组（同源说明数据） ───────────────────────── */

export type ShortcutNoteGroup = 'input' | 'approval' | 'terminal'

export interface ShortcutNote {
  labelKey: string
  keys?: string[]
  /** 没有固定键位时的一句说明 */
  noteKey?: string
}

/**
 * 输入框 / 审批 / 终端三组只列真实存在的行为：
 * 输入框是 Composer 的按键，审批是确认框与批准卡片的按键，终端是砚明确让给 xterm 的键。
 */
export const SHORTCUT_NOTE_GROUPS: { id: ShortcutNoteGroup; rows: ShortcutNote[] }[] = [
  {
    id: 'input',
    rows: [
      { labelKey: 'sheet.inputSend', noteKey: 'sheet.inputSendNote' },
      { labelKey: 'sheet.inputNewline', keys: ['Shift', 'Enter'] },
      { labelKey: 'sheet.inputSendForce', keys: ['Ctrl', 'Enter'] },
      { labelKey: 'sheet.inputMenu', keys: ['↑', '↓'] },
      { labelKey: 'sheet.inputComplete', keys: ['Tab'] },
      { labelKey: 'sheet.inputCloseMenu', keys: ['Esc'] },
      { labelKey: 'sheet.inputLong', keys: ['↑', '↑'], noteKey: 'sheet.inputLongNote' },
      { labelKey: 'sheet.inputStop', keys: ['Esc'], noteKey: 'sheet.inputStopNote' }
    ]
  },
  {
    id: 'approval',
    rows: [
      { labelKey: 'sheet.approvalConfirm', keys: ['Enter'] },
      { labelKey: 'sheet.approvalCancel', keys: ['Esc'] },
      { labelKey: 'sheet.approvalMove', keys: ['Tab', 'Shift+Tab'] },
      { labelKey: 'sheet.approvalFocus', noteKey: 'sheet.approvalFocusNote' }
    ]
  },
  {
    id: 'terminal',
    rows: [
      { labelKey: 'sheet.terminalYield', noteKey: 'sheet.terminalYieldNote' },
      { labelKey: 'sheet.terminalInterrupt', keys: ['Ctrl', 'C'] }
    ]
  }
]

export function shortcutNoteGroupKey(group: ShortcutNoteGroup): string {
  return `sheet.group.${group}`
}
