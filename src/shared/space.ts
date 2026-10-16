export interface Space {
  id: string
  name: string
  description?: string
  archived: boolean
  createdAt: number
  updatedAt: number
}

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

export function makeSpaceId(taken: (id: string) => boolean, random: () => number = Math.random): string {
  for (let i = 0; i < 200; i++) {
    const id = `sp_${Math.floor(random() * 0xffffffff).toString(36)}${Date.now().toString(36).slice(-4)}`
    if (!taken(id)) return id
  }
  return `sp_${Date.now().toString(36)}_${Math.floor(random() * 1e6).toString(36)}`
}

export function spacesForProject(links: readonly SpaceProjectLink[], projectId: string): string[] {
  return links
    .filter((l) => l.projectId === projectId)
    .sort((a, b) => a.at - b.at)
    .map((l) => l.spaceId)
}

export function projectsForSpace(links: readonly SpaceProjectLink[], spaceId: string): string[] {
  return links
    .filter((l) => l.spaceId === spaceId)
    .sort((a, b) => a.at - b.at)
    .map((l) => l.projectId)
}

export function activeSpaces(spaces: readonly Space[]): Space[] {
  return spaces.filter((s) => !s.archived).sort((a, b) => b.updatedAt - a.updatedAt)
}

export function linkKey(link: SpaceProjectLink): string {
  return `${link.spaceId}\u0000${link.projectId}`
}
