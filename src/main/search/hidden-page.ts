/**
 * 隐藏页面：搜索引擎结果页与「读网页正文」共用的一次性浏览窗口。
 *
 * 不显示、不带用户的 cookie（每次一个全新的内存 session），也不碰用户正在看的
 * 内置浏览器标签。内网与 link-local 地址一律拦下（含页面内的子请求与重定向），
 * 与内置浏览器的「本地预览边界」同一口径：
 *   · 地址字面就是内网 → 字符串判定直接拦；
 *   · 地址看着是公网 → 还要解析一次，域名指向内网（DNS 重绑定）同样拦。
 *   判定本身出错时放行 —— 临时解析故障不该把整页读取打死。
 */
import { randomUUID } from 'node:crypto'
import { BrowserWindow, session } from 'electron'
import { shouldBlockHiddenPageRequest } from '../browser/network-boundary'
import { resolvesToPrivateAddress } from '../browser/network-policy'

/** 可被取消的等待：超时后不必再等满一轮轮询间隔。 */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined
    const done = (): void => {
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    timer = setTimeout(done, ms)
    /* 已经取消时 addEventListener 不会再触发，得手动收尾 */
    if (signal.aborted) done()
    else signal.addEventListener('abort', done, { once: true })
  })
}

export class HiddenPageTimeout extends Error {
  constructor(ms: number) {
    super(`超过 ${ms}ms 没有返回`)
  }
}

export async function withHiddenPage<T>(
  timeoutMs: number,
  fn: (win: BrowserWindow, signal: AbortSignal) => Promise<T>
): Promise<T> {
  const partition = `yan-hidden-${randomUUID()}`
  const controller = new AbortController()
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition, backgroundThrottling: false }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  /*
   * 页面加载会并发发起很多子资源请求，每个都查一次 DNS 太慢：
   * 同一个域名在一个短暂窗口内只解析一次（与 browser.ts 的 dns-rebind 缓存同一做法）。
   */
  const privateDns = new Map<string, { privateTarget: boolean; expiresAt: number }>()
  session.fromPartition(partition).webRequest.onBeforeRequest((details, callback) => {
    /*
     * 判定是异步的（要解析域名），Electron 允许稍后再调 callback。
     * 出错时放行：与 network-policy 同一取舍 —— 宁可少拦，也不要把读取整页打死。
     */
    void shouldBlockHiddenPageRequest(details.url, async (hostname) => {
      const key = hostname.toLowerCase()
      const cached = privateDns.get(key)
      if (cached && cached.expiresAt > Date.now()) return cached.privateTarget
      const privateTarget = await resolvesToPrivateAddress(key)
      privateDns.set(key, { privateTarget, expiresAt: Date.now() + 2000 })
      return privateTarget
    })
      .then((block) => callback({ cancel: block }))
      .catch(() => callback({}))
  })
  let timer: NodeJS.Timeout | undefined
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        /*
         * 先取消再 reject：`fn` 里的轮询必须真的停下来。
         * 只销毁窗口是不够的 —— executeJavaScript 在已销毁窗口上抛错，
         * 而旧实现把那个错当成“正在跳转”吞掉，循环继续跑（每轮还设下一个 timer）。
         */
        controller.abort()
        reject(new HiddenPageTimeout(timeoutMs))
      }, timeoutMs)
    })
    return await Promise.race([fn(win, controller.signal), timeout])
  } finally {
    if (timer) clearTimeout(timer)
    controller.abort()
    if (!win.isDestroyed()) win.destroy()
  }
}
