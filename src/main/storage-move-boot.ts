import { app, BrowserWindow, dialog, nativeTheme } from 'electron'
import { hasPendingStorageMove, runPendingStorageMove, type StorageMoveProgress, type StorageMoveResult } from './storage-move'

interface MoveText {
  title: string
  hint: string
  scan: string
  copy: (files: string, totalFiles: string, bytes: string, totalBytes: string) => string
  verify: string
  cleanup: string
  failed: string
  leftover: (path: string) => string
}

const ZH: MoveText = {
  title: '正在迁移数据',
  hint: '正在把数据复制到新位置，完成后会自动打开砚。请不要关机或结束进程。',
  scan: '正在统计文件…',
  copy: (files, totalFiles, bytes, totalBytes) => `已复制 ${files} / ${totalFiles} 个文件 · ${bytes} / ${totalBytes}`,
  verify: '正在核对复制结果…',
  cleanup: '正在清理旧目录…',
  failed: '数据迁移没有完成',
  leftover: (path) => `数据完整保存在：${path}`
}

const EN: MoveText = {
  title: 'Moving data',
  hint: 'Copying your data to the new location. Inkstone opens automatically when done. Do not shut down or end the process.',
  scan: 'Counting files…',
  copy: (files, totalFiles, bytes, totalBytes) => `Copied ${files} / ${totalFiles} files · ${bytes} / ${totalBytes}`,
  verify: 'Verifying the copy…',
  cleanup: 'Removing the old folder…',
  failed: 'Data move did not complete',
  leftover: (path) => `Your data is intact at: ${path}`
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

function progressView(text: MoveText, progress: StorageMoveProgress): { percent: number; detail: string } {
  if (progress.phase === 'scan') return { percent: 0, detail: text.scan }
  if (progress.phase === 'verify') return { percent: 100, detail: text.verify }
  if (progress.phase === 'cleanup') return { percent: 100, detail: text.cleanup }
  const percent = progress.totalBytes > 0 ? Math.min(100, (progress.bytes / progress.totalBytes) * 100) : 0
  return {
    percent,
    detail: text.copy(
      progress.files.toLocaleString(),
      progress.totalFiles.toLocaleString(),
      formatBytes(progress.bytes),
      formatBytes(progress.totalBytes)
    )
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] as string)
}

function progressPage(text: MoveText, dark: boolean): string {
  const bg = dark ? '#151515' : '#fcfcfa'
  const fg = dark ? '#e8e6e1' : '#1f1e1c'
  const track = dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)'
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(text.title)}</title><style>
body{margin:0;height:100vh;box-sizing:border-box;padding:0 28px;display:flex;flex-direction:column;justify-content:center;background:${bg};color:${fg};font:13px/1.55 "Segoe UI","Microsoft YaHei UI",system-ui,sans-serif;-webkit-app-region:drag;user-select:none;cursor:default}
h1{margin:0 0 4px;font-size:15px;font-weight:600}
p{margin:0;opacity:.7}
.bar{height:4px;margin:16px 0 8px;border-radius:2px;background:${track};overflow:hidden}
.fill{height:100%;width:0;background:${fg};transition:width .2s ease-out}
#detail{font-variant-numeric:tabular-nums;opacity:.85}
</style></head><body><h1>${escapeHtml(text.title)}</h1><p>${escapeHtml(text.hint)}</p><div class="bar"><div class="fill" id="fill"></div></div><p id="detail">${escapeHtml(text.scan)}</p>
<script>window.update=function(v){document.getElementById('fill').style.width=v.percent+'%';document.getElementById('detail').textContent=v.detail}</script></body></html>`
}

function closeWhenAppWindowShows(window: BrowserWindow): void {
  const close = (): void => {
    clearTimeout(timer)
    app.off('browser-window-created', watch)
    if (!window.isDestroyed()) window.destroy()
  }
  const watch = (_event: Electron.Event, next: BrowserWindow): void => {
    if (next !== window) next.once('show', close)
  }
  const timer = setTimeout(close, 20_000)
  app.on('browser-window-created', watch)
}

async function moveWithProgressWindow(): Promise<void> {
  const text = app.getLocale().toLowerCase().startsWith('zh') ? ZH : EN
  const dark = nativeTheme.shouldUseDarkColors
  let finished = false
  const window = new BrowserWindow({
    width: 440,
    height: 168,
    resizable: false,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    roundedCorners: true,
    show: false,
    title: text.title,
    backgroundColor: dark ? '#151515' : '#fcfcfa',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false }
  })
  window.on('close', (event) => {
    if (!finished) event.preventDefault()
  })
  window.once('ready-to-show', () => window.show())
  const focus = (): void => {
    if (window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
  app.on('second-instance', focus)
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(progressPage(text, dark))}`).catch(() => {})

  let lastSent = 0
  let lastPhase = ''
  const onProgress = (progress: StorageMoveProgress): void => {
    const now = Date.now()
    if (progress.phase === lastPhase && now - lastSent < 150) return
    lastSent = now
    lastPhase = progress.phase
    if (window.isDestroyed() || window.webContents.isLoading()) return
    void window.webContents.executeJavaScript(`window.update&&window.update(${JSON.stringify(progressView(text, progress))})`).catch(() => {})
  }

  let result: StorageMoveResult | undefined
  try {
    result = await runPendingStorageMove(onProgress)
  } finally {
    finished = true
    app.off('second-instance', focus)
  }
  if (result && !result.ok && !window.isDestroyed()) {
    await dialog.showMessageBox(window, {
      type: 'warning',
      title: text.failed,
      message: text.failed,
      detail: [result.error, result.leftover ? text.leftover(result.leftover) : ''].filter(Boolean).join('\n\n'),
      noLink: true
    }).catch(() => {})
  }
  closeWhenAppWindowShows(window)
}

export const storageMoveReady: Promise<void> =
  app.requestSingleInstanceLock() && hasPendingStorageMove()
    ? app.whenReady().then(moveWithProgressWindow).catch(() => {})
    : Promise.resolve()
