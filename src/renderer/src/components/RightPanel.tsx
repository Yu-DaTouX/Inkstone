import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../icons/Icon'
import { useT } from '../i18n'
import type { MessageKey } from '../i18n'
import { Section } from './ToolSection'
import { useStore } from '../state/store'
import { TOOL_SECTIONS, type QueueMode, type ToolSectionId } from '../../../shared/ipc'
import { HandleProvider } from './ToolSection'
import { ToolLibrary } from './ToolLibrary'
import { FileTree } from './FileTree'
import { Resizer } from './Resizer'

/**
 * 右栏 —— 常驻状态栏。
 *
 * 布局参考 OpenCode 的右侧栏（用户给的截图）：一串**小分区的堆叠**，
 * 每块只讲一件事，没有图表没有装饰：
 *
 *   上下文   用了多少 / 占了多少 / 花了多少
 *   任务      agent 的 panel_todos（与 TUI 的 /panel 同一份）
 *   队列      待投递的插话 + 投递模式（pi 的 set_steering_mode / set_follow_up_mode）
 *   文件      项目文件树（点一下 = 往输入框插 @路径）
 *   扩展      扩展的 setStatus / setWidget（真实数据，不再丢掉）
 *   日志      pi stderr + 扩展通知（原来挤在中栏底部，用户要求搬过来）
 *   操作      pi 自带能力的入口
 *
 * ── 本次的两处改动（用户要求）──
 * · **去掉「环境」分区**（pi 版本 / 模型 / 计数 / 热键提示）：
 *   这些都不需要在右栏常驻 —— 模型在标题栏、热键在设置里、
 *   pi 版本在设置→关于。而且它的工作目录一行与文件树的根重复。
 * · **加文件树**：见 FileTree.tsx。
 *
 * 为什么不照抄 OpenCode 的分区名（MCP / LSP）：
 *   pi 没有 MCP 与 LSP 这两个概念，硬写上去就是**编状态**。
 *   这份界面里出现的每个数字都必须真的来自某个地方
 *   （这就是为什么「已同步 · 桌面·笔记本·手机」那条被从标题栏删掉了）。
 *
 * 默认展开，可以收起 —— 收起后宽度归零，中栏内容重新居中（不是盖上去的浮层）。
 */
export function RightPanel() {
  const t = useT()
  const open = useStore((s) => s.settings?.rightPanelOpen ?? true)
  const toggle = useStore((s) => s.toggleRightPanel)
  const order = useStore((s) => s.settings?.toolOrder)
  const hidden = useStore((s) => s.settings?.toolHidden)
  const setToolLayout = useStore((s) => s.setToolLayout)
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

  /*
   * 收起时不再返回 null —— 而是留一个**窄把手**：
   * 面板开关已经搬到面板自己的头部（用户要求），
   * 如果收起后什么都不留，就没办法再展开了。
   * 这也是左右对称的：左栏收起后有头部那个开关。
   */
  if (!open) {
    return (
      <aside className="rightstub" data-testid="rightstub">
        <button
          className="rp-x"
          onClick={() => void toggle()}
          title={t('rp.show')}
          data-testid="rightpanel-toggle"
          data-open="0"
        >
          <Icon name="sidebar-right" size={12} />
        </button>
      </aside>
    )
  }

  return (
    <aside className="rightpanel" data-testid="rightpanel">
      {/*
       * 宽度把手放在 aside **内部**并绝对定位。
       * 不能作为 .workspace 的 grid 子元素 —— 那会多出一列，
       * grid-template-columns 只有三列的定义（本项目的列宽踩过坑，见 redesign.css §23b）。
       */}
      <Resizer side="panel" />
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
        <button
          className="rp-x"
          onClick={() => void toggle()}
          title={t('rp.hide')}
          data-testid="rightpanel-hide"
        >
          <Icon name="sidebar-right" size={12} />
        </button>
      </div>

      {libOpen ? <ToolLibrary onClose={() => setLibOpen(false)} /> : null}

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
    </aside>
  )
}

/* ==================================================================
   分区插槽 —— 把「注册表 + 排序」与各分区自己的渲染分开
   ================================================================== */

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
  const [over, setOver] = useState<'before' | 'after' | null>(null)
  const ref = useRef<HTMLDivElement>(null)

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
          setOver(null)
          return
        }
        setOver(e.clientY < r.top + r.height / 2 ? 'before' : 'after')
        return
      }
    }
    setOver(null)
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
    setOver(null)
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
      data-over={over ?? ''}
      data-tool-id={id}
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
  }
> = {
  context: { Body: () => <ContextSection /> },
  todo: {
    isEmpty: (s) => s.todos.length === 0,
    Extra: () => <TodoCount />,
    Body: () => <TodoSection />
  },
  queue: { Body: () => <QueueSection /> },
  files: { Body: () => <FileTree /> },
  ext: {
    isEmpty: (s) => Object.keys(s.statuses).length === 0 && Object.keys(s.widgets).length === 0,
    Body: () => <ExtSection />
  },
  log: {
    isEmpty: (s) => s.logs.length === 0,
    Extra: () => <LogCount />,
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

/* ==================================================================
   一个可折叠的小分区 —— 右栏所有块共用
   ================================================================== */

/* ==================================================================
   上下文 —— 用多少 / 占多少 / 花了多少
   ================================================================== */

function ContextSection() {
  const t = useT()
  const stats = useStore((s) => s.stats)
  const session = useStore((s) => s.session)
  const cu = stats?.contextUsage
  const used = cu?.tokens ?? 0
  const win = cu?.contextWindow ?? session?.model?.contextWindow ?? 0
  const pct = cu?.percent ?? (used && win ? (used / win) * 100 : 0)
  const tone = pct >= 95 ? 'err' : pct >= 85 ? 'warn' : 'ok'
  const tokens = stats?.tokens.total ?? 0
  const cost = stats?.cost ?? 0

  const nf = new Intl.NumberFormat('en-US')

  return (
    <Section titleKey="rp.context" testId="rp-context">
      <div className="rp-kv">
        <span className="rp-k" />
        <span className="rp-v big">{nf.format(tokens)}</span>
        <span className="rp-u">{t('rp.tokens')}</span>
      </div>
      <div className="rp-kv">
        <span className="rp-k" />
        <span className={`rp-v ${tone}`}>{pct.toFixed(pct < 10 ? 1 : 0)}%</span>
        <span className="rp-u">{t('rp.used')}</span>
      </div>

      <div className={`rp-meter ${tone}`} title={t('ctx.tip', {
        used: nf.format(used),
        win: nf.format(win),
        pct: pct.toFixed(1)
      })}>
        <i style={{ width: `${Math.min(100, pct)}%` }} />
      </div>

      {/*
       * 压缩中 —— 从中栏底部的状态条搬过来的。
       * 放在上下文分区是因为它本来就是上下文的事（快满了才压缩），
       * 而且这样中栏底部那一条就能整个去掉（用户嫌它挤，见 rp 文件头注释）。
       */}
      {session?.isCompacting ? (
        <div className="rp-kv rp-warn" data-testid="rp-compacting">
          <span className="rp-now-spin" aria-hidden>
            <Spinner />
          </span>
          <span className="rp-text">{t('status.compacting')}</span>
        </div>
      ) : null}

      <div className="rp-kv">
        <span className="rp-k" />
        <span className="rp-v">${cost.toFixed(2)}</span>
        <span className="rp-u">{t('rp.spent')}</span>
      </div>
    </Section>
  )
}

/* ==================================================================
   任务 —— 来自会话里的 custom entry（panel_todos）
   ================================================================== */

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
  const done = useMemo(() => todos.filter((x) => x.done).length, [todos])

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
      {active ? (
        <div className="rp-todo-now" data-testid="todo-now">
            <span className="rp-now-spin" aria-hidden>
              <Spinner />
            </span>
          <span className="rp-now-label">{t('rp.todoNow')}</span>
          <span className="rp-now-text">{active.text}</span>
        </div>
      ) : (
        <div className="rp-todo-all" data-testid="todo-all-done">
          <span className="rp-all-done">{t('rp.todoAllDone')}</span>
        </div>
      )}

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
               *   active    当前正在做
               *   flash     刚被勾完（闪一下）
               * `--i` 给 CSS 做逐行落位
               */
              className={`rp-todo ${todo.done ? 'done' : 'todo-open'} ${isActive ? 'active' : ''} ${justDone.has(i) ? 'flash' : ''}`}
              style={{ '--i': i } as React.CSSProperties}
              data-done={todo.done ? '1' : '0'}
              data-active={isActive ? '1' : '0'}
            >
              <span className="rp-box" aria-hidden>
                {todo.done ? '✓' : ''}
              </span>
              <span className="rp-text">{todo.text}</span>
              <span className="rp-state">
                {todo.done ? t('rp.done') : isActive ? t('rp.doing') : t('rp.open')}
              </span>
            </div>
          )
        })}
      </div>
    </Section>
  )
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

/* ==================================================================
   队列 —— pi 的投递模式 + 待投递内容
   ================================================================== */

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
  const modes: QueueMode[] = ['one-at-a-time', 'all']
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

/* ==================================================================
   扩展 —— setStatus / setWidget 的真实内容
   ================================================================== */

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

/* ==================================================================
   日志 —— pi 的 stderr + 扩展通知

   原来挤在中栏底部（.statusbar + .logdrawer），用户嫌它不美观。
   搬到右栏的理由：「状态」类信息本来就属于右栏（见文件头注释）。
   顺带把中栏底部整条去掉 —— 那个条只用干两件事：显示压缩中
   与当日志按钮，两件都搬走了就不需要它了。
   ================================================================== */

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

/* ==================================================================
   操作 —— pi 自带能力的入口
   ================================================================== */

function ActionsSection() {
  const t = useT()
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
