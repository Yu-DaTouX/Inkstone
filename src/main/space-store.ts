import { parsePersistedDocument } from './persisted-document'
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { writeFileDurable } from './write-file-durable'
import { dirname, join } from 'node:path'
import {
  MAX_SPACES,
  linkKey,
  makeSpaceId,
  validateSpaceInput,
  type Space,
  type SpaceDocument,
  type SpaceInput,
  type SpaceProjectLink
} from '../shared/space'
import { YAN_DIR } from './paths'

export const SPACE_FILE_NAME = 'spaces.json'

export function spaceDocumentPath(root: string = YAN_DIR): string {
  return join(root, SPACE_FILE_NAME)
}

function sanitizeSpace(raw: unknown): Space | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id.trim()) return null
  if (typeof o.name !== 'string' || !o.name.trim()) return null
  const createdAt = Number.isFinite(o.createdAt) ? Number(o.createdAt) : Date.now()
  const updatedAt = Number.isFinite(o.updatedAt) ? Number(o.updatedAt) : createdAt
  return {
    id: o.id.trim().slice(0, 80),
    name: o.name.trim().slice(0, 200),
    ...(typeof o.description === 'string' && o.description.trim()
      ? { description: o.description.trim().slice(0, 2000) }
      : {}),
    archived: o.archived === true,
    createdAt,
    updatedAt
  }
}

function sanitizeLink(raw: unknown): SpaceProjectLink | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.spaceId !== 'string' || !o.spaceId.trim()) return null
  if (typeof o.projectId !== 'string' || !o.projectId.trim()) return null
  return {
    spaceId: o.spaceId.trim().slice(0, 80),
    projectId: o.projectId.trim().slice(0, 80),
    at: Number.isFinite(o.at) ? Number(o.at) : Date.now()
  }
}

export function sanitizeSpaceDocument(raw: unknown): SpaceDocument {
  const source = raw && typeof raw === 'object' ? (raw as Partial<SpaceDocument>) : {}
  const spaces: Space[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(source.spaces) ? source.spaces : []) {
    const space = sanitizeSpace(item)
    if (!space || seen.has(space.id)) continue
    seen.add(space.id)
    spaces.push(space)
  }
  const links: SpaceProjectLink[] = []
  const linkSeen = new Set<string>()
  for (const item of Array.isArray(source.links) ? source.links : []) {
    const link = sanitizeLink(item)
    if (!link || !seen.has(link.spaceId)) continue
    const key = linkKey(link)
    if (linkSeen.has(key)) continue
    linkSeen.add(key)
    links.push(link)
  }
  const retained = spaces.slice(-MAX_SPACES)
  const retainedIds = new Set(retained.map((space) => space.id))
  return { version: 1, spaces: retained, links: links.filter((link) => retainedIds.has(link.spaceId)) }
}

export type SpaceMutationResult =
  | { ok: true; space: Space }
  | { ok: false; error: 'bad-input' | 'not-found' | 'too-many'; detail?: string }

export class SpaceStore {
  private readonly root: string
  private readonly now: () => number
  private readonly random: () => number
  private doc: SpaceDocument = { version: 1, spaces: [], links: [] }
  private loadPromise: Promise<void> | null = null
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: { root?: string; now?: () => number; random?: () => number } = {}) {
    this.root = options.root ?? YAN_DIR
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
  }

  load(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          this.doc = sanitizeSpaceDocument(parsePersistedDocument(await readFile(spaceDocumentPath(this.root), 'utf8'), { spaces: 'array', links: 'array' }))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            this.doc = { version: 1, spaces: [], links: [] }
            return
          }
          throw new Error('空间文件读取或解析失败，已拒绝覆盖', { cause: error })
        }
      })()
    }
    return this.loadPromise
  }

  list(): Space[] {
    return [...this.doc.spaces].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  links(): SpaceProjectLink[] {
    return [...this.doc.links]
  }

  find(id: string): Space | undefined {
    return this.doc.spaces.find((s) => s.id === id)
  }

  async create(input: unknown): Promise<SpaceMutationResult> {
    return this.enqueue(async () => {
      await this.load()
      const check = validateSpaceInput(input)
      if (!check.ok) return { ok: false as const, error: 'bad-input' as const, detail: check.reason }
      if (this.doc.spaces.length >= MAX_SPACES) {
        return { ok: false as const, error: 'too-many' as const, detail: `最多 ${MAX_SPACES} 个空间` }
      }
      const at = this.now()
      const value: SpaceInput = check.value
      const space: Space = {
        id: makeSpaceId((id) => this.doc.spaces.some((s) => s.id === id), this.random),
        name: value.name,
        ...(value.description ? { description: value.description } : {}),
        archived: false,
        createdAt: at,
        updatedAt: at
      }
      const document: SpaceDocument = { ...this.doc, spaces: [...this.doc.spaces, space] }
      await this.flush(document)
      this.doc = document
      return { ok: true, space }
    })
  }

  async update(id: string, patch: { name?: string; description?: string | null; archived?: boolean }): Promise<SpaceMutationResult> {
    return this.enqueue(async () => {
      await this.load()
      const index = this.doc.spaces.findIndex((s) => s.id === id)
      if (index < 0) return { ok: false as const, error: 'not-found' as const }
      const current = this.doc.spaces[index]

      let name = current.name
      if (patch.name !== undefined) {
        const check = validateSpaceInput({ name: patch.name, description: patch.description ?? current.description })
        if (!check.ok) return { ok: false as const, error: 'bad-input' as const, detail: check.reason }
        name = check.value.name
      }
      let description = current.description
      if (patch.description !== undefined) {
        if (patch.description === null) description = undefined
        else {
          const check = validateSpaceInput({ name, description: patch.description })
          if (!check.ok) return { ok: false as const, error: 'bad-input' as const, detail: check.reason }
          description = check.value.description
        }
      }

      const next: Space = {
        ...current,
        name,
        ...(description ? { description } : {}),
        archived: patch.archived ?? current.archived,
        updatedAt: this.now()
      }
      if (!description) delete next.description
      const spaces = [...this.doc.spaces]
      spaces[index] = next
      const document: SpaceDocument = { ...this.doc, spaces }
      await this.flush(document)
      this.doc = document
      return { ok: true, space: next }
    })
  }

  async linkProject(spaceId: string, projectId: string): Promise<{ ok: boolean; error?: string; links?: SpaceProjectLink[] }> {
    return this.enqueue(async () => {
      await this.load()
      if (!this.find(spaceId)) return { ok: false, error: 'not-found' }
      if (!projectId.trim()) return { ok: false, error: 'bad-input' }
      const link: SpaceProjectLink = { spaceId, projectId: projectId.trim().slice(0, 80), at: this.now() }
      const key = linkKey(link)
      if (this.doc.links.some((l) => linkKey(l) === key)) {
        return { ok: true, links: this.links() }
      }
      const document: SpaceDocument = { ...this.doc, links: [...this.doc.links, link] }
      await this.flush(document)
      this.doc = document
      return { ok: true, links: this.links() }
    })
  }

  async unlinkProject(spaceId: string, projectId: string): Promise<{ ok: boolean; error?: string; links?: SpaceProjectLink[] }> {
    return this.enqueue(async () => {
      await this.load()
      const links = this.doc.links.filter((l) => !(l.spaceId === spaceId && l.projectId === projectId))
      if (links.length === this.doc.links.length) return { ok: true, links: this.links() }
      const document: SpaceDocument = { ...this.doc, links }
      await this.flush(document)
      this.doc = document
      return { ok: true, links: this.links() }
    })
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job)
    this.tail = run.catch(() => undefined)
    return run
  }

  private async flush(candidate: SpaceDocument): Promise<void> {
    const target = spaceDocumentPath(this.root)
    await mkdir(dirname(target), { recursive: true })
    const temp = `${target}.${process.pid}.tmp`
    const payload = JSON.stringify(candidate, null, 2)
    await writeFileDurable(temp, payload)
    try {
      await rename(temp, target)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }
}
