import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import type { MessageKey } from '../../i18n'
import { Section } from './ToolSection'
import { useStore } from '../../state/store'
import { TOOL_SECTIONS, type CompactionInfo, type QueueMode, type QuotaWindow, type ToolSectionId } from '../../../../shared/ipc'
import { HandleProvider, SECTION_TITLE } from './ToolSection'
import { ToolLibrary } from './ToolLibrary'
import { FileTree } from './FileTree'
import { Resizer } from './Resizer'
import { BrowserSurface } from '../browser/BrowserSurface'

/**
 * 右侧工具面板：按用户配置排列上下文、任务、队列、文件、扩展、日志和操作分区。
 * 仅显示真实会话数据；空分区不参与排序。浏览器视图占用面板下方独立区域。
 * 收起后释放布局宽度，不以浮层覆盖对话。
 */
export function RightPanel() {
  const t = useT()
  const open = useStore((s) => s.settings?.rightPanelOpen ?? true)
  const order = useStore((s) => s.settings?.toolOrder)
  const hidden = useStore((s) => s.settings?.toolHidden)
  const setToolLayout = useStore((s) => s.setToolLayout)
  const draggingId = useStore((s) => s.draggingSection)
  const setDraggingSection = useStore((s) => s.setDraggingSection)
  const setToolDropTarget = useStore((s) => s.setToolDropTarget)
  const placeSection = useStore((s) => s.placeSection)
  const browserOpen = useStore((s) => s.browserState.open)
  const browserHeight = useStore((s) => s.settings?.browserHeight ?? 0)
  const [libOpen, setLibOpen] = useState(false)

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

  /**
   * 从工具库拖拽到工具栏的全过程处理。
   *
   * 为什么监听挂在 window 上：指针一旦离开工具库那个元素（这是必然的 ——
   * 用户在往工具栏那边拖），元素自己的 pointermove 就不再触发了。
   * 监听 window 才能持续拿到坐标、算出落点 —— 这就是「实时位置预览」的来源。
   */
  useEffect(() => {
    if (!draggingId) return

    /** 根据指针 Y 找出「会插到哪个分区的前/后」 */
    const onMove = (e: PointerEvent): void => {
      // 浮动标签跟着鼠标（直接改 style，零重渲染）
      const g = ghostRef.current
      if (g) {
        g.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 10}px)`
      }
      const slots = [...document.querySelectorAll('.rp-body > .rp-slot')] as HTMLElement[]
      // 先看有没有落在某个分区里（含它的边界）
      for (const el of slots) {
        const r = el.getBoundingClientRect()
        if (e.clientY >= r.top && e.clientY <= r.bottom) {
          const id2 = el.dataset.toolId ?? ''
          if (!id2 || id2 === draggingId) {
            setToolDropTarget(null)
            return
          }
          setToolDropTarget({ id: id2, after: e.clientY > r.top + r.height / 2 })
          return
        }
      }
      /*
       * 落在空白处（列表上方/下方）：
       *   · 在第一个分区之上 → 插到最前
       *   · 在最后一个分区之下 → 插到最后（targetId = null 时 placeSection 会追加）
       * 不给反馈的话，用户拖到顶部会以为「拖丢了」。
       */
      const first = slots[0]?.dataset.toolId
      if (slots.length && e.clientY < slots[0].getBoundingClientRect().top && first) {
        setToolDropTarget({ id: first, after: false })
      } else {
        setToolDropTarget(null)
      }
    }

    const onUp = (e: PointerEvent): void => {
      const t = useStore.getState().toolDropTarget
      /*
       * 落点在工具栏区域内才真的移动；拖到别处 = 取消。
       * 不这么做的话，用户想放弃拖拽时把指针甩到中栏，
       * 分区会莫名其妙地跳位置。
       */
      const body = document.querySelector('.rp-body')?.getBoundingClientRect()
      const inside = !!body && e.clientX >= body.left - 40 && e.clientX <= body.right + 8 && e.clientY >= body.top - 60 && e.clientY <= body.bottom + 40
      if (inside) void placeSection(draggingId, t?.id ?? null, t?.after ?? true)
      else setDraggingSection(null)
    }

    /** 拖到一半按 Esc = 取消 */
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setDraggingSection(null)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey)
    document.body.classList.add('tool-dragging')
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', onKey)
      document.body.classList.remove('tool-dragging')
    }
  }, [draggingId, placeSection, setDraggingSection, setToolDropTarget])

  /** 跟着鼠标的小标签：告诉用户「正在搬的这块叫什么」 */
  const ghostLabel = draggingId ? t(SECTION_TITLE[draggingId as ToolSectionId]) : ''
  /** 浮动标签的 DOM 引用：位置直接改 style，不走 state（每像素重渲染会卡） */
  const ghostRef = useRef<HTMLDivElement>(null)
  /** 右栏自身：浏览器高度分隔条需要从它里面量浏览器区域的高度 */
  const asideRef = useRef<HTMLElement>(null)

  /*
   * 浏览器与工具栏**解耦**（用户要求）。
   *
   * 两者的开关互相独立：
   *   · 只开工具栏  → 只渲染工具分区
   *   · 只开浏览器  → 浏览器**独占整列**（工具栏收起时不再拖着一排空标题）
   *   · 都开        → 上浏览器 / 下工具分区，中间可拖高度
   * 浏览器入口在**标题栏**（与左右栏开关同一处，位置永不漂移），
   * 不再占用工具栏标题行 —— 这样「收起工具栏」对浏览器完全无影响。
   * pi 工具也可以直接打开浏览器；此时即使工具栏原本收起，也把浏览器显示出来。
   */
  if (!open && !browserOpen) return null

  return (
    <aside
      ref={asideRef}
      className={`rightpanel ${browserOpen ? 'browser-mode' : ''} ${open ? '' : 'tools-collapsed'}`}
      data-testid="rightpanel"
      style={browserHeight > 0 ? ({ '--h-browser': `${browserHeight}px` } as React.CSSProperties) : undefined}
    >
      {/*
       * 宽度把手放在 aside **内部**并绝对定位。
       * 不能作为 .workspace 的 grid 子元素 —— 那会多出一列，
       * grid-template-columns 只有三列的定义（本项目的列宽踩过坑，见 redesign.css §23b）。
       */}
      <Resizer side="panel" />

      {open ? (
        <>
          <div className="rp-top">
            <span className="rp-title">{t('rp.title')}</span>
            <span className="spacer" />
            {/*
             * 工具库。放在标题旁边（用户问「库放哪」时给的备选之一）——
             * 库管的就是工具栏的内容，入口贴着工具栏标题最直。
             */}
            <button
              className={`rp-x ${libOpen ? 'on' : ''}`}
              onClick={() => setLibOpen((v) => !v)}
              title={t('tl.open')}
              data-testid="tool-lib-btn"
              aria-expanded={libOpen}
            >
              <Icon name="layers" size={12} />
            </button>
          </div>

          {libOpen ? <ToolLibrary onClose={() => setLibOpen(false)} /> : null}
        </>
      ) : null}

      {browserOpen ? <BrowserSurface /> : null}
      {browserOpen && open ? <BrowserHeightSplitter asideRef={asideRef} /> : null}

      {/*
        拖动中的浮动标签（用户要的「实时位置预览」的文字部分）。
        位置跟随鼠标：pointermove 里直接改 style，不走 React state ——
        否则每移动一像素就重渲染整棵工具栏，拖拽会卡。
        插入位置那条线由各 .rp-slot 的 data-over 画（也在实时更新）。
      */}
      {draggingId ? (
        <div className="tool-drag-ghost" data-testid="tool-drag-ghost" ref={ghostRef}>
          {ghostLabel}
        </div>
      ) : null}

      {open ? (
        <div className="rp-body" data-testid="rp-body">
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

/* 浏览器高度分隔条
   只在浏览器与工具栏同时显示时出现。拖动时直接改 aside 上的
   `--h-browser`（CSS 变量，零重渲染）；松手才把最终值落盘。
   双击复原成设计默认（55%）。 */
function BrowserHeightSplitter({ asideRef }: { asideRef: React.RefObject<HTMLElement | null> }) {
  const t = useT()
  const patchSettings = useStore((s) => s.patchSettings)
  const [dragging, setDragging] = useState(false)
  const startRef = useRef<{ y: number; base: number } | null>(null)

  /** 浏览器区域当前高度（从真实布局量，避免再维护一份 state） */
  const browserEl = (): HTMLElement | null =>
    asideRef.current?.querySelector('.browser-surface') as HTMLElement | null
  /* 与主进程夹的区间一致（主进程会再夹一次，防脏值） */
  const clamp = (h: number): number => {
    const available = (asideRef.current?.clientHeight ?? 900) - 140
    return Math.round(Math.min(Math.max(120, available), Math.max(120, h)))
  }

  const onDown = (e: React.PointerEvent<HTMLButtonElement>): void => {
    if (e.button !== 0) return
    const el = browserEl()
    if (!el) return
    e.preventDefault()
    startRef.current = { y: e.clientY, base: el.getBoundingClientRect().height }
    setDragging(true)
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* 拿不到 capture 也能拖 */
    }
    document.body.classList.add('resizing')
  }

  const onMove = (e: React.PointerEvent<HTMLButtonElement>): void => {
    const st = startRef.current
    if (!st || !asideRef.current) return
    const next = clamp(st.base + (e.clientY - st.y))
    asideRef.current.style.setProperty('--h-browser', `${next}px`)
  }

  const onUp = (e: React.PointerEvent<HTMLButtonElement>): void => {
    const st = startRef.current
    if (!st) return
    startRef.current = null
    setDragging(false)
    document.body.classList.remove('resizing')
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    const h = browserEl()?.getBoundingClientRect().height ?? 0
    if (h > 0) void patchSettings({ browserHeight: clamp(h) })
  }

  const reset = (): void => {
    asideRef.current?.style.removeProperty('--h-browser')
    void patchSettings({ browserHeight: 0 })
  }

  return (
    <button
      className={`browser-splitter ${dragging ? 'on' : ''}`}
      title={t('browser.resizeHint')}
      aria-label={t('browser.resizeHint')}
      role="separator"
      aria-orientation="horizontal"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={reset}
      data-testid="browser-splitter"
    />
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

    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.rp-slot') as HTMLElement | null
    const targetId = target?.dataset.toolId as ToolSectionId | undefined
    setToolDropTarget(null)
    if (!target || !targetId || targetId === id) return

    // 放在目标之前还是之后：用指针在目标盒子里的相对位置决定
    const r = target.getBoundingClientRect()
    onMove(id, targetId, e.clientY > r.top + r.height / 2)
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
      className={`rp-slot ${dragging ? 'dragging' : ''} tool-drag-from-lib`}
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
  const refresh = useCallback(async () => {
    if (!provider) return
    setLoading(true)
    try { setQuota(await window.yan.providerQuota(provider, budget)) } finally { setLoading(false) }
  }, [provider, budget])
  useEffect(() => { setQuota(null); void refresh() }, [refresh])
  const amount = quota?.remaining
  /**
   * 百分比口径（ChatGPT 订阅的用量接口只给 used_percent）。
   * 用 PERCENT 这个伪币种传递 —— 它不能走 money()，否则会显示成 “$28.00”。
   */
  const isPercent = (quota?.currency ?? '').toUpperCase() === 'PERCENT'
  const pctText = (v: number): string => `${Math.round(v)}%`
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
  const isCodex = provider === 'openai-codex'
  const codexReset = (w: QuotaWindow): string => {
    if (!w.resetAt) return ''
    // 短窗口显示剩余时长，周窗口显示具体的重置日期。
    if (w.id === 'primary') {
      const seconds = Math.max(0, Math.ceil((w.resetAt - Date.now()) / 1000))
      const hours = Math.floor(seconds / 3600)
      const minutes = Math.floor((seconds % 3600) / 60)
      return hours ? `${hours}小时${minutes}分后` : `${Math.max(1, minutes)}分钟后`
    }
    return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(w.resetAt))
  }
  return (
    <Section titleKey="rp.quota" testId="rp-quota">
      <div className="rp-kv">
        <span className="rp-k">{provider || '—'}</span><span className="spacer" />
        {isCodex ? (
          <button className="rp-btn" onClick={() => void refresh()} disabled={loading}>{loading ? '…' : t('quota.refresh')}</button>
        ) : (
          <span className={`rp-v big ${quota?.windows?.some((w) => w.exceeded) ? 'err' : ''}`}>
            {amount !== undefined
              ? money(amount, quota?.currency)
              : quota?.used !== undefined
                ? `${money(quota.used, quota?.currency)} ${isPercent ? t('quota.usedPct') : t('quota.used')}`
                : loading
                  ? '…'
                  : '—'}
          </span>
        )}
      </div>
      {/* Codex 的套餐名、短窗口和周窗口按官网的阅读顺序分开显示。 */}
      {quota?.label ? <div className={isCodex ? 'rp-quota-plan' : 'rp-dim'}>{quota.label}{!isCodex && !quota.windows?.length && quota.total ? ` · ${money(quota.used ?? 0, quota.currency)} / ${money(quota.total, quota.currency)}` : ''}</div> : null}
      {quota?.error ? <div className="rp-dim">{quota.supported ? quota.error : t('quota.unsupported')}</div> : null}
      {quota?.windows?.length ? (
        <div className="rp-quota-wins">
          {quota.windows.map((w) => {
            const left = Math.max(0, w.total - w.used)
            const pct = w.total > 0 ? Math.min(100, (w.used / w.total) * 100) : 0
            const tone = w.exceeded ? 'err' : pct >= 85 ? 'warn' : 'ok'
            const reset = isCodex ? codexReset(w) : w.resetAt ? new Date(w.resetAt).toLocaleString() : ''
            return (
              <div key={w.id} className="rp-quota-win" data-testid={`quota-win-${w.id}`}>
                <div className="rp-kv">
                  <span className="rp-k">{w.label}</span>
                  <span className="spacer" />
                  <span className={`rp-v ${w.exceeded ? 'err' : ''}`}>{pct.toFixed(pct < 10 ? 1 : 0)}%</span>
                  {/* 百分比口径下不再重复 “28% / 100%”（读起来是噪声） */}
                  {isPercent ? null : <span className="rp-u">{money(left, quota.currency)} / {money(w.total, quota.currency)}</span>}
                </div>
                <div className={`rp-meter ${tone}`} title={reset ? `${t('quota.resetAt')} ${reset}` : undefined}>
                  <i style={{ width: `${pct}%` }} />
                </div>
                {w.exceeded ? (
                  <div className="rp-dim err" data-testid={`quota-win-${w.id}-reached`}>{t('quota.limitReached')}{reset ? ` · ${t('quota.resetAt')} ${reset}` : ''}</div>
                ) : reset ? (
                  <div className="rp-dim">{t('quota.resetAt')} {reset}</div>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
      <div className="rp-quota-actions">
        {!isCodex ? <button className="rp-btn" onClick={() => void refresh()} disabled={loading}>{t('quota.refresh')}</button> : null}
        {/* 月预算只适用于按量计费的 openai 平台 key；订阅制（codex）没有这个概念 */}
        {provider === 'openai' ? <button className="rp-btn" onClick={() => {
          const value = window.prompt(t('quota.budgetPrompt'), budget ? String(budget) : '')
          if (value === null) return
          const n = Number(value)
          if (!Number.isFinite(n) || n <= 0) return
          void patchSettings({ providerBudgets: { ...(settings?.providerBudgets ?? {}), [provider]: n } })
        }}>{t('quota.setBudget')}</button> : null}
      </div>
    </Section>
  )
}

/** 常用币种符号；没有的币种就退回 “9.92 CNY” 这种写法（不猜符号） */
const CURRENCY_SYMBOL: Record<string, string> = { USD: '$', CNY: '¥', EUR: '€', GBP: '£', JPY: '¥' }

function ContextSection() {
  const t = useT()
  const stats = useStore((s) => s.stats)
  const messages = useStore((s) => s.messages)
  const session = useStore((s) => s.session)
  const cu = stats?.contextUsage
  const win = cu?.contextWindow ?? session?.model?.contextWindow ?? 0
  /*
   * pi 在「刚压缩完、还没有下一条带 usage 的助手消息」时会**故意**把
   * tokens / percent 报成 null（见 pi 的 getContextUsage：latestCompaction 之后
   * 找不到新的 usage 就返回 null）。
   *
   * 所以这里不能用 `?? 0` —— 那会把它显示成「0 tokens / 0.0% 已用」，
   * 看起来像是进度条坏了（用户报的「手动压缩后不显示进度」）。
   * 区分「未知」与「真的是 0」是这里的核心。
   */
  const known = typeof cu?.tokens === 'number'
  const used = known ? (cu?.tokens as number) : 0
  const pct = known ? (cu?.percent ?? (used && win ? (used / win) * 100 : 0)) : 0
  const tone = pct >= 95 ? 'err' : pct >= 85 ? 'warn' : 'ok'
  const tokens = used
  const cost = [...messages].reverse().find((m) => m.role === 'assistant' && m.usage)?.usage?.cost ?? 0

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

  return (
    <Section titleKey="rp.context" testId="rp-context">
      <div className="rp-context-summary">
        <span><strong>{known ? nf.format(tokens) : '—'}</strong> {t('rp.tokens')}</span>
        <span className={known ? tone : ''}><strong>{known ? pct.toFixed(1) + '%' : '—'}</strong> {t('rp.used')}</span>
      </div>

      <div className={`rp-meter ${known ? tone : 'unknown'}`} title={known ? t('ctx.tip', {
        used: nf.format(used),
        win: nf.format(win),
        pct: pct.toFixed(1)
      }) : t('ctx.afterCompact')}>
        <i style={{ width: `${Math.min(100, pct)}%` }} />
        {/*
         * 自动压缩的触发线画在进度条上，而不只写一个数字 ——
         * 用户真正想知道的是「离那条线还有多远」，那就把线画出来。
         */}
        {compact?.enabled && thresholdPct > 0 && thresholdPct < 100 ? (
          <b
            className="rp-threshold"
            data-testid="ctx-threshold-mark"
            style={{ left: `${thresholdPct}%` }}
            title={t('ctx.thresholdTip', { n: nf.format(compact.threshold) })}
          />
        ) : null}
      </div>

      {/*
        自动压缩的触发点**只在进度条上画一条记号**（用户要求）：
        「不要显示自动压缩还差多少多少多少，在进度条上有记号即可」。
        记号右边还有一行说明 —— 但只在**已经过线**时才出现
        （那时它是警告，不是冗余信息）。
      */}
      {compact?.enabled && untilCompact <= 0 ? (
        <div className="rp-kv" data-testid="ctx-compaction">
          <span className="rp-k">{t('ctx.autoCompact')}</span>
          <span className="spacer" />
          <span className="rp-v warn">{t('ctx.atCompact')}</span>
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
        <div className="rp-kv" data-testid="ctx-unknown">
          <span className="rp-k">{t('ctx.afterCompactK')}</span>
          <span className="spacer" />
          <span className="rp-v">{t('ctx.afterCompact')}</span>
        </div>
      ) : null}

      {session?.isCompacting ? (
        <div className="rp-kv rp-warn" data-testid="rp-compacting">
          <span className="rp-now-spin" aria-hidden>
            <Spinner />
          </span>
          <span className="rp-text">{t('status.compacting')}</span>
        </div>
      ) : null}

      {/* 累计花费：与其它 rp-kv 一致 —— 标注靠左、数值靠右（对齐） */}
      <div className="rp-kv" data-testid="ctx-cost">
        <span className="rp-k">{t('rp.spent')}</span>
        <span className="spacer" />
        <span className="rp-v">${cost.toFixed(4)}</span>
      </div>
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
 *      判定 = 第一个未完成的（列表本来就是顺序执行的）。
 *      它带一个转动的 spinner + 左条强调色 + 名字高亮。
 *   ③ 动画：
 *      · 进度条宽度变化用 transition（不是瞬跳）
 *      · 刚被勾完的那一条闪一下（确认反馈）
 *      · 当前条目的左条呼吸 + 进度条上有一道扫光
 */
function TodoSection() {
  const t = useT()
  const todos = useStore((s) => s.todos)
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
  // 当前正在做的 = 第一个未完成的
  const activeIdx = todos.findIndex((x) => !x.done)
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
              className={`rp-todo ${todo.done ? 'done' : 'todo-open'} ${isActive ? 'active' : ''} ${justDone.has(i) ? 'flash' : ''}`}
              style={{ '--i': i } as React.CSSProperties}
              data-done={todo.done ? '1' : '0'}
              data-active={isActive ? '1' : '0'}
              title={todo.text}
            >
              <span className="rp-box" aria-hidden>
                {todo.done ? '✓' : ''}
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
          {[...queue.steering, ...queue.followUp].map((q, i) => (
            <div key={i} className="rp-queued-row" title={q}>
              <span className="rp-queued-dot" />
              <span className="rp-text">{q}</span>
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
  const compact = useStore((s) => s.compact)
  const copyLastReply = useStore((s) => s.copyLastReply)
  const abortRetry = useStore((s) => s.abortRetry)
  const exportHtml = useStore((s) => s.exportHtml)
  const clone = useStore((s) => s.clone)
  const session = useStore((s) => s.session)
  const streaming = !!session?.isStreaming

  return (
    <Section titleKey="rp.actions" testId="rp-actions" defaultOpen={false}>
      <div className="rp-acts">
        <Act onClick={() => void compact()} disabled={streaming} labelKey="rp.actCompact" testId="act-compact" />
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
