import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AgentActivity } from '../shared/agent-profile'
import { assembleContext, renderContextSection, type ContextAssembly } from '../shared/context-assembly'
import { refReadable, refsForOwner } from '../shared/library'
import { LibraryService } from './library-service'
import { YAN_DIR } from './paths'

export const CONTEXT_SNAPSHOT_DIRNAME = 'agent-context'
export const DEFAULT_MAX_SOURCE_CHARS = 1200
export const DEFAULT_MAX_SOURCES = 3

export interface AssembleContextRequest {
  activity: AgentActivity
  sessionId?: string
  requirement?: string
  task?: string
  space?: string
  preference?: string
  budget?: number
  maxSourceChars?: number
  maxSources?: number
}

export function contextSnapshotFileName(runtimeKey: string): string {
  const safe = runtimeKey.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
  return `${safe || 'session'}.json`
}

export function contextSnapshotPath(runtimeKey: string, root: string = YAN_DIR): string {
  return join(root, CONTEXT_SNAPSHOT_DIRNAME, contextSnapshotFileName(runtimeKey))
}

export class ContextAssembler {
  private readonly root: string
  private readonly library: LibraryService

  constructor(options: { root?: string; library?: LibraryService } = {}) {
    this.root = options.root ?? YAN_DIR
    this.library = options.library ?? new LibraryService({ root: this.root })
  }

  async assemble(request: AssembleContextRequest): Promise<ContextAssembly> {
    const sources: {
      ref: { sourceId: string; version: number }
      title: string
      text: string
      start: number
    }[] = []

    const sessionId = request.sessionId?.trim()
    if (sessionId) {
      await this.library.store.load()
      const doc = this.library.store.document()
      const refs = refsForOwner(doc, { kind: 'session', id: sessionId })
      const maxSources = request.maxSources ?? DEFAULT_MAX_SOURCES
      const maxChars = request.maxSourceChars ?? DEFAULT_MAX_SOURCE_CHARS
      let taken = 0
      for (const ref of refs) {
        if (taken >= maxSources) break
        if (!refReadable(doc, ref)) continue
        let opened: Awaited<ReturnType<LibraryService['openRef']>>
        try {
          opened = await this.library.openRef(ref, { maxChars })
        } catch {
          continue
        }
        if (!opened.text?.trim()) continue
        sources.push({
          ref,
          title: opened.source?.title ?? opened.version?.title ?? ref.sourceId,
          text: opened.text,
          start: 0
        })
        taken++
      }
    }

    return assembleContext(
      {
        activity: request.activity,
        ...(request.requirement ? { requirement: request.requirement } : {}),
        ...(request.task ? { task: request.task } : {}),
        ...(request.space ? { space: request.space } : {}),
        ...(request.preference ? { preference: request.preference } : {}),
        ...(sources.length ? { sources } : {})
      },
      request.budget
    )
  }

  async assembleAndWrite(runtimeKey: string, request: AssembleContextRequest): Promise<ContextAssembly> {
    let assembly: ContextAssembly
    try {
      assembly = await this.assemble(request)
    } catch {
      assembly = assembleContext({ activity: request.activity }, request.budget)
    }
    try {
      await writeContextSnapshot(runtimeKey, assembly, this.root)
    } catch {
    }
    return assembly
  }
}

export interface ContextSnapshotRecord {
  version: 1
  runtimeKey: string
  activity: AgentActivity
  section: string | null
  citations: ContextAssembly['citations']
  budget: ContextAssembly['budget']
  at: string
}

export async function writeContextSnapshot(
  runtimeKey: string,
  assembly: ContextAssembly,
  root: string = YAN_DIR
): Promise<ContextSnapshotRecord> {
  const target = contextSnapshotPath(runtimeKey, root)
  await mkdir(dirname(target), { recursive: true })
  const record: ContextSnapshotRecord = {
    version: 1,
    runtimeKey,
    activity: assembly.activity,
    section: renderContextSection(assembly),
    citations: assembly.citations,
    budget: assembly.budget,
    at: new Date().toISOString()
  }
  const temp = `${target}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(record), 'utf8')
  try {
    await rename(temp, target)
  } catch {
    await writeFile(target, JSON.stringify(record), 'utf8')
    await rm(temp, { force: true }).catch(() => undefined)
  }
  return record
}

export async function readContextSnapshot(
  runtimeKey: string,
  root: string = YAN_DIR
): Promise<ContextSnapshotRecord | null> {
  try {
    const raw = JSON.parse(await readFile(contextSnapshotPath(runtimeKey, root), 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    return raw as ContextSnapshotRecord
  } catch {
    return null
  }
}
