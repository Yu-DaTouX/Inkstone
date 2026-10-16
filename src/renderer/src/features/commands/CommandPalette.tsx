/**
 * v3 命令面板（WP-25 / WP-25c）。
 *
 * 做四件事：
 *   1. 把「v3 当前确能执行的动作」和「当前会话」摆成可搜索的列表，绑键盘，
 *      调**正式 store 动作**；
 *   2. 前缀模式（02 §13.1）：`>` 只看操作、`@` 只看会话、`#` 搜当前会话的消息、
 *      `?` 显示前缀帮助；不加前缀时维持旧行为（空查询只列操作，输入后操作 + 会话）；
 *   3. 工作区 / 设置各分区复用 v3 已有入口（`state/ui-v3`、`store.openSettings`、
 *      `features/workbench/activation`），不新建第二套导航；
 *   4. 自己订阅 store（会话 / 标题 / 主题 / 是否在跑），路由仍通过 `onNavigate`
 *      交回父 Shell；工作区与侧栏属于外壳界面状态，直接调 `state/ui-v3` 的正式动作。
 *
 * 边界：
 *   · 只列 v3 已迁移、确实能跑的命令；没迁移的 v2 宿主动作 / 斜杠命令 / 计划任务
 *     命令不造按钮（尤其不展示需要额外授权的旧命令）。
 *   · 停止只对**当前视图就是运行实例**的那条会话出现：peek 别的会话时不会误停后台会话。
 *   · 打开终端 / 浏览器页签只经由 `activateWorkspaceOwner` 的正式激活流程；
 *     未激活就如实失败，不静默挂到别的会话。
 *   · 不回滚、不猜「成功」：动作抛错或 store 报了错就停面板里显示，只有成功才关闭。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { Search, X } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import { useUiV3 } from '../../state/ui-v3'
import { sessionViewIdentity, viewMatchesProjectedSession } from '../session/view-state'
import { displayedSessionOf, useSplitView } from '../../state/split-view'
import { sideBySideCandidate } from '../../app/SideBySideLayout'
import { activateWorkspaceOwner, captureActivationTarget } from '../workbench/activation'
import { WORKBENCH_ACTIVE_TABS, type WorkbenchTabId } from '../workbench/types'
import { Dialog, Kbd, Modal, ModalOverlay, Spinner, cx } from '../../ui'
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

/** 会话结果上限：搜索时最多列这么多条，避免几百条会话压满列表。 */
const SESSION_LIMIT = 8
/** 消息结果上限：`#` 模式一次最多列这么多条。 */
const MESSAGE_LIMIT = 12

/** 工作区动作 → 页签。 */
const WORKSPACE_ACTION_TABS: Record<string, WorkbenchTabId> = {
  [COMMAND_ACTION_IDS.workspaceChanges]: 'changes',
  [COMMAND_ACTION_IDS.workspaceTerminal]: 'terminal',
  [COMMAND_ACTION_IDS.workspaceFiles]: 'files',
  [COMMAND_ACTION_IDS.workspaceBrowser]: 'browser',
  [COMMAND_ACTION_IDS.workspacePreview]: 'preview'
}

export interface CommandPaletteProps {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  /** 父路由；面板只请求跳转，不自己改路由（工作区 / 侧栏是界面状态，另走 ui-v3）。 */
  onNavigate?: (route: 'chat' | 'runs' | 'settings') => void
}

interface RunResult {
  ok: boolean
  error?: string
  /** 成功但不关闭（帮助行把前缀写回查询，方便继续输入）。 */
  keepOpen?: boolean
}

/** 路径最后一段（项目 / 未命名会话的兜底显示）。 */
function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || path
}

/** 行右侧的键位徽标与 ShellV3 的实际绑定同源（`app/shortcuts.ts`）。 */
function shortcutKeys(id: ShortcutId): readonly string[] | undefined {
  return SHORTCUTS.find((def) => def.id === id)?.keys
}

export function CommandPalette({ isOpen, onOpenChange, onNavigate }: CommandPaletteProps): ReactElement | null {
  const { lang } = useI18n()
  const text = commandText(lang)

  /* 面板打开期间的自有状态；每次打开重置 */
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

  /* 当前视图身份按 peek 成对取值（不回落 session）；只有视图就是运行实例时才认为在跑。 */
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
    /* RAC 会自动聚焦第一个可聚焦元素；这里显式钉住搜索框，别让焦点落到别的控件。 */
    const id = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [isOpen])

  const actionItems = useMemo<CommandItem[]>(() => {
    const items: CommandItem[] = [
      {
        id: COMMAND_ACTION_IDS.newSession,
        group: 'action',
        label: text.newSession,
        /* 实际绑定见 app/shortcuts.ts：Ctrl+N。 */
        keywords: 'new chat session 新建 新对话',
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
        id: COMMAND_ACTION_IDS.openRuns,
        group: 'action',
        label: text.openRuns,
        keywords: 'runs overview status 运行 总览 状态',
        shortcut: shortcutKeys('openRuns')
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
    /* 停止只对当前视图（就是运行实例）出现；peek 别的会话时不误停后台运行。 */
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

  /* `#` 模式只搜当前视图的消息；正文只作为检索词，行上只显示短摘。
     面板关着或不在消息模式时不建这份列表，避免长会话每次流式更新都白算一遍。 */
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
        /* 空 `#` 不铺 2000 条历史；提示用户输入关键词。 */
        if (!trimmedTerm) return []
        return limitCommandGroup(rankCommands(messageItems, parsed.term), 'message', MESSAGE_LIMIT)
      case 'help':
        return rankCommands(helpItems, parsed.term)
      default: {
        /* 空查询只列命令；输入后才搜会话（全部会话铺出来会淹掉命令）。 */
        const pool = trimmedTerm ? [...actionItems, ...sessionItems] : actionItems
        return limitCommands(rankCommands(pool, parsed.term), SESSION_LIMIT)
      }
    }
  }, [parsed.mode, parsed.term, trimmedTerm, actionItems, sessionItems, messageItems, helpItems])

  const groups = useMemo(() => groupCommands(visible, PALETTE_GROUP_ORDER), [visible])
  const options = useMemo(() => navigableCommands(visible), [visible])
  const optionIndex = useMemo(() => new Map(options.map((item, index) => [item.id, index])), [options])

  /* 查询变化后回到第一条，避免停在已消失的位置；上一次失败提示也不再挂在新结果上 */
  useEffect(() => {
    setActiveIndex(0)
    setError(null)
  }, [query])

  useEffect(() => {
    if (!options.length) return
    if (activeIndex > options.length - 1) setActiveIndex(options.length - 1)
  }, [options.length, activeIndex])

  const safeIndex = options.length ? Math.min(Math.max(activeIndex, 0), options.length - 1) : -1

  /* 键盘移动后把当前项滚进视野 */
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

  /** 打开一个工作区页签：先回对话路由，需要激活的页签走正式激活流程。 */
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

  /** 切换工作区开合；与 ShellV3 的快捷键同一套激活规则。 */
  const toggleWorkspace = async (): Promise<RunResult> => {
    onNavigate?.('chat')
    const ui = useUiV3.getState()
    if (ui.workspaceOpen) {
      ui.setWorkspaceOpen(false)
      return { ok: true }
    }
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

    /* 帮助行：把前缀写回查询，面板不关，方便继续输入。 */
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
        /*
         * 面板关闭时 RAC 会把焦点归还给打开前的元素，若同步派发会被抢回去。
         * 放到下一个任务再派发，侧栏自己的监听把焦点放进搜索框。
         * 侧栏未展开时 ShellV3 会先展开（监听同一事件）。
         */
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
      case COMMAND_ACTION_IDS.openRuns:
        onNavigate?.('runs')
        return { ok: true }
      case COMMAND_ACTION_IDS.openSettings:
        onNavigate?.('settings')
        return { ok: true }
      case COMMAND_ACTION_IDS.openSideBySide: {
        /*
         * 「并排打开」：把最近活动的、还没在分屏里的另一条会话放到当前视图旁边。
         * 身份按 peek 成对取值（与 view-state 同一口径），不拿运行实例的字段补缺。
         */
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
        /* 消息：定位到当前会话里的那条消息（可能要先回对话路由再等一帧） */
        if (item.messageId) {
          const messageId = item.messageId
          onNavigate?.('chat')
          if (store.locateMessage(messageId)) return { ok: true }
          window.setTimeout(() => useStore.getState().locateMessage(messageId), 60)
          return { ok: true }
        }
        if (!item.sessionPath) return { ok: false, error: text.failed }
        /* 会话切换成功与否以 store 的实际结果为准：错误 notice / peekedPath 对齐。 */
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
    /* 失败不假装成功：面板留着并显示原因，用户可重试或换一条。 */
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
              <p className="cmd-empty">
                {parsed.mode === 'message' && !trimmedTerm ? text.messageHint : text.empty}
              </p>
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
            <p className="cmd-error" role="alert">
              {error}
            </p>
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
