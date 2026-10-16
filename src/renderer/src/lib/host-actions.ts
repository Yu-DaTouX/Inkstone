import type { TFunc } from '../i18n'

export type HostT = TFunc

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
  group: 'global'
  labelKey: string
}

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
  binding?: ShortcutBindingId
  tool?: 'files' | 'browser' | 'terminal' | 'tasks' | 'agents' | 'logs' | 'accounts'
  settingsTab?: string
}

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

export const QUICK_ACTION_IDS: HostActionId[] = ['newSession', 'openSettings', 'launchTerminal']

export const HOST_SECTION_ORDER: HostActionSection[] = ['session', 'settings', 'view', 'tools', 'ops']

export function hostSectionKey(section: HostActionSection): string {
  return `action.section.${section}`
}

export function hostActionById(id: HostActionId): HostActionDef | undefined {
  return HOST_ACTIONS.find((action) => action.id === id)
}

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

export function tokensOf(query: string): string[] {
  return [...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 6)
}

export function matchesTokens(haystack: string, tokens: string[]): boolean {
  if (!tokens.length) return true
  const hay = haystack.toLowerCase()
  return tokens.every((token) => hay.includes(token))
}

export function filterHostActions(
  query: string,
  labelOf: (action: HostActionDef) => string,
  actions: HostActionDef[] = HOST_ACTIONS
): HostActionDef[] {
  const tokens = tokensOf(query)
  if (!tokens.length) return actions
  return actions.filter((action) => matchesTokens(labelOf(action), tokens))
}

export function groupHostActions(actions: HostActionDef[]): { section: HostActionSection; actions: HostActionDef[] }[] {
  return HOST_SECTION_ORDER.map((section) => ({
    section,
    actions: actions.filter((action) => action.section === section)
  })).filter((group) => group.actions.length > 0)
}

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
  composing: boolean
  repeat: boolean
  altGraph: boolean
  inTerminal: boolean
  modalOpen: boolean
}

export function resolveShortcut(state: KeyState): ShortcutId | null {
  if (state.composing || state.repeat || state.altGraph || state.modalOpen || state.alt) return null
  const ctrl = state.ctrl || state.meta
  const key = state.key.toLowerCase()
  for (const id of Object.keys(KEY_BINDINGS) as ShortcutBindingId[]) {
    const keys = KEY_BINDINGS[id].keys
    if (ctrl !== keys.includes('Ctrl') || state.shift !== keys.includes('Shift')) continue
    if (key !== keys[keys.length - 1]?.toLowerCase()) continue
    if (state.inTerminal && ['toggleRail', 'focusComposer', 'copyLastReply', 'openSessionSwitcher'].includes(id)) continue
    return id
  }
  return null
}

export type ShortcutNoteGroup = 'input' | 'approval' | 'terminal'

export interface ShortcutNote {
  labelKey: string
  keys?: string[]
  noteKey?: string
}

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
