/**
 * 工具磁贴布局的唯一真源（实施-12 U-0；设计 §5.3）。
 *
 * 为什么需要这一层：旧配置把「顺序」和「隐藏」拆成两个字符串数组
 * （`toolOrder` / `toolHidden`），它们表达不了「浮动位置」「折叠」「收进库」
 * 这三种状态，也没有写入版本号 —— 连续拖动时慢请求回来会把新位置覆盖掉。
 * 这里把三件事收进一个带 `revision` 的结构，旧字段只用于**一次性迁移**。
 *
 * 边界（设计 §5.3）：这里只描述**布局**，不含任何业务数据（会话正文、
 * 任务、日志、上下文、凭证）。「内容始终绑定当前会话」由调用方
 * （store / 组件）保证 —— 本模块不缓存、不索引任何内容，因此切会话时
 * 不需要在这里做失效处理。
 */

/** 布局结构的版本。未知版本一律回到默认布局（见 `normalizeTileLayout`）。 */
export const TOOL_TILE_LAYOUT_VERSION = 2

/** 浮动磁贴的尺寸约束（设计 §5.2：初始 300，最窄 240，最宽 420）。 */
export const TILE_DEFAULT_W = 300
export const TILE_MIN_W = 240
export const TILE_MAX_W = 420
/** 磁贴头高度：拖动把手与折叠开关都在这条里，所以夹取时不能小于它。 */
export const TILE_HEAD_H = 32

/**
 * 工具页的分区 id（设计 §5.1）。这是**默认 known 集**，也是「新增工具」
 * 的增量来源：布局里出现别的 id 会被当成未知项过滤掉。
 */
export const TOOL_TILE_IDS = [
  'context',
  'quota',
  'todo',
  'queue',
  'files',
  'ext',
  'log',
  'actions'
] as const

/**
 * 不参与浮动的磁贴：todo 保持工具页原布局（设计 §5.1 明确排除）。
 * 它仍然可以停靠 / 排序，只是不能被放到应用内容区。
 */
export const NON_FLOATING_TILE_IDS = ['todo'] as const

export type TilePlacement = 'dock' | 'library' | 'float'

/**
 * 浮动磁贴的几何。
 *
 * `x` / `y` 是**相对应用内容区的归一化坐标**（0..1，左上角为原点），
 * `w` / `h` 是 CSS px —— 这样窗口缩放后仍然能算出可见位置，
 * 不必把某一次的窗口尺寸写进配置（设计 §5.3）。
 */
export interface TileRect {
  x: number
  y: number
  w: number
  h: number
}

export interface ToolTile {
  id: string
  placement: TilePlacement
  /** 停靠顺序（只对 `dock` 有意义）；数组顺序同时也是浮动的叠放顺序。 */
  order: number
  /** 仅 `float` 有；`dock` / `library` 上的残留 rect 会被丢弃。 */
  rect?: TileRect
  collapsed?: boolean
}

export interface ToolTileLayout {
  version: number
  tiles: ToolTile[]
  /** 单调递增的写入版本：用于丢弃比当前更旧的写入（设计 §5.3）。 */
  revision: number
}

/** 旧设置里的两个数组（只读迁移输入）。 */
export interface LegacyTilePrefs {
  toolOrder?: unknown
  toolHidden?: unknown
}

export function emptyTileLayout(): ToolTileLayout {
  return { version: TOOL_TILE_LAYOUT_VERSION, tiles: [], revision: 0 }
}

export function isTileFloatable(id: string): boolean {
  return !(NON_FLOATING_TILE_IDS as readonly string[]).includes(id)
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function asFiniteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function normalizeRevision(raw: unknown): number {
  const n = asFiniteNumber(raw)
  if (n === null || n < 0) return 0
  return Math.floor(n)
}

function normalizeRect(raw: unknown): TileRect | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const x = asFiniteNumber(r.x)
  const y = asFiniteNumber(r.y)
  const w = asFiniteNumber(r.w)
  const h = asFiniteNumber(r.h)
  if (x === null || y === null) return undefined
  return {
    /* 归一化坐标夹回 0..1：越界值只会让磁贴跑到视野外，夹取后必然可见 */
    x: clamp(x, 0, 1),
    y: clamp(y, 0, 1),
    w: clamp(w ?? TILE_DEFAULT_W, TILE_MIN_W, TILE_MAX_W),
    h: clamp(h ?? TILE_HEAD_H, TILE_HEAD_H, 4000)
  }
}

function placeable(id: string, known: readonly string[] | undefined): boolean {
  return known === undefined || known.includes(id)
}

function placementOf(raw: unknown, id: string): TilePlacement {
  const want = raw === 'library' || raw === 'float' || raw === 'dock' ? raw : 'dock'
  /* todo 不允许浮动：脏数据（或旧版本写进去的）在这里被收回停靠位 */
  if (want === 'float' && !isTileFloatable(id)) return 'dock'
  return want
}

/**
 * 把任意来源的数据整理成合法布局。
 *
 * 规则（设计 §5.3「恢复时过滤未知 ID、去重、夹取越界值」）：
 *   · 版本不是本版 → 整体回默认（宁可让用户重新摆一次，也不猜旧结构）；
 *   · 未知 id 丢弃、重复 id 只保留**首次**出现（顺序稳定比「后者覆盖」更可预期）；
 *   · 非法 placement 回 `dock`、越界 rect 夹取、order 重排为 0..n-1。
 */
export function normalizeTileLayout(raw: unknown, knownIds?: readonly string[]): ToolTileLayout {
  if (!raw || typeof raw !== 'object') return emptyTileLayout()
  const obj = raw as Record<string, unknown>
  if (obj.version !== TOOL_TILE_LAYOUT_VERSION) return emptyTileLayout()
  const list = Array.isArray(obj.tiles) ? obj.tiles : []
  const seen = new Set<string>()
  const kept: Array<{ tile: ToolTile; index: number; rawOrder: number }> = []
  list.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return
    const t = entry as Record<string, unknown>
    const id = typeof t.id === 'string' ? t.id.trim() : ''
    if (!id || seen.has(id) || !placeable(id, knownIds)) return
    seen.add(id)
    const placement = placementOf(t.placement, id)
    const order = asFiniteNumber(t.order)
    kept.push({
      index,
      rawOrder: order === null ? index : order,
      tile: {
        id,
        placement,
        order: 0,
        ...(placement === 'float' ? { rect: normalizeRect(t.rect) } : {}),
        ...(t.collapsed === true ? { collapsed: true } : {})
      }
    })
  })
  /* 停靠项按原 order 排序（同 order 用出现顺序兜底），其余保持数组顺序 */
  const sorted = kept
    .slice()
    .sort((a, b) =>
      a.tile.placement === 'dock' && b.tile.placement === 'dock'
        ? a.rawOrder - b.rawOrder || a.index - b.index
        : a.index - b.index
    )
  return {
    version: TOOL_TILE_LAYOUT_VERSION,
    tiles: sorted.map((e, i) => ({ ...e.tile, order: i })),
    revision: normalizeRevision(obj.revision)
  }
}

/**
 * 旧 `toolOrder` / `toolHidden` → 布局（一次性迁移）。
 *
 * 语义（设计 §5.3）：`toolOrder` 里的排在前面并保持相对顺序、`toolHidden`
 * 里的进库；两边都没提到的 known id（= 版本升级后**新增**的工具）按默认
 * 顺序补到停靠末尾，这样老用户不会「升级后少了一个分区」。
 */
export function migrateLegacyTileLayout(
  legacy: LegacyTilePrefs,
  knownIds: readonly string[] = TOOL_TILE_IDS,
  revision = 0
): ToolTileLayout {
  const order = Array.isArray(legacy.toolOrder)
    ? legacy.toolOrder.filter((x): x is string => typeof x === 'string')
    : []
  const hidden = Array.isArray(legacy.toolHidden)
    ? legacy.toolHidden.filter((x): x is string => typeof x === 'string')
    : []
  const hiddenSet = new Set(hidden)
  const tiles: ToolTile[] = []
  const used = new Set<string>()
  const push = (id: string, placement: TilePlacement): void => {
    if (used.has(id) || !knownIds.includes(id)) return
    used.add(id)
    tiles.push({ id, placement, order: tiles.length })
  }
  /* ① 先按用户显式顺序走一遍（顺序 + 隐藏都按旧配置保留） */
  for (const id of order) push(id, hiddenSet.has(id) ? 'library' : 'dock')
  /* ② 只出现在 toolHidden 里的（用户没排过序）也进库 */
  for (const id of hidden) push(id, 'library')
  /* ③ 新增工具补到停靠末尾 */
  for (const id of knownIds) push(id, 'dock')
  return { version: TOOL_TILE_LAYOUT_VERSION, tiles, revision: normalizeRevision(revision) }
}

/**
 * 写入仲裁：只有 revision **更大**的布局才落地。
 *
 * 这是「连续拖动的晚返回不覆盖新位置」的实现点：晚回来的那次写带着旧
 * revision，于是被丢弃；等 revision 的重复写也丢弃（幂等，避免无意义的
 * 重渲染与二次落盘）。
 */
export function commitTileLayout(
  current: ToolTileLayout,
  incoming: ToolTileLayout
): { layout: ToolTileLayout; applied: boolean } {
  if (incoming.revision > current.revision) return { layout: incoming, applied: true }
  return { layout: current, applied: false }
}

export interface MoveTileOptions {
  /** 停靠插入位置（`dock` 时有效；缺省放末尾）。 */
  index?: number
  rect?: TileRect
  collapsed?: boolean
}

/**
 * 移动 / 放置 / 折叠一个磁贴，返回**新**布局（不原地改，便于比较与写盘）。
 *
 * 每次变更把 revision +1 —— 保存时机（拖动结束后写盘，而不是每帧）由调用方
 * 掌握，但「变更即换 revision」让仲裁有据可依。
 */
export function moveTile(
  layout: ToolTileLayout,
  id: string,
  placement: TilePlacement,
  options: MoveTileOptions = {}
): ToolTileLayout {
  const want = placement === 'float' && !isTileFloatable(id) ? 'dock' : placement
  const rest = layout.tiles.filter((t) => t.id !== id)
  const prev = layout.tiles.find((t) => t.id === id)
  const tile: ToolTile = {
    id,
    placement: want,
    order: 0,
    ...(want === 'float'
      ? { rect: normalizeRect(options.rect ?? prev?.rect) }
      : {}),
    ...(options.collapsed ?? prev?.collapsed ? { collapsed: true } : {})
  }
  const dock = rest.filter((t) => t.placement === 'dock')
  const others = rest.filter((t) => t.placement !== 'dock')
  if (want === 'dock') {
    const at = clamp(Math.floor(options.index ?? dock.length), 0, dock.length)
    dock.splice(at, 0, tile)
  }
  const tiles = want === 'dock' ? [...dock, ...others] : [...dock, ...others, tile]
  return {
    version: TOOL_TILE_LAYOUT_VERSION,
    tiles: tiles.map((t, i) => ({ ...t, order: i })),
    revision: layout.revision + 1
  }
}

/** 恢复默认布局：全部停靠在工具页（设计 §5.3「只重置布局」）。 */
export function restoreDefaultTileLayout(
  knownIds: readonly string[] = TOOL_TILE_IDS,
  revision = 0
): ToolTileLayout {
  return {
    version: TOOL_TILE_LAYOUT_VERSION,
    tiles: knownIds.map((id, i) => ({ id, placement: 'dock' as const, order: i })),
    revision: normalizeRevision(revision)
  }
}

/** 唯一的选择器入口：UI 不要再自己筛 `tiles`（否则规则会漂）。 */
export function dockTiles(layout: ToolTileLayout): ToolTile[] {
  return layout.tiles.filter((t) => t.placement === 'dock')
}

export function libraryTiles(layout: ToolTileLayout): ToolTile[] {
  return layout.tiles.filter((t) => t.placement === 'library')
}

export function floatingTiles(layout: ToolTileLayout): ToolTile[] {
  return layout.tiles.filter((t) => t.placement === 'float')
}

export function tileLayoutEquals(a: ToolTileLayout, b: ToolTileLayout): boolean {
  return a.revision === b.revision && JSON.stringify(a.tiles) === JSON.stringify(b.tiles)
}
