/**
 * 文件相关的 IPC 适配：@ 路径补全、拖入文件授权、只读预览、文件树、全项目文件名搜索与图片附件目录。
 *
 * 安全边界在这里：渲染端只能传路径，能不能读、是否越界、大小上限都由主进程决定；
 * 带 cwd / projectId 的请求先经 `resolveFileContext` 核对成真实目录。
 */
import type { IpcRegistrar } from './registrar'
import { join } from 'node:path'
import { getSettings } from '../settings'
import { completePath } from '../credentials'
import { listDir, searchFiles } from '../files'
import { grantFiles, readGrantedText, readPreview, statPreview } from '../file-refs'
import { attachmentsUsage, listSessionFiles, pruneAttachments, referencedAttachmentNames } from '../attachments'
import { PI_AGENT_DIR, YAN_DIR } from '../paths'
import type { FileSearchRequest } from '../../shared/ipc'
import type { FileRequestContext } from '../../shared/ipc'

export type FileContextResult =
  | { ok: true; context: FileRequestContext }
  | { ok: false; context: FileRequestContext; error: string }

/** 当前主窗口的全项目文件名搜索；新请求可取消旧请求，退出时自然随进程释放。 */
const activeFileSearches = new Map<string, AbortController>()

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export interface FilesIpcDeps {
  /** 文件树 / @ 补全 / 全项目搜索共用的 cwd 与项目核对（见 index.ts） */
  resolveFileContext(settings: Awaited<ReturnType<typeof getSettings>>, fallbackCwd: string, rawContext: unknown): Promise<FileContextResult>
}

export function registerFilesIpc(ipc: IpcRegistrar, deps: FilesIpcDeps): void {
  const { handle, rawHandle } = ipc
  const { resolveFileContext } = deps
  /**
   *  文件引用补全 —— 只读一层目录（不递归扫项目）。
   * 以 cwd 为根；拒绝跳出 cwd 的路径。
   */
  handle('yan:completePath', async (prefix: string, requestedCwd?: string, rawContext?: unknown) => {
    const st = await getSettings()
    const resolved = await resolveFileContext(st, typeof requestedCwd === 'string' && requestedCwd.trim() ? requestedCwd : st.cwd, rawContext)
    if (!resolved.ok) {
      return { paths: [], truncated: false, status: 'invalid' as const, request: resolved.context }
    }
    return completePath(resolved.context.cwd, String(prefix ?? ''), resolved.context)
  })

  /*
   * 拖入的普通文件：主进程校验 + 登记授权（方案 5.1）。
   * ⚠️ 这是安全边界：渲染端只能传路径，能不能读、是不是普通文件、
   *    有没有超出大小上限，全部在这里定，而且只认已登记的路径。
   */
  handle('yan:describeFiles', async (paths: string[]) => grantFiles(paths))
  handle('yan:readFileText', async (p: string) => readGrantedText(String(p ?? '')))
  /* 只读预览（消息里的文件链接）：相对路径按**当前会话 cwd** 解析 */
  handle('yan:readPreview', async (p: string, line?: number, requestedCwd?: string, lineEnd?: number) => {
    const s = await getSettings()
    const cwd = typeof requestedCwd === 'string' && requestedCwd.trim() ? requestedCwd : s.cwd
    return readPreview(
      String(p ?? ''),
      cwd,
      typeof line === 'number' ? line : undefined,
      typeof lineEnd === 'number' ? lineEnd : undefined
    )
  })
  /* 变化提示：只 stat（不读内容），与 readPreview 同一条越界校验链 */
  handle('yan:statPreview', async (p: string, requestedCwd?: string) => {
    const s = await getSettings()
    const cwd = typeof requestedCwd === 'string' && requestedCwd.trim() ? requestedCwd : s.cwd
    return statPreview(String(p ?? ''), cwd)
  })

  /* ---- 文件树 ---- */
  rawHandle('yan:listDir', async (_e, rel: unknown, showHidden: unknown, rawContext: unknown) => {
    const s = await getSettings()
    const context = isObject(rawContext) ? rawContext : undefined
    const requestedCwd = context && typeof context.cwd === 'string' ? context.cwd : s.cwd
    const resolved = await resolveFileContext(s, requestedCwd, context)
    if (!resolved.ok) {
      return {
        path: typeof rel === 'string' ? rel : '',
        abs: '',
        entries: [],
        skipped: [],
        truncated: false,
        status: 'invalid' as const,
        error: resolved.error,
        request: resolved.context
      }
    }
    return listDir(resolved.context.cwd, typeof rel === 'string' ? rel : '', showHidden === true, resolved.context)
  })
  rawHandle('yan:searchFiles', async (_e, rawRequest: unknown) => {
    const s = await getSettings()
    const input = isObject(rawRequest) ? rawRequest : {}
    const requestId = typeof input.requestId === 'string' ? input.requestId.trim().slice(0, 160) : ''
    const query = typeof input.query === 'string' ? input.query.slice(0, 240) : ''
    const requestedCwd = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd : s.cwd
    const resolved = await resolveFileContext(s, requestedCwd, input)
    const request: FileSearchRequest = {
      ...resolved.context,
      requestId,
      query,
      ...(typeof input.limit === 'number' && Number.isFinite(input.limit) ? { limit: input.limit } : {})
    }
    if (!resolved.ok) {
      return { request, entries: [], status: 'invalid' as const, truncated: false, scannedDirs: 0, skippedDirs: 0 }
    }
    if (!requestId) {
      return { request, entries: [], status: 'invalid' as const, truncated: false, scannedDirs: 0, skippedDirs: 0 }
    }
    activeFileSearches.get(requestId)?.abort()
    const controller = new AbortController()
    activeFileSearches.set(requestId, controller)
    try {
      return await searchFiles(request, controller.signal)
    } finally {
      if (activeFileSearches.get(requestId) === controller) activeFileSearches.delete(requestId)
    }
  })
  rawHandle('yan:cancelFileSearch', async (_e, rawRequestId: unknown) => {
    if (typeof rawRequestId !== 'string') return
    activeFileSearches.get(rawRequestId)?.abort()
  })

  /*
   * 图片附件目录：占用 + 手动清理。
   *
   * 清理要扫**全部**会话文件（引用判断按内容 sha1，见 main/attachments.ts），
   * 所以放在主进程里跑，界面只等结果。不做自动 GC —— 由用户决定什么时候清。
   */
  handle('yan:attachments:usage', () => attachmentsUsage(join(YAN_DIR, 'attachments')))
  handle('yan:attachments:prune', async () => {
    const referenced = await referencedAttachmentNames(listSessionFiles(join(PI_AGENT_DIR, 'sessions')))
    return pruneAttachments(join(YAN_DIR, 'attachments'), referenced)
  })
}
