import { mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectRecord } from '../shared/ipc'
import { KNOWLEDGE_KINDS, registeredProjectIdForCwd, type ProjectIdentity, type ProjectKnowledge } from '../shared/project-memory'
import { YAN_DIR } from './paths'
import { commitKnowledge, listKnowledge, type ProjectKnowledgeStoreOptions } from './project-memory-store'

export type MemoryScope = 'project' | 'personal'

export const PERSONAL_MEMORY_ID = 'personal'
export const PERSONAL_MEMORY_ROOT = join(YAN_DIR, 'personal-memory')
export const PERSONAL_IDENTITY: ProjectIdentity = { projectId: PERSONAL_MEMORY_ID, cwd: '' }
export const PERSONAL_STORE: ProjectKnowledgeStoreOptions = { root: PERSONAL_MEMORY_ROOT }

export const MEMORY_INBOX_DIR = join(YAN_DIR, 'memory-inbox')
export const MEMORY_EXPORT_DIR = join(YAN_DIR, 'memory-export')

export function isMemoryScope(value: unknown): value is MemoryScope {
  return value === 'project' || value === 'personal'
}

export function memoryStoreOf(
  scope: MemoryScope,
  project: ProjectIdentity | null
): { identity: ProjectIdentity; opts: ProjectKnowledgeStoreOptions } | null {
  if (scope === 'personal') return { identity: PERSONAL_IDENTITY, opts: PERSONAL_STORE }
  return project ? { identity: project, opts: {} } : null
}

const TOOL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/
const MAX_INBOX_FILES = 50
const MAX_INBOX_BYTES = 256 * 1024

export interface InboxCandidateResult {
  index: number
  ok: boolean
  scope?: MemoryScope
  id?: string
  error?: string
}

export interface InboxIngestReport {
  files: number
  accepted: number
  rejected: number
}

export async function ingestMemoryInbox(registry: readonly ProjectRecord[]): Promise<InboxIngestReport> {
  const report: InboxIngestReport = { files: 0, accepted: 0, rejected: 0 }
  const names = (await readdir(MEMORY_INBOX_DIR).catch(() => [] as string[]))
    .filter((name) => /^[^\\/]+\.json$/i.test(name))
    .slice(0, MAX_INBOX_FILES)
  if (!names.length) return report
  const processed = join(MEMORY_INBOX_DIR, 'processed')
  await mkdir(processed, { recursive: true })
  for (const name of names) {
    const path = join(MEMORY_INBOX_DIR, name)
    const results: InboxCandidateResult[] = []
    let fileError: string | null = null
    try {
      const info = await stat(path)
      if (!info.isFile()) throw new Error('收件箱条目不是普通文件')
      if (info.size > MAX_INBOX_BYTES) throw new Error('文件超过 256KB')
      const handle = await open(path, 'r')
      let raw: string
      try {
        const bytes = Buffer.alloc(info.size)
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
        if (bytesRead !== info.size) throw new Error('收件箱文件读取期间发生变化')
        raw = bytes.toString('utf8')
      } finally { await handle.close() }
      const parsed = JSON.parse(raw) as { version?: unknown; tool?: unknown; candidates?: unknown }
      if (parsed.version !== 1) throw new Error('version 必须是 1')
      if (typeof parsed.tool !== 'string' || !TOOL_RE.test(parsed.tool)) throw new Error('tool 必须是 1–40 位字母数字名称')
      if (!Array.isArray(parsed.candidates) || !parsed.candidates.length) throw new Error('candidates 必须是非空数组')
      for (const [index, item] of parsed.candidates.slice(0, 20).entries()) {
        results.push(await ingestCandidate(index, parsed.tool, item, registry))
      }
    } catch (error) {
      fileError = error instanceof Error ? error.message : String(error)
    }
    report.files += 1
    report.accepted += results.filter((r) => r.ok).length
    report.rejected += fileError ? 1 : results.filter((r) => !r.ok).length
    await writeFile(
      join(processed, `${name}.result.json`),
      JSON.stringify({ processedAt: new Date().toISOString(), error: fileError, results }, null, 2),
      'utf8'
    ).catch(() => undefined)
    await rename(path, join(processed, name)).catch(() => rm(path, { force: true }))
  }
  return report
}

async function ingestCandidate(index: number, tool: string, item: unknown, registry: readonly ProjectRecord[]): Promise<InboxCandidateResult> {
  try {
  const raw = (item ?? {}) as { scope?: unknown; project?: unknown; kind?: unknown; text?: unknown; tags?: unknown; source?: unknown }
  if (raw.scope !== 'project' && raw.scope !== 'personal') return { index, ok: false, error: 'scope 只能是 project 或 personal' }
  const scope: MemoryScope = raw.scope
  let identity: ProjectIdentity = PERSONAL_IDENTITY
  let opts: ProjectKnowledgeStoreOptions = PERSONAL_STORE
  if (scope === 'project') {
    const projectId = registeredProjectIdForCwd(raw.project, registry)
    if (!projectId) return { index, ok: false, scope, error: 'project 必须是砚里已登记项目的目录（绝对路径，与登记完全一致）' }
    identity = { projectId, cwd: String(raw.project) }
    opts = {}
  }
  const kind = typeof raw.kind === 'string' && (KNOWLEDGE_KINDS as readonly string[]).includes(raw.kind) ? raw.kind : 'fact'
  const source = (raw.source ?? {}) as { excerpt?: unknown; ref?: unknown }
  const excerpt = [typeof source.ref === 'string' ? source.ref.trim() : '', typeof source.excerpt === 'string' ? source.excerpt.trim() : '']
    .filter(Boolean)
    .join(' · ')
    .slice(0, 480)
  const tags = [`external:${tool}`, ...(Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 8) : [])]
  const outcome = await commitKnowledge({
    identity,
    request: {
      kind,
      text: raw.text,
      tags,
      evidence: excerpt ? [{ excerpt }] : [],
      confidenceClass: 'inferred',
      expectedRevision: 0
    },
    opts
  })
  return outcome.ok
    ? { index, ok: true, scope, id: outcome.entry.id }
    : { index, ok: false, scope, error: `${outcome.code}：${outcome.message}` }
  } catch (error) {
    return { index, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function exportMarkdown(title: string, entries: readonly ProjectKnowledge[]): string {
  const lines = [`# ${title}`, '', `> 由砚自动维护（${new Date().toISOString()}），只含已确认的条目；修改请在砚的设置页进行。`, '']
  for (const entry of entries) {
    lines.push(`- **${entry.kind}** ${entry.text.replace(/\n+/g, ' ')}`)
    lines.push(`  <!-- id=${entry.id} revision=${entry.revision} confidence=${entry.confidenceClass} updated=${entry.updatedAt}${entry.tags.length ? ` tags=${entry.tags.join(',')}` : ''} -->`)
  }
  if (!entries.length) lines.push('（暂无）')
  return `${lines.join('\n')}\n`
}

export async function writeMemoryExport(
  name: string,
  title: string,
  identity: ProjectIdentity,
  opts: ProjectKnowledgeStoreOptions
): Promise<void> {
  const active = (await listKnowledge(identity, opts)).filter((entry) => entry.status === 'active')
  await mkdir(MEMORY_EXPORT_DIR, { recursive: true })
  const json = active.map(({ id, revision, kind, text, tags, confidenceClass, createdAt, updatedAt, evidence, validFor }) => ({
    id,
    revision,
    kind,
    text,
    tags,
    confidenceClass,
    createdAt,
    updatedAt,
    evidence,
    ...(validFor ? { validFor } : {})
  }))
  await writeFile(join(MEMORY_EXPORT_DIR, `${name}.md`), exportMarkdown(title, active), 'utf8')
  await writeFile(
    join(MEMORY_EXPORT_DIR, `${name}.json`),
    JSON.stringify({ version: 1, scope: identity.projectId === PERSONAL_MEMORY_ID ? 'personal' : 'project', projectId: identity.projectId, cwd: identity.cwd || undefined, entries: json }, null, 2),
    'utf8'
  )
}
