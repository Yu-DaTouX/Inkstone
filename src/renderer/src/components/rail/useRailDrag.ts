import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useStore } from '../../state/store'
import { beforeFromDrop, orderAfterDrag } from '../../../../shared/rail-order'
import type { AppSettings, ProjectGroup, ProjectRecord } from '../../../../shared/ipc'
import { splitDropHit, useSplitDrop } from '../../state/split-drop'
import { openInSplit } from './SessionRow'

/**
 * 拖拽排序（N01）的距离阈值（px）。
 *
 * 为什么要阈值：项目行同时是「切项目」按钮、分组标题里的名字也能被点 ——
 * 按下就进入拖拽会让单击全部失效。超过这个距离才当拖拽，没超过一律当点击。
 */
const DRAG_THRESHOLD = 4

type DragKind = 'project' | 'group' | 'session'
/** 插入线落点：插在 `id` 这一行的**前**（after=false）或**后**（after=true） */
interface DropHint {
  kind: DragKind
  id: string
  after: boolean
}
/**
 * 「投放到某个容器」的落点（拖会话用）。
 *
 * 与 `DropHint`（插入线，换顺序）是两回事：会话是**归属**变更 ——
 * 拖到某个项目行 = 移入该项目，拖到「全局」行 = 移回默认位置。
 * 这里不存在「插在某一行的上/下半」的含义。
 */
interface DropInto {
  /** 容器 key：`project:<id>` 或 `global:<cwd>` */
  key: string
  /** 目标项目 id；null = 默认位置（全局） */
  projectId: string | null
}
/** 一次拖拽会话（存在 ref 里，pointermove 高频且回调要读最新值） */
interface DragSession {
  kind: DragKind
  id: string
  /** 项目所属分组；落点必须同组（跨组是归属变更，走右键菜单） */
  groupId: string
  /** 会话拖拽：出发时所在的容器 key（拖回同一个容器 = 无操作） */
  from: string
  startX: number
  startY: number
  /** 是否已越过阈值、真正进入拖拽态 */
  active: boolean
}

/**
 * 左栏拖拽：项目 / 分组换序、会话改归属、会话拖进工作区右半边分屏。
 *
 * 只管指针交互与落盘，不画任何东西；左栏据返回的 `dragItem / dropHint / dropInto`
 * 给行加视觉态，行上的 `onPointerDown` 调 `beginDrag`。
 */
export function useRailDrag({ query, projectsOpen, displayProjects, projectRecords, projectGroups, patchSettings, expandAllProjects }: {
  query: string
  projectsOpen: boolean
  /** 屏幕上从上到下的项目；只用到 projectId */
  displayProjects: ReadonlyArray<{ projectId?: string }>
  projectRecords: ProjectRecord[]
  projectGroups: ProjectGroup[]
  patchSettings: (p: Partial<AppSettings>) => Promise<void>
  /** 折叠态下进入拖拽就全部展开，否则拖不到看不见的行 */
  expandAllProjects: () => void
}) {
  /*
   * ------------------------------------------------------------------
   * 拖拽排序（N01）
   *
   * 为什么自己写指针拖拽而不用 HTML5 的 `draggable`：
   *   · 原生 dragstart/dragover 在自动化里只能靠底层接口合成，
   *     而本项目的验收铁律是「在真实窗口里跑出来」；
   *   · 原生拖拽的拖影 / dropEffect 跳平台不一致。
   * 用 pointerdown / move / up + elementFromPoint，行为全由这里的代码决定，
   * 探针合成 PointerEvent 就能走同一条路径。
   *
   * 与「搜索」「前五项折叠」的关系（互斥）：
   *   · 搜索态下列表是筛过的，拖出来的顺序不代表真实排列 → 不允许拖；
   *   · 折叠态下看不到第 6 个以后的项目 → 真正开始拖就自动展开，
   *     否则会出现「拖不到看不见的行」。
   * ------------------------------------------------------------------
   */
  /** 拖拽中的行（用于 `.is-dragging` 视觉态）；null = 没在拖 */
  const [dragItem, setDragItem] = useState<{ kind: DragKind; id: string } | null>(null)
  /** 插入线落点 */
  const [dropHint, setDropHint] = useState<DropHint | null>(null)
  /** 会话拖拽的投放目标（项目行 / 全局行） */
  const [dropInto, setDropInto] = useState<DropInto | null>(null)
  /** 拖拽会话（事件回调是 pointerdown 那一刻的闭包，必须经 ref 读最新值） */
  const dragRef = useRef<DragSession | null>(null)
  const dropHintRef = useRef<DropHint | null>(null)
  const dropIntoRef = useRef<DropInto | null>(null)
  /**
   * 屏幕上真实渲染出来的分组顺序。
   * **不等于** `projectGroups`：没有项目的分组根本不渲染标题（标题是跟着
   * 第一个项目行出来的），拿 `projectGroups` 排会出现「拖了没反应」。
   */
  const renderedGroupIds = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const project of displayProjects) {
      const gid = project.projectId ? projectRecords.find((record) => record.id === project.projectId)?.groupId : undefined
      if (gid && !seen.has(gid)) {
        seen.add(gid)
        out.push(gid)
      }
    }
    return out
  }, [displayProjects, projectRecords])
  /** 落盘时要用的「当前排列」快照（pointerup 读它，保证不是旧渲染的数组） */
  const orderRef = useRef({ projects: displayProjects, groups: renderedGroupIds })
  useEffect(() => {
    orderRef.current = { projects: displayProjects, groups: renderedGroupIds }
  }, [displayProjects, renderedGroupIds])
  /* 组件卸载（拖拽中切走）时别把类名留在 body 上 */
  useEffect(() => () => document.body.classList.remove('rail-dragging'), [])

  /** 同步落点：state 给渲染用，ref 给 pointerup 用 */
  const setHint = (hint: DropHint | null): void => {
    dropHintRef.current = hint
    setDropHint(hint)
  }

  /** 同上，用于会话拖拽的投放目标 */
  const setInto = (into: DropInto | null): void => {
    dropIntoRef.current = into
    setDropInto(into)
  }

  /** 拆掉监听与视觉态；`keepSession` = 把会话留给随后的 click 消费（见 consumeDragClick） */
  function cleanupDrag(keepSession: boolean): void {
    window.removeEventListener('pointermove', onDragMove)
    window.removeEventListener('pointerup', onDragUp)
    window.removeEventListener('pointercancel', onDragCancel)
    window.removeEventListener('keydown', onDragKey)
    document.body.classList.remove('rail-dragging')
    useSplitDrop.getState().set({ dragging: false, zone: null, at: null })
    setDragItem(null)
    setHint(null)
    setInto(null)
    if (!keepSession) dragRef.current = null
  }

  /**
   * 会话拖拽的落点：指针下的「容器」（项目行 / 全局行）。
   *
   * 为什么用 `closest('[data-drop-into]')` 而不是看插入线：会话是归属变更，
   * 行内嵌套很多（会话行在项目行下方），指针落在会话行上时也要能命中它所属的项目行
   * —— 与 `DropHint` 只认同类行不同。
   */
  function intoAt(x: number, y: number): DropInto | null {
    const under = document.elementFromPoint(x, y) as HTMLElement | null
    const row = under?.closest<HTMLElement>('[data-drop-into]')
    const key = row?.dataset.dropInto
    if (!row || !key) return null
    return { key, projectId: key.startsWith('project:') ? key.slice('project:'.length) : null }
  }

  /** 指针落在哪一行上：上半 → 插到它之前；下半 → 插到它之后 */
  function hintAt(x: number, y: number, session: DragSession): DropHint | null {
    const under = document.elementFromPoint(x, y) as HTMLElement | null
    const row = under?.closest<HTMLElement>(`[data-drag-kind="${session.kind}"]`)
    const id = row?.dataset.dragId
    if (!row || !id || id === session.id) return null
    /*
     * 项目只在**同一个分组内**换位，跨组的落点一律不接受。
     * 「把项目移到另一个分组」是归属变更（右键菜单里已有明确入口），
     * 让拖拽同时表示「换组」和「换序」会让一次误拖悄悄改掉归属。
     */
    if (session.kind === 'project' && (row.dataset.dragGroup ?? '') !== session.groupId) return null
    const rect = row.getBoundingClientRect()
    return { kind: session.kind, id, after: y > rect.top + rect.height / 2 }
  }

  function onDragMove(e: PointerEvent): void {
    const session = dragRef.current
    if (!session) return
    if (!session.active) {
      if (Math.hypot(e.clientX - session.startX, e.clientY - session.startY) < DRAG_THRESHOLD) return
      session.active = true
      /* 折叠态下后面的行不可见 —— 进入拖拽就展开，否则拖不过去 */
      expandAllProjects()
      setDragItem({ kind: session.kind, id: session.id })
      document.body.classList.add('rail-dragging')
    }
    e.preventDefault()
    if (session.kind === 'session') {
      /* 进了工作区左 / 右半边 = 分屏落点，不再当成「改归属」 */
      const hit = splitDropHit(e.clientX, e.clientY)
      useSplitDrop.getState().set({ dragging: true, zone: hit?.zone ?? null, at: hit?.at ?? null })
      setInto(hit ? null : intoAt(e.clientX, e.clientY))
    } else setHint(hintAt(e.clientX, e.clientY, session))
  }

  function onDragUp(): void {
    const session = dragRef.current
    const hint = dropHintRef.current
    const into = dropIntoRef.current
    const toAt = useSplitDrop.getState().at
    cleanupDrag(true)
    if (!session?.active) return
    if (session.kind === 'session' && toAt !== null) {
      const target = useStore.getState().sessions.find((x) => x.id === session.id)
      if (target) openInSplit(target, toAt)
      return
    }
    /*
     * 会话：拖到项目行 / 全局行 → 改归属。
     * 拖回出发时所在的容器（或没拖到任何容器）= 无操作，不发 IPC。
     */
    if (session.kind === 'session') {
      if (!into || into.key === session.from) return
      void useStore.getState().moveSession(session.id, into.projectId)
      return
    }
    if (!hint) return
    const { projects: list, groups } = orderRef.current
    if (session.kind === 'group') {
      const nextIds = orderAfterDrag(groups, session.id, beforeFromDrop(groups, hint.id, hint.after))
      if (nextIds.join('\u0000') === groups.join('\u0000')) return
      const byId = new Map(projectGroups.map((group) => [group.id, group]))
      const ordered = nextIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
      /* 没渲染的分组（暂时没项目）保持相对位置跟在后面，不能丢 */
      const rest = projectGroups.filter((group) => !nextIds.includes(group.id))
      void patchSettings({ projectGroups: [...ordered, ...rest] })
      return
    }
    const ids = list.flatMap((project) => (project.projectId ? [project.projectId] : []))
    const nextIds = orderAfterDrag(ids, session.id, beforeFromDrop(ids, hint.id, hint.after))
    if (nextIds.join('\u0000') === ids.join('\u0000')) return
    void patchSettings({ projectOrder: nextIds })
  }

  function onDragCancel(): void {
    cleanupDrag(false)
  }

  function onDragKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return
    e.preventDefault()
    cleanupDrag(false)
  }

  /**
   * 开始一次可能的拖拽。
   *
   * 不在这里 preventDefault：项目行整行也是「切到该项目」的按钮，
   * 按下就拦掉会让单击失效 —— 只有越过阈值、真正进入拖拽后才接管。
   */
  function beginDrag(e: ReactPointerEvent, kind: DragKind, id: string, groupId = '', from = ''): void {
    if (e.button !== 0) return
    if (query) return
    if (!projectsOpen) return
    const target = e.target as HTMLElement
    /*
     * 行内的按钮 / 输入框有自己的语义，不要让拖拽把它们吃掉。
     * 会话行的「主体」正好就是一个 button（`.srow`），所以**不能**对会话
     * 用同一条排除规则 —— 否则整个会话行都拖不动。那里只排除行内的
     * 操作按钮（⋯ / 分叉开关）与重命名输入框。
     */
    if (kind === 'session') {
      if (target.closest('.srow-acts, .srow-btoggle, input')) return
    } else if (target.closest('button:not(.proj-pick), input, [role="button"]')) return
    dragRef.current = { kind, id, groupId, from, startX: e.clientX, startY: e.clientY, active: false }
    window.addEventListener('pointermove', onDragMove)
    window.addEventListener('pointerup', onDragUp)
    window.addEventListener('pointercancel', onDragCancel)
    window.addEventListener('keydown', onDragKey)
  }

  /**
   * 拖拽结束后紧跟而来的 click 不该再当成「点这一行」。
   *
   * click 一定在 pointerup 之后、下一次 pointerdown 之前派发，所以在 click
   * 处理器里读到「上一次拖拽仍活着」就吞掉它，然后清掉标记。
   * 用时间戳不行 —— 拖完立刻点同一行会被误吞。
   */
  function consumeDragClick(): boolean {
    if (!dragRef.current?.active) return false
    dragRef.current = null
    return true
  }

  return { dragItem, dropHint, dropInto, beginDrag, consumeDragClick }
}
