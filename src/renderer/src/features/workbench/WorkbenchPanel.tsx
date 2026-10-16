/**
 * 右侧工作区面板（P3 · R0 框架）。
 *
 * 职责边界：只做**面板框架与归属协调** —— 页签、响应式形态、按页签保活、
 * owner 切换时的显隐时序。真正建立/结束 PTY、导航原生浏览器、读文件或 diff
 * 都由 R1–R5 的叶子负责；本面板不替它们持有资源，也不另开 server / 复制状态机。
 *
 * 保活与上限：每个固定页签各只挂一个叶子实例，**按页签**而不是按 owner 挂载。
 * 切换 owner 时只把新的 owner 作为同一个 prop 传下去，不重挂组件、不新建资源；
 * 因此挂载实例数天然封顶为固定页签数，不会随会话切换复制出无限终端。
 *
 * 拆分与专注：拆分把面板上下分两格，每格一块页签（主格 / 下半格）；专注把所有
 * 位置让给当前页签一块，占满主区。两格不允许显示同一页签，规则在 `panel-layout.ts`。
 * 拆分与专注都只是版面状态，不改叶子的挂载：所有已访问页签仍各挂一份，非当前
 * 格子里的只隐藏。弹出独立窗口：控制器在 `main/windows/pane-popout-*`，页签能否弹出
 * 由 `shared/pane-popout.ts` 的矩阵判定（browser / terminal 走各自的 transfer 适配器），
 * 面板只把当前页签交给 `onPopout`；preview 仍不支持独立窗口，按钮保持禁用并标注
 * 未迁移，不画假可用。
 *
 * 惰性挂载：默认关闭时 `visited` 为空，**一个叶子都不挂**；首次 `open` 才登记
 * `activeTab`，之后关闭只隐藏、不注销已访问页签（终端 / 浏览器保活）。规则见
 * `mount-state.ts`。
 *
 * owner 切换时序：owner.key 变化时，布局阶段先把 `shownKey` 置空 —— 这一帧所有
 * 叶子都以 `visible=false` 渲染，原生视图（终端 / 浏览器）立即隐藏；下一帧再
 * 放行新 owner。避免「新 owner 的内容还没铺上、旧原生视图先露出来」。
 *
 * 预览归属：文件页签回传的路径按 `owner.key` 绑定（`preview-state.ts`），只把
 * 与当前叶子 owner 匹配的那条传给预览页签。owner 切换首帧 B 拿到的是 `undefined`
 * 而不是 A 的路径，不依赖异步 effect 去「稍后清空」。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactElement, type ReactNode } from 'react'
import { ArrowLeft, ExternalLink, FolderOpen, Globe, Maximize2, Minimize2, MoreHorizontal, Rows2, Terminal, X } from 'lucide-react'
import { Button, IconButton, Menu, MenuItem, MenuTrigger, Popover, Tab, TabList, Tabs } from '../../ui'
import { useI18n } from '../../i18n'
import { useUiV3 } from '../../state/ui-v3'
import { OverviewPane } from './OverviewPane'
import { workbenchText, type WorkbenchText } from './workbench-text'
import { emptyMountState, mountedTabs, nextVisited } from './mount-state'
import { bindPreviewPath, previewPathFor } from './preview-state'
import {
  cellForTab,
  extraVisibleTabs,
  nextSplitTab,
  resolvePanelLayout,
  splitTabOnPrimaryChange
} from './panel-layout'
import {
  WORKBENCH_ACTIVE_TABS,
  WORKBENCH_TABS,
  type WorkspaceOwner,
  type WorkbenchPaneComponents,
  type WorkbenchTabId
} from './types'
import './workbench.css'

/**
 * 面板可请求弹出的页签。
 *
 * DOM-only 页签里只有「上下文」有同步投影可直接推给弹出窗；文件 / 改动 / 分支各自走异步
 * hook，外壳拿不到同步受限快照，因此不向它们开放（按钮禁用并沿用「未迁移」提示），不去开
 * 一个没内容的空窗口。原生页签里 browser 走同视图改挂，terminal 由外壳按当前归属解析
 * terminalId 后交同 PTY 桥。
 */
const POPOUT_TABS: ReadonlySet<WorkbenchTabId> = new Set<WorkbenchTabId>(['context', 'browser', 'terminal'])

function canRequestPopout(tab: WorkbenchTabId): boolean {
  return POPOUT_TABS.has(tab)
}

interface TabStripProps {
  label: string
  selectedKey: string
  /** 面板是否展开：展开时（隐藏期间滚动无效）重新把选中页签滚进可视区 */
  open: boolean
  onSelect: (key: string) => void
  className?: string
  children: ReactNode
}

/**
 * 页签栏：`TabList` 本身横向可滚动，这里补两件事。
 *
 * 1. 两侧还有被遮住的页签时渐隐提示（`data-fade-*` 由滚动位置算出，CSS 决定渐隐宽度）；
 * 2. 选中项变化（含键盘移动、从别处切换、面板展开）时把它滚进可视区，选中的页签不会藏在视野外。
 */
function TabStrip({ label, selectedKey, open, onSelect, className, children }: TabStripProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ start: false, end: false })

  const stripEl = useCallback((): HTMLElement | null => ref.current?.querySelector<HTMLElement>('.wb-tablist') ?? null, [])

  const sync = useCallback((): void => {
    const el = stripEl()
    if (!el) return
    const max = el.scrollWidth - el.clientWidth
    const next = { start: el.scrollLeft > 1, end: max > 1 && el.scrollLeft < max - 1 }
    setEdges((prev) => (prev.start === next.start && prev.end === next.end ? prev : next))
  }, [stripEl])

  useLayoutEffect(() => {
    if (!open) return
    stripEl()?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
    sync()
  }, [selectedKey, open, stripEl, sync])

  useEffect(() => {
    const el = stripEl()
    if (!el) return
    el.addEventListener('scroll', sync, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync)
    observer?.observe(el)
    sync()
    return () => {
      el.removeEventListener('scroll', sync)
      observer?.disconnect()
    }
  }, [stripEl, sync])

  return (
    <div
      ref={ref}
      className={className ? `wb-tabstrip ${className}` : 'wb-tabstrip'}
      data-fade-start={edges.start ? '1' : '0'}
      data-fade-end={edges.end ? '1' : '0'}
    >
      <Tabs selectedKey={selectedKey} onSelectionChange={(key) => onSelect(String(key))}>
        <TabList aria-label={label} className="wb-tablist">
          {children}
        </TabList>
      </Tabs>
    </div>
  )
}

export interface WorkbenchPanelProps {
  /** 当前正式视图的归属；null = 还没有可归属的会话 */
  owner: WorkspaceOwner | null
  /** 面板是否展开；关闭时保留已挂载叶子，仅隐藏 */
  open: boolean
  /** 外壳算好的形态：宽屏固定列 / 中屏浮层 / 窄屏全宽 */
  mode: 'docked' | 'overlay' | 'full'
  /** R1–R5 组件注册表；缺省项显示「未接入」 */
  panes: WorkbenchPaneComponents
  onClose: () => void
  /**
   * 请求把当前视图在 pi 侧激活。外壳在调用前后钉住目标；返回 false 表示
   * 未就绪，面板只显示先激活提示。
   */
  onRequestActivation: (tab: WorkbenchTabId) => Promise<boolean>
  /** 文件页签选中预览时回传路径（供预览页签使用） */
  onPreview?: (path: string) => void
  /** 请求把当前页签弹出为独立窗口；仅 DOM-only 页签会调用。缺省时按钮禁用。 */
  onPopout?: (tab: WorkbenchTabId) => void
}

export function WorkbenchPanel({
  owner,
  open,
  mode,
  panes,
  onClose,
  onRequestActivation,
  onPreview,
  onPopout
}: WorkbenchPanelProps): ReactElement {
  const { lang } = useI18n()
  const text = useMemo(() => workbenchText(lang), [lang])
  const view = useUiV3((s) => s.workspaceTab)
  const setWorkspaceTab = useUiV3((s) => s.setWorkspaceTab)
  const isOverview = view === 'overview'
  /* 概览下不显示任何工具，但布局与挂载仍需一个工具页签：沿用最近停留的那一个。 */
  const lastToolRef = useRef<WorkbenchTabId>(view === 'overview' ? 'changes' : view)
  if (!isOverview) lastToolRef.current = view
  const activeTab = lastToolRef.current
  const split = useUiV3((s) => s.workspaceSplit)
  const splitTab = useUiV3((s) => s.workspaceSplitTab)
  const focus = useUiV3((s) => s.workspaceFocus)
  const setWorkspaceSplitTab = useUiV3((s) => s.setWorkspaceSplitTab)
  const toggleWorkspaceSplit = useUiV3((s) => s.toggleWorkspaceSplit)
  const setWorkspaceFocus = useUiV3((s) => s.setWorkspaceFocus)
  const toggleWorkspaceFocus = useUiV3((s) => s.toggleWorkspaceFocus)

  const layout = useMemo(
    () => resolvePanelLayout({ split, focus, activeTab, splitTab }),
    [split, focus, activeTab, splitTab]
  )

  /* 默认关闭时零挂载；首次 open 才登记当前页签与下半格，关闭后保留已访问页签（终端保活）。 */
  const [visited, setVisited] = useState<ReadonlySet<WorkbenchTabId>>(emptyMountState)
  const extraTabs = useMemo(() => extraVisibleTabs(layout), [layout.secondary])
  /* 概览不挂任何工具：只有停在工具视图时才登记（概览本身零资源）。 */
  useEffect(() => {
    setVisited((prev) => nextVisited(prev, { open: open && !isOverview, activeTab, extra: isOverview ? [] : extraTabs }))
  }, [open, isOverview, activeTab, extraTabs])

  /* 关闭面板就退出专注；下次打开仍是普通布局，不把上一屏的遮罩留回来。 */
  useEffect(() => {
    if (!open && focus) setWorkspaceFocus(false)
  }, [open, focus, setWorkspaceFocus])

  const mounted = useMemo(() => mountedTabs(visited), [visited])
  /* 下半格里的页签放进下格；其余（含已访问但当前未显示的）留在主格容器里，只隐藏。 */
  const primaryTabs = useMemo(() => mounted.filter((tab) => cellForTab(layout, tab) !== 'secondary'), [mounted, layout])
  const secondaryTabs = useMemo(() => mounted.filter((tab) => cellForTab(layout, tab) === 'secondary'), [mounted, layout])

  /* owner 切换：先隐藏旧原生视图，再展示新 owner */
  const ownerKey = owner?.key ?? null
  const [shownKey, setShownKey] = useState<string | null>(ownerKey)
  const prevKeyRef = useRef<string | null>(ownerKey)
  useLayoutEffect(() => {
    const next = owner?.key ?? null
    if (prevKeyRef.current === next) return
    setShownKey(null)
  }, [owner?.key])
  useEffect(() => {
    const next = owner?.key ?? null
    if (shownKey !== null || prevKeyRef.current === next) return
    prevKeyRef.current = next
    setShownKey(next)
  }, [owner?.key, shownKey])

  const [activating, setActivating] = useState(false)
  /* 预览路径按 owner.key 绑定：没有绑定的 owner 首帧就是 undefined。 */
  const [previewBindings, setPreviewBindings] = useState<ReadonlyMap<string, string>>(() => new Map())
  const ownerReady = ownerKey !== null && shownKey === ownerKey && !!owner

  /*
   * 已挂载叶子用的 owner：在 owner 切换的「先隐藏」那一帧仍是旧 owner，
   * 等新 owner 就绪后再换。这样不会在隐藏帧把叶子卸载，也不让它先拿到新归属。
   */
  const [displayOwner, setDisplayOwner] = useState<WorkspaceOwner | null>(owner)
  useEffect(() => {
    if (owner && ownerReady) setDisplayOwner(owner)
  }, [owner, ownerReady])

  const handlePreview = (path: string): void => {
    /* 绑给当前叶子真正持有的 owner（隐藏帧里是旧 owner），而不是已经在 prop 上变新的 owner。 */
    if (displayOwner) setPreviewBindings((prev) => bindPreviewPath(prev, displayOwner.key, path))
    setWorkspaceTab('preview')
    onPreview?.(path)
  }

  const attemptActivation = (tab: WorkbenchTabId): void => {
    if (activating) return
    setActivating(true)
    void onRequestActivation(tab).finally(() => setActivating(false))
  }

  const selectTab = (tab: WorkbenchTabId): void => {
    /* 主格选到下半格现有的页签时两格互换，避免两格撞同一页签。 */
    const swap = splitTabOnPrimaryChange({ split, splitTab, prevActive: activeTab, nextActive: tab })
    if (swap) setWorkspaceSplitTab(swap)
    setWorkspaceTab(tab)
    if (!owner || owner.active || !WORKBENCH_ACTIVE_TABS.has(tab)) return
    /* 用户明确点了需要激活的页签：就地请求一次，失败则停留并显示提示 */
    attemptActivation(tab)
  }

  const selectSecondary = (tab: WorkbenchTabId): void => {
    const next = nextSplitTab(splitTab, activeTab, tab)
    if (next) setWorkspaceSplitTab(next)
    if (!owner || owner.active || !WORKBENCH_ACTIVE_TABS.has(tab)) return
    attemptActivation(tab)
  }

  /* 一块页签的挂载位；同一页签只调一次，按所属格子决定可见性。 */
  const renderPane = (tab: WorkbenchTabId, cell: 'primary' | 'secondary', ownerForPane: WorkspaceOwner): ReactElement => (
    <PaneSlot
      key={tab}
      tab={tab}
      containerVisible={open && !isOverview && ownerReady && cellForTab(layout, tab) === cell}
      blocked={!ownerForPane.active && WORKBENCH_ACTIVE_TABS.has(tab)}
      owner={ownerForPane}
      panes={panes}
      text={text}
      previewPath={previewPathFor(previewBindings, ownerForPane.key)}
      activating={activating}
      onActivate={() => attemptActivation(tab)}
      onPreview={handlePreview}
    />
  )

  return (
    <section
      className="wb-panel"
      data-open={open ? '1' : '0'}
      data-mode={mode}
      data-focus={focus ? '1' : '0'}
      role="region"
      aria-label={text.title}
      hidden={!open}
    >
      <div className="wb-head">
        {isOverview ? (
          <span className="wb-head-title" data-testid="wb-overview-title">
            {text.overview.title}
          </span>
        ) : (
          <>
            <Button variant="ghost" size="sm" className="wb-back" aria-label={text.overview.backLabel} onPress={() => setWorkspaceTab('overview')} data-testid="wb-back">
              <ArrowLeft size={14} aria-hidden />
              <span>{text.overview.back}</span>
            </Button>
            <TabStrip label={text.title} selectedKey={view} open={open} onSelect={(key) => selectTab(key as WorkbenchTabId)}>
              {WORKBENCH_TABS.filter((tab) => tab === view || visited.has(tab)).map((tab) => (
                <Tab key={tab} id={tab} className="wb-tab" data-testid={`wb-tab-${tab}`}>
                  {text.tabs[tab]}
                </Tab>
              ))}
            </TabStrip>
          </>
        )}
        <div className="wb-actions">
          {isOverview ? (
            <>
              <IconButton aria-label={text.tabs.terminal} title={text.tabs.terminal} data-testid="wb-open-terminal" onPress={() => selectTab('terminal')}>
                <Terminal size={15} />
              </IconButton>
              <IconButton aria-label={text.tabs.files} title={text.tabs.files} data-testid="wb-open-files" onPress={() => selectTab('files')}>
                <FolderOpen size={15} />
              </IconButton>
              <IconButton aria-label={text.tabs.browser} title={text.tabs.browser} data-testid="wb-open-browser" onPress={() => selectTab('browser')}>
                <Globe size={15} />
              </IconButton>
              <MenuTrigger>
                <IconButton aria-label={text.overview.moreTools} title={text.overview.moreTools} data-testid="wb-more-tools">
                  <MoreHorizontal size={15} />
                </IconButton>
                <Popover placement="bottom end" offset={6}>
                  <Menu aria-label={text.overview.moreTools} className="wb-more-menu" data-testid="wb-more-menu">
                    {(['changes', 'preview', 'logs', 'branch'] as const).map((tab) => (
                      <MenuItem key={tab} id={tab} textValue={text.tabs[tab]} onAction={() => selectTab(tab)}>
                        {text.tabs[tab]}
                      </MenuItem>
                    ))}
                  </Menu>
                </Popover>
              </MenuTrigger>
            </>
          ) : (
            <>
              <IconButton
                aria-label={split ? text.unsplit : text.split}
                title={split ? text.unsplit : text.split}
                isDisabled={focus}
                data-active={split ? '1' : '0'}
                data-testid="wb-split"
                onPress={toggleWorkspaceSplit}
              >
                <Rows2 size={15} />
              </IconButton>
              <IconButton
                aria-label={focus ? text.unfocus : text.focus}
                title={focus ? text.unfocus : text.focus}
                data-active={focus ? '1' : '0'}
                data-testid="wb-focus"
                onPress={toggleWorkspaceFocus}
              >
                {focus ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              </IconButton>
              <IconButton
                aria-label={canRequestPopout(activeTab) ? text.popout : `${text.popout}（${text.unmigrated}）`}
                title={canRequestPopout(activeTab) ? text.popout : `${text.popout} · ${text.unmigrated}`}
                isDisabled={!canRequestPopout(activeTab) || !onPopout}
                data-testid="wb-popout"
                onPress={() => onPopout?.(activeTab)}
              >
                <ExternalLink size={15} />
              </IconButton>
            </>
          )}
          <IconButton aria-label={text.close} onPress={onClose} data-testid="wb-close" className="wb-close">
            <X size={15} />
          </IconButton>
        </div>
      </div>

      <div className="wb-body">
        {isOverview ? (
          <OverviewPane owner={owner} onOpenView={selectTab} onPreview={handlePreview} />
        ) : null}
        {/* 工具视图的挂载位始终保留在 DOM 里（只隐藏），资源不随切到概览而卸载。 */}
        <div className="wb-view" hidden={isOverview}>
        {displayOwner ? (
          <div className="wb-cells" data-split={layout.secondary ? '1' : '0'}>
            <div className="wb-cell">
              <div className="wb-panes">{primaryTabs.map((tab) => renderPane(tab, 'primary', displayOwner))}</div>
            </div>
            {layout.secondary ? (
              <div className="wb-cell wb-cell-secondary" data-testid="wb-split-secondary">
                <div className="wb-cell-head">
                  <TabStrip
                    label={text.secondaryPane}
                    selectedKey={layout.secondary}
                    open={open}
                    onSelect={(key) => selectSecondary(key as WorkbenchTabId)}
                  >
                    {WORKBENCH_TABS.map((tab) => (
                      <Tab
                        key={tab}
                        id={tab}
                        className="wb-tab"
                        isDisabled={tab === layout.primary}
                        data-testid={`wb-split-tab-${tab}`}
                      >
                        {text.tabs[tab]}
                      </Tab>
                    ))}
                  </TabStrip>
                </div>
                <div className="wb-panes">
                  {secondaryTabs.map((tab) => renderPane(tab, 'secondary', displayOwner))}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="wb-empty" data-testid="wb-empty">
            {text.inactiveTitle}
          </div>
        )}
        </div>
      </div>
    </section>
  )
}

/** 各叶子共有的最小 props 形状；具体契约见 types.ts。 */
interface LeafProps {
  owner: WorkspaceOwner
  visible?: boolean
  onPreview?: (path: string) => void
  path?: string
}

interface PaneSlotProps {
  tab: WorkbenchTabId
  /** 容器是否显示：面板打开且这是当前页签 */
  containerVisible: boolean
  /** 需要激活但会话未激活：叶子收到 visible=false 且盖上提示 */
  blocked: boolean
  owner: WorkspaceOwner
  panes: WorkbenchPaneComponents
  text: WorkbenchText
  previewPath?: string
  activating: boolean
  onActivate: () => void
  onPreview?: (path: string) => void
}

/**
 * 单个页签的挂载位。每个页签一个实例；owner / visible / 所属格子只作为 prop 变化，
 * 不改变 React key，避免切换页签、拆分或 owner 时 remount。
 */
function PaneSlot({ tab, containerVisible, blocked, owner, panes, text, previewPath, activating, onActivate, onPreview }: PaneSlotProps): ReactElement {
  const Body = panes[tab] as ComponentType<LeafProps> | undefined
  const leafVisible = containerVisible && !blocked
  return (
    <div className="wb-pane" data-tab={tab} data-visible={containerVisible ? '1' : '0'} hidden={!containerVisible} data-testid={`wb-pane-${tab}`}>
      {Body ? <Body owner={owner} visible={leafVisible} onPreview={onPreview} path={previewPath} /> : (
        <div className="wb-nowire">
          <p className="wb-nowire-title">{text.notWired}</p>
          <p className="wb-nowire-hint">{text.notWiredHint}</p>
        </div>
      )}
      {blocked ? (
        <div className="wb-pane-block">
          <p>{text.activateHint}</p>
          <button type="button" onClick={onActivate} disabled={activating} data-testid="wb-pane-activate">
            {text.activate}
          </button>
        </div>
      ) : null}
    </div>
  )
}
