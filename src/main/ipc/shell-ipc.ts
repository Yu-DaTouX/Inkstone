import { app, clipboard, ClipboardItem, dialog, ipcMain, nativeImage, Notification, shell, type BrowserWindow } from 'electron'
import { basename, dirname, extname, join } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import type { IpcRegistrar } from './registrar'
import type { AgentController } from '../agent'
import type { RunnerRegistry } from '../runners'
import type { BrowserController } from '../browser'
import type { McpAppViewService } from '../mcp/app-view-service'
import type { AttentionService } from '../attention'
import type { AttentionNotices } from '../attention-notice'
import type { DeepLink } from '../deeplink'
import type { NotificationBotKind } from '../bot-icon'
import type { ModelRef } from '../../shared/model-brand'
import type { Attachment, AttentionNotify, MainPush } from '../../shared/ipc'
import { pick } from '../../shared/ui-lang'
import { getSettings, patchSettings, setGuardSettingsNoticeSink } from '../settings'
import { isRestoredReadonly, restoredReadonlyMessage } from '../restored-readonly'
import { openBlockedByName } from '../open-guard'
import { exportHtmlImage } from '../artifact-image-export'
import { htmlArtifactPreviews } from '../html-artifact-preview'
import { imageFile, localizeImage } from '../image-store'
import { peekUiScale, zoomState } from '../zoom'
import { YAN_DIR } from '../paths'

const IMAGE_DATA_URL = /^data:image\/([a-z0-9.+-]+);base64,/i
const PICK_IMAGES_TOTAL_BYTES = 24 * 1024 * 1024
const PICK_IMAGES_PREVIEW_WIDTH = 160
const PICK_IMAGES_PREVIEW_MIN_BYTES = 256 * 1024
const IMAGE_EXTENSIONS: Record<string, string> = { png: 'png', jpeg: 'jpg', jpg: 'jpg', gif: 'gif', webp: 'webp', bmp: 'bmp' }

function imageSaveBytes(dataUrl: unknown): { data: Buffer; ext: string } | null {
  if (typeof dataUrl !== 'string') return null
  const head = IMAGE_DATA_URL.exec(dataUrl)
  if (!head) return null
  const ext = IMAGE_EXTENSIONS[head[1].toLowerCase()]
  if (!ext) return null
  const data = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
  return data.length ? { data, ext } : null
}

function imageFileName(suggested: unknown, ext: string): string {
  const raw = typeof suggested === 'string' ? basename(suggested).replace(/[:*?"<>|]+/g, '').trim() : ''
  const stem = raw ? raw.replace(/\.[a-z0-9]{1,5}$/i, '') : ''
  return `${stem.slice(0, 80) || 'image'}.${ext}`
}

export interface ShellIpcDeps {
  isTrustedIpc(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean
  win(): BrowserWindow | null
  runners(): RunnerRegistry | null
  ac(): AgentController | null
  browser(): BrowserController | null
  mcpAppViewService(): McpAppViewService | null
  attention(): AttentionService | null
  isQuitting(): boolean
  setHotkeyGuardPaused(paused: boolean): void
  setTrayMotionAllowed(allowed: boolean): void
  refreshTaskbar(force?: boolean): void
  push(msg: MainPush): void
  attentionNotices: AttentionNotices
  botNotificationIcon(model: ModelRef, kind: NotificationBotKind): string | undefined
  sessionNoticeLink(sessionId?: string): DeepLink | undefined
  pushRunnerSnapshot(id: string): Promise<void>
  pushRunners(): void
  reclaimQueuedMessages(): Promise<void>
  requestExit(options: { relaunch?: boolean; source?: string }): Promise<{ action: 'cancelled' | 'save-and-exit' | 'interrupt-exit' | 'already-exiting' }>
  pushWinState(): void
  setUiScale(v: unknown): Promise<ReturnType<typeof zoomState>>
}

export function registerShellIpc(ipc: IpcRegistrar, deps: ShellIpcDeps): void {
  const { handle, rawHandle } = ipc
  const {
    isTrustedIpc, ac, refreshTaskbar, push, attentionNotices, botNotificationIcon, sessionNoticeLink,
    pushRunnerSnapshot, pushRunners, reclaimQueuedMessages, requestExit, pushWinState, setUiScale
  } = deps

  ipcMain.on('yan:hotkey-guard', (event, v) => {
    if (!isTrustedIpc(event) || typeof v !== 'boolean') return
    deps.setHotkeyGuardPaused(v)
  })

  ipcMain.on('yan:motion-preference', (event, reduced) => {
    if (!isTrustedIpc(event) || typeof reduced !== 'boolean') return
    deps.setTrayMotionAllowed(!reduced)
    refreshTaskbar()
  })

  handle('yan:notifyAttention', async (n: AttentionNotify) => {
    const kind = n?.kind ?? 'done'
    const title = typeof n?.title === 'string' && n.title.trim() ? n.title : '砚'
    const body = typeof n?.body === 'string' && n.body.trim() ? n.body : undefined

    const icon = botNotificationIcon(
      typeof n?.model?.provider === 'string' || typeof n?.model?.id === 'string' ? n.model : undefined,
      kind
    )
    const sessionId = typeof n?.sessionId === 'string' && n.sessionId ? n.sessionId : undefined

    if (process.env.YAN_PROBE) {
      push({ ch: 'log', payload: { text: `[通知] ${kind} | ${title} | ${body ?? ''}${icon ? ` | icon=${basename(icon)}` : ''}${sessionId ? ` | session=${sessionId}` : ''}` } })
      return { shown: true, simulated: true }
    }

    if (!Notification.isSupported()) return { shown: false, error: pick('系统不支持通知', 'System notifications are not supported') }
    try {
      attentionNotices.show({ key: sessionId ? `session:${sessionId}` : `attention:${kind}`, title, body, icon, link: sessionNoticeLink(sessionId) })
      return { shown: true }
    } catch (error) {
      return { shown: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.on('yan:renderer-ready', (event) => {
    if (!isTrustedIpc(event)) return
    deps.mcpAppViewService()?.resetForReload()
    deps.setHotkeyGuardPaused(false)
    const rid = deps.runners()?.activeRunnerId
    const c = ac()?.getConn()
    if (c) push({ ch: 'proc', payload: { state: c.state, detail: c.detail } })
    if (rid) void pushRunnerSnapshot(rid)
    else {
      const st = ac()?.getState()
      if (st) push({ ch: 'state', payload: st })
      void ac()?.refreshStats()
      void ac()?.refreshTodos()
    }
    const browser = deps.browser()
    if (browser) push({ ch: 'browser-state', payload: browser.getState() })
    pushRunners()
    void reclaimQueuedMessages()
    setGuardSettingsNoticeSink((message) => push({ ch: 'notify', payload: { id: `guard-settings-${Date.now()}-${message.length}`, method: 'notify', notifyType: 'warning', message } }))
    if (isRestoredReadonly()) push({ ch: 'notify', payload: { id: 'restored-readonly', method: 'notify', notifyType: 'info', message: restoredReadonlyMessage() } })
  })

  handle('yan:openPath', async (p: string) => {
    if (typeof p !== 'string' || !p.trim()) return { ok: false, error: 'empty path' }
    if (/^[\\/]{2}/.test(p.trim())) return { ok: false, error: 'network path' }
    if (!existsSync(p)) return { ok: false, error: 'missing' }
    let directory = false
    try {
      directory = statSync(p).isDirectory()
    } catch {
      return { ok: false, error: 'missing' }
    }
    if (!directory && openBlockedByName(p)) return { ok: false, error: 'blocked' }
    const err = await shell.openPath(p)
    return err ? { ok: false, error: err } : { ok: true }
  })

  handle('yan:revealPath', async (p: string) => {
    if (typeof p !== 'string' || !p.trim() || /^[\\/]{2}/.test(p.trim()) || !existsSync(p)) return { ok: false }
    shell.showItemInFolder(p)
    return { ok: true }
  })

  handle('yan:exportHtmlImage', async (htmlPath: unknown) => {
    if (!deps.win()) return { ok: false, error: 'window:missing' }
    if (typeof htmlPath !== 'string' || !/\.html?$/i.test(htmlPath) || !existsSync(htmlPath)) return { ok: false, error: 'export:path' }
    const r = await dialog.showSaveDialog(deps.win()!, {
      title: pick('导出 PNG', 'Export PNG'),
      defaultPath: join(dirname(htmlPath), `${basename(htmlPath).replace(/\.html?$/i, '')}.png`),
      filters: [{ name: 'PNG', extensions: ['png'] }]
    })
    if (r.canceled || !r.filePath) return { ok: true, canceled: true }
    try {
      const result = await exportHtmlImage({ previews: htmlArtifactPreviews, htmlPath, root: dirname(htmlPath), outPath: r.filePath })
      shell.showItemInFolder(result.path)
      return { ok: true, path: result.path }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('yan:image:stash', async (images: unknown) => {
    if (!Array.isArray(images) || images.length > 16) return []
    const dir = join(YAN_DIR, 'attachments')
    const paths: string[] = []
    for (const item of images as Array<{ data?: unknown; mimeType?: unknown }>) {
      if (typeof item?.data !== 'string' || typeof item.mimeType !== 'string') continue
      const file = imageFile(dir, item.mimeType, item.data)
      if (!file || !localizeImage(dir, item.mimeType, item.data)) continue
      paths.push(file)
    }
    return paths
  })

  handle('yan:image:copy', async (dataUrl: unknown) => {
    const bytes = imageSaveBytes(dataUrl)
    if (!bytes) return { ok: false, error: 'image:invalid' }
    const mime = `image/${bytes.ext === 'jpg' ? 'jpeg' : bytes.ext}`
    await clipboard.write([new ClipboardItem({ [mime]: new Blob([bytes.data], { type: mime }) })])
    return { ok: true }
  })

  handle('yan:image:save', async (dataUrl: unknown, suggestedName?: unknown) => {
    if (!deps.win()) return { ok: false, error: 'window:missing' }
    const bytes = imageSaveBytes(dataUrl)
    if (!bytes) return { ok: false, error: 'image:invalid' }
    const r = await dialog.showSaveDialog(deps.win()!, {
      title: pick('保存图片', 'Save image'),
      defaultPath: join(app.getPath('pictures'), imageFileName(suggestedName, bytes.ext)),
      filters: [{ name: pick('图片', 'Images'), extensions: [bytes.ext] }]
    })
    if (r.canceled || !r.filePath) return { ok: true, canceled: true }
    await writeFile(r.filePath, bytes.data)
    return { ok: true, path: r.filePath }
  })

  handle('yan:pickImages', async (): Promise<Attachment[]> => {
    if (!deps.win()) return []
    const r = await dialog.showOpenDialog(deps.win()!, {
      title: pick('选择图片', 'Choose images'),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: pick('图片', 'Images'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
    })
    if (r.canceled) return []

    const out: Attachment[] = []
    let total = 0
    let skippedForSize = false
    for (const file of r.filePaths) {
      try {
        const size = (await stat(file)).size
        if (size > 12 * 1024 * 1024) {
          skippedForSize = true
          continue
        }
        if (total + size > PICK_IMAGES_TOTAL_BYTES) {
          skippedForSize = true
          break
        }
        const buf = await readFile(file)
        if (buf.byteLength > 12 * 1024 * 1024 || total + buf.byteLength > PICK_IMAGES_TOTAL_BYTES) {
          skippedForSize = true
          continue
        }
        total += buf.byteLength
        const ext = extname(file).slice(1).toLowerCase()
        const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext || 'png'}`
        const data = buf.toString('base64')
        const thumb = buf.byteLength > PICK_IMAGES_PREVIEW_MIN_BYTES
          ? nativeImage.createFromBuffer(buf).resize({ width: PICK_IMAGES_PREVIEW_WIDTH }).toDataURL().replace(/^data:[^;]+;base64,/, '')
          : ''
        const preview = thumb || data
        out.push({
          id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: basename(file),
          mimeType,
          size: buf.byteLength,
          data,
          preview
        })
        await new Promise<void>((resolve) => setImmediate(resolve))
      } catch (e) {
        console.error('[yan] 读图失败：', file, e)
      }
    }
    if (skippedForSize) {
      push({
        ch: 'notify',
        payload: {
          id: `pick-images-${Date.now()}`,
          method: 'notify',
          notifyType: 'warning',
          message: pick(`有图片没能加入：单张超过 12 MB 或合计超过 ${Math.round(PICK_IMAGES_TOTAL_BYTES / (1024 * 1024))} MB。`, `Some images were not added: over 12 MB each or ${Math.round(PICK_IMAGES_TOTAL_BYTES / (1024 * 1024))} MB total.`)
        }
      })
    }
    return out
  })

  handle('yan:pickFiles', async (): Promise<string[]> => {
    if (!deps.win()) return []
    const r = await dialog.showOpenDialog(deps.win()!, {
      title: pick('选择文件或文件夹', 'Choose files or folders'),
      properties: ['openFile', 'openDirectory', 'multiSelections']
    })
    return r.canceled ? [] : r.filePaths
  })

  handle('yan:pickCwd', async () => {
    if (!deps.win()) return null
    const lastCwd = (await getSettings()).cwd
    const r = await dialog.showOpenDialog(deps.win()!, {
      properties: ['openDirectory'],
      title: pick('选择工作目录', 'Choose working folder'),
      ...(lastCwd && existsSync(lastCwd) ? { defaultPath: lastCwd } : {})
    })
    if (r.canceled || !r.filePaths[0]) return null
    return r.filePaths[0]
  })
  ipcMain.on('win:minimize', (event) => { if (isTrustedIpc(event)) deps.win()?.minimize() })
  ipcMain.on('win:maximize', (event) => {
    const win = deps.win()
    if (!isTrustedIpc(event) || !win) return
    win.isMaximized() ? win.unmaximize() : win.maximize()
  })
  ipcMain.on('win:close', (event) => { if (isTrustedIpc(event)) deps.win()?.close() })
  rawHandle('win:requestExit', async () => requestExit({ source: 'ipc' }))
  rawHandle('win:lifecycle', () => ({
    tray: deps.attention()?.hasTray() ?? false,
    visible: !!deps.win() && !deps.win()!.isDestroyed() && deps.win()!.isVisible(),
    quitting: deps.isQuitting()
  }))

  rawHandle('win:setAlwaysOnTop', async (_e, v: boolean) => {
    const on = !!v
    deps.win()?.setAlwaysOnTop(on)
    await patchSettings({ alwaysOnTop: on })
    pushWinState()
    return on
  })

  rawHandle('yan:getZoom', async () => zoomState(deps.win(), peekUiScale()))

  rawHandle('yan:setUiScale', async (_e, v: unknown) => setUiScale(v))
}
