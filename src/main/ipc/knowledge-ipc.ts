/**
 * 设置页「项目知识 / 个人记忆」的 IPC 适配（`yan:knowledge:*`）。
 *
 * 身份不由渲染端给：一律按当前会话推导（与 `yan knowledge` 同源）；
 * 写操作全部带 `expectedRevision`；「确认」只能由用户在这里触发，模型那条路不传 hostCheck。
 */
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
  /** 当前会话的工作目录（没有会话时为 undefined） */
  currentCwd(): string | undefined
  /** 项目身份：与能力服务 `capability.projectId` 同一规则（见 index.ts 的 knowledgeProjectId） */
  knowledgeProjectId(settings: Awaited<ReturnType<typeof getSettings>>, cwd: string): string
  /** 导出对话框的父窗口 */
  window(): BrowserWindow | null
}

export function registerKnowledgeIpc(ipc: IpcRegistrar, deps: KnowledgeIpcDeps): void {
  const { handle } = ipc
  const { currentCwd, knowledgeProjectId } = deps
  /* ---- 项目知识（实施-03 S5）---- */
  /*
   * 设置页「项目知识」页的一组通道。四条边界：
   *   ① **身份不由渲染端给**：一律按当前会话推导（同一处 `projectIdForCwd`，与 `yan knowledge` 同源），
   *      所以界面永远只能看到「当前项目」的知识；
   *   ② 「需复核」是**派生**状态（分支漂移 / 路径没了 / 来源会话被删）：
   *      文件系统与 git 由宿主查，判定交给纯函数（`shared/project-knowledge-view.ts`）；
   *   ③ 写操作全部带 `expectedRevision`（CAS）—— 界面上看到的版本变了就报错，**不静默覆盖**；
   *   ④ 「确认」是**用户动作**：只有这条路径能把条目升为 active（hostCheck.userConfirmed），
   *      模型那条（`yan knowledge propose`）不传 hostCheck，走不通。
   */
  const knowledgeIdentity = async (): Promise<{ projectId: string; cwd: string } | null> => {
    const settings = await getSettings()
    const cwd = currentCwd()
    if (!cwd) return null
    /*
     * 与能力服务（`capability.projectId`，见 startAgent 那里）**同一个表达式**：
     * 不一致会出现最难查的一类 bug —— 模型 `yan knowledge propose` 写的条目
     * 用户在设置页看不到（反之亦然）。未登记目录用 cwd 派生的稳定 id，
     * 它仍只属于这棵树，不是跨项目共享。
     */
    const projectId = knowledgeProjectId(settings, cwd)
    return projectId ? { projectId, cwd } : null
  }

  /**
   * 设置页按范围取存储：`personal` 是全局个人记忆（固定身份、独立目录），
   * 其余按当前会话的项目身份。渲染端只能选范围，不能指定项目。
   */
  const knowledgeStore = async (scope: unknown) =>
    memoryStoreOf(isMemoryScope(scope) ? scope : 'project', await knowledgeIdentity())

  /** 生效条目有变化后刷新给其他 AI 工具读的导出文件；失败不影响本次操作 */
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
    const sessions = await listSessions(500).catch(() => [])
    const ids = new Set(sessions.map((session) => session.id))
    return {
      branch: repo?.branch ?? null,
      /* 只判「在不在」，不读内容；路径先过 `isSafeRelativeRef` 挡越界（文本引用不授读取权） */
      pathExists: (rel: string) => isSafeRelativeRef(rel) && existsSync(resolve(cwd, rel)),
      sessionReadable: (id: string) => ids.has(id)
    }
  }

  /* 个人记忆没有工作目录：不查分支、不判路径，只核对来源会话 */
  const knowledgeQueryFor = async (identity: { projectId: string; cwd: string }): Promise<KnowledgeViewContext> => {
    if (identity.projectId !== PERSONAL_MEMORY_ID) return knowledgeQueryOf(identity.cwd)
    const ids = new Set((await listSessions(500).catch(() => [])).map((session) => session.id))
    return { branch: null, pathExists: () => true, sessionReadable: (id: string) => ids.has(id) }
  }

  const knowledgeSnapshot = async (scope: unknown) => {
    const settings = await getSettings()
    const enabled = settings.projectKnowledge?.enabled === true
    /* 打开列表时顺带收一次外部工具写回的候选 */
    await ingestMemoryInbox(settings.projects).catch(() => null)
    const store = await knowledgeStore(scope)
    const empty = { all: 0, active: 0, candidate: 0, review: 0 }
    if (!store) return { ok: true, enabled, entries: [], counts: empty }
    const identity = store.identity
    try {
      const views = await knowledgeQueryFor(identity).then((query) =>
        listKnowledge(identity, store.opts).then((entries) => toKnowledgeViews(entries, query))
      )
      void refreshMemoryExport(store)
      return { ok: true, projectId: identity.projectId, enabled, entries: views, counts: countKnowledge(views) }
    } catch (error) {
      return {
        ok: false,
        projectId: identity.projectId,
        enabled,
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
    /*
     * 项目身份 CAS（R10）：界面上的列表属于某个项目，而这里按「此刻的当前会话」
     * 选项目 —— 用户在设置页开着的时候切了会话，点确认就会打到别的项目上。
     * 带了期望身份就严格校验；缺省接受（旧调用/CLI 不受影响）。
     */
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
        /* 永久删除是**另一个动作**（墓碑之外的正文也清），需要明确用户凭据 —— 不靠一个布尔切换 */
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
      /*
       * 三种写操作都是「以**磁盘上的当前版**为底稿改字段」，
       * 底稿一律重新读，不信渲染端回传的内容 —— 否则界面上的旧副本
       * 会覆盖掉别处（例如模型在会话里）刚写进去的字段。
       */
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
        /* 用户点了确认 → 就是「用户确认」这一类，而不是仍标成模型推断 */
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
      } else {
        return { ok: false, error: '未知的操作' }
      }
      const out = await commitKnowledge({
        identity,
        opts: store.opts,
        request: draft,
        /* 这是「用户动作」的凭据：模型构造不出来（它那条路不传 hostCheck） */
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
      const settings = await getSettings()
      const views = toKnowledgeViews(await listKnowledge(identity, store.opts), await knowledgeQueryFor(identity))
      const markdown = knowledgeMarkdown(views, {
        projectId: identity.projectId,
        exportedAt: new Date().toISOString(),
        enabled: settings.projectKnowledge?.enabled === true
      })
      if (mode !== 'save') return { ok: true, markdown }
      /*
       * 「保存到文件」只写用户在选择框里点的地方，**不自动改写仓库文档**
       *（§6：「导出到项目文档」必须展示目标文件与 diff，属于单独动作）。
       */
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

  /*
   * 来源跳转（§6「来源跳转」）：渲染端只知道 sessionId，文件路径只有主进程知道。
   * 返回 `ok:false` 时界面显示「不可回读」——**不伪造证据**（§4）。
   */
  handle('yan:knowledge:sourceSession', async (sessionId: string) => {
    const id = String(sessionId ?? '')
    if (!id) return { ok: false, error: '缺少会话 id' }
    try {
      const sessions = await listSessions(500)
      const hit = sessions.find((session) => session.id === id)
      if (!hit) return { ok: false, error: '来源会话已被删除，无法回读' }
      return { ok: true, path: hit.path, ...(hit.title ? { title: hit.title } : {}) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

}
