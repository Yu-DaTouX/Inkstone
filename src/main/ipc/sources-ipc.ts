/**
 * 会话来源的 IPC 适配（`yan:sources:*`）。
 *
 * 只有 addImage / removeImage 会写磁盘，而且只写数据目录下属于这个会话的副本；
 * 文件引用（用户的原文件）永远不写也不删。
 */
import type { IpcRegistrar } from './registrar'
import { linkSources, listImagesForSession, readImage, removeImage, saveImage, verifyFiles } from '../sources'
import type { WebSearchAvailability } from '../../shared/web-search'

export interface SourcesIpcDeps {
  /** 当前会话能否用网页搜索（没有运行实例时为 undefined） */
  webSearchAvailability(): Promise<WebSearchAvailability | undefined>
}

export function registerSourcesIpc(ipc: IpcRegistrar, deps: SourcesIpcDeps): void {
  const { handle } = ipc
  const { webSearchAvailability } = deps
  /*
   * 会话来源（§8 的 S1）。
   *
   * 只有 addImage / removeImage 会写磁盘，而且只写数据目录下属于这个会话的副本 ——
   * 文件引用（用户的原文件）**永远不写也不删**，removeImage 那边还有一道
   * 「拼出来的路径必须还在 sources 目录里」的兜底。
   */
  handle('yan:sources:list', async (sessionId: string) => {
    try {
      return listImagesForSession(String(sessionId ?? ''))
    } catch (error) {
      return { ok: false, images: [], dir: '', error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('yan:sources:addImage', async (req: unknown) => {
    const raw = (req ?? {}) as Record<string, unknown>
    try {
      return saveImage({
        sessionId: String(raw.sessionId ?? ''),
        name: String(raw.name ?? ''),
        mimeType: String(raw.mimeType ?? ''),
        base64: String(raw.base64 ?? '')
      })
    } catch {
      return null
    }
  })

  handle('yan:sources:verifyFiles', async (req: unknown) => {
    const raw = (req ?? {}) as Record<string, unknown>
    try {
      const entries = Array.isArray(raw.entries)
        ? raw.entries
            .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
            .map((x) => ({
              path: String(x.path ?? ''),
              name: typeof x.name === 'string' ? x.name : undefined,
              addedAt: typeof x.addedAt === 'number' ? x.addedAt : undefined
            }))
            .filter((x) => x.path)
        : []
      return verifyFiles(String(raw.sessionId ?? ''), entries)
    } catch {
      return []
    }
  })

  handle('yan:sources:link', async (req: unknown) => {
    const raw = (req ?? {}) as Record<string, unknown>
    try {
      return linkSources({
        sessionId: String(raw.sessionId ?? ''),
        sourceIds: Array.isArray(raw.sourceIds) ? raw.sourceIds.map((x) => String(x)) : [],
        messageId: String(raw.messageId ?? '')
      })
    } catch (error) {
      return { ok: false, added: 0, skipped: 0, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('yan:sources:removeImage', async (req: unknown) => {
    const raw = (req ?? {}) as Record<string, unknown>
    try {
      return removeImage(String(raw.sessionId ?? ''), String(raw.sourceId ?? ''))
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('yan:sources:readImage', async (req: unknown) => {
    const raw = (req ?? {}) as Record<string, unknown>
    try {
      return readImage(String(raw.sessionId ?? ''), String(raw.sourceId ?? ''))
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /*
   * 来源搜索入口的可用性（实施-07 S4）。只读查询：不装、不连、不搜。
   * 没发现兼容搜索能力时如实回 `available:false`，界面据此**隐藏**入口
   *（方案：网页搜索只在已发现兼容搜索能力时启用，且不自造私有搜索后端）。
   */
  handle('yan:sources:webSearch', async () => (await webSearchAvailability()) ?? { available: false })
}
