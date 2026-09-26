import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { useSidebarJson, useSidebarValue } from '../rail/sidebar-state'
import { shortProject } from '../rail/rail-utils'
import { buildSessionMap, type SessionMapLane, type SessionMapNode } from '../../../../shared/session-map'
import { SessionPreview } from './SessionPreview'
import { forkAt } from '../../lib/fork'

/**
 * 会话地图（日常模式的中栏视图）。
 *
 * 形态取自参考实现 dsh-synapse 的**思路**：按工作区分泳道、按分支深度分列、
 * 父子之间连线的可缩放画布。实现是砚自己的 React —— 不内嵌上游那份宿主耦合的
 * JS，也不自带侧栏（会话树在左栏，地图里重复一份会打架）。
 *
 * 分工：
 *   · `shared/session-map.ts` 负责投影（泳道 / 深度 / 边 / 折叠簇），纯逻辑；
 *   · 这里负责画布：相机（平移 / 缩放）、卡片位置、折叠子树、键盘遍历。
 *
 * 只读会话元数据；拖动、折叠、相机都是本机布局偏好，丢了不影响会话本身。
 */

interface Props {
  onOpen: (path: string) => void
  /** 分叉后要回到对话：那才是能接着编辑输入框的地方 */
  onBackToChat: () => void
}

/* 画布几何：列 = 分支深度，行 = 泳道内顺序。改这里要同时看 workbench.css */
const COL_W = 208
const NODE_W = 188
const NODE_H = 26
const ROW_H = 32
const TITLE_H = 26
const PAD_X = 14
const PAD_Y = 12
/* 折叠按钮贴在节点右端内侧；拖拽阈值（屏幕像素）区分点击与拖动 */
const FOLD_W = 18
const DRAG_THRESHOLD = 4
const MIN_ZOOM = 0.4
const MAX_ZOOM = 1.6
const ZOOM_STEP = 1.15

interface NodeBox {
  x: number
  y: number
}

interface Offset {
  x: number
  y: number
}

const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

export function SessionMap({ onOpen, onBackToChat }: Props): React.JSX.Element {
  const t = useT()
  const sessions = useStore((s) => s.sessions)
  const session = useStore((s) => s.session)
  const settings = useStore((s) => s.settings)
  const runners = useStore((s) => s.runners)

  /* 置顶 / 未读沿用左栏那一份本地偏好：同一个会话在两处不该有两种标记 */
  const [pinned] = useSidebarValue<string[]>('pinned', [])
  const [unread] = useSidebarValue<string[]>('unread', [])
  /* 用户点开的折叠簇泳道：只记键，不记节点 —— 会话被删除后键自然失效 */
  const [expandedLanes, setExpandedLanes] = useSidebarValue<string[]>('map-expanded-lanes', [])
  /* 手动折叠的分支（记父会话路径）；与簇折叠是两件事：这个是用户在地图里点的 */
  const [collapsed, setCollapsed] = useSidebarValue<string[]>('map-collapsed', [])
  /* 手动拖过的卡片位置（相对自动布局的偏移）；拖拽中不落盘，见 dragOffset */
  const [offsets, setOffsets] = useSidebarJson<Record<string, Offset>>('map-offsets', {})

  const [query, setQuery] = useState('')
  /* 预览哪个会话（地图内只读抽屉）；null = 没打开 */
  const [preview, setPreview] = useState<string | null>(null)
  const [forking, setForking] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [cam, setCam] = useState({ x: 0, y: 0 })
  const [panning, setPanning] = useState(false)
  const [dragOffset, setDragOffset] = useState<{ path: string; x: number; y: number } | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)

  const bodyRef = useRef<HTMLDivElement>(null)
  const nodeRefs = useRef(new Map<string, HTMLDivElement>())
  const panRef = useRef<{ px: number; py: number; cx: number; cy: number } | null>(null)
  const dragRef = useRef<{ path: string; px: number; py: number; o: Offset; moved: boolean } | null>(null)
  const suppressClick = useRef<string | null>(null)
  /* 拖拽中的最新位置：state 是异步的，松手那一帧读到的可能是旧值 */
  const dragLive = useRef<{ path: string; x: number; y: number } | null>(null)
  /* 原生 wheel 监听里要读最新相机（React 闭包里的值会过期） */
  const cameraRef = useRef({ zoom: 1, x: 0, y: 0 })
  const focusedOnce = useRef(false)

  const currentPath = session?.sessionFile

  const running = useMemo(
    () => runners.filter((r) => r.running && r.sessionFile).map((r) => r.sessionFile as string),
    [runners]
  )

  const projectNames = settings?.projectNames ?? {}
  const projects = settings?.projects ?? []
  const cwdByPath = useMemo(() => new Map(sessions.map((s) => [s.path, s.cwd])), [sessions])

  const map = useMemo(
    () =>
      buildSessionMap({
        sessions,
        currentPath,
        pinned,
        unread,
        running,
        currentProjectId: sessions.find((s) => s.path === currentPath)?.projectId,
        expandLanes: expandedLanes
      }),
    [sessions, currentPath, pinned, unread, running, expandedLanes]
  )

  const laneName = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p]))
    return (lane: SessionMapLane): string => {
      if (!lane.projectId) return t('map.laneGlobal')
      const project = byId.get(lane.projectId)
      if (project?.name) return project.name
      const cwd = lane.nodes.map((n) => cwdByPath.get(n.path)).find(Boolean)
      return (cwd && projectNames[cwd]) || (cwd && shortProject(cwd)) || t('map.laneGlobal')
    }
  }, [projects, projectNames, cwdByPath, t])

  /* 完整父子表（含被折叠的）：折叠子树与子树计数都基于它 */
  const childrenByPath = useMemo(() => {
    const all = new Map<string, string[]>()
    for (const e of map.edges) {
      const kids = all.get(e.from) ?? []
      kids.push(e.to)
      all.set(e.from, kids)
    }
    return all
  }, [map])

  /* 被折叠掉的后代（含多层）：这些节点不参与布局与连线 */
  const hiddenByFold = useMemo(() => {
    const hidden = new Set<string>()
    const stack = [...collapsed]
    while (stack.length > 0) {
      const path = stack.pop() as string
      for (const child of childrenByPath.get(path) ?? []) {
        if (hidden.has(child)) continue
        hidden.add(child)
        stack.push(child)
      }
    }
    return hidden
  }, [collapsed, childrenByPath])

  /* 子树大小（含自身）：折叠按钮的提示要说清藏了多少条 */
  const subtreeSize = useMemo(() => {
    const size = new Map<string, number>()
    const calc = (path: string, seen: Set<string>): number => {
      const cached = size.get(path)
      if (cached !== undefined) return cached
      if (seen.has(path)) return 0
      seen.add(path)
      let total = 1
      for (const child of childrenByPath.get(path) ?? []) total += calc(child, seen)
      seen.delete(path)
      size.set(path, total)
      return total
    }
    for (const n of map.nodes) calc(n.path, new Set())
    return size
  }, [map, childrenByPath])

  const layout = useMemo(() => {
    const positions = new Map<string, NodeBox>()
    const laneByPath = new Map<string, SessionMapLane>()
    const lanes: Array<{ lane: SessionMapLane; top: number; height: number; name: string; nodes: SessionMapNode[] }> = []
    let top = PAD_Y
    let right = 0
    for (const lane of map.lanes) {
      /* 折叠后重排行号：泳道会跟着变矮，不留空洞 */
      const nodes = lane.nodes
        .filter((n) => !hiddenByFold.has(n.path))
        .map((n, i) => ({ ...n, row: i }))
      const height = TITLE_H + Math.max(nodes.length, 1) * ROW_H + 4
      for (const n of nodes) {
        const live = dragOffset && dragOffset.path === n.path ? dragOffset : offsets[n.path]
        const x = PAD_X + n.depth * COL_W + (live?.x ?? 0)
        const y = top + TITLE_H + n.row * ROW_H + (ROW_H - NODE_H) / 2 + (live?.y ?? 0)
        positions.set(n.path, { x, y })
        laneByPath.set(n.path, lane)
        right = Math.max(right, x + NODE_W)
      }
      lanes.push({ lane, top, height, name: laneName(lane), nodes })
      top += height
    }
    /* 连线只画两端都还在的 */
    const edges = map.edges.filter((e) => positions.has(e.from) && positions.has(e.to))
    const visibleChildren = new Map<string, string[]>()
    for (const e of edges) {
      const kids = visibleChildren.get(e.from) ?? []
      kids.push(e.to)
      visibleChildren.set(e.from, kids)
    }
    return {
      positions,
      lanes,
      laneByPath,
      edges,
      childrenByPath: visibleChildren,
      width: right + PAD_X,
      height: top + PAD_Y
    }
  }, [map, laneName, hiddenByFold, offsets, dragOffset])

  const edgePaths = useMemo(() => {
    const out: string[] = []
    for (const e of layout.edges) {
      const from = layout.positions.get(e.from)
      const to = layout.positions.get(e.to)
      if (!from || !to) continue
      const x1 = from.x + NODE_W
      const y1 = from.y + NODE_H / 2
      const x2 = to.x
      const y2 = to.y + NODE_H / 2
      const mid = x1 + Math.max(12, (x2 - x1) / 2)
      out.push(`M${x1} ${y1} H${mid} V${y2} H${x2}`)
    }
    return out
  }, [layout])

  const needle = query.trim().toLowerCase()
  const currentNode = map.nodes.find((n) => n.current)

  useEffect(() => {
    cameraRef.current = { zoom, x: cam.x, y: cam.y }
  }, [zoom, cam])

  /* 把某个节点（默认当前会话）摆到视口中间 */
  const centerOn = useCallback(
    (path?: string): void => {
      const body = bodyRef.current
      if (!body) return
      const target = path ?? currentNode?.path ?? map.nodes[0]?.path
      const box = target ? layout.positions.get(target) : undefined
      if (!box) {
        setCam({ x: 0, y: 0 })
        return
      }
      setCam({
        x: body.clientWidth / 2 - (box.x + NODE_W / 2) * zoom,
        y: body.clientHeight / 2 - (box.y + NODE_H / 2) * zoom
      })
    },
    [currentNode?.path, layout.positions, map.nodes, zoom]
  )

  const fit = useCallback((): void => {
    const body = bodyRef.current
    if (!body) return
    const next = clampZoom(
      Math.min(body.clientWidth / (layout.width + 40), body.clientHeight / (layout.height + 40))
    )
    setZoom(next)
    setCam({
      x: (body.clientWidth - layout.width * next) / 2,
      y: (body.clientHeight - layout.height * next) / 2
    })
  }, [layout.width, layout.height])

  /* 整理 = 丢掉手动摆放，回到自动布局，并把相机复位 */
  const tidy = useCallback((): void => {
    setOffsets({})
    setZoom(1)
    setCam({ x: 0, y: 0 })
  }, [setOffsets])

  const zoomAt = useCallback((factor: number): void => {
    const body = bodyRef.current
    if (!body) return
    const { zoom: z, x, y } = cameraRef.current
    const next = clampZoom(z * factor)
    if (next === z) return
    const cx = body.clientWidth / 2
    const cy = body.clientHeight / 2
    const wx = (cx - x) / z
    const wy = (cy - y) / z
    setZoom(next)
    setCam({ x: cx - wx * next, y: cy - wy * next })
  }, [])

  /*
   * 滚轮：带 Ctrl/Cmd 缩放（以指针为锚点），否则平移 —— 画布没有滚动条，
   * 内容靠相机移动。必须用原生监听：React 的 onWheel 是 passive 的，
   * preventDefault 不会生效（实测页面会跟着缩放一起动）。
   */
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return undefined
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const rect = body.getBoundingClientRect()
        const lx = e.clientX - rect.left
        const ly = e.clientY - rect.top
        const { zoom: z, x, y } = cameraRef.current
        const next = clampZoom(z * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP))
        if (next === z) return
        const wx = (lx - x) / z
        const wy = (ly - y) / z
        setZoom(next)
        setCam({ x: lx - wx * next, y: ly - wy * next })
        return
      }
      e.preventDefault()
      setCam((c) => ({ x: c.x - e.deltaX, y: c.y - e.deltaY }))
    }
    body.addEventListener('wheel', onWheel, { passive: false })
    return () => body.removeEventListener('wheel', onWheel)
  }, [map.lanes.length])

  /* 首屏把当前会话带进视口（只做一次，之后听用户的） */
  useEffect(() => {
    if (focusedOnce.current || map.nodes.length === 0) return
    focusedOnce.current = true
    /* 没有当前会话就不动相机：左上角起画比凭空居中更自然 */
    if (!currentNode) return
    const timer = window.setTimeout(() => centerOn(currentNode.path), 0)
    return () => window.clearTimeout(timer)
  }, [map.nodes.length, currentNode?.path, centerOn])

  /* ---- 空白处拖动 = 移动相机 ---- */
  const onBodyPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('[data-testid="map-node"]') || target.closest('button') || target.closest('input')) return
    panRef.current = { px: e.clientX, py: e.clientY, cx: cam.x, cy: cam.y }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* 合成事件（探针）里 pointerId 不活跃：真实鼠标不会走到这里 */
    }
    setPanning(true)
  }

  const onBodyPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const pan = panRef.current
    if (!pan) return
    setCam({ x: pan.cx + (e.clientX - pan.px), y: pan.cy + (e.clientY - pan.py) })
  }

  const onBodyPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!panRef.current) return
    panRef.current = null
    setPanning(false)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* 指针已经不在这个元素上 */
    }
  }

  /* ---- 卡片拖动 = 摆位置（不移动子树，每张卡片各自记偏移） ---- */
  const onNodePointerDown = (e: React.PointerEvent<HTMLDivElement>, node: SessionMapNode): void => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('[data-testid="map-fold"]')) return
    const off = offsets[node.path] ?? { x: 0, y: 0 }
    dragRef.current = { path: node.path, px: e.clientX, py: e.clientY, o: off, moved: false }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* 同上：合成事件没有真实指针 */
    }
  }

  const onNodePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    const dx = e.clientX - drag.px
    const dy = e.clientY - drag.py
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      /* moved 记在 ref 上：同一帧里可能连着来好几次 move，state 还没更新 */
      drag.moved = true
      setDragging(drag.path)
    }
    const next = {
      path: drag.path,
      x: Math.round(drag.o.x + dx / zoom),
      y: Math.round(drag.o.y + dy / zoom)
    }
    dragLive.current = next
    setDragOffset(next)
  }

  const onNodePointerUp = (e: React.PointerEvent<HTMLDivElement>, node: SessionMapNode): void => {
    const drag = dragRef.current
    const live = dragLive.current
    dragRef.current = null
    dragLive.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* 指针已经不在这个元素上 */
    }
    if (drag && drag.moved && live && live.path === node.path) {
      /* 拖过才落盘：拖拽过程里的每一次移动都写 localStorage 会卡 */
      setOffsets((prev) => ({ ...prev, [node.path]: { x: live.x, y: live.y } }))
      suppressClick.current = node.path
    }
    setDragging(null)
    setDragOffset(null)
  }

  const toggleFold = (path: string): void => {
    setCollapsed((prev) => (prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]))
  }

  /* 预览的会话被删掉 / 迁走时自动关掉：否则会一直显示一份不存在的会话 */
  useEffect(() => {
    if (preview && !sessions.some((s) => s.path === preview)) setPreview(null)
  }, [sessions, preview])

  /*
   * 预览开着时 Esc 先关预览（不退出地图）。
   *
   * ⚠️ 不能靠“捕获阶段抢先”—— 两个监听器都挂在 window 上，
   * 而 App 的“退出地图”先注册，会先跑。所以由 App 那边看一眼
   * 地图里有没有抽屉（见 App.tsx 的 Esc 处理）主动让位。
   */
  useEffect(() => {
    if (!preview) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setPreview(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview])

  const handleFork = (entryId: string): void => {
    setForking(true)
    void forkAt(entryId)
      .then(() => onBackToChat())
      .finally(() => setForking(false))
  }

  /*
   * 键盘遍历：上下在同泳道内按 row 走，左右沿分支（父 / 首个子会话）。
   * 地图是纯视图，键盘可达与否直接决定它能不能只用键盘浏览。
   */
  const neighborOf = (node: SessionMapNode, keyName: string): string | undefined => {
    const lane = layout.lanes.find((l) => l.nodes.some((n) => n.path === node.path))
    if (keyName === 'ArrowDown') return lane?.nodes[node.row + 1]?.path
    if (keyName === 'ArrowUp') return lane?.nodes[node.row - 1]?.path
    if (keyName === 'ArrowLeft') return node.parentPath
    if (keyName === 'ArrowRight') return layout.childrenByPath.get(node.path)?.[0]
    return undefined
  }

  const onNodeKey = (e: React.KeyboardEvent<HTMLDivElement>, node: SessionMapNode): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      onOpen(node.path)
      return
    }
    /* 空格 = 看预览，Enter = 直接打开：键盘用户也能只预览不切换 */
    if (e.key === ' ') {
      e.preventDefault()
      setPreview(node.path)
      return
    }
    const next = neighborOf(node, e.key)
    if (!next) return
    e.preventDefault()
    nodeRefs.current.get(next)?.focus()
  }

  if (map.lanes.length === 0) {
    return (
      <div className="wb-map" data-testid="session-map">
        <header className="wb-map-head">
          <span className="wb-map-title">
            <Icon name="layers" size={14} />
            {t('map.title')}
          </span>
          <span className="wb-map-stats" />
        </header>
        <div className="wb-map-empty" data-testid="session-map-empty">
          <Icon name="layers" size={16} />
          {t('map.empty')}
        </div>
      </div>
    )
  }

  return (
    <div className="wb-map" data-testid="session-map">
      <header className="wb-map-head">
        <span className="wb-map-title">
          <Icon name="layers" size={14} />
          {t('map.title')}
        </span>
        <label className="wb-map-search">
          <Icon name="search" size={12} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('map.search')}
            aria-label={t('map.search')}
            data-testid="map-search"
          />
        </label>
        <span className="wb-map-stats" data-testid="session-map-stats">
          {t('map.stats', { lanes: map.stats.laneCount, nodes: map.stats.shown })}
          {map.stats.folded > 0 ? ` · ${t('map.foldedStat', { n: map.stats.folded })}` : ''}
        </span>
      </header>

      <div
        className={`wb-map-body ${panning ? 'panning' : ''}`}
        ref={bodyRef}
        onPointerDown={onBodyPointerDown}
        onPointerMove={onBodyPointerMove}
        onPointerUp={onBodyPointerUp}
        onPointerCancel={onBodyPointerUp}
      >
        <div
          className="wb-map-stage"
          style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${zoom})` }}
        >
          <div className="wb-map-canvas" style={{ width: layout.width, height: layout.height }}>
            <svg className="wb-map-edges" width={layout.width} height={layout.height} aria-hidden="true">
              {edgePaths.map((d) => (
                <path key={d} className="wb-edge" d={d} />
              ))}
            </svg>

            {layout.lanes.map(({ lane, top, height, name, nodes }) => (
              <div className="wb-lane" key={lane.key} style={{ top, height }} data-lane={lane.key}>
                <div className="wb-lane-title" title={name}>
                  <Icon name={lane.projectId ? 'folder' : 'globe'} size={12} />
                  <span className="wb-lane-name">{name}</span>
                  <span className="wb-lane-count">{lane.total}</span>
                  {lane.clusters.map((c) => (
                    <button
                      className="wb-cluster"
                      key={c.id}
                      onClick={() => setExpandedLanes([...new Set([...expandedLanes, lane.key])])}
                      title={t('map.expandLane')}
                      data-testid="session-map-cluster"
                    >
                      +{c.count}
                    </button>
                  ))}
                </div>

                {nodes.map((n) => {
                  const box = layout.positions.get(n.path)
                  if (!box) return null
                  const dim = needle.length > 0 && !n.title.toLowerCase().includes(needle)
                  const folded = collapsed.includes(n.path)
                  const classes = ['wb-node']
                  if (n.current) classes.push('on')
                  if (n.running) classes.push('running')
                  if (n.unread) classes.push('unread')
                  if (n.pinned) classes.push('pinned')
                  if (n.orphan) classes.push('orphan')
                  if (dim) classes.push('dim')
                  if (dragging === n.path) classes.push('dragging')
                  const notes = [t('map.info.branches', { n: n.childCount })]
                  if (n.orphan) notes.push(t('map.orphan'))
                  if (n.truncated) notes.push(t('map.foldedParent'))
                  const hidden = (subtreeSize.get(n.path) ?? 1) - 1
                  return (
                    <div
                      key={n.path}
                      role="button"
                      tabIndex={0}
                      ref={(el) => {
                        if (el) nodeRefs.current.set(n.path, el)
                        else nodeRefs.current.delete(n.path)
                      }}
                      className={classes.join(' ')}
                      style={{ left: box.x, top: box.y, width: NODE_W, height: NODE_H }}
                      onClick={() => {
                        if (suppressClick.current === n.path) {
                          suppressClick.current = null
                          return
                        }
                        /* 单击看预览（地图内），要真打开用预览里的按钮或 Enter */
                        setPreview(n.path)
                      }}
                      onKeyDown={(e) => onNodeKey(e, n)}
                      onPointerDown={(e) => onNodePointerDown(e, n)}
                      onPointerMove={onNodePointerMove}
                      onPointerUp={(e) => onNodePointerUp(e, n)}
                      onPointerCancel={(e) => onNodePointerUp(e, n)}
                      title={`${n.title || t('rail.untitled')}\n${notes.join(' · ')}`}
                      data-testid="map-node"
                      data-path={n.path}
                      data-current={n.current ? '1' : undefined}
                      data-folded={folded ? '1' : undefined}
                    >
                      <span className="wb-node-mark" />
                      <span className="wb-node-title">{n.title || t('rail.untitled')}</span>
                      {n.childCount > 0 ? (
                        <>
                          {folded ? (
                            <span className="wb-node-kids" data-testid="map-folded-count">
                              {hidden}
                            </span>
                          ) : (
                            <span className="wb-node-kids">
                              {n.branchIndex ? `${n.branchIndex}/${n.childCount}` : n.childCount}
                            </span>
                          )}
                          <button
                            className="wb-node-fold"
                            style={{ width: FOLD_W }}
                            data-testid="map-fold"
                            data-path={n.path}
                            aria-expanded={!folded}
                            title={folded ? t('map.unfold', { n: hidden }) : t('map.fold')}
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleFold(n.path)
                            }}
                            onPointerDown={(e) => e.stopPropagation()}
                          >
                            {folded ? '+' : '−'}
                          </button>
                        </>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/*
       * 工具条浮在画布左下角，不占头部的一行：
       * 窄窗口（中栏只剩 ~420px）下头部被标题 + 搜索 + 工具条挤到「会话地图」
       * 竖排 —— 而工具条浮动后不参与头部布局，谁也挤不到谁。
       */}
      <div className="wb-map-tools" data-testid="map-tools">
        <button onClick={tidy} title={t('map.tidy')} data-testid="map-tidy">
          <Icon name="refresh" size={12} />
          {t('map.tidy')}
        </button>
        <button onClick={() => centerOn(currentNode?.path)} title={t('map.focus')} data-testid="map-focus">
          {t('map.focus')}
        </button>
        <button onClick={fit} title={t('map.fit')} data-testid="map-fit">
          {t('map.fit')}
        </button>
        <span className="wb-map-zoom">
          <button onClick={() => zoomAt(1 / ZOOM_STEP)} title={t('map.zoomOut')} data-testid="map-zoom-out">
            −
          </button>
          <span data-testid="map-zoom-level">{Math.round(zoom * 100)}%</span>
          <button onClick={() => zoomAt(ZOOM_STEP)} title={t('map.zoomIn')} data-testid="map-zoom-in">
            +
          </button>
        </span>
      </div>

      <footer className="wb-map-foot">
        <div className="wb-map-info" data-testid="map-info">
          {currentNode ? (
            <>
              <Icon name="chat-round" size={12} />
              <strong>{currentNode.title || t('rail.untitled')}</strong>
              <span>{t('map.info.messages', { n: currentNode.messageCount })}</span>
              {currentNode.childCount > 0 ? (
                <span>{t('map.info.branches', { n: currentNode.childCount })}</span>
              ) : null}
              <span className="wb-map-time">{new Date(currentNode.lastActivityAt).toLocaleString()}</span>
            </>
          ) : null}
        </div>
        <div className="wb-map-hint">{t('map.hint')}</div>
      </footer>

      {preview ? (
        <SessionPreview
          path={preview}
          isCurrent={preview === currentPath}
          onOpen={onOpen}
          onClose={() => setPreview(null)}
          onFork={handleFork}
          forking={forking}
        />
      ) : null}
    </div>
  )
}
