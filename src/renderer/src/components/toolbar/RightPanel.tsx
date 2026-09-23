import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import type { MessageKey } from '../../i18n'
import { Section } from './ToolSection'
import { useStore } from '../../state/store'
import {
  compactionGrowthText,
  compactionReclaimText,
  compactionRunningText,
  compactionSummary,
  compactionTokensText,
  compactionTone
} from '../../state/compaction-view'
import { CONTEXT_STAGES, contextStageLabel, contextStageTip, nextContextStageText } from '../../state/context-view'
import { nextContextStage, LARGE_PRESET_NAME_KEYS, largePresetOf } from '../../../../shared/context-policy'
import { quotaTone } from '../../../../shared/quota-tone'
import { TOOL_SECTIONS, type CompactionInfo, type QueueMode, type QuotaWindow, type ToolSectionId } from '../../../../shared/ipc'
import { HandleProvider } from './ToolSection'
import { ToolLibrary } from './ToolLibrary'
import { FileTree } from './FileTree'
import { Resizer } from './Resizer'
import { BrowserSurface } from '../browser/BrowserSurface'
import { FilePreviewPane } from './FilePreview'
import { ReviewPanel } from '../review/ReviewPanel'
import { SubagentList } from '../chat/SubagentList'
import { GoalSection } from './GoalSection'
import {
  activateWorkbenchTab,
  closeWorkbenchTab,
  loadWorkbenchState,
  saveWorkbenchState,
  viewFromWorkbench,
  workbenchSessionKey,
  type WorkbenchState,
  type WorkbenchView
} from '../../state/workbench'

type RightWindowView = Exclude<WorkbenchView, 'subagent'>

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
  const order = useStore((s) => s.settings?.toolOrder)
  const hidden = useStore((s) => s.settings?.toolHidden)
  const setToolLayout = useStore((s) => s.setToolLayout)
  const browserOpen = useStore((s) => s.browserState.open)
  /** 只读文件预览：与浏览器详情占同一块区域（方案 5.2） */
  const filePreview = useStore((s) => s.filePreview)
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
  const session = useStore((s) => s.session)
  const workbenchKey = workbenchSessionKey(session?.conversationFile ?? session?.sessionFile, session?.conversationId ?? session?.sessionId)
  const [workbench, setWorkbench] = useState<WorkbenchState>(() => loadWorkbenchState(workbenchKey))
  const [libOpen, setLibOpen] = useState(false)
  const [quickMenuOpen, setQuickMenuOpen] = useState(false)
  const [windowView, setWindowView] = useState<RightWindowView>(() => {
    const initial = loadWorkbenchState(workbenchKey)
    const available = new Set<WorkbenchView>(['tools', ...(reviewOpen ? ['review' as const] : []), ...(filePreview ? ['file' as const] : []), ...(browserOpen ? ['browser' as const] : [])])
    return viewFromWorkbench(initial, available) as RightWindowView
  })

  /* 工作窗口按稳定会话文件隔离；切会话只恢复布局，不复制会话正文或资源凭证。 */
  useEffect(() => {
    const next = loadWorkbenchState(workbenchKey)
    setWorkbench(next)
    const available = new Set<WorkbenchView>(['tools', ...(reviewOpen ? ['review' as const] : []), ...(filePreview ? ['file' as const] : []), ...(browserOpen ? ['browser' as const] : [])])
    setWindowView(viewFromWorkbench(next, available) as RightWindowView)
    setLibOpen(false)
    setQuickMenuOpen(false)
  }, [workbenchKey])

  useEffect(() => {
    saveWorkbenchState(workbenchKey, workbench)
  }, [workbenchKey, workbench])

  const activateWindow = (next: RightWindowView): void => {
    setWindowView(next)
    setWorkbench((current) => activateWorkbenchTab(current, next))
  }

  /*
   * 空判据需要的几个字段分别选出来（选对象会让 zustand 每帧返回新引用 → 无限重渲染）。
   * 有了它们才能算出**真正会渲染出来的**分区列表 —— 这一步很关键：
   * 排序的 index/total 必须按「可见分区」算，否则交换的是两个看不见的分区，
   * 界面完全没反应（实测踩过：todo/ext 为空时不渲染，但 order 里还算着它们）。
   */
  const todos = useStore((s) => s.todos)
  const logs = useStore((s) => s.logs)
  const statuses = useStore((s) => s.statuses)
  const widgets = useStore((s) => s.widgets)

  /**
   * 完整顺序（含当前不可见的）：设置里的顺序规范化到 7 项。
   * 排序操作在**它**上面做 —— 这样「因空而不显示」的分区不会被挤到末尾。
   */
  const fullOrder = useMemo<ToolSectionId[]>(() => {
    const saved = order?.length ? order : [...TOOL_SECTIONS]
    const known = new Set<string>(TOOL_SECTIONS)
    const out = saved.filter((x): x is ToolSectionId => known.has(x))
    for (const id of TOOL_SECTIONS) if (!out.includes(id)) out.push(id)
    return out
  }, [order])

  /** 实际渲染出来的（再减去收进库的与内容为空的） */
  const visible = useMemo<ToolSectionId[]>(() => {
    const hiddenSet = new Set(hidden ?? [])
    const state = { todos, logs, statuses, widgets }
    return fullOrder.filter((id) => {
      if (hiddenSet.has(id)) return false
      const isEmpty = SECTION_REGISTRY[id].isEmpty
      return isEmpty ? !isEmpty(state) : true
    })
  }, [fullOrder, hidden, todos, logs, statuses, widgets])

  /**
   * 把 `id` 移到 `targetId` 的前/后（在**完整顺序**上操作）。
   * 集中在这里做：键盘与拖拽只是「目标是谁、放前还是放后」不同，
   * 移动算法不该写两遍。
   */
  const move = useCallback(
    (id: ToolSectionId, targetId: ToolSectionId, after: boolean) => {
      if (id === targetId) return
      const next = fullOrder.filter((x) => x !== id)
      const at = next.indexOf(targetId)
      if (at < 0) return
      next.splice(after ? at + 1 : at, 0, id)
      void setToolLayout({ toolOrder: next })
    },
    [fullOrder, setToolLayout]
  )


  /** 右栏自身：工具菜单的外点关闭需要从它里面判断命中。 */
  const asideRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!quickMenuOpen) return undefined
    const close = (event: MouseEvent): void => {
      if (event.target instanceof Node && asideRef.current?.contains(event.target)) return
      setQuickMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [quickMenuOpen])

  /* 外部入口打开浏览器/文件/审查时，把窗口切到对应标签。资源本身不随切页销毁。 */
  const previousBrowserOpen = useRef(browserOpen)
  const previousReviewOpen = useRef(reviewOpen)
  const previousFilePreview = useRef(!!filePreview)
  useEffect(() => {
    if (filePreview && !open) void setRightPanelOpen(true)
  }, [filePreview, open, setRightPanelOpen])

  useEffect(() => {
    const opened = browserOpen && !previousBrowserOpen.current
    const reviewOpened = reviewOpen && !previousReviewOpen.current
    const fileOpened = !!filePreview && !previousFilePreview.current
    previousBrowserOpen.current = browserOpen
    previousReviewOpen.current = reviewOpen
    previousFilePreview.current = !!filePreview
    setWindowView((current) => {
      const next = reviewOpened
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
      if (next !== current) setWorkbench((state) => activateWorkbenchTab(state, next))
      return next
    })
  }, [browserOpen, filePreview, reviewOpen])

  const switchWindow = (next: RightWindowView): void => {
    setQuickMenuOpen(false)
    activateWindow(next)

    if (next === 'tools') {
      /* 切页只是隐藏当前资源；关闭标签才释放浏览器 / 预览。 */
      if (browserOpen) void window.yan.browser.setVisible(false)
      return
    }

    if (next === 'review') {
      if (browserOpen) void window.yan.browser.setVisible(false)
      openReview()
      return
    }

    if (next === 'browser') {
      if (browserOpen) void window.yan.browser.setVisible(true)
      else {
        void openBrowser().then(() => {
          /* 打开失败时没有 browserState 事件，不能把右栏永远留在空的 browser tab。 */
          if (!useStore.getState().browserState.open) {
            setWindowView((current) => current === 'browser' ? 'tools' : current)
            setWorkbench((state) => closeWorkbenchTab(state, 'browser'))
          }
        })
      }
      return
    }

    /* 文件窗口没有原生视图，文件树和文件预览共用这个表面。 */
    if (browserOpen) {
      void window.yan.browser.setVisible(false)
    }
    if (!open) void setRightPanelOpen(true)
  }

  const closeWindow = (which: Exclude<RightWindowView, 'tools'>): void => {
    setQuickMenuOpen(false)
    if (which === 'review') {
      closeReview()
      const next = browserOpen ? 'browser' : filePreview ? 'file' : 'tools'
      activateWindow(next)
      setWorkbench((state) => closeWorkbenchTab(state, 'review'))
      if (browserOpen && !filePreview) void window.yan.browser.setVisible(true)
    } else if (which === 'browser') {
      activateWindow('tools')
      setWorkbench((state) => closeWorkbenchTab(state, 'browser'))
      void closeBrowser()
    } else {
      closePreview()
      activateWindow('tools')
      setWorkbench((state) => closeWorkbenchTab(state, 'file'))
      if (browserOpen) void window.yan.browser.setVisible(false)
    }
  }

  const activeView: RightWindowView = windowView
  const reviewMode = activeView === 'review' && reviewOpen
  const browserMode = activeView === 'browser' && browserOpen
  const fileMode = activeView === 'file'
  const toolsMode = activeView === 'tools' && open
  /* 异步打开浏览器的瞬间仍保留面板；否则 activeView 切过去后组件会卸载，
     本地 windowView 又回到 tools，最终表现就是点击“＋”没有反应。 */
  const pendingSurface = (activeView === 'browser' && !browserOpen) || (activeView === 'review' && !reviewOpen)
  const hasVisibleSurface = reviewMode || browserMode || fileMode || toolsMode || pendingSurface

  /* 原生网页的显隐只有一个协调点；切标签不等于销毁网页资源。 */
  useEffect(() => {
    if (!browserOpen) return
    void window.yan.browser.setVisible(activeView === 'browser')
  }, [activeView, browserOpen])

  /* 浏览器收起工具栏时不再保留一行空标签，让原生网页占满右列。 */
  if (!hasVisibleSurface) return null

  const showWindowBar = !browserMode || open

  return (
    <aside
      ref={asideRef}
      className={`rightpanel right-window-panel window-${activeView} ${browserMode ? 'browser-mode' : ''} ${fileMode && filePreview ? 'file-preview-mode' : ''} ${!open && browserMode ? 'tools-collapsed' : ''} ${reviewMode ? 'review-mode' : ''}`}
      data-testid="rightpanel"
    >
      {/*
       * 宽度把手放在 aside **内部**并绝对定位。
       * 不能作为 .workspace 的 grid 子元素 —— 那会多出一列，
       * grid-template-columns 只有三列的定义（本项目的列宽踩过坑，见 redesign.css §23b）。
      */}
      <Resizer side="panel" />

      {showWindowBar ? (
        <div
          className={`review-tabbar rp-windowbar ${activeView === 'tools' ? 'rp-top' : ''}`}
          role="tablist"
          aria-label="右栏窗口"
          data-testid="right-window-tabs"
        >
          <div
            className={`review-tab rp-window-tab ${activeView === 'tools' ? 'active' : ''}`}
            role="tab"
            aria-selected={activeView === 'tools'}
            data-testid="right-window-tab-tools"
            onClick={() => switchWindow('tools')}
          >
            <Icon name="layers" size={12} />
            <span className="rp-title">{t('rp.title')}</span>
          </div>

          {reviewOpen ? (
            <div
              className={`review-tab rp-window-tab ${activeView === 'review' ? 'active' : ''}`}
              role="tab"
              aria-selected={activeView === 'review'}
              data-testid="review-tab"
              onClick={() => switchWindow('review')}
            >
              <Icon name="check-circle" size={12} />
              <span>审查</span>
              <button
                type="button"
                className="review-tab-close"
                onClick={(event) => { event.stopPropagation(); closeWindow('review') }}
                aria-label={t('review.close')}
                title={t('review.close')}
              >×</button>
            </div>
          ) : null}

          {browserOpen ? (
            <div
              className={`review-tab rp-window-tab ${activeView === 'browser' ? 'active' : ''}`}
              role="tab"
              aria-selected={activeView === 'browser'}
              data-testid="right-window-tab-browser"
              onClick={() => switchWindow('browser')}
            >
              <Icon name="globe" size={12} />
              <span>浏览器</span>
              <button
                type="button"
                className="review-tab-close"
                onClick={(event) => { event.stopPropagation(); closeWindow('browser') }}
                aria-label="关闭浏览器"
                title="关闭浏览器"
              >×</button>
            </div>
          ) : null}

          {activeView === 'file' || filePreview ? (
            <div
              className={`review-tab rp-window-tab ${activeView === 'file' ? 'active' : ''}`}
              role="tab"
              aria-selected={activeView === 'file'}
              data-testid="right-window-tab-file"
              onClick={() => switchWindow('file')}
            >
              <Icon name="folder" size={12} />
              <span>文件</span>
              <button
                type="button"
                className="review-tab-close"
                onClick={(event) => { event.stopPropagation(); closeWindow('file') }}
                aria-label="关闭文件窗口"
                title="关闭文件窗口"
              >×</button>
            </div>
          ) : null}

          <span className="spacer" />

          <div className="rp-tool-launcher-wrap">
            <button
              className={`review-tab-plus rp-window-plus rp-tool-launcher ${quickMenuOpen ? 'on' : ''}`}
              type="button"
              title="打开工作区工具"
              aria-label="打开工作区工具"
              aria-expanded={quickMenuOpen}
              data-testid="right-tool-menu"
              onClick={() => setQuickMenuOpen((value) => !value)}
            >＋</button>
            {quickMenuOpen ? (
              <div className="rp-tool-menu" role="menu" data-testid="right-tool-menu-popover">
                <button type="button" className="rp-tool-menu-item" role="menuitem" onClick={() => switchWindow('review')}>
                  <Icon name="check-circle" size={12} />
                  <span>审查</span>
                  <kbd>Ctrl+Shift+G</kbd>
                </button>
                <button type="button" className="rp-tool-menu-item" role="menuitem" disabled title="终端面板尚未接入">
                  <Icon name="activity" size={12} />
                  <span>终端</span>
                  <kbd>Ctrl+`</kbd>
                </button>
                <button type="button" className="rp-tool-menu-item" role="menuitem" onClick={() => switchWindow('browser')}>
                  <Icon name="globe" size={12} />
                  <span>浏览器</span>
                  <kbd>Ctrl+T</kbd>
                </button>
                <button type="button" className="rp-tool-menu-item" role="menuitem" onClick={() => switchWindow('file')}>
                  <Icon name="folder" size={12} />
                  <span>文件</span>
                  <kbd>Ctrl+P</kbd>
                </button>
              </div>
            ) : null}
          </div>

          {activeView === 'tools' ? (
            <button
              className={`rp-x ${libOpen ? 'on' : ''}`}
              onClick={() => setLibOpen((v) => !v)}
              title={t('tl.open')}
              data-testid="tool-lib-btn"
              aria-expanded={libOpen}
            >
              <Icon name="layers" size={12} />
            </button>
          ) : null}
        </div>
      ) : null}

      {toolsMode && libOpen ? <ToolLibrary onClose={() => setLibOpen(false)} /> : null}

      {reviewMode ? <ReviewPanel /> : null}
      {browserMode ? <BrowserSurface /> : null}
      {pendingSurface ? (
        <div className="rp-pending-surface" data-testid="right-window-pending">
          {activeView === 'browser' ? '正在打开浏览器…' : '正在打开审查…'}
        </div>
      ) : null}
      {toolsMode || (fileMode && open) ? (
        <div className="rp-body" data-testid="rp-body">
          {toolsMode ? <GoalSection /> : null}
          {toolsMode ? <SubagentList placement="right" /> : null}
          {fileMode && filePreview ? <FilePreviewPane /> : null}
          {visible.map((id, i) => (
            <SectionSlot
              key={id}
            id={id}
            index={i}
            total={visible.length}
            /* 键盘用：下一个/上一个**可见**邻居 */
            prevId={visible[i - 1]}
            nextId={visible[i + 1]}
            onMove={move}
          />
        ))}
        </div>
      ) : null}
    </aside>
  )
}

/* 分区插槽 —— 把「注册表 + 排序」与各分区自己的渲染分开 */

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
  onMove
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
}) {
  const t = useT()
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
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
  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
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
    document.body.classList.add('reordering')
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* 拿不到 capture 也能拖 —— 只是指针移出把手后会断流 */
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>): void => {
    if (!dragging) return
    /*
     * 找「指针现在落在哪个分区上、在它的上半还是下半」。
     *
     * ⚠️ 用 `.rp-slot` 上的 data-tool-id（**不带 rp- 前缀的原始 id**）来比，
     *    不能读 `.rp-sec` 的 data-sec（那是 `rp-queue` 这种 testid 形态）——
     *    顺序数组里存的是 `queue`，拿 testid 去 indexOf 会得到 -1，
     *    于是整个拖放静默失效（实测就错在这里）。
     */
    const others = [...document.querySelectorAll('.rp-body > .rp-slot')] as HTMLElement[]
    for (const el of others) {
      const r = el.getBoundingClientRect()
      if (e.clientY >= r.top && e.clientY <= r.bottom) {
        const id2 = el.dataset.toolId as ToolSectionId | undefined
        if (!id2 || id2 === id) {
          setToolDropTarget(null)
          return
        }
        setToolDropTarget({ id: id2, after: e.clientY >= r.top + r.height / 2 })
        return
      }
    }
    setToolDropTarget(null)
  }

  const finish = (e: React.PointerEvent<HTMLButtonElement>): void => {
    if (!dragging) return
    setDragging(false)
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
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.rp-slot') as HTMLElement | null
    const drop = useStore.getState().toolDropTarget
    const targetId = (target?.dataset.toolId ?? drop?.id) as ToolSectionId | undefined
    setToolDropTarget(null)
    if (!targetId || targetId === id) return

    // 放在目标之前还是之后：优先使用落点所在盒子的几何位置，回退到 pointermove 记录。
    const r = target?.getBoundingClientRect()
    const after = r ? e.clientY > r.top + r.height / 2 : !!drop?.after
    onMove(id, targetId, after)
  }

  /**
   * 键盘调顺序（把手聚焦后 Alt+↑↓）。
   * 与**可见**邻居交换 —— 不是数组里的相邻项（中间可能夹着不可见的分区，
   * 那样按一下会「没反应」）。
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
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
    ref.current?.querySelector('.rp-fs, .rp-log, .rp-todos') as HTMLElement | null

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
  const isEmpty = useStore((s) =>
    SECTION_REGISTRY[id].isEmpty ? SECTION_REGISTRY[id].isEmpty!(s) : false
  )
  if (isEmpty) return null

  return (
    <div
      className={`rp-slot ${dragging ? 'dragging' : ''}`}
      data-tool-id={id}
      data-over={dropTarget?.id === id ? (dropTarget.after ? 'after' : 'before') : ''}
      ref={ref}
    >
      <HandleProvider
        value={
          <button
            className="rp-grip"
            title={t('rp.dragHint')}
            aria-label={t('rp.dragHint')}
            tabIndex={0}
            data-testid={`grip-${id}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={finish}
            onPointerCancel={finish}
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

/** 每个分区自己的内容与头部声明（与 SectionFrame 分开，避免把顺序逻辑重复七遍） */
const SECTION_REGISTRY: Record<
  ToolSectionId,
  {
    /** 这个分区自己的内容 */
    Body: () => React.ReactElement | null
    /** 头部右侧的附加信息（如任务的 2/4、日志行数） */
    Extra?: () => React.ReactElement | null
    /** 返回 true 则整个分区不渲染（而不是渲染一个空的） */
    isEmpty?: (s: ToolPanelState) => boolean
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
    isEmpty: (s) => s.todos.length === 0,
    Extra: () => <TodoCount />,
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

/** 注册表的 isEmpty 只读这几个字段（从 store 里抳型，避免写 any） */
type ToolPanelState = Pick<ReturnType<typeof useStore.getState>, 'todos' | 'logs' | 'statuses' | 'widgets'>

/** 任务完成数 / 总数（放在分区头部，不进 body） */
function TodoCount() {
  const todos = useStore((s) => s.todos)
  const done = todos.filter((x) => x.done).length
  return (
    <span className="rp-count" data-testid="todo-count">
      {done}/{todos.length}
    </span>
  )
}

/** 日志行数 */
function LogCount() {
  const n = useStore((s) => s.logs.length)
  return (
    <span className="rp-count" data-testid="log-count">
      {n}
    </span>
  )
}

/* 一个可折叠的小分区 —— 右栏所有块共用 */

/* 上下文 —— 用多少 / 占多少 / 花了多少 */

function QuotaSection() {
  const t = useT()
  const provider = useStore((s) => s.session?.model?.provider ?? '')
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)
  const budget = settings?.providerBudgets?.[provider]
  const [quota, setQuota] = useState<Awaited<ReturnType<typeof window.yan.providerQuota>> | null>(null)
  const [loading, setLoading] = useState(false)
  /** 查询失败时的错误；**不**清掉 quota —— 保留上一次成功的快照（方案 7.2） */
  const [error, setError] = useState('')
  /** 当前请求属于哪个 provider：切账户后旧请求的返回不能覆盖新视图 */
  const providerRef = useRef(provider)
  /** 倒计时刷新用（重置时间要以“现在”为基准） */
  const [, setTick] = useState(0)

  const refresh = useCallback(async () => {
    if (!provider) return
    providerRef.current = provider
    setLoading(true)
    try {
      const next = await window.yan.providerQuota(provider, budget)
      /* 用户已经切到别的供应商了 —— 这个结果作废 */
      if (providerRef.current !== provider) return
      const hasData =
        !!next.windows?.length || next.remaining !== undefined || next.used !== undefined
      if (next.error && !hasData) {
        setError(next.error)
      } else {
        setQuota(next)
        setError(next.error ?? '')
      }
    } catch (e) {
      if (providerRef.current === provider) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (providerRef.current === provider) setLoading(false)
    }
  }, [provider, budget])

  /* 切 provider 时清空旧账户的数字（不能把上一个账户的额度留在屏幕上） */
  useEffect(() => {
    providerRef.current = provider
    setQuota(null)
    setError('')
    void refresh()
  }, [refresh, provider])

  /* 倒计时每分钟重算；到点后自动重新查询（不本地归零） */
  useEffect(() => {
    const id = setInterval(() => setTick((v) => v + 1), 30_000)
    return () => clearInterval(id)
  }, [])
  useEffect(() => {
    const wins = quota?.windows ?? []
    if (!wins.length) return
    const now = Date.now()
    const due = wins.some((w) => w.resetAt !== undefined && w.resetAt <= now && !w.exceeded)
    if (due) void refresh()
  }, [quota, refresh])
  /**
   * 百分比口径（ChatGPT 订阅的用量接口只给 used_percent）。
   * 用 PERCENT 这个伪币种传递 —— 它不能走 money()，否则会显示成 “$28.00”。
   */
  const isPercent = (quota?.currency ?? '').toUpperCase() === 'PERCENT'
  /* 一位小数：方案 7.2 的示例写的是「已用 25.0%」，整数会丢掉小额度区间的变化 */
  const pctText = (v: number): string => `${v.toFixed(1)}%`
  /*
   * 余额行只写一个数字 + 一个单位，不要 `$` / 币种混排。
   * 为什么单独一个函数：DeepSeek 的余额可能是 CNY（¥9.92），
   * 之前只认 USD，非 USD 会显示成 “9.92 CNY”，与右侧其它数值对不齐。
   */
  const money = (v: number, cur?: string): string => {
    const code = (cur ?? 'USD').toUpperCase()
    if (code === 'PERCENT') return pctText(v)
    const sym = CURRENCY_SYMBOL[code]
    return sym ? `${sym}${v.toFixed(2)}` : `${v.toFixed(2)} ${code}`
  }
  /**
   * 主值口径（方案 7.2）：
   *   · 有分窗口（commandcode / codex）→ **本月已用**（不是最紧窗口的已用）
   *   · 其它供应商（deepseek 余额 / openrouter 信用）→ 沿用原有语义
   */
  const hasWindows = !!quota?.windows?.length
  const anyExceeded = !!quota?.windows?.some((w) => w.exceeded)
  /*
   * 主值着色沿用窗口那一套阈值（quotaTone：<70% 绿 / 70–95% 黄 / ≥95% 红）。
   * 以前主值只在「已超限」时变红 —— 结果 95% 的窗口红着、主值还是黑的，
   * 看着像「还没到线」，与窗口自相矛盾。
   * 没有 used/total 的口径（例如 DeepSeek 的余额）拿不到使用率，就不着色。
   */
  const mainPct =
    quota?.used !== undefined && quota.total !== undefined && quota.total > 0
      ? (quota.used / quota.total) * 100
      : undefined
  const mainTone = mainPct === undefined ? '' : quotaTone(mainPct, anyExceeded)
  const mainText = !quota
    ? null
    : hasWindows || isPercent
      ? quota.used !== undefined
        ? money(quota.used, quota.currency)
        : null
      : quota.remaining !== undefined
        ? money(quota.remaining, quota.currency)
        : quota.used !== undefined
          ? money(quota.used, quota.currency)
          : null
  const mainLabel = quota?.label ?? (hasWindows ? t('quota.usedMain') : t('quota.remaining'))
  return (
    <Section titleKey="rp.quota" testId="rp-quota">
      {/* 标题区：供应商 + 刷新（方案 7.2：刷新放标题区） */}
      <div className="rp-kv">
        <span className="rp-k">{provider || '—'}</span>
        <span className="spacer" />
        <button className="rp-btn" onClick={() => void refresh()} disabled={loading} data-testid="quota-refresh">
          {loading ? '…' : t('quota.refresh')}
        </button>
      </div>

      {/* 主值：本月已用（有分窗口时）—— 不再取“最紧窗口”的 used */}
      {mainText ? (
        <div className="rp-quota-main" data-testid="quota-main">
          <span className="rp-quota-main-label">{mainLabel}</span>
          <span className={`rp-v big ${mainTone}`} data-testid="quota-main-value">
            {mainText}
          </span>
        </div>
      ) : null}

      {quota?.error ? (
        <div className="rp-dim" data-testid="quota-error">
          {quota.supported ? quota.error : t('quota.unsupported')}
        </div>
      ) : null}
      {/* 查询失败时保留旧快照，但必须说清它是什么时候的（方案 7.2） */}
      {error && !quota?.error ? (
        <div className="rp-dim" data-testid="quota-error">
          {t('quota.stale', { msg: error })}
        </div>
      ) : null}
      {quota ? (
        <div className="rp-dim" data-testid="quota-checked">
          {t('quota.checkedAt', { time: new Date(quota.checkedAt).toLocaleTimeString() })}
        </div>
      ) : null}

      {quota?.windows?.length ? (
        <div className="rp-quota-wins">
          {quota.windows.map((w) => {
            /* 真实比例（可能 > 100%，方案要求如实显示） */
            const realPct = w.total > 0 ? (w.used / w.total) * 100 : 0
            /* 进度条只夹取宽度，不改数字 */
            const barPct = Math.min(100, Math.max(0, realPct))
            const left = Math.max(0, w.total - w.used)
            /*
             * 颜色分级：<70% 绿 / 70–95% 黄 / ≥95% 红（口径见 shared/quota-tone.ts）。
             * exceeded（供应商报的已超限）恒红，不受百分比影响。
             */
            const tone = quotaTone(realPct, w.exceeded)
            const reset = resetText(w)
            return (
              <div key={w.id} className="rp-quota-win" data-testid={`quota-win-${w.id}`}>
                <div className="rp-kv">
                  <span className="rp-k">{w.label}</span>
                  {/* 推算值必须标明来源，不能伪装成官方额度 */}
                  {w.estimated ? (
                    <span
                      className="rp-quota-est"
                      title={t('quota.estimatedTip')}
                      data-testid={`quota-win-${w.id}-estimated`}
                    >
                      {t('quota.estimated')}
                    </span>
                  ) : null}
                  <span className="spacer" />
                  <span
                    /*
                     * 三档都要落到类名上：以前 ok 档被写成空字符串，于是「低用量」
                     * 用的是 .rp-v 的默认色（--fg-dim 灰）—— 而用户要的是**绿色**。
                     */
                    className={`rp-v ${tone}`}
                    data-testid={`quota-win-${w.id}-pct`}
                  >
                    {t('quota.usedInline', { pct: realPct.toFixed(1) })}
                  </span>
                </div>
                <div className="rp-kv">
                  <span className="rp-u" data-testid={`quota-win-${w.id}-amount`}>
                    {money(w.used, quota.currency)} / {t('quota.remainingShort')} {money(left, quota.currency)}
                  </span>
                  <span className="spacer" />
                </div>
                <div className={`rp-meter ${tone}`} title={reset || undefined}>
                  <i style={{ width: `${barPct}%` }} />
                </div>
                {w.exceeded ? (
                  <div className="rp-dim err" data-testid={`quota-win-${w.id}-reached`}>
                    {t('quota.limitReached')}
                    {reset ? ` · ${reset}` : ''}
                  </div>
                ) : reset ? (
                  <div className="rp-dim" data-testid={`quota-win-${w.id}-reset`}>
                    {reset}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}

      <div className="rp-quota-actions">
        {/* 月预算只适用于按量计费的 openai 平台 key；订阅制（codex）没有这个概念 */}
        {provider === 'openai' ? (
          <button
            className="rp-btn"
            onClick={() => {
              const value = window.prompt(t('quota.budgetPrompt'), budget ? String(budget) : '')
              if (value === null) return
              const n = Number(value)
              if (!Number.isFinite(n) || n <= 0) return
              void patchSettings({
                providerBudgets: { ...(settings?.providerBudgets ?? {}), [provider]: n }
              })
            }}
          >
            {t('quota.setBudget')}
          </button>
        ) : null}
      </div>
    </Section>
  )
}

/**
 * 重置说明（方案 7.2）：
 *   · 五小时 / 周 → 本地时区**倒计时**
 *   · 月 → 完整年月日与秒
 *   · 已到点 → 「待刷新」（不本地归零，由 effect 重新查询）
 */
function resetText(w: QuotaWindow): string {
  if (w.resetAt === undefined) return ''
  const now = Date.now()
  if (w.resetAt <= now) return '已到重置时间 · 待刷新'
  if (w.id === 'monthly') {
    return `重置于 ${new Date(w.resetAt).toLocaleString('zh-CN', { hour12: false })}`
  }
  return `重置于 ${countdown(w.resetAt - now)}`
}

/** 剩余时长：3天4时12分后 / 2时18分后 / 12分钟后 */
function countdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (d > 0) return `${d}天${h}时${m}分后`
  if (h > 0) return `${h}时${m}分后`
  return `${Math.max(1, m)}分钟后`
}

/** 常用币种符号；没有的币种就退回 “9.92 CNY” 这种写法（不猜符号） */
const CURRENCY_SYMBOL: Record<string, string> = { USD: '$', CNY: '¥', EUR: '€', GBP: '£', JPY: '¥' }

function ContextSection() {
  const t = useT()
  const stats = useStore((s) => s.stats)
  const messages = useStore((s) => s.messages)
  const session = useStore((s) => s.session)
  const compactNow = useStore((s) => s.compact)
  const setAutoCompaction = useStore((s) => s.setAutoCompaction)
  const cu = stats?.contextUsage
  const modelKey = session?.model ? `${session.model.provider}/${session.model.id}` : undefined
  const statsMatchModel = !!cu && (!cu.modelKey || cu.modelKey === modelKey)
  /* 模型切换后先用新模型的窗口；旧模型的 token 快照不能冒充当前容量。 */
  const win = session?.model?.contextWindow ?? (statsMatchModel ? cu?.contextWindow : undefined) ?? 0
  /*
   * pi 在「刚压缩完、还没有下一条带 usage 的助手消息」时会**故意**把
   * tokens / percent 报成 null（见 pi 的 getContextUsage：latestCompaction 之后
   * 找不到新的 usage 就返回 null）。
   *
   * 所以这里不能用 `?? 0` —— 那会把它显示成「0 tokens / 0.0% 已用」，
   * 看起来像是进度条坏了（用户报的「手动压缩后不显示进度」）。
   * 区分「未知」与「真的是 0」是这里的核心。
   */
  const known = statsMatchModel && typeof cu?.tokens === 'number'
  const used = known ? (cu?.tokens as number) : 0
  /*
   * 工作集视角（N21-3）：策略生效时主值就是**砚真正用来判断的那条线**，
   * 而不是物理窗口 —— 1M 模型上写「3%」会让用户以为还早得很，
   * 而砚在 240k 就会动手。预算由主进程随会话状态推送（同一个对象，不重算）。
   */
  const policy = session?.contextPolicy
  /** 运行期拼出来的 i18n key（`set.ctxSource.model` 这类）要断言一次，见 ContextTab 同款注释 */
  const tk = (key: string): string => t(key as MessageKey)
  /*
   * C-5 尾：默认行要不要说「现在用的是哪一档」。
   * 判据只看**精确模型层原文** —— `source === 'model'` 也可能是用户手填的自定义数，
   * 那种情况不该被叫成「均衡 600K」档。
   */
  const presetName = policy?.modelOverrides ? largePresetOf(policy.modelOverrides) : undefined
  const workingSet = policy && policy.budget.workingSet > 0 ? policy.budget.workingSet : 0
  const workingSetMode = workingSet > 0
  /*
   * C-5：主值与进度条的分母是**有效模型窗口**，砚真正动手的那条线（工作集）
   * 画成条上的软标记，并在下面单独给一行。
   *
   * 两个方向都是真话，但不能只说一半：拿工作集当分母会出现 `240k / 240k = 100%`，
   * 被读成「1M 模型满了」；只给窗口尺度又会让人以为「还早得很」，
   * 而砚在 240k 就已经会动手。所以主值给物理尺度，下面那行给策略尺度。
   */
  const policyWindow = policy?.budget.contextWindow
  const effectiveWin = policyWindow && policyWindow > 0 ? policyWindow : win
  const pctWindow = known && effectiveWin > 0 ? (used / effectiveWin) * 100 : 0
  /* 压力色只看工作集 —— 它才是砚的动手线（物理窗口满之前早就过线了） */
  const pctWork = known && workingSetMode ? (used / workingSet) * 100 : pctWindow
  const tone = pctWork >= 95 ? 'err' : pctWork >= 85 ? 'warn' : 'ok'
  const cost = [...messages].reverse().find((m) => m.role === 'assistant' && m.usage)?.usage?.cost ?? 0

  /* 压缩的可观测状态（N21-2）：进行中的原因 + 已结束的最近一次，都来自主进程的 RPC 事件归一化 */
  const compaction = session?.compaction
  const lastCompaction = session?.lastCompaction

  /* 工作集刻度的下一步（N21-3）：只预报**真的会执行**的阶段 */
  const nextStage = policy ? nextContextStage(known ? used : null, policy.budget, policy.kinds) : null

  const nf = new Intl.NumberFormat('en-US')

  /*
   * 自动压缩的触发点（用户要求：「显示什么时候开始自动压缩上下文」）。
   *
   * 数据来自 pi 自己的设置文件（main/compaction.ts）—— **不能写死 16384**：
   * 用户可以在 pi 的 settings.json 里改 reserveTokens，
   * 而界面上的这个数字是他判断「还能聊多久」的依据（丢了上下文就没了）。
   * 窗口大小变化（换模型）时重算。
   */
  const [compact, setCompact] = useState<CompactionInfo | null>(null)
  useEffect(() => {
    if (!win) return
    let alive = true
    void window.yan
      .compactionInfo(win)
      .then((r) => {
        if (alive) setCompact(r)
      })
      .catch(() => {
        /* 读不到就不显示这一行 —— 不能因此把上下文分区弄崩 */
      })
    return () => {
      alive = false
    }
  }, [win])

  /** 触发点在进度条上的位置（%） */
  const thresholdPct =
    compact && compact.contextWindow > 0 ? (compact.threshold / compact.contextWindow) * 100 : 0
  /** 距离触发还差多少 tokens（≤ 0 = 已经过线） */
  const untilCompact = compact ? compact.threshold - used : 0
  /** 详情（阈值 / 保留量 / 预留 token / 累计花费）默认收起（方案 7.3） */
  const [detailsOpen, setDetailsOpen] = useState(false)
  /** 84k / 200k 这种紧凑写法（方案 7.3 的示例写法） */
  const fmtK = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

  return (
    <Section titleKey="rp.context" testId="rp-context">
      {/*
       * 主值（方案 7.3）：一行内给「上下文 42%」与「84k / 200k」，
       * 下面只跟一条细进度条。阈值/保留量/预留 token 全部收进「详情」——
       * 它们平时不改变用户要做的事，却占着右栏最贵的位置。
       */}
      <div className="rp-ctx-main" data-testid="ctx-main" data-mode={workingSetMode ? 'working-set' : 'window'}>
        <span className="rp-k">{t('rp.context')}</span>
        <span className={`rp-v big ${known ? tone : ''}`}>{known ? `${pctWindow.toFixed(0)}%` : '—'}</span>
        <span className="spacer" />
        <span className="rp-u" data-testid="ctx-tokens">
          {known ? `${fmtK(used)} / ${fmtK(effectiveWin)}` : '—'}
        </span>
      </div>

      {/*
       * 工作集那一行（C-5）：主值是物理尺度，这里说清砚什么时候动手。
       * 没有策略（工作集不可得）时不显示 —— 不编一条不存在的线。
       */}
      {workingSetMode ? (
        <div className="rp-dim" data-testid="ctx-working-set-line">
          {known
            ? t('ctx.workingSetLine', {
                used: fmtK(used),
                cap: fmtK(workingSet),
                pct: pctWork.toFixed(0)
              })
            : t('ctx.workingSetLineUnknown', { cap: fmtK(workingSet) })}
        </div>
      ) : null}

      {/*
        档位行（C-5 尾）：区分「试行档」与「自定义数值」——
        之前 600K/700K 的名字只在设置页，右栏只写工作集数字，
        用户没法从右栏回答「我现在到底在哪个档上」。
      */}
      {presetName ? (
        <div className="rp-dim" data-testid="ctx-preset" data-preset={presetName}>
          {t('ctx.presetLine', { name: tk(LARGE_PRESET_NAME_KEYS[presetName]) })}
        </div>
      ) : null}

      <div
        className={`rp-meter ${known ? tone : 'unknown'}`}
        title={
          known
            ? workingSetMode
              ? t('ctx.tipWorkingSet', {
                  used: nf.format(used),
                  cap: nf.format(workingSet),
                  pct: pctWork.toFixed(1),
                  win: nf.format(effectiveWin)
                })
              : t('ctx.tip', { used: nf.format(used), win: nf.format(effectiveWin), pct: pctWindow.toFixed(1) })
            : t('ctx.afterCompact')
        }
      >
        <i style={{ width: `${Math.min(100, pctWindow)}%` }} />
        {workingSetMode ? (
          /*
           * 工作集刻度（N21-3）：三条线都在同一个尺度上（工作集 × 70/85/100%），
           * 但它们**不是同一回事** —— 只有压缩现在真的会触发，
           * 清理 / 折叠要等阶段 4 的上下文扩展。所以未接管的画成虚线，
           * 并把“什么时候才会真的发生”放进 title（不上色、不装成生效了）。
           */
          CONTEXT_STAGES.map((kind) => {
            const at = kind === 'tool-sweep' ? policy!.budget.triggers.sweep : kind === 'episode-fold' ? policy!.budget.triggers.fold : policy!.budget.triggers.compact
            const active = policy!.kinds.includes(kind)
            /* 刻度画在**窗口尺度**上（与分母一致），否则会跑到条外去 */
            const left = Math.max(0, Math.min(100, effectiveWin > 0 ? (at / effectiveWin) * 100 : 0))
            return (
              <b
                key={kind}
                className={`rp-stage ${active ? 'active' : 'planned'}`}
                data-testid="ctx-stage-mark"
                data-kind={kind}
                data-active={active ? '1' : '0'}
                style={{ left: `${left}%` }}
                title={contextStageTip(t, kind, { at, ratio: left / 100, active })}
              />
            )
          })
        ) : compact?.enabled && thresholdPct > 0 && thresholdPct < 100 ? (
          /*
           * 物理窗口视角：自动压缩的触发线画在进度条上，而不只写一个数字 ——
           * 用户真正想知道的是「离那条线还有多远」，那就把线画出来。
           */
          <b
            className="rp-threshold"
            data-testid="ctx-threshold-mark"
            style={{ left: `${thresholdPct}%` }}
            title={t('ctx.thresholdTip', { n: nf.format(compact.threshold) })}
          />
        ) : null}
      </div>

      {/*
        工作集模式下的「下一步」（N21-3）：只预报真的会执行的那个阶段。
        已过线时改说“已达工作集上限” —— 站在线上还报“约 240k 时”是废话。
      */}
      {workingSetMode && nextStage ? (
        <div className={nextStage.reached ? 'rp-dim warn' : 'rp-dim'} data-testid="ctx-next-stage" data-kind={nextStage.kind} data-reached={nextStage.reached ? '1' : '0'}>
          {nextContextStageText(t, nextStage)}
        </div>
      ) : null}

      {/* 阶段图例：名字 + 是否已接管（虚线 = 阶段 4 前不会触发） */}
      {workingSetMode ? (
        <div className="rp-stages" data-testid="ctx-stages" title={t('ctx.stagesTip')}>
          {CONTEXT_STAGES.map((kind) => {
            const active = policy!.kinds.includes(kind)
            return (
              <span
                key={kind}
                className={`rp-stage-chip ${active ? 'on' : 'planned'}`}
                data-testid="ctx-stage-chip"
                data-kind={kind}
                data-active={active ? '1' : '0'}
                /* 说明也挂在格子上：用户是看着这三个词问“它们是干什么的” */
                title={contextStageTip(t, kind, {
                  at: kind === 'tool-sweep' ? policy!.budget.triggers.sweep : kind === 'episode-fold' ? policy!.budget.triggers.fold : policy!.budget.triggers.compact,
                  ratio: kind === 'tool-sweep' ? 0.7 : kind === 'episode-fold' ? 0.85 : 1,
                  active
                })}
              >
                {contextStageLabel(t, kind)}
              </span>
            )
          })}
        </div>
      ) : null}

      {/*
        自动压缩的触发点**只在进度条上画一条记号**（用户要求）：
        「不要显示自动压缩还差多少多少多少，在进度条上有记号即可」。
        记号右边还有一行说明 —— 但只在**已经过线**时才出现
        （那时它是警告，不是冗余信息）。

        工作集模式下这条不渲染：那条线是 pi 自己的（已经远在工作集之上），
        而「已达工作集上限」那行上面已经说过了 —— 两行同时出现只是噪声。
      */}
      {!workingSetMode && compact?.enabled && untilCompact <= 0 ? (
        <div className="rp-dim err" data-testid="ctx-compaction">
          {t('ctx.atCompact')}
        </div>
      ) : null}

      {/*
       * 压缩中 —— 从中栏底部的状态条搬过来的。
       * 放在上下文分区是因为它本来就是上下文的事（快满了才压缩），
       * 而且这样中栏底部那一条就能整个去掉（用户嫌它挤，见 rp 文件头注释）。
       */}
      {/*
        刚压缩完：pi 还报不出新的 contextUsage（tokens=null）。
        不是“没了”，只是要等下一轮才有新数据 —— 明说一句，别让用户以为坏了。
      */}
      {cu && cu.tokens === null ? (
        <div className="rp-dim" data-testid="ctx-unknown">
          {t('ctx.afterCompact')}
        </div>
      ) : null}

      {session?.isCompacting ? (
        <div className="rp-dim rp-warn" data-testid="rp-compacting">
          <span className="rp-now-spin" aria-hidden>
            <Spinner />
          </span>
          {/*
           * 「压缩中 · 已达阈值」（N21-2）：只说“正在压缩”回答不了用户当下最想知道的
           * —— 为什么突然在压缩？原因来自 pi 的 `compaction_start.reason`。
           * 拿不到原因时退回短的 `status.compacting`，不编一个原因。
           */}
          <span data-testid="ctx-compacting-reason">
            {compactionRunningText(t, compaction)}
          </span>
        </div>
      ) : null}

      {/*
        自动压缩的开关与手动入口（阶段 1 归位）。

        它属于「上下文」本身，所以紧跟进度条与状态提示 —— 之前它排在
        「详情」折叠区下面，视觉上像第二个工具（用户报的问题）。
        标签改用 ctx.* 域，与这一块其余文案同一命名空间。

        `rp-ctx-actions`：这一行里混了**按钮**与纯文本，不能沿用 `.rp-kv` 的
        `align-items: baseline`（24px 的按钮与 17px 的文字会错位，窄栏下按钮
        还会折成两行 —— 用户截图里的「压缩上/下文」）。见 tools.css 里的说明。
      */}
      <div className="rp-kv rp-ctx-actions" data-testid="rp-context-actions">
        <span className="rp-k">{t('ctx.autoCompact')}</span>
        {/* 不用 .spacer：在这个窄行里它自己要吃掉两个 gap（16px），
            而这十几 px 正是按钮文字够不够用的临界值 —— 改用 CSS 的 margin-left:auto */}
        <button
          className={`switch-pill ${session?.autoCompactionEnabled !== false ? 'on' : ''}`}
          role="switch"
          aria-checked={session?.autoCompactionEnabled !== false}
          data-testid="rp-auto-compact"
          title={t('status.autoCompactHint')}
          onClick={() => void setAutoCompaction(!(session?.autoCompactionEnabled !== false))}
        >
          <span className="switch-knob" />
        </button>
        <button
          className="btn"
          data-testid="rp-compact-now"
          disabled={!!session?.isStreaming || !!session?.isCompacting}
          title={t('status.compact')}
          onClick={() => void compactNow()}
        >
          <Icon name={session?.isCompacting ? 'refresh' : 'layers'} size={12} className={session?.isCompacting ? 'spin' : undefined} />
          <span>{session?.isCompacting ? t('status.compacting') : t('status.compact')}</span>
        </button>
      </div>

      {/*
       * 详情：容量参数与花费，分两组，默认收起（方案 7.3 + 阶段 1 分组）。
       *
       * 只读的「自动压缩 开/关」行已删除：上面就是可切换的同一个开关，
       * 两处同时出现正是「看起来像两个工具」的一部分。
       * 这里只放**真实生效**的 pi 参数（阶段 1 不提前展示尚未接管的工作集）。
       */}
      <button
        className="rp-details-toggle"
        onClick={() => setDetailsOpen((v) => !v)}
        aria-expanded={detailsOpen}
        data-testid="ctx-details-toggle"
      >
        <Icon name="chevron-right" size={12} className={`chev ${detailsOpen ? 'on' : ''}`} />
        {t('ctx.details')}
      </button>

      {detailsOpen ? (
        <div className="rp-details" data-testid="ctx-details">
          <div className="rp-group">{t('ctx.groupCapacity')}</div>
          {workingSetMode ? (
            <>
              {/*
                工作集的三个数（N21-3）：上限定下来之后，用户才能把「为什么 240k」
                算清楚。它们与砚内部用的是同一份预算（主进程随状态推送），
                不是渲染端照公式再算一遂的副本。
                ⚠️ 「工作集预留」与 pi 自己的「为回答预留」是两个数：前者进工作集
                公式，后者（reserveTokens）只决定 pi 那条原生触发线。标签必须
                分开写 —— 同一个面板里同名不同值是 D21 那类误解的温床。
              */}
              <div className="rp-kv" data-testid="ctx-working-set">
                <span className="rp-k">{t('ctx.workingSet')}</span>
                <span className="spacer" />
                <span className="rp-v" title={t('ctx.workingSetTip')}>
                  {nf.format(workingSet)}
                </span>
              </div>
              <div className="rp-kv" data-testid="ctx-reserve-computed">
                <span className="rp-k">{t('ctx.reserveWorkingSet')}</span>
                <span className="spacer" />
                <span className="rp-v">{nf.format(policy!.budget.responseReserve)}</span>
              </div>
              <div className="rp-kv" data-testid="ctx-safety-margin">
                <span className="rp-k">{t('ctx.safetyMargin')}</span>
                <span className="spacer" />
                <span className="rp-v">{nf.format(policy!.budget.safetyMargin)}</span>
              </div>
            </>
          ) : null}
          <div className="rp-kv">
            <span className="rp-k">{t('ctx.window')}</span>
            <span className="spacer" />
            <span className="rp-v">{win ? nf.format(win) : '—'}</span>
          </div>
          {workingSetMode ? (
            <div className="rp-kv" data-testid="ctx-emergency">
              <span className="rp-k">{t('ctx.emergency')}</span>
              <span className="spacer" />
              <span
                className="rp-v"
                title={t('ctx.emergencyTip', { pct: Math.round((policy!.budget.emergency / policy!.budget.contextWindow) * 100) })}
              >
                {nf.format(policy!.budget.emergency)}
              </span>
            </div>
          ) : null}
          <div className="rp-kv">
            {/* 工作集模式下这条线是 pi 自己的（作为兜底保留） */}
            <span className="rp-k">{workingSetMode ? t('ctx.thresholdPi') : t('ctx.threshold')}</span>
            <span className="spacer" />
            <span
              className="rp-v"
              title={compact ? t('ctx.scopeTip', { scope: t(compact.scope === 'project' ? 'ctx.scopeProject' : 'ctx.scopeGlobal') }) : undefined}
            >
              {compact ? nf.format(compact.threshold) : '—'}
            </span>
          </div>
          <div className="rp-kv">
            <span className="rp-k">{t('ctx.keep')}</span>
            <span className="spacer" />
            <span className="rp-v">{compact ? nf.format(compact.keepRecentTokens) : '—'}</span>
          </div>
          <div className="rp-kv">
            {/* 工作集模式下这个名字要与上面的「工作集预留」区分开 */}
            <span className="rp-k">{workingSetMode ? t('ctx.reservePi') : t('ctx.reserve')}</span>
            <span className="spacer" />
            <span className="rp-v">{compact ? nf.format(compact.reserveTokens) : '—'}</span>
          </div>
          {/*
            项目里配了压缩参数、pi 却不会读它（D21）：
            不说的话，用户改的是 `.pi/settings.json`，看到的却是一条永远对不上的
            触发线 —— 而 “界面数字与实际生效值不符” 正是这一块最不能容忍的错。
            完整解释放 `title`，面板里只留一句短的。
          */}
          {compact?.projectIgnored ? (
            <div className="rp-dim warn" data-testid="ctx-project-ignored" title={t('ctx.projectIgnoredTip')}>
              {t('ctx.projectIgnored')}
            </div>
          ) : null}
          {/*
            容量来源（C-5 尾）：这些数到底是默认、用户设的、还是模型级 / env 推的。
            设置页的 `ctx-source` 早就有这条，但用户看右栏数字时不该被逼回设置页 ——
            「界面上的数 ≠ 真正在用的数」正是这一块最不能容忍的错。
          */}
          {policy ? (
            <div className="rp-kv" data-testid="ctx-source-line" title={t('ctx.sourceLineTip')}>
              <span className="rp-k">{t('ctx.sourceLine')}</span>
              <span className="spacer" />
              <span className="rp-v">
                {`${tk(`set.ctxSource.${policy.source}`)}${policy.sourceKey ? ` · ${policy.sourceKey}` : ''}`}
              </span>
            </div>
          ) : null}
          <div className="rp-group">{t('ctx.groupSpend')}</div>
          <div className="rp-kv" data-testid="ctx-cost">
            <span className="rp-k">{t('rp.spent')}</span>
            <span className="spacer" />
            <span className="rp-v">${cost.toFixed(4)}</span>
          </div>
          {/*
            最近一次压缩（N21-2）。

            为什么放在「详情」而不是主视区：它不是用户每轮都要看的数，
            但“上下文突然变短了”时是唯一能解释原因的地方（什么时候压的、为什么）。

            为什么没有记录时**整行不渲染**：从磁盘打开的历史会话可能早就压缩过，
            而砚现在不读会话文件里的 compaction 条目 —— 写「未发生过」会是假陈述。
          */}
          {lastCompaction ? (
            <>
              <div
                className="rp-kv"
                data-testid="ctx-last-compaction"
                title={t('ctx.lastCompactionTip')}
              >
                <span className="rp-k">{t('ctx.lastCompaction')}</span>
                <span className="spacer" />
                <span className={`rp-v ${lastCompaction.status === 'completed' ? '' : compactionTone(lastCompaction)}`}>
                  {compactionSummary(t, lastCompaction)}
                </span>
              </div>
              {/* 「1.6k → 160」：上下文到底短了多少（pi 不报就不显示） */}
              {compactionTokensText(lastCompaction) ? (
                <div className="rp-dim" data-testid="ctx-last-compaction-tokens">
                  {compactionTokensText(lastCompaction)}
                </div>
              ) : null}
              {/*
               * C-2 的两个派生量：这次回收了多少、以及压完到现在又新增多少。
               *
               * `used` 只在 pi 报了当前用量时才有值（刚压缩完它会故意报 null），
               * 所以「此后新增」拿不到数就不显示 —— 不能把“还没测”写成“没新增”。
               * 「回收 XX%」在压缩完成后总是给一句（含「待测」），因为它回答的是
               * 用户看完压缩后最直接的问题：这次到底有没有用。
               */}
              {lastCompaction.status === 'completed' ? (
                <div className="rp-dim" data-testid="ctx-last-compaction-reclaim">
                  {compactionReclaimText(t, lastCompaction)}
                  {(() => {
                    const growth = compactionGrowthText(t, lastCompaction, known ? used : undefined)
                    return growth ? ` · ${growth}` : ''
                  })()}
                </div>
              ) : null}
              {/*
               * 失败/被跳过时**必须**有话说：pi 的原文（英文）原样透传，
               * 不翻译也不吞（约定：pi 内置错误一律原样透传）。
               */}
              {lastCompaction.error ? (
                <div className="rp-dim err" data-testid="ctx-last-compaction-error">
                  {lastCompaction.error}
                </div>
              ) : lastCompaction.status === 'declined' ? (
                <div className="rp-dim" data-testid="ctx-last-compaction-note">
                  {t('ctx.declinedTip')}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </Section>
  )
}

/* 任务 —— 来自会话里的 custom entry（panel_todos） */

/**
 * 任务栏 —— 进度条 + 逐行落位。
 *
 * ── 用户要求 ──
 * 「假设你列出五个任务 已完成两个 再执行当前任务时 显示一个进度条 并加入动画」
 *
 * 所以三件事：
 *   ① **进度条始终显示**（原先只有 ≥ 4 个任务才显示）——
 *      5 个任务完成 2 个时它不是装饰，而是「还剩多少」的唯一提示。
 *   ② 「当前正在做的那一条」要能认出来：
 *      显式 `status` 优先；只有老数据才退回「第一个未完成」，
 *      而且**要求回合真的在跑**（见下面 activeIdx）。
 *      它带一个转动的 spinner + 左条强调色 + 名字高亮。
 *   ③ 动画：
 *      · 进度条宽度变化用 transition（不是瞬跳）
 *      · 刚被勾完的那一条闪一下（确认反馈）
 *      · 当前条目的左条呼吸 + 进度条上有一道扫光
 */
function TodoSection() {
  const t = useT()
  const todos = useStore((s) => s.todos)
  /**
   * 回合是否真的在跑 —— 「正在进行」的兜底判据（见下面 activeIdx）。
   *
   * `isStreaming` 在工具执行期间是 false（见 shared/ipc.ts 的注释），
   * 所以两个都要看，否则「调工具的那几十秒」会被当成已经停下。
   */
  const agentRunning = useStore(
    (s) => s.session?.isAgentRunning === true || s.session?.isStreaming === true
  )
  /** 全部任务清单快照（含最新）——历史任务模块用 */
  const history = useStore((s) => s.todoHistory)
  const scrollToTurn = useStore((s) => s.scrollToTurn)
  /** 历史任务折叠模块是否展开（默认收起） */
  const [histOpen, setHistOpen] = useState(false)
  const done = useMemo(() => todos.filter((x) => x.done).length, [todos])

  /*
   * 任务栏的展开态（用户要求：「当任务完成时自动收起任务工具栏」）。
   * 条件是**从“未全部完成”变为“全部完成”**那一刻收起；新任务出现时再展开。
   * 用受控 open 传给 Section（之前 Section 自己管，外面插不进去）。
   */
  const [open, setOpen] = useState(true)
  const prevTodoCount = useRef(todos.length)
  useEffect(() => {
    /* 从无任务会话切回有任务会话时，任务本体不能继承上一份空态的收起状态。 */
    if (todos.length > 0 && prevTodoCount.current === 0) setOpen(true)
    prevTodoCount.current = todos.length
  }, [todos.length])
  const allDone = todos.length > 0 && done === todos.length
  const prevAllDone = useRef(allDone)
  useEffect(() => {
    if (allDone && !prevAllDone.current) setOpen(false)
    else if (!allDone && prevAllDone.current) setOpen(true)
    prevAllDone.current = allDone
  }, [allDone])

  /*
   * 记住上一条被勾完的，用来给它加一下高亮闪动。
   *
   * 为什么要记「上一条」而不是直接看 done：勾完的条目不会消失，
   * 光靠 done 无法区分「刚勾的」与「早就勾的」。
   */
  const prevDone = useRef<Set<number>>(new Set())
  const [justDone, setJustDone] = useState<Set<number>>(new Set())

  useEffect(() => {
    const cur = new Set(todos.map((x, i) => (x.done ? i : -1)).filter((i) => i >= 0))
    const fresh = new Set<number>()
    for (const i of cur) if (!prevDone.current.has(i)) fresh.add(i)
    prevDone.current = cur
    // 首次渲染时不要把全部已完成当成「刚完成」
    if (cur.size && fresh.size === cur.size) return
    if (fresh.size === 0) return
    setJustDone(fresh)
    const id = setTimeout(() => setJustDone(new Set()), 900)
    return () => clearTimeout(id)
  }, [todos])

  if (todos.length === 0) return null

  const pct = todos.length ? (done / todos.length) * 100 : 0
  /*
   * 「当前正在做」的那一条 —— 决定哪一行带 active + spinner。
   *
   * ⚠️ 以前是一句 `findIndex((x) => !x.done)`：只要还有没做完的任务，
   *    界面上就**永远**有一条「正在进行」在转 —— agent 停了、报错了、
   *    用户中断了，它照转。那不是状态，是猜测（方案 4.5）。
   *
   * 现在分两步：
   *   ① pi 侧的清单带**显式 `status`** 时以它为准（有人 running 就是它；
   *      有状态但没人 running → 真的没有正在做的那条）；
   *   ② 只有 `{text, done}` 的老数据退回推断，但**要求回合真的在跑** ——
   *      没在跑时，那些没做完的是「还没做」，不是「正在做」。
   */
  const activeIdx = (() => {
    const explicit = todos.findIndex((x) => x.status === 'running')
    if (explicit >= 0) return explicit
    if (todos.some((x) => x.status !== undefined)) return -1
    if (!agentRunning) return -1
    return todos.findIndex((x) => !x.done)
  })()
  const active = activeIdx >= 0 ? todos[activeIdx] : null

  return (
    <Section
      titleKey="rp.todo"
      testId="rp-todo"
      open={open}
      onOpenChange={setOpen}
      extra={
        <span className="rp-count" data-testid="todo-count">
          {done}/{todos.length}
        </span>
      }
    >
      {/* 进度条：**总是**显示（用户要的就是“已完成两个、五个任务”的比例感） */}
      <div
        className={`rp-meter ${active ? 'busy' : ''}`}
        data-testid="todo-meter"
        data-pct={Math.round(pct)}
        title={t('rp.todoProgress', { done, total: todos.length })}
      >
        <i style={{ width: `${pct}%` }} />
      </div>
      {/*
        正在进行的任务**在任务本体上显示**（用户要求：「不要单独开一栏」）。
        这里只剩下「全部完成」的提示 —— 它不属于任何一个任务行。
        原先这里有一行 .rp-todo-now 重复了一遍当前任务名，
        与下面列表里那一行是同一件事，白占一行。
      */}
      {!active ? (
        <div className="rp-todo-all" data-testid="todo-all-done">
          <span className="rp-all-done">{t('rp.todoAllDone')}</span>
        </div>
      ) : null}

      <div className="rp-todos">
        {todos.map((todo, i) => {
          const isActive = i === activeIdx
          /** 受阻：只有数据真的标了 blocked 才显示（方案 7.1） */
          const blocked = todo.status === 'blocked'
          return (
            <div
              key={i}
              /*
               * 行类名：
               *   done      已完成（删除线 + 绿勾）
               *   todo-open 未完成
               *   active    当前正在做（行内会显示「正在进行」+ spinner）
               *   flash     刚被勾完（闪一下）
               * `--i` 给 CSS 做逐行落位
               */
              className={`rp-todo ${todo.done ? 'done' : blocked ? 'blocked' : 'todo-open'} ${isActive ? 'active' : ''} ${justDone.has(i) ? 'flash' : ''}`}
              style={{ '--i': i } as React.CSSProperties}
              data-done={todo.done ? '1' : '0'}
              data-active={isActive ? '1' : '0'}
              data-blocked={blocked ? '1' : '0'}
              title={todo.text}
            >
              <span className="rp-running-mark" aria-hidden />
              <span className="rp-box" aria-hidden>
                {todo.done ? '✓' : blocked ? '!' : ''}
              </span>
              {/** 只做 200 字安全上限，真正的行数限制交给 CSS 两行截断 */}
              <span className="rp-text">{clip(todo.text, TODO_MAX_CHARS)}</span>
              {isActive ? (
                <span className="rp-state doing" data-testid="todo-active-label">
                  <span className="rp-now-spin" aria-hidden>
                    <Spinner />
                  </span>
                  {t('rp.doing')}
                </span>
              ) : blocked ? (
                <span className="rp-state blocked" data-testid="todo-blocked-label">
                  <Icon name="alert-circle" size={12} />
                  {t('rp.blocked')}
                </span>
              ) : (
                <span className="rp-state">{todo.done ? t('rp.done') : t('rp.open')}</span>
              )}
            </div>
          )
        })}
      </div>

      {/*
        历史任务（用户要求）：
          · 「如果这段对话有历史任务 就显示一个历史任务的折叠模块 如果没有就不显示」
          · 「在任务模块的旁边加入一个当前会话历史任务查看以及跳转」
        两者用同一个入口：头部的「历史 N」按钮 = 在任务模块旁边；
        点开后是折叠模块，每份清单带「跳转」。
        history 里最后一份就是**当前**这份，所以只在 length > 1 时才算有历史。
      */}
      {history.length > 1 ? (
        <div className="rp-todo-hist" data-testid="todo-history">
          <button
            className={`rp-hist-head ${histOpen ? 'open' : ''}`}
            onClick={() => setHistOpen((v) => !v)}
            aria-expanded={histOpen}
            data-testid="todo-history-toggle"
          >
            <Icon name="history" size={12} className="chev" />
            <span>{t('rp.todoHistory')}</span>
            <span className="spacer" />
            <span className="rp-count">{history.length - 1}</span>
          </button>
          {histOpen ? (
            <div className="rp-hist-body">
              {/* 新的在前（最近的一轮最可能被回看） */}
              {history
                .slice(0, -1)
                .reverse()
                .map((snap) => (
                  <div key={snap.id} className="rp-hist-item" data-testid={`todo-hist-${snap.round}`}>
                    <div className="rp-hist-meta">
                      <span className="rp-hist-round">
                        {t('rp.todoHistoryRound', { n: snap.round })}
                      </span>
                      <span className="rp-count">
                        {snap.todos.filter((x) => x.done).length}/{snap.todos.length}
                      </span>
                      <span className="spacer" />
                      {/*
                       * 跳转：滚到写这份清单时那一轮。
                       * 用 store 的 scrollToTurn（与导航轨同一个实现）——
                       * 一个应用里不该有两套「跳到第几轮」。
                       */}
                      <button
                        className="rp-hist-jump"
                        onClick={() => scrollToTurn(Math.max(0, snap.round - 1))}
                        data-testid={`todo-hist-jump-${snap.round}`}
                        title={t('rp.todoHistoryJump')}
                      >
                        {t('rp.jump')}
                      </button>
                    </div>
                    <div className="rp-hist-todos">
                      {snap.todos.map((x, j) => (
                        <div key={j} className={`rp-hist-todo ${x.done ? 'done' : ''}`}>
                          <span className="rp-box" aria-hidden>
                            {x.done ? '✓' : ''}
                          </span>
                          <span className="rp-text">{clip(x.text, TODO_MAX_CHARS)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </Section>
  )
}

/**
 * 任务文字的安全上限（用户新要求：显示**最多两行**）。
 * 不再按字数硬截（那会让两行永远用不满）；只留一个很大的安全上限，
 * 防止模型把一整段文轩塞进一条任务，然后交给 CSS `-webkit-line-clamp: 2`。
 */
const TODO_MAX_CHARS = 200

/** 超过上限就截断并加省略号（完整文本由 title 提供） */
function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** 盲文 spinner —— 与输入框边框上那个同一套帧（pi 的 loader.js） */
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
function Spinner() {
  const [i, setI] = useState(0)
  useEffect(() => {
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce) return
    const id = setInterval(() => setI((v) => (v + 1) % SPIN.length), 80)
    return () => clearInterval(id)
  }, [])
  return <>{SPIN[i]}</>
}

/* 队列 —— pi 的投递模式 + 待投递内容 */

function QueueSection() {
  const t = useT()
  const queue = useStore((s) => s.queue)
  const session = useStore((s) => s.session)
  const setSteeringMode = useStore((s) => s.setSteeringMode)
  const setFollowUpMode = useStore((s) => s.setFollowUpMode)

  const steering = session?.steeringMode ?? 'one-at-a-time'
  const followUp = session?.followUpMode ?? 'one-at-a-time'
  const pending = queue.steering.length + queue.followUp.length

  return (
    <Section titleKey="rp.queue" testId="rp-queue">
      {pending > 0 ? (
        <div className="rp-queued">
          {[...queue.steering, ...queue.followUp].map((q) => (
            <div key={q.id} className="rp-queued-row" title={q.text}>
              <span className="rp-queued-dot" />
              <span className="rp-text">{q.text}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="rp-dim">{t('rp.noQueue')}</div>
      )}

      <ModeRow
        labelKey="rp.steering"
        value={steering}
        onChange={(m) => void setSteeringMode(m)}
        testId="steering-mode"
      />
      <ModeRow
        labelKey="rp.followUp"
        value={followUp}
        onChange={(m) => void setFollowUpMode(m)}
        testId="followup-mode"
      />
    </Section>
  )
}

function ModeRow({
  labelKey,
  value,
  onChange,
  testId
}: {
  labelKey: MessageKey
  value: QueueMode
  onChange: (m: QueueMode) => void
  testId: string
}) {
  const t = useT()
  const label = (m: QueueMode): string =>
    m === 'all' ? t('rp.modeAll') : t('rp.modeOne')

  return (
    <div className="rp-kv rp-mode">
      <span className="rp-k">{t(labelKey)}</span>
      <span className="spacer" />
      <button
        className="rp-switch"
        data-testid={testId}
        data-value={value}
        title={t('rp.queueTip')}
        onClick={() => onChange(value === 'all' ? 'one-at-a-time' : 'all')}
      >
        <span className={value === 'one-at-a-time' ? 'on' : ''}>{t('rp.modeOne')}</span>
        <span className={value === 'all' ? 'on' : ''}>{t('rp.modeAll')}</span>
        <span className="rp-switch-tip">{label(value)}</span>
      </button>
    </div>
  )
}

/* 扩展 —— setStatus / setWidget 的真实内容 */

function ExtSection() {
  const t = useT()
  const statuses = useStore((s) => s.statuses)
  const widgets = useStore((s) => s.widgets)

  const statusEntries = Object.entries(statuses)
  const widgetEntries = Object.entries(widgets)
  if (statusEntries.length === 0 && widgetEntries.length === 0) return null

  return (
    <Section titleKey="rp.ext" testId="rp-ext">
      {statusEntries.map(([k, v]) => (
        <div key={k} className="rp-kv">
          <span className="rp-k">{k}</span>
          <span className="spacer" />
          <span className="rp-v">{v}</span>
        </div>
      ))}
      {widgetEntries.map(([k, lines]) => (
        <div key={k} className="rp-widget">
          <div className="rp-widget-key">{k}</div>
          {lines.map((l, i) => (
            <div key={i} className="rp-widget-line">
              {l}
            </div>
          ))}
        </div>
      ))}
      <div className="rp-dim">{t('rp.extHint')}</div>
    </Section>
  )
}

/* 日志 —— pi 的 stderr + 扩展通知
   原来挤在中栏底部（.statusbar + .logdrawer），用户嫌它不美观。
   搬到右栏的理由：「状态」类信息本来就属于右栏（见文件头注释）。
   顺带把中栏底部整条去掉 —— 那个条只用干两件事：显示压缩中
   与当日志按钮，两件都搬走了就不需要它了。 */

function LogSection() {
  const t = useT()
  const logs = useStore((s) => s.logs)

  // 日志为空时不占位（与 ExtSection 同一个约定）
  if (logs.length === 0) return null

  return (
    <Section
      titleKey="rp.log"
      testId="rp-log"
      defaultOpen={false}
      extra={
        <span className="rp-count" data-testid="log-count">
          {logs.length}
        </span>
      }
    >
      {/*
       * 只渲染最后 200 行。
       * pi 的 stderr 在启动期可能一下刷很多（扩展自检、警告），
       * 全量渲染会把右栏变成一个几千行的列表 —— 而用户真正要看的是尾部。
       */}
      <pre className="rp-log" data-testid="log-body">
        {logs.slice(-200).join('\n')}
      </pre>
      <div className="rp-dim">{t('rp.logHint')}</div>
    </Section>
  )
}

/* 操作 —— pi 自带能力的入口 */

function ActionsSection() {
  const t = useT()
  const copyLastReply = useStore((s) => s.copyLastReply)
  const abortRetry = useStore((s) => s.abortRetry)
  const autoRetry = useStore((s) => s.autoRetryEnabled)
  const setAutoRetry = useStore((s) => s.setAutoRetry)
  const exportHtml = useStore((s) => s.exportHtml)
  const clone = useStore((s) => s.clone)
  const session = useStore((s) => s.session)
  const streaming = !!session?.isStreaming

  return (
    <Section titleKey="rp.actions" testId="rp-actions" defaultOpen={false}>
      <div className="rp-acts">
        <Act onClick={() => void copyLastReply()} labelKey="rp.actCopy" testId="act-copy" />
        <Act onClick={() => void abortRetry()} labelKey="rp.actRetry" testId="act-abort-retry" />
        <Act onClick={() => void exportHtml()} labelKey="rp.actExport" testId="act-export" />
        <Act onClick={() => void clone()} disabled={streaming} labelKey="rp.actClone" testId="act-clone" />
        {session?.sessionFile ? (
          <Act
            onClick={() => void window.yan.revealPath(session.sessionFile!)}
            labelKey="rp.actReveal"
            testId="act-reveal"
          />
        ) : null}
      </div>
      <div className="rp-kv rp-action-setting" data-testid="rp-auto-retry">
        <span className="rp-k">{t('status.autoRetry')}</span>
        <span className="spacer" />
        <button
          className={`switch-pill ${autoRetry ? 'on' : ''}`}
          role="switch"
          aria-checked={autoRetry}
          title={t('status.autoRetryHint')}
          onClick={() => void setAutoRetry(!autoRetry)}
        >
          <span className="switch-knob" />
        </button>
      </div>
    </Section>
  )
}

function Act({
  onClick,
  labelKey,
  testId,
  disabled
}: {
  onClick: () => void
  labelKey: MessageKey
  testId: string
  disabled?: boolean
}) {
  const t = useT()
  return (
    <button
      className="rp-act"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      title={disabled ? t('picker.busy') : t(labelKey)}
    >
      {t(labelKey)}
    </button>
  )
}
