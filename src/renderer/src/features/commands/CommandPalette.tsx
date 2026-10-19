import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { Search, X } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import { useUiV3 } from '../../state/ui-v3'
import { openSettingsDialog } from '../settings/root/deep-link'
import { sessionViewIdentity, viewMatchesProjectedSession } from '../session/view-state'
import { displayedSessionOf, useSplitView } from '../../state/split-view'
import { sideBySideCandidate } from '../../app/SideBySideLayout'
import { activateWorkspaceOwner, captureActivationTarget } from '../workbench/activation'
import { WORKBENCH_ACTIVE_TABS, type WorkbenchTabId } from '../workbench/types'
import { Dialog, EmptyState, Kbd, Modal, ModalOverlay, Notice, Spinner, cx } from '../../ui'
import { SHORTCUTS, type ShortcutId } from '../../app/shortcuts'
import {
  COMMAND_ACTION_IDS,
  COMMAND_PREFIXES,
  PALETTE_GROUP_ORDER,
  groupCommands,
  limitCommandGroup,
  limitCommands,
  messageSnippet,
  navigableCommands,
  parsePaletteQuery,
  rankCommands,
  shouldExecuteOnEnter,
  type CommandItem
} from './command-items'
import { commandText } from './command-text'
import './command-palette.css'

const SESSION_LIMIT = 8
const MESSAGE_LIMIT = 12

const WORKSPACE_ACTION_TABS: Record<string, WorkbenchTabId> = {
  [COMMAND_ACTION_IDS.workspaceChanges]: 'changes',
  [COMMAND_ACTION_IDS.workspaceTerminal]: 'terminal',
  [COMMAND_ACTION_IDS.workspaceFiles]: 'files',
  [COMMAND_ACTION_IDS.workspaceBrowser]: 'browser',
  [COMMAND_ACTION_IDS.workspacePreview]: 'files'
}

export interface CommandPaletteProps {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onNavigate?: (route: 'chat') => void
}

interface RunResult {
  ok: boolean
  error?: string
  keepOpen?: boolean
}

function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || path
}

function shortcutKeys(id: ShortcutId): readonly string[] | undefined {
  return SHORTCUTS.find((def) => def.id === id)?.keys
}

export function CommandPalette(props: CommandPaletteProps): ReactElement | null {
  return props.isOpen ? <CommandPaletteBody {...props} /> : null
}

function CommandPaletteBody({ isOpen, onOpenChange, onNavigate }: CommandPaletteProps): ReactElement | null {
  const { lang } = useI18n()
  const text = commandText(lang)

  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const theme = useStore((s) => s.settings?.theme ?? 'dark')
  const session = useStore((s) => s.session)
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const peekedPath = useStore((s) => s.peekedPath)
  const sessions = useStore((s) => s.sessions)
  const titles = useStore((s) => s.titles)
  const manualTitles = useStore((s) => s.manualTitles)
  const messages = useStore((s) => s.messages)

  const view = useMemo(
    () => sessionViewIdentity({ peekedSessionId, peekedPath, session }),
    [peekedSessionId, peekedPath, session]
  )
  const running = useMemo(
    () => viewMatchesProjectedSession(view, session) && (!!session?.isAgentRunning || !!session?.isStreaming),
    [view, session]
  )

  useEffect(() => {
    if (!isOpen) return
    setQuery('')
    setActiveIndex(0)
    setError(null)
    setBusy(false)
    busyRef.current = false
    const id = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [isOpen])

  const actionItems = useMemo<CommandItem[]>(() => {
    const items: CommandItem[] = [
      {
        id: COMMAND_ACTION_IDS.newSession,
        group: 'action',
        label: text.newSession,
        keywords: 'new chat session 新建 新对话 新会话',
        shortcut: shortcutKeys('newSession')
      },
      {
        id: COMMAND_ACTION_IDS.focusSearch,
        group: 'action',
        label: text.focusSearch,
        keywords: 'search sidebar find chat 搜索 侧栏 会话'
      },
      {
        id: COMMAND_ACTION_IDS.toggleSidebar,
        group: 'action',
        label: text.toggleSidebar,
        keywords: 'sidebar rail panel 侧栏 左栏 收起 展开',
        shortcut: shortcutKeys('toggleSidebar')
      },
      {
        id: COMMAND_ACTION_IDS.toggleWorkspace,
        group: 'action',
        label: text.toggleWorkspace,
        keywords: 'workspace panel right 工作区 右栏 面板 收起 展开',
        shortcut: shortcutKeys('toggleWorkspace')
      },
      {
        id: COMMAND_ACTION_IDS.toggleTheme,
        group: 'action',
        label: theme === 'dark' ? text.themeToLight : text.themeToDark,
        keywords: 'theme dark light appearance 主题 深色 浅色 外观'
      },
      {
        id: COMMAND_ACTION_IDS.openSettings,
        group: 'action',
        label: text.openSettings,
        keywords: 'settings preferences options 设置 首选项',
        shortcut: shortcutKeys('openSettings')
      },
      {
        id: COMMAND_ACTION_IDS.openSideBySide,
        group: 'action',
        label: text.openSideBySide,
        keywords: 'split side by side panes 并排 分屏 双栏'
      },
      {
        id: COMMAND_ACTION_IDS.workspaceChanges,
        group: 'action',
        label: text.workspaceChanges,
        keywords: 'workspace changes diff 工作区 改动 差异',
        shortcut: shortcutKeys('workspaceTab1')
      },
      {
        id: COMMAND_ACTION_IDS.workspaceTerminal,
        group: 'action',
        label: text.workspaceTerminal,
        keywords: 'workspace terminal shell 工作区 终端',
        shortcut: shortcutKeys('openTerminal')
      },
      {
        id: COMMAND_ACTION_IDS.workspaceFiles,
        group: 'action',
        label: text.workspaceFiles,
        keywords: 'workspace files tree 工作区 文件',
        shortcut: shortcutKeys('workspaceTab3')
      },
      {
        id: COMMAND_ACTION_IDS.workspaceBrowser,
        group: 'action',
        label: text.workspaceBrowser,
        keywords: 'workspace browser web 工作区 浏览器',
        shortcut: shortcutKeys('workspaceTab4')
      },
      {
        id: COMMAND_ACTION_IDS.workspacePreview,
        group: 'action',
        label: text.workspacePreview,
        keywords: 'workspace preview html 工作区 预览',
        shortcut: shortcutKeys('workspaceTab5')
      },
      {
        id: COMMAND_ACTION_IDS.settingsAppearance,
        group: 'action',
        label: text.settingsAppearance,
        keywords: 'settings appearance theme 设置 外观 主题'
      },
      {
        id: COMMAND_ACTION_IDS.settingsModels,
        group: 'action',
        label: text.settingsModels,
        keywords: 'settings models providers services 设置 模型 服务'
      },
      {
        id: COMMAND_ACTION_IDS.settingsCapabilities,
        group: 'action',
        label: text.settingsCapabilities,
        keywords: 'settings capabilities mcp skills 设置 能力'
      },
      {
        id: COMMAND_ACTION_IDS.settingsUsage,
        group: 'action',
        label: text.settingsUsage,
        keywords: 'settings usage tokens 设置 用量'
      }
    ]
    if (running) {
      items.push({
        id: COMMAND_ACTION_IDS.stopSession,
        group: 'action',
        label: text.stopSession,
        keywords: 'stop abort cancel interrupt 停止 中断 取消',
        shortcut: shortcutKeys('stopRun')
      })
    }
    return items
  }, [text, theme, running])

  const sessionItems = useMemo<CommandItem[]>(
    () =>
      [...sessions]
        .filter((item) => !item.archivedAt)
        .sort((a, b) => (b.lastActivityAt ?? b.updatedAt) - (a.lastActivityAt ?? a.updatedAt))
        .map((item) => ({
          id: `session:${item.path}`,
          group: 'session' as const,
          label: manualTitles[item.id] ?? titles[item.id] ?? (item.title?.trim() || shortPath(item.path)),
          keywords: [item.cwd, item.path, item.projectId].filter(Boolean).join(' '),
          sessionPath: item.path,
          meta: item.cwd ? shortPath(item.cwd) : ''
        })),
    [sessions, titles, manualTitles]
  )

  const parsed = useMemo(() => parsePaletteQuery(query), [query])
  const trimmedTerm = parsed.term.trim()

  const messageItems = useMemo<CommandItem[]>(() => {
    if (!isOpen || parsed.mode !== 'message') return []
    return messages
      .filter((message) => message.text.trim().length > 0)
      .map((message) => ({
        id: `message:${message.id}`,
        group: 'message' as const,
        label: `${roleLabel(message.role, text)}: ${messageSnippet(message.text)}`,
        keywords: message.text.slice(0, 2000),
        messageId: message.id
      }))
  }, [isOpen, parsed.mode, messages, text])

  const helpItems = useMemo<CommandItem[]>(
    () =>
      COMMAND_PREFIXES.map((prefix) => ({
        id: `help:${prefix}`,
        group: 'help' as const,
        label: text.helpRows[prefix],
        keywords: `help prefix ${prefix}`,
        helpPrefix: prefix
      })),
    [text]
  )

  const visible = useMemo(() => {
    switch (parsed.mode) {
      case 'action':
        return rankCommands(actionItems, parsed.term)
      case 'session':
        return limitCommands(rankCommands(sessionItems, parsed.term), SESSION_LIMIT)
      case 'message':
        if (!trimmedTerm) return []
        return limitCommandGroup(rankCommands(messageItems, parsed.term), 'message', MESSAGE_LIMIT)
      case 'help':
        return rankCommands(helpItems, parsed.term)
      default: {
        const pool = trimmedTerm ? [...actionItems, ...sessionItems] : actionItems
        return limitCommands(rankCommands(pool, parsed.term), SESSION_LIMIT)
      }
    }
  }, [parsed.mode, parsed.term, trimmedTerm, actionItems, sessionItems, messageItems, helpItems])

  const groups = useMemo(() => groupCommands(visible, PALETTE_GROUP_ORDER), [visible])
  const options = useMemo(() => navigableCommands(visible), [visible])
  const optionIndex = useMemo(() => new Map(options.map((item, index) => [item.id, index])), [options])

  useEffect(() => {
    setActiveIndex(0)
    setError(null)
  }, [query])

  useEffect(() => {
    if (!options.length) return
    if (activeIndex > options.length - 1) setActiveIndex(options.length - 1)
  }, [options.length, activeIndex])

  const safeIndex = options.length ? Math.min(Math.max(activeIndex, 0), options.length - 1) : -1

  useEffect(() => {
    if (safeIndex < 0) return
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [safeIndex, options.length])

  const move = (delta: number): void => {
    if (!options.length) return
    setActiveIndex((current) => {
      const base = Math.min(Math.max(current, 0), options.length - 1)
      return (base + delta + options.length) % options.length
    })
  }

  const openWorkspaceTab = async (tab: WorkbenchTabId): Promise<RunResult> => {
    onNavigate?.('chat')
    const ui = useUiV3.getState()
    ui.setWorkspaceTab(tab)
    if (WORKBENCH_ACTIVE_TABS.has(tab)) {
      const target = captureActivationTarget()
      const ok = await activateWorkspaceOwner(target)
      if (!ok) return { ok: false, error: text.activationFailed }
    }
    useUiV3.getState().setWorkspaceOpen(true)
    return { ok: true }
  }

  const toggleWorkspace = async (): Promise<RunResult> => {
    onNavigate?.('chat')
    const ui = useUiV3.getState()
    if (ui.workspaceOpen && ui.workspaceTab !== 'overview') {
      ui.setWorkspaceOpen(false)
      return { ok: true }
    }
    if (ui.workspaceTab === 'overview') ui.setWorkspaceTab('changes')
    if (WORKBENCH_ACTIVE_TABS.has(ui.workspaceTab)) {
      const target = captureActivationTarget()
      const ok = await activateWorkspaceOwner(target)
      if (!ok) return { ok: false, error: text.activationFailed }
    }
    useUiV3.getState().setWorkspaceOpen(true)
    return { ok: true }
  }

  const runItem = async (item: CommandItem): Promise<RunResult> => {
    const store = useStore.getState()

    if (item.helpPrefix) {
      setQuery(item.helpPrefix)
      return { ok: true, keepOpen: true }
    }

    const workspaceTab = WORKSPACE_ACTION_TABS[item.id]
    if (workspaceTab) return openWorkspaceTab(workspaceTab)

    switch (item.id) {
      case COMMAND_ACTION_IDS.newSession: {
        onNavigate?.('chat')
        const result = await store.newSession({ scope: 'global' })
        return result.ok ? { ok: true } : { ok: false, error: result.error ?? text.failed }
      }
      case COMMAND_ACTION_IDS.focusSearch: {
        window.setTimeout(() => window.dispatchEvent(new CustomEvent('yan-v3-focus-search')), 0)
        return { ok: true }
      }
      case COMMAND_ACTION_IDS.toggleSidebar:
        useUiV3.getState().toggleSidebar()
        return { ok: true }
      case COMMAND_ACTION_IDS.toggleWorkspace:
        return toggleWorkspace()
      case COMMAND_ACTION_IDS.toggleTheme: {
        const next = (store.settings?.theme ?? 'dark') === 'dark' ? 'light' : 'dark'
        await store.patchSettings({ theme: next })
        return { ok: true }
      }
      case COMMAND_ACTION_IDS.openSettings:
        openSettingsDialog()
        return { ok: true }
      case COMMAND_ACTION_IDS.openSideBySide: {
        onNavigate?.('chat')
        const state = useStore.getState()
        const current = displayedSessionOf({
          peekedSessionId: state.peekedSessionId,
          peekedPath: state.peekedPath,
          session: state.session ? { sessionId: state.session.sessionId, sessionFile: state.session.sessionFile } : null
        })
        if (!current) return { ok: false, error: text.failed }
        const taken = useSplitView.getState().split?.tiles ?? []
        const candidate = sideBySideCandidate(state.sessions, current, taken)
        if (!candidate) return { ok: false, error: text.sideBySideNoPeer }
        useSplitView.getState().open({ sessionId: candidate.id, path: candidate.path }, current)
        return { ok: true }
      }
      case COMMAND_ACTION_IDS.settingsAppearance:
        store.openSettings('appearance')
        return { ok: true }
      case COMMAND_ACTION_IDS.settingsModels:
        store.openSettings('models')
        return { ok: true }
      case COMMAND_ACTION_IDS.settingsCapabilities:
        store.openSettings('capabilities')
        return { ok: true }
      case COMMAND_ACTION_IDS.settingsUsage:
        store.openSettings('usage')
        return { ok: true }
      case COMMAND_ACTION_IDS.stopSession:
        await store.abort()
        return { ok: true }
      default: {
        if (item.messageId) {
          const messageId = item.messageId
          onNavigate?.('chat')
          if (store.locateMessage(messageId)) return { ok: true }
          window.setTimeout(() => useStore.getState().locateMessage(messageId), 60)
          return { ok: true }
        }
        if (!item.sessionPath) return { ok: false, error: text.failed }
        const before = new Set(store.notices.map((notice) => notice.id))
        onNavigate?.('chat')
        await store.switchSession(item.sessionPath)
        const after = useStore.getState()
        const addedError = after.notices.find((notice) => notice.type === 'error' && !before.has(notice.id))
        if (addedError) return { ok: false, error: addedError.text }
        if (after.peekedPath === item.sessionPath || after.session?.sessionFile === item.sessionPath) {
          return { ok: true }
        }
        return { ok: false, error: text.switchFailed }
      }
    }
  }

  const execute = async (item: CommandItem): Promise<void> => {
    if (item.disabled || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    let result: RunResult
    try {
      result = await runItem(item)
    } catch (caught) {
      result = { ok: false, error: caught instanceof Error ? caught.message : String(caught) }
    }
    busyRef.current = false
    setBusy(false)
    if (result.ok) {
      if (!result.keepOpen) onOpenChange(false)
      return
    }
    setError(result.error ?? text.failed)
  }

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      move(1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      move(-1)
      return
    }
    if (
      shouldExecuteOnEnter({
        key: event.key,
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.nativeEvent.keyCode
      })
    ) {
      event.preventDefault()
      const item = options[safeIndex]
      if (item) void execute(item)
    }
  }

  if (!isOpen) return null

  return (
    <ModalOverlay className="cmd-overlay" isOpen onOpenChange={onOpenChange} isDismissable>
      <Modal className="cmd-modal">
        <Dialog className="cmd-dialog" aria-label={text.paletteLabel} showClose={false}>
          <div className="cmd-search">
            <Search className="cmd-search__icon" size={16} aria-hidden="true" />
            <input
              ref={inputRef}
              className="cmd-input"
              type="text"
              role="combobox"
              aria-label={text.paletteLabel}
              aria-expanded="true"
              aria-controls="cmd-list"
              aria-autocomplete="list"
              aria-activedescendant={safeIndex >= 0 ? `cmd-opt-${safeIndex}` : undefined}
              placeholder={text.placeholder}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onInputKeyDown}
              autoComplete="off"
              spellCheck={false}
              data-testid="v3-command-input"
            />
            {query ? (
              <button
                type="button"
                className="cmd-clear"
                aria-label={text.clear}
                onClick={() => setQuery('')}
                tabIndex={-1}
              >
                <X size={14} aria-hidden="true" />
              </button>
            ) : null}
            {busy ? <Spinner className="cmd-busy" label={text.busy} size={15} /> : null}
          </div>

          <div className="cmd-prefix-hint" aria-hidden="true">
            {text.prefixHint}
          </div>

          <div ref={listRef} id="cmd-list" className="cmd-list" role="listbox" aria-label={text.paletteLabel}>
            {options.length === 0 ? (
              <EmptyState size="sm" title={parsed.mode === 'message' && !trimmedTerm ? text.messageHint : text.empty} />
            ) : (
              groups.map((section) => (
                <div key={section.group} className="cmd-group" role="group" aria-label={groupLabel(section.group, text)}>
                  <div className="cmd-group__label" aria-hidden="true">
                    {groupLabel(section.group, text)}
                  </div>
                  {section.items.map((item) => {
                    const index = optionIndex.get(item.id) ?? -1
                    const active = index === safeIndex
                    return (
                      <div
                        key={item.id}
                        id={index >= 0 ? `cmd-opt-${index}` : undefined}
                        role="option"
                        aria-selected={active}
                        aria-disabled={item.disabled || undefined}
                        data-active={active ? 'true' : undefined}
                        className={cx('cmd-option', item.disabled && 'cmd-option--disabled')}
                        onMouseMove={() => {
                          if (index >= 0 && index !== safeIndex) setActiveIndex(index)
                        }}
                        onClick={() => void execute(item)}
                      >
                        <span className="cmd-option__label">{item.label}</span>
                        {item.disabled && item.reason ? (
                          <span className="cmd-option__reason">{item.reason}</span>
                        ) : item.meta ? (
                          <span className="cmd-option__meta">{item.meta}</span>
                        ) : null}
                        {item.shortcut?.length ? (
                          <span className="cmd-option__keys">
                            {item.shortcut.map((key) => (
                              <Kbd key={key}>{key}</Kbd>
                            ))}
                          </span>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              ))
            )}
          </div>

          {error ? (
            <Notice tone="fail" compact className="cmd-error">
              {error}
            </Notice>
          ) : null}
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}

function roleLabel(role: string, text: ReturnType<typeof commandText>): string {
  if (role === 'assistant') return text.roleAssistant
  if (role === 'bash') return text.roleBash
  return text.roleUser
}

function groupLabel(group: CommandItem['group'], text: ReturnType<typeof commandText>): string {
  switch (group) {
    case 'session':
      return text.groupSession
    case 'message':
      return text.groupMessage
    case 'help':
      return text.groupHelp
    default:
      return text.groupAction
  }
}
