import type { IpcRegistrar } from './registrar'
import { app, dialog } from 'electron'
import { join, basename, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { getSettings } from '../settings'
import { listSessions } from '../sessions'
import { readRepoState } from '../git-service'
import { PERSONAL_MEMORY_ID, ingestMemoryInbox, isMemoryScope, memoryStoreOf, writeMemoryExport } from '../personal-memory'
import { commitKnowledge, deleteKnowledge, listKnowledge, readKnowledge } from '../project-memory-store'
import { isSafeRelativeRef } from '../../shared/project-memory'
import type { KnowledgeCommitRequest } from '../../shared/project-memory'
import { countKnowledge, knowledgeMarkdown, toKnowledgeView, toKnowledgeViews } from '../../shared/project-knowledge-view'
import type { KnowledgeViewContext } from '../../shared/project-knowledge-view'
import type { BrowserWindow } from 'electron'

export interface KnowledgeIpcDeps {
  currentCwd(): string | undefined
  knowledgeProjectId(settings: Awaited<ReturnType<typeof getSettings>>, cwd: string): string
  window(): BrowserWindow | null
}

export function registerKnowledgeIpc(ipc: IpcRegistrar, deps: KnowledgeIpcDeps): void {
  const { handle } = ipc
  const { currentCwd, knowledgeProjectId } = deps
  const knowledgeIdentity = async (): Promise<{ projectId: string; cwd: string } | null> => {
    const settings = await getSettings()
    const cwd = currentCwd()
    if (!cwd) return null
    const projectId = knowledgeProjectId(settings, cwd)
    return projectId ? { projectId, cwd } : null
  }

  const knowledgeStore = async (scope: unknown) =>
    memoryStoreOf(isMemoryScope(scope) ? scope : 'project', await knowledgeIdentity())

  const refreshMemoryExport = async (store: NonNullable<Awaited<ReturnType<typeof knowledgeStore>>>): Promise<void> => {
    const personal = store.identity.projectId === PERSONAL_MEMORY_ID
    await writeMemoryExport(
      personal ? 'personal' : `project-${store.identity.projectId}`,
      personal ? '个人记忆' : `项目记忆 · ${basename(store.identity.cwd) || store.identity.projectId}`,
      store.identity,
      store.opts
    ).catch(() => undefined)
  }

  const knowledgeQueryOf = async (cwd: string): Promise<KnowledgeViewContext> => {
    const repo = await readRepoState(cwd).catch(() => null)
    const sessions = await listSessions(Number.MAX_SAFE_INTEGER).catch(() => [])
    const ids = new Set(sessions.map((session) => session.id))
    return {
      branch: repo?.branch ?? null,
      pathExists: (rel: string) => isSafeRelativeRef(rel) && existsSync(resolve(cwd, rel)),
      sessionReadable: (id: string) => ids.has(id)
    }
  }

  const knowledgeQueryFor = async (identity: { projectId: string; cwd: string }): Promise<KnowledgeViewContext> => {
    if (identity.projectId !== PERSONAL_MEMORY_ID) return knowledgeQueryOf(identity.cwd)
    const ids = new Set((await listSessions(Number.MAX_SAFE_INTEGER).catch(() => [])).map((session) => session.id))
    return { branch: null, pathExists: () => true, sessionReadable: (id: string) => ids.has(id) }
  }

  const knowledgeSnapshot = async (scope: unknown) => {
    const settings = await getSettings()
    await ingestMemoryInbox(settings.projects).catch(() => null)
    const store = await knowledgeStore(scope)
    const empty = { all: 0, active: 0, candidate: 0, review: 0 }
    if (!store) return { ok: true, enabled: false, entries: [], counts: empty }
    const identity = store.identity
    try {
      const views = await knowledgeQueryFor(identity).then((query) =>
        listKnowledge(identity, store.opts).then((entries) => toKnowledgeViews(entries, query))
      )
      void refreshMemoryExport(store)
      return { ok: true, projectId: identity.projectId, enabled: false, entries: views, counts: countKnowledge(views) }
    } catch (error) {
      return {
        ok: false,
        projectId: identity.projectId,
        enabled: false,
        entries: [],
        counts: empty,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  handle('yan:knowledge:list', (scope?: unknown) => knowledgeSnapshot(scope))

  handle('yan:knowledge:action', async (req: unknown) => {
    const raw = (req ?? {}) as { action?: unknown; id?: unknown; expectedRevision?: unknown; expectedProjectId?: unknown; text?: unknown; tags?: unknown; kind?: unknown; permanent?: unknown; scope?: unknown }
    const store = await knowledgeStore(raw.scope)
    if (!store) return { ok: false, error: '当前会话没有绑定项目（先选一个项目工作目录）' }
    const identity = store.identity
    if (typeof raw.expectedProjectId === 'string' && raw.expectedProjectId && raw.expectedProjectId !== identity.projectId) {
      return { ok: false, error: '项目已切换，刷新后再改' }
    }
    const id = typeof raw.id === 'string' ? raw.id : ''
    const expectedRevision = Number(raw.expectedRevision)
    if (!id || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
      return { ok: false, error: '缺少条目 id 或版本号（先刷新列表）' }
    }
    const query = await knowledgeQueryFor(identity)
    try {
      if (raw.action === 'delete') {
        const permanent = raw.permanent === true
        const out = await deleteKnowledge({
          identity,
          opts: store.opts,
          request: {
            id,
            expectedRevision,
            mode: permanent ? 'permanent' : 'logical',
            ...(permanent ? { userAction: { by: 'user' as const } } : {})
          }
        })
        if (!out.ok) return { ok: false, error: out.message, latestRevision: out.latest?.revision }
        void refreshMemoryExport(store)
        return { ok: true, entry: toKnowledgeView(out.entry, query) }
      }
      const current = await readKnowledge(identity, id, store.opts)
      if (!current) return { ok: false, error: '条目不存在（可能已被删除）' }
      const draft: KnowledgeCommitRequest = {
        id,
        kind: current.kind,
        text: current.text,
        tags: current.tags,
        evidence: current.evidence,
        confidenceClass: current.confidenceClass,
        ...(current.validFor ? { validFor: current.validFor } : {}),
        ...(current.supersedes?.length ? { supersedes: current.supersedes } : {}),
        expectedRevision
      }
      if (raw.action === 'update') {
        if (typeof raw.text === 'string') draft.text = raw.text
        if (Array.isArray(raw.tags)) draft.tags = raw.tags
        if (raw.kind) draft.kind = raw.kind
        if (!String(draft.text ?? '').trim()) return { ok: false, error: '正文不能为空' }
      } else if (raw.action === 'confirm') {
        draft.confidenceClass = 'user-confirmed'
      } else if (raw.action === 'supersede') {
        if (typeof raw.text !== 'string' || !raw.text.trim()) return { ok: false, error: '替代需要新正文' }
        delete draft.id
        draft.expectedRevision = 0
        draft.text = raw.text
        if (Array.isArray(raw.tags)) draft.tags = raw.tags
        if (raw.kind) draft.kind = raw.kind
        draft.confidenceClass = 'user-confirmed'
        draft.supersedes = [id]
        draft.expectedSupersedesRevisions = { [id]: expectedRevision }
      } else {
        return { ok: false, error: '未知的操作' }
      }
      const out = await commitKnowledge({
        identity,
        opts: store.opts,
        request: draft,
        hostCheck: { userConfirmed: { quote: '用户在项目知识页确认' } }
      })
      if (!out.ok) return { ok: false, error: out.message, latestRevision: out.latest?.revision }
      void refreshMemoryExport(store)
      return {
        ok: true,
        entry: toKnowledgeView(out.entry, query),
        ...(out.superseded.length ? { superseded: out.superseded.map((entry) => toKnowledgeView(entry, query)) } : {})
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('yan:knowledge:export', async (mode: 'copy' | 'save', scope?: unknown) => {
    const store = await knowledgeStore(scope)
    if (!store) return { ok: false, error: '当前会话没有绑定项目（先选一个项目工作目录）' }
    const identity = store.identity
    const personal = identity.projectId === PERSONAL_MEMORY_ID
    const exportDir = personal ? app.getPath('documents') : identity.cwd
    const exportName = personal ? 'personal-memory.md' : 'project-knowledge.md'
    try {
      const views = toKnowledgeViews(await listKnowledge(identity, store.opts), await knowledgeQueryFor(identity))
      const markdown = knowledgeMarkdown(views, {
        projectId: identity.projectId,
        exportedAt: new Date().toISOString(),
        enabled: false
      })
      if (mode !== 'save') return { ok: true, markdown }
      const parent = deps.window()
      const picked = parent
        ? await dialog.showSaveDialog(parent, {
            title: '导出项目知识',
            defaultPath: join(exportDir, exportName),
            filters: [{ name: 'Markdown', extensions: ['md'] }]
          })
        : await dialog.showSaveDialog({
            title: '导出项目知识',
            defaultPath: join(exportDir, exportName),
            filters: [{ name: 'Markdown', extensions: ['md'] }]
          })
      if (picked.canceled || !picked.filePath) return { ok: true, markdown, canceled: true }
      await writeFile(picked.filePath, markdown, 'utf8')
      return { ok: true, markdown, path: picked.filePath }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('yan:knowledge:sourceSession', async (sessionId: string) => {
    const id = String(sessionId ?? '')
    if (!id) return { ok: false, error: '缺少会话 id' }
    try {
      const sessions = await listSessions(Number.MAX_SAFE_INTEGER)
      const hit = sessions.find((session) => session.id === id)
      if (!hit) return { ok: false, error: '来源会话已被删除，无法回读' }
      return { ok: true, path: hit.path, ...(hit.title ? { title: hit.title } : {}) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

}
