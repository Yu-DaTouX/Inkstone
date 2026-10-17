import type { IpcRegistrar } from './registrar'
import { linkSources, listImagesForSession, removeImage, saveImage, verifyFiles } from '../sources'

export function registerSourcesIpc(ipc: IpcRegistrar): void {
  const { handle } = ipc
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
      if (typeof raw.mimeType !== 'string' || !/^image\/(?:png|jpeg|webp|gif|bmp|avif)$/i.test(raw.mimeType)) throw new Error('不支持的图片类型')
      if (typeof raw.base64 !== 'string' || raw.base64.length > 16 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw.base64) || !raw.base64.length) throw new Error('图片数据无效或超过大小上限')
      if (typeof raw.name !== 'string' || raw.name.length > 255 || /[\u0000-\u001f]/.test(raw.name)) throw new Error('图片名称无效')
      return saveImage({
        sessionId: String(raw.sessionId ?? ''),
        name: String(raw.name ?? ''),
        mimeType: String(raw.mimeType ?? ''),
        base64: String(raw.base64 ?? '')
      })
    } catch (error) {
      throw new Error(`保存来源图片失败：${error instanceof Error ? error.message : String(error)}`)
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
}
