/**
 * 主题空间（Space）—— 契约与纯逻辑（实施-25 P02）。
 *
 * 为什么需要它：日常里的主题（「英语学习」「产品调研」）不该逼用户先选一个
 * 代码仓库。空间是**产品的组织单位**，不改变 pi 的会话存储，也不代表
 * 「空间拥有这些文件」。
 *
 * 三条边界（实施-25 §3.2 与不变量）：
 *   · 会话与空间共享**同一份** `Session` 实体：`spaceId` 是一等可空字段，
 *     已有 Code 会话保持 `null`，不做迁移；导航只是投影。
 *   · 空间 ↔ 项目是**显式关联记录**（多对多），不写成 `project.spaceId` 外键 ——
 *     同一个文件夹可以既是项目又是空间，两条记录互不吞并。
 *   · 「空间关联了项目」**不等于**「空间拥有项目下的文件」：关联只用于展示与
 *     跨空间引用，不改变文件归属。
 */

export interface Space {
  id: string
  name: string
  description?: string
  /**
   * 归档态。
   *
   * 归档不是删除：不在活动列表里出现，但资料、成果与课程仍在，
   * 旧引用照常能打开（P03 的版本绑定依赖这一点）。
   */
  archived: boolean
  createdAt: number
  updatedAt: number
}

/** 空间 ↔ 项目的显式关联记录（多对多）。 */
export interface SpaceProjectLink {
  spaceId: string
  projectId: string
  at: number
}

export interface SpaceDocument {
  version: 1
  spaces: Space[]
  links: SpaceProjectLink[]
}

export const MAX_SPACES = 500
export const MAX_SPACE_NAME = 60
export const MAX_SPACE_DESCRIPTION = 400

export interface SpaceInput {
  name: string
  description?: string
}

/**
 * 校验建/改空间的输入。
 *
 * 与活动档案同一个口径：不合格就返回原因（不静默截断成合法值）。
 * 只对长度做夹取 —— 名字里可以有空格与标点，那是用户的表达。
 */
export function validateSpaceInput(raw: unknown): { ok: true; value: SpaceInput } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: '输入不是对象' }
  const o = raw as Record<string, unknown>
  if (typeof o.name !== 'string' || !o.name.trim()) return { ok: false, reason: '空间名称不能为空' }
  const name = o.name.trim()
  if (name.length > MAX_SPACE_NAME) return { ok: false, reason: `空间名称最多 ${MAX_SPACE_NAME} 个字符` }
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, reason: '空间名称含控制字符' }
  const out: SpaceInput = { name }
  if (o.description !== undefined && o.description !== null) {
    if (typeof o.description !== 'string') return { ok: false, reason: '描述不是文本' }
    const description = o.description.trim()
    if (description.length > MAX_SPACE_DESCRIPTION) {
      return { ok: false, reason: `描述最多 ${MAX_SPACE_DESCRIPTION} 个字符` }
    }
    if (description) out.description = description
  }
  return { ok: true, value: out }
}

/** 空间 id 的生成（可注入随机源，便于单测）。 */
export function makeSpaceId(taken: (id: string) => boolean, random: () => number = Math.random): string {
  for (let i = 0; i < 200; i++) {
    const id = `sp_${Math.floor(random() * 0xffffffff).toString(36)}${Date.now().toString(36).slice(-4)}`
    if (!taken(id)) return id
  }
  return `sp_${Date.now().toString(36)}_${Math.floor(random() * 1e6).toString(36)}`
}

/** 某项目关联了哪些空间（按关联时间排序）。 */
export function spacesForProject(links: readonly SpaceProjectLink[], projectId: string): string[] {
  return links
    .filter((l) => l.projectId === projectId)
    .sort((a, b) => a.at - b.at)
    .map((l) => l.spaceId)
}

/** 某空间关联了哪些项目。 */
export function projectsForSpace(links: readonly SpaceProjectLink[], spaceId: string): string[] {
  return links
    .filter((l) => l.spaceId === spaceId)
    .sort((a, b) => a.at - b.at)
    .map((l) => l.projectId)
}

/** 活动列表用的排序：最近更新的在前；归档的不在列表里。 */
export function activeSpaces(spaces: readonly Space[]): Space[] {
  return spaces.filter((s) => !s.archived).sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 关联记录的去重键（同一对只留一条，更新时间取最新）。 */
export function linkKey(link: SpaceProjectLink): string {
  return `${link.spaceId}\u0000${link.projectId}`
}
