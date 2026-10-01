/**
 * 隐藏页面：搜索引擎结果页与「读网页正文」共用的一次性浏览窗口。
 *
 * 不显示、不带用户的 cookie（每次一个全新的内存 session），也不碰用户正在看的
 * 内置浏览器标签。内网与 link-local 地址一律拦下（含页面内的子请求与重定向），
 * 与内置浏览器的「本地预览边界」同一口径。
 */
import { randomUUID } from 'node:crypto'
import { BrowserWindow, session } from 'electron'
import { isLinkLocalHost, isPrivateHost } from '../browser/network-boundary'

export class HiddenPageTimeout extends Error {
  constructor(ms: number) {
    super(`超过 ${ms}ms 没有返回`)
  }
}

export async function withHiddenPage<T>(
  timeoutMs: number,
  fn: (win: BrowserWindow) => Promise<T>
): Promise<T> {
  const partition = `yan-hidden-${randomUUID()}`
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition, backgroundThrottling: false }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  session.fromPartition(partition).webRequest.onBeforeRequest((details, callback) => {
    try {
      const host = new URL(details.url).hostname
      callback({ cancel: isPrivateHost(host) || isLinkLocalHost(host) })
    } catch {
      callback({})
    }
  })
  let timer: NodeJS.Timeout | undefined
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new HiddenPageTimeout(timeoutMs)), timeoutMs)
    })
    return await Promise.race([fn(win), timeout])
  } finally {
    if (timer) clearTimeout(timer)
    if (!win.isDestroyed()) win.destroy()
  }
}
