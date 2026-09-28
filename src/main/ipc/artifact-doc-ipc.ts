/**
 * 可编辑成果的 IPC 适配（`yan:artifactDoc:*`）。
 *
 * 版本推进、段落保护都是纯函数（shared/artifact-doc.ts），这里只做 I/O 与转发。
 * `applyAgentEdit` 是 agent 改正文的唯一入口：定向替换段落，或带基线版本整篇重写。
 */
import type { IpcRegistrar } from './registrar'
import { app, dialog } from 'electron'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import type { AgentEditInput, ArtifactMutation, ArtifactSourceRef, CreateArtifactInput } from '../../shared/artifact-doc'
import type { BrowserWindow } from 'electron'
import type { ArtifactDocStore } from '../artifact-doc-store'
import type { LibraryService } from '../library-service'

/** 纯逻辑层的 `ArtifactMutation` → IPC 形状。 */
function artifactResult(m: ArtifactMutation) {
  return m.ok
    ? {
        ok: true as const,
        doc: m.doc,
        ...(m.unchanged ? { unchanged: true } : {}),
        ...(m.preserved ? { preserved: m.preserved } : {})
      }
    : { ok: false as const, error: m.reason }
}

export interface ArtifactDocIpcDeps {
  artifactDocs: ArtifactDocStore
  library: LibraryService
  /** 成果引用的资料现在怎么样了（与 `yan research status` 同一实现） */
  sourceStatus(artifactId: string): Promise<unknown>
  /** 导出对话框的父窗口 */
  window(): BrowserWindow | null
}

export function registerArtifactDocIpc(ipc: IpcRegistrar, deps: ArtifactDocIpcDeps): void {
  const { handle } = ipc
  const { artifactDocs, library, sourceStatus } = deps
  /*
   * ---- 可编辑成果（实施-25 P06a）----
   *
   * 版本推进、段落保护都是纯函数（shared/artifact-doc.ts），这里只做 I/O 与转发。
   * `applyAgentEdit` 是 agent 改正文的**唯一**入口：它要么定向替换段落，要么
   * 带基线版本整篇重写（宿主会保留用户改过的段落）。没有「直接写全文」的口子。
   */
  handle('yan:artifactDoc:list', async (spaceId?: string | null) => {
    await artifactDocs.load()
    return { ok: true, docs: artifactDocs.list(spaceId) }
  })
  handle('yan:artifactDoc:create', async (input: CreateArtifactInput) => artifactResult(await artifactDocs.create(input)))
  handle('yan:artifactDoc:saveUserEdit', async (id: string, text: string) =>
    artifactResult(await artifactDocs.saveUserEdit(id, text))
  )
  handle('yan:artifactDoc:applyAgentEdit', async (id: string, edit: AgentEditInput) =>
    artifactResult(await artifactDocs.applyAgentEdit(id, edit))
  )
  handle('yan:artifactDoc:rename', async (id: string, title: string) => artifactResult(await artifactDocs.rename(id, title)))
  handle('yan:artifactDoc:assign', async (id: string, patch: { spaceId?: string | null; taskId?: string | null }) =>
    artifactResult(await artifactDocs.assign(id, patch))
  )
  handle('yan:artifactDoc:addSource', async (id: string, ref: ArtifactSourceRef) =>
    artifactResult(await artifactDocs.addSource(id, ref))
  )
  handle('yan:artifactDoc:toggleChecklist', async (id: string, index: number) =>
    artifactResult(await artifactDocs.toggleChecklist(id, index))
  )
  /*
   * 导出为 Markdown（T06b-3）。
   *
   * 只写**用户在保存框里点的地方**（不自动改写仓库里的文档）。
   * 来源标题现去资料库取：成果只存 `{sourceId, version}`，在这里复制一份标题会让
   * 资料改名后的导出对不上。
   */
  handle('yan:artifactDoc:exportMarkdown', async (id: string) => {
    try {
      await artifactDocs.load()
      const doc = artifactDocs.find(id)
      if (!doc) return { ok: false, error: '找不到这份成果' }
      await library.store.load()
      const lib = library.store.document()
      const sources = doc.sources.map((ref) => {
        const hit = lib.sources.find((s) => s.id === ref.sourceId)
        return { sourceId: ref.sourceId, version: ref.version, ...(hit?.title ? { title: hit.title } : {}) }
      })
      const rendered = artifactDocs.markdownOf(id, sources)
      if (!rendered.ok) return { ok: false, error: rendered.reason }
      const defaultPath = join(
        app.getPath('documents'),
        `${doc.title.replace(/[\\/:*?"<>|]/g, '_') || 'artifact'}.md`
      )
      const options: Electron.SaveDialogOptions = {
        title: '导出成果',
        defaultPath,
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      }
      const picked = deps.window() ? await dialog.showSaveDialog(deps.window()!, options) : await dialog.showSaveDialog(options)
      if (picked.canceled || !picked.filePath) return { ok: true, markdown: rendered.markdown, canceled: true }
      await writeFile(picked.filePath, rendered.markdown, 'utf8')
      return { ok: true, markdown: rendered.markdown, path: picked.filePath }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  handle('yan:artifactDoc:remove', async (id: string) => artifactDocs.remove(id))
  /*
   * 成果引用的资料现在怎么样了（T13-4）。
   *
   * 只**提示变化**，不改任何引用 —— 旧版本按 P03 的不变量保留。
   */
  handle('yan:artifactDoc:sourceStatus', async (id: string) => sourceStatus(id))
}
