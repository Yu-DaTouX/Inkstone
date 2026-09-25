/**
 * 可移动工具磁贴的布局契约（实施-12 U-0）。
 *
 * 这是磁贴位置的**唯一真源**：一个版本化的 ToolLayout，取代旧的
 * `toolOrder` + `toolHidden` 两个平行字段（旧字段只读迁移，迁移后只写新真源）。
 * 布局是应用级偏好；**内容**始终绑定当前会话，不写进这里。
 *
 * 纯函数，不依赖 Electron / React，便于单测。`ids` 是当前已知的工具分区，
 * 由调用方从 `TOOL_SECTIONS` 传入，避免 shared 层反向依赖 ipc。
 */

export type ToolPlacement = 'docked' | 'floating' | 'library'

/** 浮动磁贴初始宽度与最小宽度；用户调整尺寸可扩到整个工作区。 */
export const TILE_DEFAULT_W = 300
export const TILE_MIN_W = 240
export const TILE_MAX_W = 420
/** 磁贴头高度：拖动把手与折叠开关都在这一条里，内容区从它下面开始。 */
export const TILE_HEAD_H = 32

/** 用户可将任意工具磁贴从右栏拖入工作区，再拖回停靠区。 */
export const NON_FLOATING_TILE_IDS: readonly string[] = []

export function isTileFloatable(id: string): boolean {
  return !NON_FLOATING_TILE_IDS.includes(id)
}

/**
 * 新建浮动磁贴的默认位置（初始宽 300）。
 *
 * 坐标是相对内容区的归一化值（U-0 契约：x/y/w/h 均 0–1），所以宽度用
 * 「目标像素 ÷ 可用宽度」换算。`floatingCount` 用来逐个错开，避免叠加。
 */
export function defaultFloatRect(floatingCount: number, areaW: number, areaH: number): ToolRect {
  const target = Math.min(TILE_MAX_W, Math.max(TILE_MIN_W, TILE_DEFAULT_W))
  const w = Math.min(0.95, target / Math.max(areaW, target))
  const h = Math.min(0.6, 320 / Math.max(areaH, 320))
  const step = 0.05
  const n = Math.max(0, Math.round(floatingCount))
  return {
    x: Math.min(0.06 + n * step, Math.max(0, 1 - w)),
    y: Math.min(0.1 + n * step, Math.max(0, 1 - h)),
    w,
    h
  }
}

export interface ToolRect {
  /** 相对内容区的归一化坐标与尺寸（0–1），恢复时再乘回可用区 */
  x: number
  y: number
  w: number
  h: number
}

export interface ToolTile {
  id: string
  placement: ToolPlacement
  /** 停靠顺序（升序）；浮动/入库也保留一个序，便于放回时定位 */
  order: number
  rect?: ToolRect
  collapsed?: boolean
}

export interface ToolLayout {
  version: 2
  tiles: ToolTile[]
  /** 单调递增：慢请求的迟到写入不能覆盖更新的拖动结果 */
  revision: number
}

const PLACEMENTS: readonly ToolPlacement[] = ['docked', 'floating', 'library']

function isPlacement(value: unknown): value is ToolPlacement {
  return typeof value === 'string' && (PLACEMENTS as readonly string[]).includes(value)
}

export function defaultToolLayout(ids: readonly string[]): ToolLayout {
  return { version: 2, revision: 0, tiles: ids.map((id, index) => ({ id, placement: 'docked', order: index })) }
}

/** 旧字段迁移：顺序里的停靠，隐藏的进库；未知 id 丢弃，重复只留一份 */
export function migrateToolLayout(
  order: readonly string[] | undefined,
  hidden: readonly string[] | undefined,
  ids: readonly string[]
): ToolLayout {
  const known = new Set(ids)
  const hiddenSet = new Set((hidden ?? []).filter((id) => known.has(id)))
  const ordered = (order ?? []).filter((id) => known.has(id) && !hiddenSet.has(id))
  const seen = new Set<string>()
  const tiles: ToolTile[] = []
  for (const id of ordered) {
    if (seen.has(id)) continue
    seen.add(id)
    tiles.push({ id, placement: 'docked', order: tiles.length })
  }
  /* 旧顺序没列到的已安装分区补在后面（停靠），保持“新增工具默认可见” */
  for (const id of ids) {
    if (seen.has(id) || hiddenSet.has(id)) continue
    seen.add(id)
    tiles.push({ id, placement: 'docked', order: tiles.length })
  }
  for (const id of ids) {
    if (!hiddenSet.has(id) || seen.has(id)) continue
    seen.add(id)
    tiles.push({ id, placement: 'library', order: tiles.length })
  }
  return { version: 2, revision: 0, tiles }
}

function clamp01(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null
}

function sanitizeRect(value: unknown): ToolRect | undefined {
  if (!value || typeof value !== 'object') return undefined
  const r = value as Partial<ToolRect>
  const x = clamp01(r.x)
  const y = clamp01(r.y)
  const w = clamp01(r.w)
  const h = clamp01(r.h)
  if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) return undefined
  /* 尺寸归一化后不能越出可用区（无效坐标恢复可见，而不是丢到屏外） */
  return { x: Math.min(x, 1 - w), y: Math.min(y, 1 - h), w, h }
}

function sanitizeOrder(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : fallback
}

/** 归一化任意输入：版本显式分支、未知 id 过滤、重复归一、rect 夹取 */
export function normalizeToolLayout(value: unknown, ids: readonly string[]): ToolLayout {
  const known = new Set(ids)
  if (!value || typeof value !== 'object') return defaultToolLayout(ids)
  const input = value as Record<string, unknown>
  const version = typeof input.version === 'number' && Number.isInteger(input.version) ? input.version : 1
  if (version < 1 || version > 2) return defaultToolLayout(ids)
  const rawTiles = Array.isArray(input.tiles) ? input.tiles : []
  const seen = new Set<string>()
  const tiles: ToolTile[] = []
  for (const raw of rawTiles) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Partial<ToolTile>
    if (typeof item.id !== 'string' || !known.has(item.id) || seen.has(item.id)) continue
    seen.add(item.id)
    const rawPlacement: ToolPlacement = isPlacement(item.placement) ? item.placement : 'docked'
    /* 若以后引入禁止浮动的磁贴，读盘时把它恢复到停靠位。 */
    const placement: ToolPlacement = rawPlacement === 'floating' && !isTileFloatable(item.id) ? 'docked' : rawPlacement
    const rect = placement === 'floating' ? sanitizeRect(item.rect) : undefined
    tiles.push({
      id: item.id,
      placement: rect ? 'floating' : placement === 'floating' ? 'docked' : placement,
      order: sanitizeOrder(item.order, tiles.length),
      ...(rect ? { rect } : {}),
      ...(item.collapsed === true ? { collapsed: true } : {})
    })
  }
  /* 新安装的分区按默认策略补成停靠 */
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    tiles.push({ id, placement: 'docked', order: tiles.length })
  }
  tiles.sort((a, b) => a.order - b.order)
  tiles.forEach((tile, index) => { tile.order = index })
  const revision = typeof input.revision === 'number' && Number.isFinite(input.revision) ? Math.max(0, Math.round(input.revision)) : 0
  return { version: 2, tiles, revision }
}

/** 位置/折叠/尺寸变化；revision 自增 */
export function setTilePlacement(
  layout: ToolLayout,
  id: string,
  placement: ToolPlacement,
  rect?: ToolRect
): ToolLayout {
  /* 放置命令与读盘使用同一份可浮动规则。 */
  const want: ToolPlacement = placement === 'floating' && !isTileFloatable(id) ? 'docked' : placement
  const tiles = layout.tiles.map((tile) => {
    if (tile.id !== id) return tile
    const safe = want === 'floating' ? sanitizeRect(rect) : undefined
    const next: ToolTile = { id, placement: safe ? 'floating' : want === 'floating' ? 'docked' : want, order: tile.order }
    if (safe) next.rect = safe
    if (tile.collapsed) next.collapsed = true
    return next
  })
  return { ...layout, tiles, revision: layout.revision + 1 }
}

/** 折叠 / 展开浮动磁贴（折叠偏好进布局，菜单开关等临时状态不进） */
export function setTileCollapsed(layout: ToolLayout, id: string, collapsed: boolean): ToolLayout {
  const tiles = layout.tiles.map((tile) => {
    if (tile.id !== id) return tile
    const next: ToolTile = { id: tile.id, placement: tile.placement, order: tile.order }
    if (tile.rect) next.rect = tile.rect
    if (collapsed) next.collapsed = true
    return next
  })
  return { ...layout, tiles, revision: layout.revision + 1 }
}

/**
 * 按**停靠位次**放置（工具库的上移/下移、拖放插入线都用它）。
 * 只影响停靠项之间的相对顺序：从 0..n-1 重新编号，非停靠项保持原 order。
 */
export function moveTileToIndex(layout: ToolLayout, id: string, index: number): ToolLayout {
  const docked = layout.tiles.filter((tile) => tile.placement === 'docked').sort((a, b) => a.order - b.order)
  const from = docked.findIndex((tile) => tile.id === id)
  if (from < 0) return layout
  const [picked] = docked.splice(from, 1)
  const at = Math.min(Math.max(0, Math.round(index)), docked.length)
  docked.splice(at, 0, picked)
  /* 重建 order：停靠项按新位次，其它项接在后面（浮动的叠放序也稳定） */
  const rest = layout.tiles.filter((tile) => tile.placement !== 'docked').sort((a, b) => a.order - b.order)
  const tiles = [...docked, ...rest].map((tile, i) => ({ ...tile, order: i }))
  return { ...layout, tiles, revision: layout.revision + 1 }
}

/** 只保留停靠项（工具库面板按它列目录） */
export function dockedTileIds(layout: ToolLayout): string[] {
  return layout.tiles.filter((tile) => tile.placement === 'docked').sort((a, b) => a.order - b.order).map((t) => t.id)
}

/** 停靠顺序：把 id 移到 targetId 前/后 */
export function moveTile(layout: ToolLayout, id: string, targetId: string, after: boolean): ToolLayout {
  if (id === targetId) return layout
  const ordered = layout.tiles.map((tile) => ({ ...tile })).sort((a, b) => a.order - b.order)
  const from = ordered.findIndex((tile) => tile.id === id)
  const to = ordered.findIndex((tile) => tile.id === targetId)
  if (from < 0 || to < 0) return layout
  const [picked] = ordered.splice(from, 1)
  const at = ordered.findIndex((tile) => tile.id === targetId)
  ordered.splice(after ? at + 1 : at, 0, picked)
  ordered.forEach((tile, index) => { tile.order = index })
  return { ...layout, tiles: ordered, revision: layout.revision + 1 }
}

/** 把归一化 rect 夹回当前可用区（缩窗后浮动磁贴不丢到屏外） */
export function clampRectToBounds(rect: ToolRect): ToolRect {
  const w = Math.min(rect.w, 1)
  const h = Math.min(rect.h, 1)
  const x = Math.min(Math.max(0, rect.x), Math.max(0, 1 - w))
  const y = Math.min(Math.max(0, rect.y), Math.max(0, 1 - h))
  return { x, y, w, h }
}

/** 晚到的写入是否过时（不能覆盖更新的布局） */
export function isStaleLayoutWrite(incomingRevision: number, currentRevision: number): boolean {
  return incomingRevision < currentRevision
}

/**
 * 写入仲裁：只有 revision **更大**的布局才落地。
 *
 * 「连续拖动的晚返回不覆盖新位置」的实现点：晚回来的那次写带旧
 * revision，于是被丢弃；等 revision 的重复写也丢弃（幂等，避免无意义的重渲染）。
 */
export function commitTileLayout(
  current: ToolLayout,
  incoming: ToolLayout
): { layout: ToolLayout; applied: boolean } {
  if (incoming.revision > current.revision) return { layout: incoming, applied: true }
  return { layout: current, applied: false }
}

/* ── 像素级几何（U-5）：吸附、夹取与障碍避让 ──────────────────────────
 *
 * 上面的 rect 是 0–1 归一化（U-0 冻结契约）；拖动/放置发生在真实像素里，
 * 所以这里单独给一组像素函数 —— 输入输出都是 px，便于纯函数单测。
 * 归一化 ↔ 像素的换算只在渲染层做一次（见 FloatingTiles）。
 */

export interface FloatArea {
  left: number
  top: number
  width: number
  height: number
}

export interface FloatPxRect {
  left: number
  top: number
  width: number
  height: number
}

/** 把像素矩形完整夹进可用区（缩窗/缩放后磁贴不丢到屏外） */
export function clampFloatPixels(rect: FloatPxRect, area: FloatArea): FloatPxRect {
  const width = Math.min(rect.width, Math.max(0, area.width))
  const height = Math.min(rect.height, Math.max(0, area.height))
  const left = Math.min(Math.max(area.left, rect.left), area.left + Math.max(0, area.width - width))
  const top = Math.min(Math.max(area.top, rect.top), area.top + Math.max(0, area.height - height))
  return { left, top, width, height }
}

function intersects(a: FloatPxRect, b: FloatArea): boolean {
  return a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top
}

/**
 * 与障碍（原生网页矩形）相交时，把磁贴吸附到最近的、能完整容纳它的空位。
 *
 * 策略：优先水平让开（网页通常占右栏，往左让最自然），再竖直让开；
 * 都不行时返回 `null` —— 调用方据此退回工具页并说明原因（设计 §5.4），
 * 而不是把磁贴永久压在网页上。
 */
export function avoidFloatObstacle(
  rect: FloatPxRect,
  area: FloatArea,
  obstacle: FloatArea | null
): FloatPxRect | null {
  if (!obstacle) return clampFloatPixels(rect, area)
  const base = clampFloatPixels(rect, area)
  if (!intersects(base, obstacle)) return base
  /* ① 让到障碍左侧（右对齐到障碍左缘） */
  const leftSide: FloatPxRect = { ...base, left: obstacle.left - base.width }
  const leftFit = clampFloatPixels(leftSide, area)
  if (!intersects(leftFit, obstacle) && leftFit.left + leftFit.width <= obstacle.left) return leftFit
  /* ② 让到障碍右侧 */
  const rightSide: FloatPxRect = { ...base, left: obstacle.left + obstacle.width }
  const rightFit = clampFloatPixels(rightSide, area)
  if (!intersects(rightFit, obstacle) && rightFit.left >= obstacle.left + obstacle.width) return rightFit
  /* ③ 让到障碍上方 */
  const upSide: FloatPxRect = { ...base, top: obstacle.top - base.height }
  const upFit = clampFloatPixels(upSide, area)
  if (!intersects(upFit, obstacle) && upFit.top + upFit.height <= obstacle.top) return upFit
  /* ④ 让到障碍下方 */
  const downSide: FloatPxRect = { ...base, top: obstacle.top + obstacle.height }
  const downFit = clampFloatPixels(downSide, area)
  if (!intersects(downFit, obstacle) && downFit.top >= obstacle.top + obstacle.height) return downFit
  return null
}

/** 像素矩形 → 归一化 rect（保存用；尺寸一并归一化，窗口变化后可复原） */
export function pxRectToNormalized(rect: FloatPxRect, area: FloatArea): ToolRect {
  const aw = Math.max(1, area.width)
  const ah = Math.max(1, area.height)
  const w = clamp01(rect.width / aw) ?? 0.3
  const h = clamp01(rect.height / ah) ?? 0.4
  const x = clamp01((rect.left - area.left) / aw) ?? 0
  const y = clamp01((rect.top - area.top) / ah) ?? 0
  return { x: Math.min(x, 1 - w), y: Math.min(y, 1 - h), w, h }
}
