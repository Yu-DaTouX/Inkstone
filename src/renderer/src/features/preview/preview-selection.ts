/**
 * R5 预览面板自己的归属绑定（纯函数，可单测）。
 *
 * 背景：`selectedPath` 曾是单个 `string`，只靠 `useEffect([path])` 在提交之后清空。
 * owner 从 A 切到 B 时，清空发生在渲染之后，B 的首帧仍会拿 A 的选择（配 B 的 cwd）
 * 去请求文件；已加载的视图（文本 / office 结果 / 图片 `abs`）同样会跨 owner 显示。
 *
 * 规则（明确、可测）：
 *   · 作用域键 = 会话键 + cwd；cwd 不同就当作不同归属。当前 owner 没有条目就是
 *     `undefined`，在 render 计算 `activePath` 时就隔离，绝不用异步 effect 兜底。
 *     不带 generation：同一条会话换 run 通常 cwd 不变，路径解析上下文一样，选择应当保留。
 *   · 同一作用域内，外部 `path` 换了值（相对点选当刻记下的值）就接管，面板内点选作废；
 *     这样「父级绑定 / 面板点选」的优先级在每个 owner 内都是确定的。
 *   · 返回原 owner 且外部 path 未变时，该 owner 自己的点选仍在（有限条数，最近使用淘汰）。
 */

/** 最多记住多少个 owner 作用域；超出按最久未用淘汰。 */
export const MAX_PREVIEW_SCOPES = 5

export interface PreviewScopeOwner {
  readonly key: string
  readonly cwd?: string
}

export interface PreviewSelectionEntry {
  /** 面板内点选的成果路径。 */
  readonly path: string
  /** 点选当刻的外部 path；用于判断外部是否换了输入。 */
  readonly external: string | null
}

/** 视图是否由外部 path 接管。 */
export interface ResolvedPreviewPath {
  /** 当前 owner 真正要预览的路径；没有则为 `null`。 */
  readonly path: string | null
  /** 本次是否因为外部 path 变化而由外部接管（面板内点选需作废）。 */
  readonly externalChanged: boolean
}

/** owner → 作用域键；cwd 是相对路径的解析上下文，必须进键。 */
export function previewScopeKey(owner: PreviewScopeOwner): string {
  return [owner.key, owner.cwd ?? ''].join('\u0000')
}

/**
 * 记录一次面板内点选，返回新表。
 *
 * 重复作用域移到末尾（最近使用），因此淘汰的是最久没预览的 owner。
 */
export function recordPreviewSelection(
  selections: ReadonlyMap<string, PreviewSelectionEntry>,
  scopeKey: string,
  path: string,
  external: string | null
): ReadonlyMap<string, PreviewSelectionEntry> {
  const next = new Map(selections)
  next.delete(scopeKey)
  next.set(scopeKey, { path, external })
  while (next.size > MAX_PREVIEW_SCOPES) {
    const oldest = next.keys().next().value
    if (oldest === undefined) break
    next.delete(oldest)
  }
  return next
}

/** 外部输入接管时丢掉某个作用域的面板内点选；没有该条目时原样返回。 */
export function dropPreviewSelection(
  selections: ReadonlyMap<string, PreviewSelectionEntry>,
  scopeKey: string
): ReadonlyMap<string, PreviewSelectionEntry> {
  if (!selections.has(scopeKey)) return selections
  const next = new Map(selections)
  next.delete(scopeKey)
  return next
}

/**
 * 当前 owner 真正要预览的路径与接管判定。
 *
 * 没有点选条目：直接用外部 path。有点选条目：外部 path 与点选时记下的值相同才用点选，
 * 不同说明外部换了输入，由外部接管并让调用方作废该点选。
 */
export function resolvePreviewPath(
  entry: PreviewSelectionEntry | undefined,
  externalPath: string | null
): ResolvedPreviewPath {
  if (!entry) return { path: externalPath, externalChanged: false }
  if (entry.external !== externalPath) return { path: externalPath, externalChanged: true }
  return { path: entry.path, externalChanged: false }
}

/** 视图缓存键：作用域 + 路径 + 重试代次；没有路径返回 `null`。 */
export function previewViewKey(scopeKey: string, path: string | null, reload: number): string | null {
  return path ? [scopeKey, path, String(reload)].join('\u0000') : null
}

/** 路径里的文件名（跨平台，不依赖宿主 path 模块）。 */
export function previewBaseName(path: string): string {
  return path.replace(/^.*[\\/]/, '')
}
