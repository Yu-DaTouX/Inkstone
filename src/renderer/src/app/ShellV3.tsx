/*
 * ⚠️ 样式入口必须最先求值：`design/index.css` 里的 `@layer reset, tokens, base, …`
 * 先声明层顺序，后面 ui/features 的模块 CSS 才会落到正确的层上。
 */
import '../design/index.css'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type CSSProperties } from 'react'
import { Splitter } from '../ui'
import { UsagePage } from '../features/usage/UsagePage'
import { translate, useI18n, type Lang, type MessageKey } from '../i18n'
import { useStore } from '../state/store'
import { useRunnerVisibility } from '../lib/use-runner-visibility'
import { displayedSessionOf, reconcileSplit, useSplitView, type SplitSessionRef } from '../state/split-view'
import { sessionViewIdentity, viewMatchesProjectedSession } from '../features/session/view-state'
import { isModalOpen } from '../lib/modalLayer'
import { dismissBootSplash } from '../lib/boot-splash'
import { useUiV3, useV3RouteSync } from '../state/ui-v3'
import { startRunSync } from '../state/runs-v3'
import type { RunSnapshot } from '../../../shared/runs'
import { Sidebar } from '../features/sidebar/Sidebar'
import { SplitDropLayer } from '../features/sidebar/SplitDropLayer'
import { SideBySide } from './SideBySide'
import { collapsedPanes, sessionTiles } from './SideBySideLayout'
import { CommandPalette } from '../features/commands/CommandPalette'
import { ShortcutSheet } from '../features/commands/ShortcutSheet'
import { resolveV3Shortcut, shortcutOverridesFromSettings } from './shortcuts'
import { NoticeBridge } from './NoticeBridge'
import { RunsPage } from '../features/runs/RunsPage'
import { ReviewPage } from '../features/review'
import { ScheduleTasksPage } from '../features/schedule'
import { RunPill } from '../patterns/RunPill'
import { Header } from './Header'
import { SettingsPanelV3 } from './SettingsPanelV3'
import { OnboardingWizard, markOnboarded, shouldAutoWizard } from '../features/onboarding'
import { NativeSessionSurfaces } from '../features/session/native'
import { V3ErrorBoundary } from './ErrorBoundary'
import { WorkbenchPanel } from '../features/workbench/WorkbenchPanel'
import { WORKBENCH_PANES } from '../features/workbench/panes'
import { useWorkspaceOwner } from '../features/workbench/use-owner'
import { createPanePopoutClient } from '../features/workbench/pane-popout-client'
import { activateWorkspaceOwner, captureActivationTarget } from '../features/workbench/activation'
import { WORKBENCH_ACTIVE_TABS, WORKBENCH_TABS, type WorkbenchTabId } from '../features/workbench/types'
import { panePopoutBridge, paneTerminalBridge } from '../../auxwin/pane-bridge'
import { pickOwnedTerminal, selectOwnedTerminals } from '../features/terminal/terminal-session'
import { resourceOwner } from '../state/resource-owners'
import { contextPaneData } from '../features/workbench/context-pane-view'
import type { ContextSlice } from '../state/context-breakdown'
import type { PaneContextSegment } from '../../../shared/pane-popout'
import './ShellV3.css'

/**
 * `bootstrap()` 不是幂等的（第二次会把设置、会话、标题整批重拉一遍），
 * 而 React StrictMode 在开发态会把 effect 跑两次。订阅与心跳本身可以重复挂
 *（`onPush` 返回退订函数、`startConnWatch` 有单例标志），所以这里只把
 * `bootstrap()` 钉成模块级一次性。
 */
let bootstrapStarted = false

/** 上下文分类在弹出窗里的标签；复用共享 i18n 的 `ctx.cat.*`，不另造文案。 */
const CONTEXT_SEGMENT_LABELS: Record<ContextSlice['id'], MessageKey> = {
  system: 'ctx.cat.system',
  user: 'ctx.cat.user',
  assistant: 'ctx.cat.assistant',
  thinking: 'ctx.cat.thinking',
  tools: 'ctx.cat.tools'
}

/**
 * 把当前会话的上下文折算成弹出窗契约的受限分段（只读，与 ContextPane 同源）。
 * 弹出窗渲染端只显示 `label`，所以在宿主侧翻译好再推过去。
 */
function contextSegments(
  slices: readonly ContextSlice[],
  usage: { tokens: number; windowSize: number },
  lang: Lang
): PaneContextSegment[] {
  const segments: PaneContextSegment[] = slices
    .filter((slice) => slice.tokens > 0)
    .map((slice) => ({ id: slice.id, label: translate(lang, CONTEXT_SEGMENT_LABELS[slice.id]), tokens: slice.tokens }))
  const free = Math.max(0, usage.windowSize - usage.tokens)
  if (free > 0) segments.push({ id: 'free', label: translate(lang, 'ctx.cat.free'), tokens: free, tone: 'free' })
  return segments
}

/**
 * 解析当前归属下正在显示的既有 PTY id：只认登记到本 owner 的终端，取仍存活的一个。
 * 只读列出，不 start / attach / kill；拿不到就不弹，不消费别人的进程。
 */
async function ownedTerminalId(ownerKey: string): Promise<string | null> {
  if (typeof window === 'undefined' || !window.yan?.terminal) return null
  try {
    const list = await window.yan.terminal.list()
    return pickOwnedTerminal(selectOwnedTerminals(list, ownerKey, resourceOwner))?.id ?? null
  } catch {
    return null
  }
}

/**
 * v3 外壳：侧栏 + 主区（会话头 + 对话流 + 输入框）。
 *
 * 与 v2 共用同一个 store、IPC 与主进程服务，只换界面与样式。会话头亦作窗口
 * 拖动区；两栏之外的一切（右侧面板、运行总览页、设置页）按需进入，不常驻。
 */
export default function ShellV3(): ReactElement {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try { const value = Number(localStorage.getItem('inkstone.v3.sidebarWidth')); return value >= 220 && value <= 420 ? value : 264 } catch { return 264 }
  })
  const [sidebarPreview, setSidebarPreview] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => { try { localStorage.setItem('inkstone.v3.sidebarWidth', String(sidebarWidth)) } catch { /* 偏好不可写时仍可调整 */ } }, 150)
    return () => clearTimeout(timer)
  }, [sidebarWidth])
  const [workspaceWidth, setWorkspaceWidth] = useState(420)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [bodyWidth, setBodyWidth] = useState(1000)
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const observer = new ResizeObserver(() => setBodyWidth(body.clientWidth))
    observer.observe(body)
    setBodyWidth(body.clientWidth)
    return () => observer.disconnect()
  }, [])
  const maxWorkspace = Math.max(280, bodyWidth - 360)
  const shownWorkspaceWidth = Math.min(workspaceWidth, maxWorkspace)
  useV3RouteSync()
  const { lang, setLang } = useI18n()

  const settings = useStore((s) => s.settings)
  const conn = useStore((s) => s.conn)
  const session = useStore((s) => s.session)
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const peekedPath = useStore((s) => s.peekedPath)
  const applyPush = useStore((s) => s.applyPush)
  const bootstrap = useStore((s) => s.bootstrap)
  const startConnWatch = useStore((s) => s.startConnWatch)
  /* 原生命令请求的面板：`tree` 映射到底部分支页签，其余模式由各自对话框消费。 */
  const nativeSessionPanel = useStore((s) => s.nativeSessionPanel)

  const route = useUiV3((s) => s.route)
  const sidebarOpen = useUiV3((s) => s.sidebarOpen)
  const workspaceOpen = useUiV3((s) => s.workspaceOpen)
  useEffect(() => { if (sidebarOpen) setSidebarPreview(false) }, [sidebarOpen])

  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutSheetOpen, setShortcutSheetOpen] = useState(false)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  /** 首次引导只在设置就绪时判定一次，避免后续 patchSettings 反复重开 */
  const onboardDecided = useRef(false)
  const [narrow, setNarrow] = useState<boolean>(() => window.matchMedia('(max-width: 899px)').matches)
  /** 工作区面板形态：>=1180 固定右列；900–1179 浮层；<900 全宽 */
  const [panelMode, setPanelMode] = useState<'docked' | 'overlay' | 'full'>(() =>
    window.innerWidth < 900 ? 'full' : window.innerWidth < 1180 ? 'overlay' : 'docked'
  )
  /** 首次打开后一直保留挂载：关面板不销毁终端 / 浏览器叶子，只隐藏 */
  const [panelMounted, setPanelMounted] = useState(false)

  /* 工作区归属：由正式当前视图 + 运行实例 / 会话摘要推导（见 features/workbench） */
  const owner = useWorkspaceOwner()

  /*
   * 页签弹出客户端：桥由 preload 注入，弹出窗不读 store。DOM-only 页签的受限投影由
   * 本窗口计算（snapshot），动作经 ownerKey + epoch 校验后回投（onAction）。原生页签不走
   * 投影：browser 带 viewId 交原生视图改挂，terminal 交同 PTY 桥。
   *
   * 投影边界：只有「上下文」有同步数据源（现有 store 的会话 / 统计 / 消息投影）；文件 /
   * 改动 / 分支都是异步 hook，Shell 拿不到同步快照，因此不向它们开放弹出（见 WorkbenchPanel
   * 的页签判定），不推空投影去开一个空窗口。
   */
  const [paneClient] = useState(() => {
    const bridge = panePopoutBridge()
    if (!bridge) return null
    return createPanePopoutClient({
      bridge,
      terminalBridge: paneTerminalBridge() ?? undefined,
      source: {
        snapshot: () => {
          const s = useStore.getState()
          const locale: Lang = s.settings?.lang === 'en-US' ? 'en-US' : 'zh-CN'
          const context = contextPaneData({ session: s.session, stats: s.stats, messages: s.messages })
          return {
            locale,
            context: {
              usedTokens: context.usage.tokens,
              windowTokens: context.usage.windowSize,
              known: context.usage.known,
              segments: context.usage.known ? contextSegments(context.slices, context.usage, locale) : []
            }
          }
        },
        onAction: (event) => {
          if (event.action.type === 'refresh') paneClientRef.current?.refresh(event.tab)
          if (event.action.type === 'files.attach' && event.action.path) {
            void useStore.getState().addFileRefPaths([event.action.path])
          }
        }
      }
    })
  })
  const paneClientRef = useRef(paneClient)
  paneClientRef.current = paneClient

  /* 语言 / owner / 上下文数据变化：重推受限投影，让弹出窗拿到当前视图（不重开窗口）。 */
  useEffect(() => {
    paneClient?.refresh()
  }, [paneClient, lang, owner.key])

  useEffect(
    () =>
      useStore.subscribe((state, previous) => {
        if (state.stats !== previous.stats || state.messages !== previous.messages) paneClient?.refresh('context')
      }),
    [paneClient]
  )

  /* 卸载时释放全部弹窗 / 租约；终端只解绑，不 kill PTY。 */
  useEffect(() => () => paneClient?.dispose(), [paneClient])

  /* ---- 主进程推送 → store；并做一次全量 bootstrap（StrictMode 下只一次） ---- */
  useEffect(() => {
    const off = window.yan.onPush(applyPush)
    if (!bootstrapStarted) {
      bootstrapStarted = true
      void bootstrap()
    }
    // 连接状态自愈：push 可能丢，不 ready 就主动拉（单例心跳）
    startConnWatch()
    return off
  }, [applyPush, bootstrap, startConnWatch])

  /*
   * 运行注册表同步：先订阅推送再拉快照，快照在途时缓冲增量，只回放更新的修订。
   * `startRunSync` 自己按引用计数复用订阅，StrictMode 的「挂载→清理→再挂载」
   * 不会叠加两条 onPush，卸载时严格清理。
   */
  useEffect(() => startRunSync(), [])

  /* ---- 主题令牌挂在 <html data-theme>，跟随设置；同时更新首帧缓存 ---- */
  useEffect(() => {
    if (!settings) return
    const theme = settings.theme === 'light' ? 'light' : 'dark'
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('yan.theme', theme)
    } catch {
      /* 存不了就只在本次会话生效 */
    }
  }, [settings])

  /* ---- 界面语言跟随设置（设置面板改了 lang 与设置一致时这里自然跳过） ---- */
  useEffect(() => {
    if (!settings) return
    if (settings.lang !== lang) setLang(settings.lang)
  }, [settings, lang, setLang])

  /* ---- 首次启动：未看过引导时打开配置向导（与主区同一 localStorage 标记） ----
   * 设置第一次就绪时判定一次，之后不再自动重开；探针环境与主区一致地不自动弹。
   * 「已看过」标记仍是主区同键 `yan.onboarded`，切外壳不会重复弹。 */
  useEffect(() => {
    if (onboardDecided.current) return
    if (!settings) return
    onboardDecided.current = true
    if (window.yan.isProbe) return
    if (shouldAutoWizard()) setOnboardingOpen(true)
  }, [settings])

  /* ---- 响应式：<900 默认收起，展开时浮层；跨过断点时回到该宽度下的默认 ---- */
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 899px)')
    const apply = (): void => {
      const next = mq.matches
      setNarrow(next)
      useUiV3.getState().setSidebarOpen(!next)
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  /* ---- 工作区面板形态跟随窗口宽度 ---- */
  useEffect(() => {
    const apply = (): void => {
      const w = window.innerWidth
      setPanelMode(w < 900 ? 'full' : w < 1180 ? 'overlay' : 'docked')
    }
    apply()
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [])

  /* ---- 告诉主进程哪些会话正在被看：并排时每一列都算，窄屏只算焦点那列 ---- */
  const displayed = useMemo<SplitSessionRef | null>(
    () =>
      displayedSessionOf({
        peekedSessionId,
        peekedPath,
        session: session ? { sessionId: session.sessionId, sessionFile: session.sessionFile } : null
      }),
    [peekedSessionId, peekedPath, session?.sessionId, session?.sessionFile]
  )
  const storedSplit = useSplitView((s) => s.split)
  const split = useMemo(() => (storedSplit ? reconcileSplit(storedSplit, displayed) : null), [storedSplit, displayed])
  /* 按正在显示的会话校正分屏（点别的会话时替换焦点那一列），与 v2 同一套规则 */
  useLayoutEffect(() => {
    useSplitView.getState().sync(displayed)
  }, [displayed, storedSplit])
  const visibleSessions = useMemo(() => {
    const layout = collapsedPanes(split, narrow)
    return layout ? sessionTiles(layout.tiles) : displayed ? [displayed] : []
  }, [split, narrow, displayed])
  useRunnerVisibility(visibleSessions)

  /* ---- 启动画面：设置、会话与连接都有结论后撤（与 v2 同一时点） ---- */
  useEffect(() => {
    if (!settings) return
    const settled = conn === 'exited' || conn === 'error' || (conn === 'ready' && !!session)
    if (!settled) return
    let id = requestAnimationFrame(() => {
      id = requestAnimationFrame(() => dismissBootSplash())
    })
    return () => cancelAnimationFrame(id)
  }, [settings, conn, session])

  /* 命令面板可请求搜索侧栏；先展开，侧栏在下一帧接管搜索焦点。 */
  useEffect(() => {
    const openSearch = (): void => useUiV3.getState().setSidebarOpen(true)
    window.addEventListener('yan-v3-focus-search', openSearch)
    return () => window.removeEventListener('yan-v3-focus-search', openSearch)
  }, [])

  /* 离开会话页（设置 / 运行总览）时收起工作区；面板保持挂载，后台资源不销毁 */
  useEffect(() => {
    if (route.name !== 'chat' && useUiV3.getState().workspaceOpen) useUiV3.getState().setWorkspaceOpen(false)
  }, [route.name])

  /*
   * 打开工作区。若记住的页签需要激活（终端 / 浏览器），先在 `ensureActivated`
   * 前后钉住目标；失败保留关闭（notice 已由激活流程给出），不静默挂到别的会话。
   */
  const toggleWorkspace = (): void => {
    const ui = useUiV3.getState()
    if (ui.workspaceOpen) {
      ui.setWorkspaceOpen(false)
      return
    }
    setPanelMounted(true)
    if (!WORKBENCH_ACTIVE_TABS.has(ui.workspaceTab)) {
      ui.setWorkspaceOpen(true)
      return
    }
    const target = captureActivationTarget()
    void activateWorkspaceOwner(target).then((ok) => {
      if (ok) useUiV3.getState().setWorkspaceOpen(true)
    })
  }

  /* 面板内点需要激活的页签：交给同一个激活流程，失败时面板停留并显示提示 */
  const requestActivation = (_tab: WorkbenchTabId): Promise<boolean> => activateWorkspaceOwner(captureActivationTarget())

  /*
   * `/tree` 只负责请求面板：`store.nativeSession('tree')` 写入 `nativeSessionPanel`，
   * 这里把请求映射成打开底部分支页签，然后消费掉请求。树本身由 `BranchPane` 直接经
   * `window.yan.nativeSession` 拉取（带 owner.sessionId 归属），不在 Shell 复制数据。
   * 其它模式（模型范围 / 信任）留给各自的正式对话框，Shell 不抢路由。
   */
  useEffect(() => {
    if (nativeSessionPanel?.mode !== 'tree') return
    setPanelMounted(true)
    useUiV3.getState().setWorkspaceTab('branch')
    useUiV3.getState().setWorkspaceOpen(true)
    useStore.getState().closeNativeSessionPanel()
  }, [nativeSessionPanel])

  /*
   * 打开（或切到）一个工作区页签：先回对话路由，需要激活的页签（终端 / 浏览器）先走
   * `activateWorkspaceOwner`；失败保留关闭并沿用激活流程的提示，不静默挂到别的会话。
   */
  const openWorkspaceTab = (tab: WorkbenchTabId): Promise<boolean> => {
    useUiV3.getState().navigate({ name: 'chat' })
    setPanelMounted(true)
    useUiV3.getState().setWorkspaceTab(tab)
    if (!WORKBENCH_ACTIVE_TABS.has(tab)) {
      useUiV3.getState().setWorkspaceOpen(true)
      return Promise.resolve(true)
    }
    return activateWorkspaceOwner(captureActivationTarget()).then((ok) => {
      if (ok) useUiV3.getState().setWorkspaceOpen(true)
      return ok
    })
  }

  /*
   * 主进程 `before-input-event` 拦下的模型 / 思考循环（Ctrl+P / Ctrl+Shift+P / Shift+Tab）：
   * 外壳只执行 store 的正式动作，不在这里二次注册按键。模态层由 `lib/modalLayer`
   * 上报 `setHotkeyGuard`，主进程会在弹窗打开时暂停拦截，Shift+Tab 留给表单反向导航。
   */
  useEffect(() => {
    const off = window.yan.onHotkey((action) => {
      const store = useStore.getState()
      if (action === 'cycleModel') void store.cycleModel()
      else if (action === 'cycleModelBack') void store.cycleModelBack()
      else void store.cycleThinking()
    })
    return off
  }, [])

  /* ---- 全局快捷键：从 `app/shortcuts.ts` 的注册表绑定；模态与输入法组字期间不响应 ---- */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || paletteOpen || isModalOpen()) return
      const target = event.target as HTMLElement | null
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      const shortcut = resolveV3Shortcut({
        key: event.key,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        alt: event.altKey,
        shift: event.shiftKey,
        composing: event.isComposing,
        repeat: event.repeat,
        altGraph: typeof event.getModifierState === 'function' ? event.getModifierState('AltGraph') : false,
        /* 终端聚焦时 Ctrl+K/B/J/L 与 Ctrl+Shift+C 让给 xterm（见注册表的 terminalsYield） */
        inTerminal: !!target?.closest?.('.xterm'),
        editing: typing
      }, shortcutOverridesFromSettings(useStore.getState().settings))
      if (shortcut) {
        const ui = useUiV3.getState()
        switch (shortcut) {
          case 'commandPalette':
            event.preventDefault()
            setPaletteOpen(true)
            return
          case 'newSession':
            event.preventDefault()
            ui.navigate({ name: 'chat' })
            void useStore.getState().newSession({ scope: 'global' })
            return
          case 'toggleSidebar':
            event.preventDefault()
            ui.toggleSidebar()
            return
          case 'openRuns':
            event.preventDefault()
            ui.navigate({ name: 'runs' })
            return
          case 'toggleWorkspace':
            event.preventDefault()
            toggleWorkspace()
            return
          case 'openSettings':
            event.preventDefault()
            ui.navigate({ name: 'settings' })
            return
          case 'shortcutSheet':
            event.preventDefault()
            setShortcutSheetOpen(true)
            return
          case 'goBack':
            event.preventDefault()
            ui.goBack()
            return
          case 'focusComposer':
            event.preventDefault()
            /* 空 target = 当前挂载的输入框；分屏只渲染焦点那一列，选择器唯一。 */
            useStore.getState().requestComposerFocus({})
            return
          case 'copyLastReply':
            event.preventDefault()
            void useStore.getState().copyLastReply()
            return
          case 'stopRun': {
            /* 只在当前视图就是运行实例时停止；peek 别的会话不误停后台运行。 */
            const s = useStore.getState()
            const view = sessionViewIdentity({ peekedSessionId: s.peekedSessionId, peekedPath: s.peekedPath, session: s.session })
            const running = viewMatchesProjectedSession(view, s.session) && (!!s.session?.isAgentRunning || !!s.session?.isStreaming)
            event.preventDefault()
            if (running) void s.abort()
            return
          }
          case 'openTerminal':
            event.preventDefault()
            void openWorkspaceTab('terminal')
            return
          case 'workspaceTab1':
          case 'workspaceTab2':
          case 'workspaceTab3':
          case 'workspaceTab4':
          case 'workspaceTab5':
          case 'workspaceTab6': {
            event.preventDefault()
            const tab = WORKBENCH_TABS[Number(shortcut.slice('workspaceTab'.length)) - 1]
            if (tab) void openWorkspaceTab(tab)
            return
          }
        }
      }
      if (event.key === 'Escape' && !typing) {
        const ui = useUiV3.getState()
        if (ui.workspaceOpen && panelMode !== 'docked') ui.setWorkspaceOpen(false)
        else if (ui.route.name !== 'chat') ui.goBack()
        else if (narrow && ui.sidebarOpen) ui.setSidebarOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [narrow, paletteOpen, panelMode, toggleWorkspace, openWorkspaceTab])

  /* 运行总览点一行：先回对话路由，再走正式 store.switchSession（标记已读在 RunsPage 内完成） */
  const openSessionFromRuns = (path: string): void => {
    useUiV3.getState().navigate({ name: 'chat' })
    void useStore.getState().switchSession(path)
  }

  /* 提醒条点一条：同一会话的最新失败/完成不能被旧的盖住；拿不到路径就不跳 */
  const openRunFromPill = (run: RunSnapshot): void => {
    const path = run.sessionPath ?? useStore.getState().sessions.find((s) => s.id === run.sessionId)?.path
    if (!path) return
    useUiV3.getState().navigate({ name: 'chat' })
    void useStore.getState().switchSession(path)
  }

  return (
    <V3ErrorBoundary>
      <div className="v3-root" style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties} data-narrow={narrow ? '1' : '0'} data-side={sidebarOpen ? 'open' : 'closed'} data-sidebar-preview={sidebarPreview && !sidebarOpen ? '1' : undefined}>
        {!sidebarOpen ? <button type="button" className="v3-sidebar-reveal" aria-label={lang === 'en-US' ? 'Show sessions' : '展开会话列表'} data-testid="v3-sidebar-reveal" onClick={() => useUiV3.getState().setSidebarOpen(true)} /> : null}
        <Sidebar
          onClose={() => { setSidebarPreview(false); useUiV3.getState().setSidebarOpen(false) }}
          preview={sidebarPreview && !sidebarOpen}
          onPin={() => useUiV3.getState().setSidebarOpen(true)}
          onPointerLeave={() => { if (!useUiV3.getState().sidebarOpen) setSidebarPreview(false) }}
          onRuns={() => useUiV3.getState().navigate({ name: 'runs' })}
          onSchedule={() => useUiV3.getState().navigate({ name: 'schedule' })}
          onReview={() => useUiV3.getState().navigate({ name: 'review' })}
          onSettings={() => useUiV3.getState().navigate({ name: 'settings' })}
        />
        {sidebarOpen && !narrow ? <Splitter className="v3-sidebar-resizer" value={sidebarWidth} min={220} max={420} step={16} aria-label={lang === 'en-US' ? 'Resize session list' : '调整会话列表宽度'} data-testid="v3-sidebar-resizer" onChange={setSidebarWidth} onReset={() => setSidebarWidth(264)} /> : null}
        {narrow && sidebarOpen ? (
          <div className="v3-scrim" onClick={() => useUiV3.getState().setSidebarOpen(false)} aria-hidden />
        ) : null}
        <div className="v3-main">
          <Header
            narrow={narrow}
            sidebarOpen={sidebarOpen}
            route={route.name}
            onToggleSidebar={() => useUiV3.getState().toggleSidebar()}
            onPreviewSidebar={() => setSidebarPreview(true)}
            onSettings={() => useUiV3.getState().navigate({ name: 'settings' })}
            onBack={() => useUiV3.getState().goBack()}
            workspaceOpen={workspaceOpen}
            onToggleWorkspace={toggleWorkspace}
          />
          <div
            className="v3-body"
            ref={bodyRef}
            style={{ '--workspace-width': `${shownWorkspaceWidth}px` } as CSSProperties}
            data-workspace={route.name === 'chat' && workspaceOpen ? 'open' : 'closed'}
            data-workspace-mode={panelMode}
          >
            {route.name === 'settings' ? (
              <SettingsPanelV3 onShowOnboarding={() => setOnboardingOpen(true)} />
            ) : route.name === 'runs' ? (
              <RunsPage onOpenSession={openSessionFromRuns} />
            ) : route.name === 'schedule' ? (
              <ScheduleTasksPage />
            ) : route.name === 'review' ? (
              <ReviewPage />
            ) : route.name === 'usage' ? (
              <UsagePage />
            ) : (
              <div className="v3-chat">
                {/* 提醒条在会话区顶部，占位不压正文；空时 RunPill 自己返回 null */}
                <RunPill
                  className="v3-pillbar"
                  onOpen={openRunFromPill}
                  onShowAll={() => useUiV3.getState().navigate({ name: 'runs' })}
                />
                <SideBySide split={split} narrow={narrow} />
              </div>
            )}
            {panelMounted ? (
              <WorkbenchPanel
                owner={owner}
                open={route.name === 'chat' && workspaceOpen}
                mode={panelMode}
                panes={WORKBENCH_PANES}
                onClose={() => useUiV3.getState().setWorkspaceOpen(false)}
                onRequestActivation={requestActivation}
                onPopout={(tab) => {
                  if (!paneClient || !owner) return
                  if (tab === 'terminal') {
                    /* 终端：只把既有 PTY 的 terminalId 交同 PTY 桥，不 start / kill。 */
                    void ownedTerminalId(owner.key).then((terminalId) => {
                      if (terminalId) void paneClient.openTerminal(owner, terminalId)
                    })
                    return
                  }
                  if (tab === 'browser') {
                    /* 原生浏览器：交当前页签 id 让同一 WebContentsView 改挂到弹窗。 */
                    const viewId = useStore.getState().browserState.activeTabId
                    if (viewId) void paneClient.open('browser', owner, { viewId })
                    return
                  }
                  if (tab === 'context') void paneClient.open('context', owner)
                }}
              />
            ) : null}
            {route.name === 'chat' && workspaceOpen && panelMode === 'docked' ? (
              <Splitter className="v3-workspace-resizer" orientation="vertical" value={bodyWidth - shownWorkspaceWidth} min={360} max={bodyWidth - 280} step={16} aria-label={lang === 'en-US' ? 'Resize workspace' : '调整工作区宽度'} onChange={(left) => setWorkspaceWidth(bodyWidth - left)} onReset={() => setWorkspaceWidth(420)} />
            ) : null}
          </div>
        </div>
      </div>
      <CommandPalette
        isOpen={paletteOpen}
        onOpenChange={setPaletteOpen}
        onNavigate={(name) => useUiV3.getState().navigate({ name })}
      />
      <ShortcutSheet isOpen={shortcutSheetOpen} onOpenChange={setShortcutSheetOpen} />
      {onboardingOpen ? (
        <OnboardingWizard
          onClose={() => {
            markOnboarded()
            setOnboardingOpen(false)
          }}
        />
      ) : null}
      <NativeSessionSurfaces />
      <SplitDropLayer />
      <NoticeBridge />
    </V3ErrorBoundary>
  )
}
