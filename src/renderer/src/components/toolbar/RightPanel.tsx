import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { SECTION_ICON, SECTION_TITLE } from './ToolSection'
import { DragDropRect, DragPreview } from './DragPreview'
import { useStore } from '../../state/store'
import { AgentHubPanel } from '../workbench/AgentHubPanel'
import { TOOL_SECTIONS, type ToolSectionId } from '../../../../shared/ipc'
import {
  defaultFloatRect,
  defaultToolLayout,
  pxRectToNormalized,
  isTileFloatable,
  moveTile,
  setTilePlacement,
  type ToolLayout,
  type ToolRect,
  type ToolTile
} from '../../../../shared/tool-layout'
import { HandleProvider } from './ToolSection'
import { FileTree } from './FileTree'
import { Resizer } from './Resizer'
import { BrowserSurface } from '../browser/BrowserSurface'
import { TerminalSurface } from '../terminal/TerminalSurface'
import { FilePreviewPane } from './FilePreview'
import { ReviewPanel } from '../review/ReviewPanel'
import { WorkObjectBar } from './WorkObjectBar'
import { fileResourceLabel } from '../../../../shared/file-resource'
import {
  activateWorkbenchTab,
  activeWorkbenchTab,
  activeWorkbenchView,
  closeWorkbenchTab,
  isCurrentWorkbenchOpen,
  loadWorkbenchState,
  newWorkbenchOpenRequest,
  reconcileWorkbench,
  resourceTabId,
  saveWorkbenchState,
  workbenchSessionKey,
  type WorkbenchOpenRequest,
  type WorkbenchState,
  type WorkbenchView
} from '../../state/workbench'
import { Button, IconButton } from '../ui'
import { ContextSection } from './ContextSection'
import { QuotaSection } from './QuotaSection'
import { hasTaskTileContent, TodoCount, TodoSection } from './TodoSection'
import { hasVisibleSubagents } from '../../state/subagent-view'
import { LogCount, QueueSection, ExtSection, LogSection, ActionsSection } from './PanelSections'

type RightWindowView = WorkbenchView

/** 活动标签的渲染页；未知/无标签时回工具页 */
function currentWindowView(state: WorkbenchState): RightWindowView {
  return activeWorkbenchView(state) ?? 'tools'
}

/**
 * 右侧窗口区：工具栏、审查、浏览器和文件都使用同一条窗口标签栏。
 *
 * 这里故意只保留一个活动表面。浏览器是原生 WebContentsView，不能和
 * DOM 面板在同一块坐标上叠放；把几个表面变成同一组窗口标签后，切换时
 * 不会再出现「工具栏标题压在浏览器上」或「文件预览与代码区重叠」的情况。
 * 工具栏内部仍按用户配置排列上下文、任务、队列、文件、扩展、日志和操作分区。
 */
export function RightPanel() {
  const t = useT()
  const open = useStore((s) => s.settings?.rightPanelOpen ?? true)
  const setToolLayout = useStore((s) => s.setToolLayout)
  const browserOpen = useStore((s) => s.browserState.open)
  const browserUrl = useStore((s) => s.browserState.url)
  const browserTitle = useStore((s) => s.browserState.title)
  /** 只读文件预览：与浏览器详情占同一块区域（方案 5.2） */
  const filePreview = useStore((s) => s.filePreview)
  /* 已打开文件的数据（key → 预览状态）：切标签时从它恢复，不重新读盘 */
  const filePreviews = useStore((s) => s.filePreviews)
  const activateFileTab = useStore((s) => s.activateFileTab)
  const closeFileTab = useStore((s) => s.closeFileTab)
  /* 交互终端（H-11）：会话列表与操件都在 store（真源在主进程 PTY 服务） */
  const terminals = useStore((s) => s.terminals)
  const closeTerminal = useStore((s) => s.closeTerminal)
  const setActiveTerminal = useStore((s) => s.setActiveTerminal)
  /**
   * 审查：同一区域的**最高**优先级。
   * 它盖住其它三个的原因很实际：原生 `WebContentsView`（浏览器）永远盖在
   * DOM 之上，两个一起显示必然有一个看不见；而审查打开时用户就是在看代码。
   */
  const reviewOpen = useStore((s) => s.reviewOpen)
  const openBrowser = useStore((s) => s.openBrowser)
  const closeBrowser = useStore((s) => s.closeBrowser)
  const openReview = useStore((s) => s.openReview)
  const closeReview = useStore((s) => s.closeReview)
  const closePreview = useStore((s) => s.closePreview)
  const setRightPanelOpen = useStore((s) => s.setRightPanelOpen)
  const setBrowserSurfaceActive = useStore((s) => s.setBrowserSurfaceActive)
  const acquireOverlayBlocker = useStore((s) => s.acquireOverlayBlocker)
  const session = useStore((s) => s.session)
  /*
   * 实施-20 U4：专用子代理页 / 资源标签已撤下。运行状态与必须由人处理的
   * 停止 / 合并 / 放弃改由会话流里的 SubagentNote 承载（见 chat/SubagentNote）。
   */
  const workbenchKey = workbenchSessionKey(session?.conversationFile ?? session?.sessionFile, session?.conversationId ?? session?.sessionId)
  /*
   * 布局和它所属的会话 key 绑在一起存（`{key, state}`）：切会话时即使某个渲染
   * 周期还拿着上一会话的 state，落盘也只会写回**它自己的 key**，不会把 A 的
   * 布局写进 B（H-3a「订阅保存按所属会话 key 固定」）。
   */
  const [bench, setBench] = useState<{ key: string; state: WorkbenchState }>(() => ({
    key: workbenchKey,
    state: loadWorkbenchState(workbenchKey)
  }))
  const [quickMenuOpen, setQuickMenuOpen] = useState(false)
  const [hubOpen, setHubOpen] = useState(false)

  const updateWorkbench = useCallback((fn: (state: WorkbenchState) => WorkbenchState): void => {
    setBench((current) => ({ key: current.key, state: fn(current.state) }))
  }, [])

  const workbench = bench.state
  const workbenchKeyRef = useRef(workbenchKey)
  workbenchKeyRef.current = workbenchKey
  /* 异步打开浏览器用：序号自增，迟到返回不写状态 */
  const openRequestIdRef = useRef(0)
  const openRequestRef = useRef<WorkbenchOpenRequest | null>(null)

  /* 资源可用集合：固定页始终可用，其余看资源自己是否打开 */
  const available = useMemo<Set<WorkbenchView>>(() => {
    const set = new Set<WorkbenchView>(['start', 'tools'])
    if (reviewOpen) set.add('review')
    if (browserOpen) set.add('browser')
    if (filePreview) set.add('file')
    /* 终端：真源是宿主 PTY 会话列表，不靠一个本地开关 */
    if (terminals.length > 0) set.add('terminal')
    return set
  }, [reviewOpen, browserOpen, filePreview, terminals.length])
  const availableRef = useRef(available)
  availableRef.current = available

  /* 工作窗口按稳定会话文件隔离；切会话只恢复布局，不复制会话正文或资源凭证。 */
  useEffect(() => {
    const next = reconcileWorkbench(loadWorkbenchState(workbenchKey), availableRef.current)
    setBench({ key: workbenchKey, state: next })
    setQuickMenuOpen(false)
  }, [workbenchKey])

  /* 只把布局写回它自己的 key；切会话的中途渲染不会污染新会话。 */
  useEffect(() => {
    saveWorkbenchState(bench.key, bench.state)
  }, [bench])

  /*
   * H-4：预览读到 realpath 后就有了资源身份 → 用它激活/新建文件标签。
   * 同一个文件重复打开只是激活（不叠加副本），不同工作树的同名文件互不覆盖。
   */
  useEffect(() => {
    const key = filePreview?.key
    if (!key) return
    updateWorkbench((state) => activateWorkbenchTab(state, 'file', key))
  }, [filePreview?.key, updateWorkbench])

  const activateWindow = (next: RightWindowView, resourceKey?: string): void => {
    updateWorkbench((current) => activateWorkbenchTab(current, next, resourceKey))
  }

  /*
   * 空判据需要的几个字段分别选出来（选对象会让 zustand 每帧返回新引用 → 无限重渲染）。
   * 有了它们才能算出**真正会渲染出来的**分区列表 —— 这一步很关键：
   * 排序的 index/total 必须按「可见分区」算，否则交换的是两个看不见的分区，
   * 界面完全没反应（实测踩过：todo/ext 为空时不渲染，但 order 里还算着它们）。
   */
  const todos = useStore((s) => s.todos)
  const goal = useStore((s) => s.goal)
  const hasMessageOutputs = useStore((s) => s.messages.some((message) =>
    !!message.artifacts?.length || (message.role === 'user' && !!message.images?.length)
  ))
  const hasSubagents = useStore(hasVisibleSubagents)
  const logs = useStore((s) => s.logs)
  const statuses = useStore((s) => s.statuses)
  const widgets = useStore((s) => s.widgets)

  /**
   * 磁贴布局真源（实施-12 U-4）：停靠顺序 / 浮动位置 / 收进库都在这里。
   * 旧 `toolOrder/toolHidden` 只在读盘时迁移过一次，界面不再写它们。
   */
  const storedLayout = useStore((s) => s.settings?.toolLayout)
  const layout = useMemo<ToolLayout>(
    () => storedLayout ?? defaultToolLayout(TOOL_SECTIONS),
    [storedLayout]
  )

  /**
   * 「什么算空」由注册表声明（任务/扩展/日志为空时整个不渲染）。
   * 选择器返回**布尔**（不是对象）—— zustand v5 用 Object.is 比较。
   */
  const isEmptySection = useCallback(
    (id: ToolSectionId): boolean => {
      const probe = SECTION_REGISTRY[id].isEmpty
      return probe ? probe({ todos, goal, hasMessageOutputs, hasSubagents, logs, statuses, widgets }) : false
    },
    [todos, goal, hasMessageOutputs, hasSubagents, logs, statuses, widgets]
  )

  /** 工具页里实际渲染的停靠磁贴：布局顺序 → 去掉内容为空的 */
  const visible = useMemo<ToolSectionId[]>(() => {
    return layout.tiles
      .filter((tile) => tile.placement === 'docked')
      .sort((a, b) => a.order - b.order)
      .map((tile) => tile.id as ToolSectionId)
      .filter((id) => !isEmptySection(id))
  }, [layout, isEmptySection])

  /** 已浮动 / 已收进库的磁贴（工具页里给浮动项一个轻量占位，内容不重复挂载） */
  const floatingTiles = useMemo(
    () => layout.tiles.filter((tile) => tile.placement === 'floating').sort((a, b) => a.order - b.order),
    [layout]
  )

  /**
   * 工具页里的渲染序列：停靠磁贴 + 已浮动磁贴的轻量占位。
   * 两者按同一个 `order` 混排 —— 磁贴移出后占位还留在原位置，
   * 不会让其余分区莫名向上跳。
   */
  const sequence = useMemo(() => {
    const orderOf = new Map(layout.tiles.map((tile) => [tile.id, tile.order]))
    const docked = visible.map((id) => ({ id, placement: 'docked' as const, order: orderOf.get(id) ?? 0 }))
    const floats = floatingTiles.map((tile) => ({ id: tile.id, placement: 'floating' as const, order: tile.order }))
    return [...docked, ...floats].sort((a, b) => a.order - b.order)
  }, [visible, floatingTiles, layout])
  /** 停靠磁贴的可见下标（键盘 Alt+↑↓ 以**可见**邻居为边界） */
  const dockIndex = useMemo(() => new Map(visible.map((id, i) => [id, i])), [visible])

  /**
   * 把 `id` 移到 `targetId` 的前/后。
   * 键盘与拖拽只是「目标是谁、放前还是放后」不同，移动算法不写两遍。
   */
  const move = useCallback(
    (id: ToolSectionId, targetId: ToolSectionId, after: boolean) => {
      void setToolLayout(moveTile(layout, id, targetId, after))
    },
    [layout, setToolLayout]
  )

  /**
   * 移出到应用内容区（浮动）/ 放回工具页。
   * U-5 的拖放手势复用**同一个命令**，不另写一套放置逻辑。
   */
  const floatTile = useCallback(
    (id: ToolSectionId, rect?: ToolRect) => {
      const tile = layout.tiles.find((t) => t.id === id)
      if (!tile || tile.placement === 'floating' || !isTileFloatable(id)) return
      void setToolLayout(setTilePlacement(layout, id, 'floating', rect ?? floatRectFor(layout)))
    },
    [layout, setToolLayout]
  )
  const dockTile = useCallback(
    (id: ToolSectionId) => {
      const tile = layout.tiles.find((t) => t.id === id)
      if (!tile || tile.placement === 'docked') return
      void setToolLayout(setTilePlacement(layout, id, 'docked'))
    },
    [layout, setToolLayout]
  )
  /** 定位到已浮动的磁贴（工具页占位行的「定位」）——闪烁一下，不抢焦点 */
  const locateTile = useCallback((id: string) => {
    const el = document.querySelector(`[data-float-id="${id}"]`)
    if (!(el instanceof HTMLElement)) return
    el.classList.add('locate-flash')
    window.setTimeout(() => el.classList.remove('locate-flash'), 900)
  }, [])

  /** 右栏自身：工具菜单的外点关闭需要从它里面判断命中。 */
  const asideRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!quickMenuOpen) return undefined
    /* 打开的工作区工具菜单也是 overlay：领 token 把原生网页藏住，关闭只释放自己。 */
    const release = acquireOverlayBlocker('right-quick-menu')
    const close = (event: MouseEvent): void => {
      if (event.target instanceof Node && asideRef.current?.contains(event.target)) return
      setQuickMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setQuickMenuOpen(false)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', closeOnEscape)
      release()
    }
  }, [quickMenuOpen, acquireOverlayBlocker])

  /* 外部入口打开浏览器/文件/审查时，把窗口切到对应标签。资源本身不随切页销毁。 */
  const previousBrowserOpen = useRef(browserOpen)
  const previousReviewOpen = useRef(reviewOpen)
  const previousFilePreview = useRef(!!filePreview)
  /*
   * 只在「打开了另一份预览」时展开右栏。不能把 `open` 放进触发条件：
   * 否则文件一开着，用户点折叠就会被这里立刻重新展开，永远收不回去。
   */
  const previewIdentity = filePreview ? `${filePreview.cwd ?? ''}\n${filePreview.path}\n${filePreview.line ?? ''}\n${filePreview.lineEnd ?? ''}` : ''
  const [previewFocus, setPreviewFocus] = useState(false)
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    if (previewIdentity && !openRef.current) void setRightPanelOpen(true)
  }, [previewIdentity, setRightPanelOpen])

  useEffect(() => {
    const opened = browserOpen && !previousBrowserOpen.current
    const reviewOpened = reviewOpen && !previousReviewOpen.current
    const fileOpened = !!filePreview && !previousFilePreview.current
    previousBrowserOpen.current = browserOpen
    previousReviewOpen.current = reviewOpen
    previousFilePreview.current = !!filePreview
    updateWorkbench((state) => {
      const current = currentWindowView(state)
      const next: RightWindowView = reviewOpened
        ? 'review'
        : fileOpened
          ? 'file'
          : opened
            ? 'browser'
            : !browserOpen && current === 'browser'
              ? (filePreview ? 'file' : 'tools')
              : current === 'review' && !reviewOpen
                ? (browserOpen ? 'browser' : 'tools')
                : current === 'file' && !filePreview
                  ? (browserOpen ? 'browser' : 'tools')
                  : current
      if (next === current) return state
      /*
       * H-4：文件标签必须带资源身份 —— 这里只负责“切到文件视图”，
       * 标签的创建/激活统一由下面那个 `filePreview.key` 的 effect 做。
       * 拿不到 key（还在 loading）就不动视图，等它到位，
       * 否则会先建出一个无法区分的无身份标签。
       */
      if (next === 'file') {
        return filePreview?.key ? activateWorkbenchTab(state, 'file', filePreview.key) : state
      }
      return activateWorkbenchTab(state, next)
    })
  }, [browserOpen, filePreview, reviewOpen, updateWorkbench])

  const switchWindow = (next: RightWindowView, resourceKey?: string): void => {
    setQuickMenuOpen(false)
    /*
     * 终端必顶带会话身份（与文件标签同一约定）：没有身份就不建标签。
     * 这里先确定目标会话，再一次性 activate；不能先建一个无身份标签再补。
     */
    if (next === 'terminal') {
      const state = useStore.getState()
      const target = resourceKey ?? state.activeTerminalId ?? state.terminals[0]?.id
      if (target) {
        activateWindow('terminal', target)
        setActiveTerminal(target)
      } else {
        /* 一个会话都没有 → 现开一个；标签由 startTerminal 写入的快照建立 */
        void state.startTerminal({ cols: 80, rows: 24 }).then((snapshot) => {
          if (snapshot) activateWindow('terminal', snapshot.id)
        })
      }
      if (!open) void setRightPanelOpen(true)
      return
    }
    activateWindow(next, resourceKey)

    if (next === 'tools' || next === 'start') {
      /* 固定导航页；切页只隐藏原生网页，不释放资源 */
      return
    }

    if (next === 'review') {
      openReview()
      return
    }

    if (next === 'browser') {
      if (browserOpen) return
      {
        /*
         * 异步打开带 requestId + sessionKey：切了会话或又发了新请求后，
         * 迟到的返回不写状态，也不把旧会话的空浏览器标签留在新会话。
         */
        const request = newWorkbenchOpenRequest(workbenchKey, openRequestIdRef.current)
        openRequestIdRef.current = request.requestId
        openRequestRef.current = request
        void openBrowser().then(() => {
          if (!isCurrentWorkbenchOpen(request, workbenchKeyRef.current, openRequestIdRef.current)) return
          /* 打开失败时没有 browserState 事件，不能把右栏永远留在空的 browser tab。 */
          if (!useStore.getState().browserState.open) updateWorkbench((state) => closeWorkbenchTab(state, 'browser'))
        })
      }
      return
    }

    /* 文件窗口没有原生视图，文件树和文件预览共用这个表面。 */
    if (!open) void setRightPanelOpen(true)
  }

  const closeWindow = (which: Exclude<RightWindowView, 'tools' | 'start'>): void => {
    setQuickMenuOpen(false)
    if (which === 'terminal') {
      /* 动“关闭”就真的 kill PTY，不只是藏起来 */
      const id = useStore.getState().activeTerminalId
      if (id) void closeTerminal(id)
      const rest = useStore.getState().terminals
      const nextId = rest[0]?.id
      if (nextId) {
        setActiveTerminal(nextId)
        activateWindow('terminal', nextId)
      } else {
        activateWindow('tools')
      }
      updateWorkbench((state) => {
        const activeTab = activeWorkbenchTab(state)
        return activeTab?.kind === 'terminal' ? closeWorkbenchTab(state, activeTab.id) : state
      })
      return
    }
    if (which === 'review') {
      closeReview()
      const next = browserOpen ? 'browser' : filePreview ? 'file' : 'tools'
      activateWindow(next)
      updateWorkbench((state) => closeWorkbenchTab(state, 'review'))
    } else if (which === 'browser') {
      activateWindow('tools')
      updateWorkbench((state) => closeWorkbenchTab(state, 'browser'))
      void closeBrowser()
    } else {
      /* 只关当前这一个文件标签；其它文件标签保留（H-4） */
      const currentKey = filePreview?.key
      if (currentKey) closeFileTab(currentKey)
      else closePreview()
      const nextTab = fileTabs.find((tab) => tab.resourceKey !== currentKey)
      if (nextTab?.resourceKey) activateFileTab(nextTab.resourceKey)
      else {
        activateWindow('tools')
      }
      if (currentKey) updateWorkbench((state) => closeWorkbenchTab(state, resourceTabId('file', currentKey)))
    }
  }

  const activeView: RightWindowView = currentWindowView(workbench)
  const homeMode = activeView === 'start' || activeView === 'tools'
  const reviewMode = activeView === 'review' && reviewOpen
  const browserMode = activeView === 'browser' && browserOpen
  const fileMode = activeView === 'file'
  const toolsMode = homeMode && open
  /* 交互终端（H-11）：纯 DOM 资源，与文件一样走工作窗口标签 */
  const terminalMode = activeView === 'terminal'
  /* 异步打开浏览器的瞬间仍保留面板；否则 activeView 切过去后组件会卸载。 */
  const pendingSurface = (activeView === 'browser' && !browserOpen) || (activeView === 'review' && !reviewOpen)
  /*
   * H-3b：收起整个工作栏 = 连原生网页一起不可见（不再沿用「只藏标签、网页满列」）。
   * 收起时整个右栏渲染为 null，布局的 `:has(.rightpanel)` 会把 --w-right 置 0。
   */
  const hasVisibleSurface = open && (reviewMode || browserMode || fileMode || toolsMode || terminalMode || pendingSurface)
  /* 文件资源标签（实施-11 H-4）：一个文件一个标签，身份是 projectId+root+canonicalPath */
  const fileTabs = workbench.tabs.filter((tab) => tab.kind === 'file')
  /* 终端资源标签（H-11）：一个 PTY 会话一个标签，身份是会话 id */
  const terminalTabs = workbench.tabs.filter((tab) => tab.kind === 'terminal')

  /*
   * 原生网页显隐的唯一协调点在 store（browser-visibility）：这里只报告
   * 「活动页是不是浏览器」，不直接 setVisible，避免多个浮层互相覆盖。
   */
  const activeBrowserSurface = activeView === 'browser'
  useEffect(() => {
    setBrowserSurfaceActive(activeBrowserSurface)
  }, [activeBrowserSurface, setBrowserSurfaceActive])

  /* 浏览器收起工具栏时不再保留一行空标签，让原生网页占满右列。 */
  if (!hasVisibleSurface) return null

  const showWindowBar = !browserMode || open

  return (
    <aside
      ref={asideRef}
      className={`rightpanel right-window-panel window-${activeView} ${browserMode ? 'browser-mode' : ''} ${fileMode && filePreview ? 'file-preview-mode' : ''} ${reviewMode ? 'review-mode' : ''}`}
      data-testid="rightpanel"
    >
      {/*
       * 宽度把手放在 aside **内部**并绝对定位。
       * 不能作为 .workspace 的 grid 子元素 —— 那会多出一列，
       * grid-template-columns 只有三列的定义（本项目的列宽踩过坑，见 layout.css 的 .workspace）。
      */}
      <Resizer side="panel" review={reviewMode} />

      {showWindowBar ? (
        <div
          className={`review-tabbar rp-windowbar ${homeMode ? 'rp-top' : ''}`}
          role="tablist"
          aria-label="右栏窗口"
          data-testid="right-window-tabs"
        >
          {/* 固定导航：开始 + 工具 */}
          <div
            className={`ui-tab doc review-tab rp-window-tab ${homeMode ? 'active' : ''}`}
            role="tab"
            aria-selected={homeMode}
            title={t('rp.home')}
            data-testid="right-window-tab-start"
            onClick={() => switchWindow('start')}
          >
            <Icon name="dashboard" size={12} />
            <span className="rp-title">{t('rp.home')}</span>
          </div>

          {reviewOpen ? (
            <div
              className={`ui-tab doc review-tab rp-window-tab ${activeView === 'review' ? 'active' : ''}`}
              role="tab"
              aria-selected={activeView === 'review'}
              data-testid="review-tab"
              onClick={() => switchWindow('review')}
            >
              <Icon name="check-circle" size={12} />
              <span>审查</span>
              <button
                type="button"
                className="ui-tab-close review-tab-close"
                onClick={(event) => { event.stopPropagation(); closeWindow('review') }}
                aria-label={t('review.close')}
                title={t('review.close')}
              ><Icon name="close" size={12} /></button>
            </div>
          ) : null}

          {browserOpen ? (
            <div
              className={`ui-tab doc review-tab rp-window-tab ${activeView === 'browser' ? 'active' : ''}`}
              role="tab"
              aria-selected={activeView === 'browser'}
              data-testid="right-window-tab-browser"
              onClick={() => switchWindow('browser')}
            >
              <Icon name="globe" size={12} />
              <span>{browserUrl ? (browserTitle || '浏览器') : '浏览器'}</span>
              <button
                type="button"
                className="ui-tab-close review-tab-close"
                onClick={(event) => { event.stopPropagation(); closeWindow('browser') }}
                aria-label="关闭浏览器"
                title="关闭浏览器"
              ><Icon name="close" size={12} /></button>
            </div>
          ) : null}

          {fileTabs.map((tab) => {
            const key = tab.resourceKey ?? ''
            const state = filePreviews[key]
            const label = state?.data?.name || fileResourceLabel(key) || '文件'
            const active = activeView === 'file' && workbench.activeTabId === tab.id
            return (
              <div
                key={tab.id}
                className={`ui-tab doc review-tab rp-window-tab ${active ? 'active' : ''}`}
                role="tab"
                aria-selected={active}
                data-testid="right-window-tab-file"
                data-file-key={key}
                onClick={() => {
                  activateFileTab(key)
                  switchWindow('file', key)
                }}
              >
                <Icon name="folder" size={12} />
                <span title={state?.data?.abs || state?.path}>{label}</span>
                <button
                  type="button"
                  className="ui-tab-close review-tab-close"
                  onClick={(event) => {
                    event.stopPropagation()
                    closeFileTab(key)
                    updateWorkbench((state) => closeWorkbenchTab(state, tab.id))
                    setQuickMenuOpen(false)
                  }}
                  aria-label="关闭文件"
                  title="关闭文件"
                ><Icon name="close" size={12} /></button>
              </div>
            )
          })}

          {terminalTabs.map((tab) => {
            const info = terminals.find((item) => item.id === tab.resourceKey)
            const active = activeView === 'terminal' && workbench.activeTabId === tab.id
            return (
              <div
                key={tab.id}
                className={`ui-tab doc review-tab rp-window-tab ${active ? 'active' : ''}`}
                role="tab"
                aria-selected={active}
                data-testid="right-window-tab-terminal"
                data-terminal-id={tab.resourceKey}
                onClick={() => {
                  if (tab.resourceKey) setActiveTerminal(tab.resourceKey)
                  switchWindow('terminal', tab.resourceKey)
                }}
              >
                <Icon name="terminal" size={12} />
                <span title={info?.cwd}>{info?.title ?? t('term.tab')}</span>
                <button
                  type="button"
                  className="ui-tab-close review-tab-close"
                  onClick={(event) => {
                    event.stopPropagation()
                    closeWindow('terminal')
                  }}
                  aria-label={t('term.close')}
                  title={t('term.close')}
                ><Icon name="close" size={12} /></button>
              </div>
            )
          })}

          <div className="rp-tool-launcher-wrap">
            <IconButton
              icon="plus"
              size="sm"
              iconSize={14}
              className={`rp-window-plus rp-tool-launcher ${quickMenuOpen ? 'on' : ''}`}
              label="打开工作区工具"
              aria-expanded={quickMenuOpen}
              data-testid="right-tool-menu"
              onClick={() => setQuickMenuOpen((value) => !value)}
            />
          </div>

          <span className="spacer" />

          {homeMode ? (
            <button
              className="rp-x"
              onClick={() =>
                void setToolLayout({ ...defaultToolLayout(TOOL_SECTIONS), revision: layout.revision + 1 })
              }
              title={t('tl.reset')}
              data-testid="tool-reset-layout"
            >
              <Icon name="refresh" size={12} />
            </button>
          ) : null}
        </div>
      ) : null}

      {quickMenuOpen ? (
        <div className="rp-tool-menu" role="menu" data-testid="right-tool-menu-popover">
          <button type="button" className="rp-tool-menu-item" role="menuitem" onClick={() => switchWindow('review')}>
            <Icon name="check-circle" size={12} />
            <span>审查</span>
          </button>
          <button type="button" className="rp-tool-menu-item" role="menuitem" onClick={() => switchWindow('terminal')}>
            <Icon name="terminal" size={12} />
            <span>终端</span>
          </button>
          <button type="button" className="rp-tool-menu-item" role="menuitem" onClick={() => switchWindow('browser')}>
            <Icon name="globe" size={12} />
            <span>浏览器</span>
          </button>
          <button type="button" className="rp-tool-menu-item" role="menuitem" onClick={() => switchWindow('file')}>
            <Icon name="folder" size={12} />
            <span>文件</span>
          </button>
          <button type="button" className="rp-tool-menu-item" role="menuitem" onClick={() => switchWindow('start')}>
            <Icon name="dashboard" size={12} />
            <span>{t('rp.home')}</span>
          </button>
        </div>
      ) : null}

      <WorkObjectBar />

      {reviewMode ? <ReviewPanel /> : null}
      {terminalMode ? <TerminalSurface /> : null}
      {browserMode ? <BrowserSurface /> : null}
      {pendingSurface ? (
        <div className="rp-pending-surface" data-testid="right-window-pending">
          {activeView === 'browser' ? '正在打开浏览器…' : '正在打开审查…'}
        </div>
      ) : null}
      {toolsMode || (fileMode && open) ? (
        <div className="rp-body" data-testid="rp-body">
          {hubOpen ? <AgentHubPanel onBack={() => setHubOpen(false)} /> : <Button size="sm" onClick={() => setHubOpen(true)} data-testid="open-agent-hub">多 Agent 工作台</Button>}
          {fileMode && filePreview ? <FilePreviewPane focus={previewFocus} onToggleFocus={() => setPreviewFocus((v) => !v)} /> : null}
          {(hubOpen || (fileMode && filePreview && previewFocus) ? [] : sequence).map((tile) => {
            if (tile.placement === 'floating') {
              return (
                <FloatPlaceholder
                  key={tile.id}
                  tile={layout.tiles.find((t) => t.id === tile.id) as ToolTile}
                  onLocate={locateTile}
                  onDock={dockTile}
                />
              )
            }
            const i = dockIndex.get(tile.id as ToolSectionId) ?? 0
            return (
              <SectionSlot
                key={tile.id}
                id={tile.id as ToolSectionId}
                index={i}
                total={visible.length}
                /* 键盘用：下一个/上一个**可见**邻居 */
                prevId={visible[i - 1]}
                nextId={visible[i + 1]}
                onMove={move}
                floatable={isTileFloatable(tile.id)}
                onFloat={floatTile}
                onDock={dockTile}
              />
            )
          })}
        </div>
      ) : null}
    </aside>
  )
}

/* 分区插槽 —— 把「注册表 + 排序」与各分区自己的渲染分开 */

/** 指针是否落在中栏内容区（拖出成浮动磁贴的落点区） */
function isOverCenter(clientX: number, clientY: number): boolean {
  const center = document.querySelector('.workspace > .center')?.getBoundingClientRect()
  return (
    !!center &&
    clientX >= center.left &&
    clientX <= center.right &&
    clientY >= center.top &&
    clientY <= center.bottom
  )
}

/**
 * 指针位置 → 这块磁贴**将来变成的浮窗**像素矩形。
 *
 * 拖动时的落位预览帧（DragDropRect）与真正落位（finish）必须走同一个
 * 函数 —— 两处各算一遍的话，只要有一处漏了夹取或偏移，松手瞬间卡片就会
 * 「跳一下」，用户看到的预览就是假的。
 */
function floatPxRectAt(
  clientX: number,
  clientY: number
): { left: number; top: number; width: number; height: number } | null {
  const ws = document.querySelector('.workspace')?.getBoundingClientRect()
  if (!ws) return null
  const floatingCount =
    useStore.getState().settings?.toolLayout?.tiles.filter((tile) => tile.placement === 'floating').length ?? 0
  const base = defaultFloatRect(floatingCount, ws.width, ws.height)
  const width = base.w * ws.width
  const height = base.h * ws.height
  return {
    left: Math.max(ws.left, Math.min(clientX - width / 2, ws.right - width)),
    top: Math.max(ws.top, Math.min(clientY - 16, ws.bottom - height)),
    width,
    height
  }
}

/**
 * 指针 Y 落在哪个分区的上半 / 下半（拖放插入位置）。
 *
 * ⚠️ 用 `.rp-slot` 上的 data-tool-id（**不带 rp- 前缀的原始 id**）来比，
 *    不能读 `.rp-sec` 的 data-sec（那是 `rp-queue` 这种 testid 形态）——
 *    顺序数组里存的是 `queue`，拿 testid 去 indexOf 会得到 -1，
 *    于是整个拖放静默失效（实测就错在这里）。
 *
 * 导出给 FloatingTiles 用：浮窗拖回工具页时也要显示同一条插入线，
 * 而它那里的指针事件根本不在这些 slot 上。
 */
export function resolveToolDrop(
  clientY: number,
  excludeId?: string
): { id: ToolSectionId; after: boolean } | null {
  const slots = [...document.querySelectorAll('.rp-body > .rp-slot')] as HTMLElement[]
  for (const el of slots) {
    const r = el.getBoundingClientRect()
    if (clientY < r.top || clientY > r.bottom) continue
    const id = el.dataset.toolId as ToolSectionId | undefined
    if (!id || id === excludeId) return null
    return { id, after: clientY >= r.top + r.height / 2 }
  }
  return null
}

/**
 * 按 id 渲染对应分区，并给它包上一层可拖拽的头。
 *
 * 为什么要注册表而不是直接写 JSX：
 *   排序功能需要「按数据决定渲染顺序」，而 JSX 的字面顺序是写死的。
 *   注册表让「分区有哪些」与「它们怎么显示」分成两件事。
 */
function SectionSlot({
  id,
  index,
  total,
  prevId,
  nextId,
  onMove,
  floatable,
  onFloat,
  onDock
}: {
  id: ToolSectionId
  /** 在**可见**分区里的序号（键盘边界用） */
  index: number
  /** 可见分区总数 */
  total: number
  /** 上一个 / 下一个**可见**邻居（键盘调顺序用） */
  prevId?: ToolSectionId
  nextId?: ToolSectionId
  onMove: (id: ToolSectionId, targetId: ToolSectionId, after: boolean) => void
  /** 当前所有工具磁贴都可以移到工作区。 */
  floatable: boolean
  onFloat: (id: ToolSectionId, rect?: ToolRect) => void
  onDock: (id: ToolSectionId) => void
}) {
  const t = useT()
  const [dragging, setDragging] = useState(false)
  const [floatingDrop, setFloatingDrop] = useState(false)
  /** 拖动中的指针位置 —— 拖动预览胶囊跟着它走 */
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const dragStart = useRef<{ x: number; y: number } | null>(null)
  const dragMoved = useRef(false)
  /*
   * 插入预览线统一走 store 的 toolDropTarget —— 因为拖拽可能**从工具库发起**，
   * 那时指针不在这块分区上，用本组件的局部 state 根本收不到事件。
   * （曾经这里有一份自己的 over state，与 store 那份会打架。）
   */
  const setToolDropTarget = useStore((s2) => s2.setToolDropTarget)
  /** 当前全局落点（拖拽从工具库发起时也走它 —— 局部 state 收不到那些事件） */
  const dropTarget = useStore((s2) => s2.toolDropTarget)

  /*
   * 拖拽用**指针事件**而不是 HTML5 DnD。
   * HTML5 DnD 在 Electron 里有一套自己的拖影/拖放目标规则，
   * 而且 dragenter/dragleave 会冒泡出成对的假事件（子元素进出时反复触发），
   * 算插入位置很麻烦。指针事件只需自己比 Y 坐标，行为完全可控 ——
   * 文件树与宽度把手用的也是同一套。
   */
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement
    if (e.button !== 0 || !target.closest('.rp-sec-row')) return
    if (target.closest('button:not(.rp-sec-head):not(.rp-grip)')) return
    dragStart.current = { x: e.clientX, y: e.clientY }
    dragMoved.current = false
  }

  const startDragging = (e: React.PointerEvent<HTMLDivElement>): void => {
    /*
     * ⚠️ 先置状态、再尝试 capture，而且 **capture 必须包 try**。
     *    上一版是 `setPointerCapture()` 放在前面且不包 catch：
     *    它会抛 NotFoundError（指针已不存在 / 合成事件里 pointerId 无效），
     *    异常抛出去之后 `setDragging(true)` 根本没执行 ——
     *    于是整个拖拽**静默失效**（看起来像「拖了但没反应」）。
     *    探针就是用这一条抓出来的。
     *    capture 只是个便利（指针移出元素后仍收 move），失败也不该影响可用性。
     */
    setDragging(true)
    dragMoved.current = true
    document.body.classList.add('reordering')
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* 拿不到 capture 也能拖 —— 只是指针移出把手后会断流 */
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const start = dragStart.current
    if (!start) return
    if (!dragMoved.current) {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < 6) return
      startDragging(e)
    }
    /*
     * 拖动预览跟着指针走：栏内重排与拖出工作区共用同一个胶囊。
     * 落进工作区时不再画插入线 —— 那时插槽命中会误报成「插到边缘那块」，
     * 而用户要做的是把它移出去。
     */
    setPointer({ x: e.clientX, y: e.clientY })
    const overCenter = floatable && isOverCenter(e.clientX, e.clientY)
    setFloatingDrop(overCenter)
    setToolDropTarget(overCenter ? null : resolveToolDrop(e.clientY, id))
  }

  const finish = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragStart.current) return
    dragStart.current = null
    if (!dragMoved.current) return
    setDragging(false)
    setFloatingDrop(false)
    setPointer(null)
    document.body.classList.remove('reordering')
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* 指针没了也无所谓 */
    }

    /*
     * Electron 的合成 PointerEvent / 隐藏探针里，elementFromPoint 可能命中
     * 事件源而不是指针坐标对应的分区。pointermove 已经把同一落点写进
     * store，因此这里以几何命中为首选、以共享落点为回退；否则拖拽会在
     * 视觉上移动了却静默不落盘。
     */
    const workspace = document.querySelector('.workspace')
    const workspaceRect = workspace?.getBoundingClientRect()
    const droppedInWorkspace = floatable && !!workspaceRect && isOverCenter(e.clientX, e.clientY)
    const pxRect = droppedInWorkspace ? floatPxRectAt(e.clientX, e.clientY) : null
    if (pxRect && workspaceRect) {
      setToolDropTarget(null)
      onFloat(
        id,
        pxRectToNormalized(pxRect, {
          left: workspaceRect.left,
          top: workspaceRect.top,
          width: workspaceRect.width,
          height: workspaceRect.height
        })
      )
      return
    }

    const drop = useStore.getState().toolDropTarget
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.rp-slot') as HTMLElement | null
    /* 落点预览就是用户看到的承诺；提交同一落点，避免合成事件或覆盖层让
       elementFromPoint 命中另一个槽位，出现“预览在 A、松手却放到 B”。 */
    const targetId = (drop?.id ?? target?.dataset.toolId) as ToolSectionId | undefined
    setToolDropTarget(null)
    if (!targetId || targetId === id) return

    // 与预览统一使用 pointermove 记录的 before/after；没有记录时才按几何位置兜底。
    const r = target?.getBoundingClientRect()
    const after = drop?.id === targetId ? drop.after : r ? e.clientY > r.top + r.height / 2 : false
    onMove(id, targetId, after)
  }

  const cancelDrag = (): void => {
    dragStart.current = null
    dragMoved.current = false
    setDragging(false)
    setFloatingDrop(false)
    setPointer(null)
    setToolDropTarget(null)
    document.body.classList.remove('reordering')
  }

  /**
   * 键盘调顺序（把手聚焦后 Alt+↑↓）。
   * 与**可见**邻居交换 —— 不是数组里的相邻项（中间可能夹着不可见的分区，
   * 那样按一下会「没反应」）。
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    /* Alt+← / Alt+→：移出为浮动 / 放回工具页（与工具库按钮是同一条命令） */
    if (e.altKey && e.key === 'ArrowLeft') {
      e.preventDefault()
      if (floatable) onFloat(id)
      return
    }
    if (e.altKey && e.key === 'ArrowRight') {
      e.preventDefault()
      onDock(id)
      return
    }
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    e.preventDefault()
    if (e.key === 'ArrowUp') {
      if (index === 0 || !prevId) return
      onMove(id, prevId, false)
    } else {
      if (index === total - 1 || !nextId) return
      onMove(id, nextId, true)
    }
  }

  /**
   * 分区高度可调（用户要求）。
   *
   * 做法：在**可滚动内容**（.rp-fs / .rp-log）上加一个底部把手，拖动改
   * max-height；数值按分区 id 存到设置里（toolHeights[id] = px）。
   *
   * 为什么不给每个分区都加：大部分分区内容就是几行，给它们加把手只是噪声。
   * 只有「内部会滚动」的分区（文件树、日志）才真的需要调高度 ——
   * 这也是用户会碰到的两个。
   */
  const [heightDragging, setHeightDragging] = useState(false)
  const heightRef = useRef<{ y: number; base: number } | null>(null)

  const onHeightDown = (e: React.PointerEvent<HTMLButtonElement>, el: HTMLElement | null): void => {
    if (e.button !== 0 || !el) return
    e.preventDefault()
    e.stopPropagation()
    heightRef.current = { y: e.clientY, base: el.getBoundingClientRect().height }
    setHeightDragging(true)
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* capture 失败也能拖（只会在移出把手后断流） */
    }
  }

  const onHeightMove = (e: React.PointerEvent<HTMLButtonElement>, el: HTMLElement | null): void => {
    const st = heightRef.current
    if (!st || !el) return
    /*
     * 边界与主进程一致（80–900）。往下拖 = 变高。
     * 拖动中直接改 style（不走 state）—— 每像素重渲染整棵工具栏会跟手不起来。
     */
    const next = Math.round(Math.min(900, Math.max(80, st.base + (e.clientY - st.y))))
    el.style.maxHeight = next + 'px'
  }

  const onHeightUp = (e: React.PointerEvent<HTMLButtonElement>, el: HTMLElement | null): void => {
    const st = heightRef.current
    if (!st || !el) return
    heightRef.current = null
    setHeightDragging(false)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    const h = Math.round(el.getBoundingClientRect().height)
    void setToolHeight(id, h)
  }

  /**
   * 找本分区里那个「会滚动的容器」（文件树的 .rp-fs / 日志的 .rp-log）。
   * 高度把手改的就是它的 max-height —— 不要改分区本身的高度，
   * 那会把标题栏也一起拉高（用户拖的是内容区）。
   */
  const scrollEl = (): HTMLElement | null =>
    ref.current?.querySelector('.rp-todo-scroll, .rp-fs, .rp-log, .rp-todos') as HTMLElement | null

  /** 设置里存的高度（启动时应用一次） */
  const savedHeight = useStore((s2) => s2.settings?.toolHeights?.[id] ?? 0)
  useEffect(() => {
    const el = scrollEl()
    if (el && savedHeight > 0) el.style.maxHeight = savedHeight + 'px'
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedHeight, id])

  const setToolHeight = useStore((s2) => s2.setToolHeight)

  const Body = SECTION_REGISTRY[id].Body
  /*
   * 空判据交给注册表，而不是「让 Body 返回 null」。
   *
   * ⚠️ 重构时犯过的错：原来 TodoSection 在没任务时返回 null，
   *    整个 section 就不存在了；改成「按注册表渲染」后，外面那层
   *    SectionFrame 是无条件渲染的 —— 于是没任务时也会出现一个空的
   *    「任务」区块（探针的「没有任务时不渲染任务区块」抓到了）。
   *    现在把「什么算空」声在注册表里，容器先问一句再决定渲染。
   *
   * 选择器返回**布尔**（不是对象）—— zustand v5 用 Object.is 比较，
   * 每帧返回新对象会无限重渲染。
   */
  const isEmpty = useStore((s) => {
    const probe = SECTION_REGISTRY[id].isEmpty
    return probe ? probe(toolPanelProbe(s)) : false
  })
  if (isEmpty) return null

  /* 落位预览框：与真正落位同算法，见 floatPxRectAt 的注释 */
  const dropRect = floatingDrop && pointer ? floatPxRectAt(pointer.x, pointer.y) : null

  return (
    <div
      className={`rp-slot ${dragging ? 'dragging' : ''} ${floatingDrop ? 'floating-drop' : ''}`}
      data-tool-id={id}
      data-over={dropTarget?.id === id ? (dropTarget.after ? 'after' : 'before') : ''}
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={cancelDrag}
      onClickCapture={(e) => {
        if (!dragMoved.current) return
        dragMoved.current = false
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      {/*
       * 拖动预览：跟随指针的胶囊 + （拖出时）工作区里的落位框。
       * 用 portal 渲染，放在这里只是为了跟着这块磁贴的生命周期挂载。
       */}
      {dragging && pointer ? (
        <>
          {dropRect ? <DragDropRect rect={dropRect} label={t('rp.dropFloat')} /> : null}
          <DragPreview
            x={pointer.x}
            y={pointer.y}
            icon={SECTION_ICON[id]}
            label={t(SECTION_TITLE[id])}
            hint={floatingDrop ? t('rp.dragFloat') : undefined}
            tone={floatingDrop ? 'float' : 'move'}
          />
        </>
      ) : null}
      <HandleProvider
        value={
          <button
            className="rp-grip"
            title={t('rp.dragHint')}
            aria-label={t('rp.dragHint')}            tabIndex={0}
            data-testid={`grip-${id}`}
            onKeyDown={onKeyDown}
          >
            <span aria-hidden>⠿</span>
          </button>
        }
      >
        <Body />
        {/* 只在会滚动的分区上给高度把手（见 onHeightDown 的注释） */}
        {SECTION_REGISTRY[id].resizable ? (
          <button
            className={`rp-vgrip ${heightDragging ? 'on' : ''}`}
            title={t('rp.heightHint')}
            aria-label={t('rp.heightHint')}
            data-testid={`vgrip-${id}`}
            onPointerDown={(e) => onHeightDown(e, scrollEl())}
            onPointerMove={(e) => onHeightMove(e, scrollEl())}
            onPointerUp={(e) => onHeightUp(e, scrollEl())}
            onPointerCancel={(e) => onHeightUp(e, scrollEl())}
          />
        ) : null}
      </HandleProvider>
    </div>
  )
}

/**
 * 已浮动磁贴在工具页留下的**轻量占位**（设计 §5.1）。
 *
 * 为什么不能只把磁贴从列表里抽掉：其余分区会集体上跳，而磁贴与它的
 * order 不变 —— 界面看起来像“被删了”。占位保留位置，并给两个出口：
 * 「定位」闪烁已浮动的那块、「放回工具页」。
 */
function FloatPlaceholder({
  tile,
  onLocate,
  onDock
}: {
  tile: ToolTile
  onLocate: (id: string) => void
  onDock: (id: ToolSectionId) => void
}) {
  const t = useT()
  const id = tile.id as ToolSectionId
  return (
    <div className="rp-float-ph" data-tool-id={tile.id} data-testid={`float-ph-${tile.id}`}>
      <Icon name="tile" size={12} />
      <span className="rp-float-ph-name">{t(SECTION_TITLE[id])}</span>
      <span className="rp-float-ph-tag">{t('tl.floating')}</span>
      <span className="spacer" />
      <Button size="sm" className="rp-btn" onClick={() => onLocate(tile.id)} data-testid={`float-locate-${tile.id}`}>
        {t('tl.locate')}
      </Button>
      <Button size="sm" className="rp-btn" onClick={() => onDock(id)} data-testid={`float-dock-${tile.id}`}>
        {t('tl.dockBack')}
      </Button>
    </div>
  )
}

/**
 * 新建浮动磁贴的默认位置（设计 §5.2：初始宽 300，最窄 240，最宽 420）。
 *
 * 坐标是**相对应用内容区的归一化值**（U-0 冻结契约，x/y/w/h 均 0–1），
 * 所以宽度用「目标像素 ÷ 可用宽度」换算；测不到 DOM（测试环境）按 900px 估。
 * 逐个错开，避免多块磁贴叠在同一处。
 */
function floatRectFor(layout: ToolLayout): ToolRect {
  const host = document.querySelector('.workspace')
  const box = host?.getBoundingClientRect()
  const n = layout.tiles.filter((tile) => tile.placement === 'floating').length
  return defaultFloatRect(n, box?.width ?? 900, box?.height ?? 700)
}

/** 每个分区自己的内容与头部声明（与 SectionFrame 分开，避免把顺序逻辑重复七遍） */
export const SECTION_REGISTRY: Record<
  ToolSectionId,
  {
    /** 这个分区自己的内容 */
    Body: () => React.ReactElement | null
    /** 头部右侧的附加信息（如任务的 2/4、日志行数） */
    Extra?: () => React.ReactElement | null
    /** 返回 true 则整个分区不渲染（而不是渲染一个空的） */
    isEmpty?: (s: ToolPanelProbe) => boolean
    /**
     * 内容会滚动、高度值得调（文件树 / 日志）。
     * 其余分区就几行，给它们加把手只是噪声。
     */
    resizable?: boolean
  }
> = {
  context: { Body: () => <ContextSection /> },
  quota: { Body: () => <QuotaSection /> },
  todo: {
    Extra: () => <TodoCount />,
    resizable: true,
    isEmpty: (s) => !hasTaskTileContent(s),
    Body: () => <TodoSection />
  },
  queue: { Body: () => <QueueSection /> },
  files: { resizable: true, Body: () => <FileTree /> },
  ext: {
    isEmpty: (s) => Object.keys(s.statuses).length === 0 && Object.keys(s.widgets).length === 0,
    Body: () => <ExtSection />
  },
  log: {
    isEmpty: (s) => s.logs.length === 0,
    Extra: () => <LogCount />,
    resizable: true,
    Body: () => <LogSection />
  },
  actions: { Body: () => <ActionsSection /> }
}

/** 空判据只投影所需字段，消息正文不进入分区注册表。 */
type ToolPanelState = Pick<ReturnType<typeof useStore.getState>, 'todos' | 'goal' | 'messages' | 'logs' | 'statuses' | 'widgets' | 'subagents' | 'session'>
type ToolPanelProbe = Pick<ToolPanelState, 'todos' | 'goal' | 'logs' | 'statuses' | 'widgets'> & {
  hasMessageOutputs: boolean
  hasSubagents?: boolean
}

function toolPanelProbe(s: ToolPanelState): ToolPanelProbe {
  return {
    todos: s.todos,
    goal: s.goal,
    logs: s.logs,
    statuses: s.statuses,
    widgets: s.widgets,
    hasSubagents: hasVisibleSubagents(s),
    hasMessageOutputs: s.messages.some((message) =>
      !!message.artifacts?.length || (message.role === 'user' && !!message.images?.length)
    )
  }
}
