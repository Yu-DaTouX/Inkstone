/**
 * 预览路径的归属绑定（纯函数，可单测）。
 *
 * 缺陷背景：`previewPath` 曾是单个 string。owner 从 A 切到 B 时，首帧就会把
 * A 的路径传给 B 的叶子（B 的 cwd + A 的 path）——即使宿主因授权拒绝越界文件，
 * 也不该依赖宿主兜底来代替视图归属。这里把路径按 `owner.key` 存成有上限的
 * 绑定表：渲染时只取当前 owner 的条目，没有绑定就是 `undefined`，**不靠异步
 * effect 去「稍后清空」**。owner 换回 A 时 A 的绑定仍在，规则明确。
 *
 * 每个 owner 最多记一条（最近一次预览）；整张表最多 `MAX_PREVIEW_BINDINGS`
 * 个 owner，超限按最早写入淘汰。
 */
export const MAX_PREVIEW_BINDINGS = 5

/**
 * 记录某个 owner 的预览路径，返回新表。
 *
 * 重复 owner 会移到末尾（最近使用），因此淘汰的是最久没预览的 owner。
 * `ownerKey` 为空（没有可归属会话）时原样返回，不产生无主绑定。
 */
export function bindPreviewPath(
  bindings: ReadonlyMap<string, string>,
  ownerKey: string | null,
  path: string
): ReadonlyMap<string, string> {
  if (!ownerKey) return bindings
  const next = new Map(bindings)
  next.delete(ownerKey)
  next.set(ownerKey, path)
  while (next.size > MAX_PREVIEW_BINDINGS) {
    const oldest = next.keys().next().value
    if (oldest === undefined) break
    next.delete(oldest)
  }
  return next
}

/** 取当前 owner 应显示的预览路径；无 owner 或无绑定一律 `undefined`。 */
export function previewPathFor(bindings: ReadonlyMap<string, string>, ownerKey: string | null): string | undefined {
  if (!ownerKey) return undefined
  return bindings.get(ownerKey)
}
