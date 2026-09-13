/**
 * 启动 / 连接本机已安装的 Chrome（独立 profile + DevTools 端口）。
 *
 * 为什么单开一个 profile（而不是用用户默认目录）：
 *   Chrome 136 起，对**默认配置目录**开 `--remote-debugging-port` 会被拒绝
 *   （安全策略，防 cookie 被调试接口读走）。所以必须 `--user-data-dir`
 *   指向一个独立目录；好处是调试能力完整、与用户日常 profile 不互相锁。
 *
 * ⚠️ 独立 profile 本身是空白的一一那会让用户以为「cookie 与历史没共享」。
 *    所以启动前会先调 `chrome-profile.ts` 把真实 profile 的登录态与历史
 *    导过来（详见那个文件的注释：Chrome 开着时 cookie 拿不到，历史能拿）。
 *    本文只负责「找到 Chrome / 拼参数 / 拉起进程 / 停掉」，
 *    协议连接在 browser/RawCdp.ts。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { delimiter, join } from 'node:path'

/** 是否 Windows（导出便于单测注入判断） */
const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'

/** 候选的 Chrome 可执行文件路径（按优先级）。纯函数：不碰文件系统。 */
export function chromeCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = []
  if (isWin) {
    for (const base of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]) {
      if (base) out.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    }
    // Edge 是 Chromium，同样的 CDP；作为没有 Chrome 时的兜底
    for (const base of [env['PROGRAMFILES(X86)'], env.PROGRAMFILES]) {
      if (base) out.push(join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    }
  } else if (isMac) {
    out.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    out.push('/Applications/Chromium.app/Contents/MacOS/Chromium')
    out.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
  } else {
    for (const dir of (env.PATH || '').split(delimiter).filter(Boolean)) {
      out.push(join(dir, 'google-chrome'), join(dir, 'chromium'), join(dir, 'chromium-browser'))
    }
    out.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser')
  }
  return out
}

/** 找到第一个真实存在的 Chrome / Chromium 可执行文件 */
export function findChrome(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const p of chromeCandidates(env)) if (p && existsSync(p)) return p
  return null
}

export interface ChromeLaunchOptions {
  /** 独立配置目录（必填：默认目录会被 Chrome 拒绝开调试口） */
  profileDir: string
  /** DevTools 端口 */
  port: number
  /** 启动时打开的地址 */
  url?: string
  /** 无头模式（测试用，不弹窗口） */
  headless?: boolean
  /** Chrome 可执行文件；不传则自动探测 */
  executable?: string
}

/**
 * 拼启动参数。纯函数，单测直接断言内容 —— 其中
 * `--remote-allow-origins=*` 是最容易被漏、漏了就一定连不上的一个：
 * 新版 Chrome 的 DevTools WebSocket 会校验 Origin 头，非 DevTools 前端
 * （我们）不带 / 带 null Origin 时会被直接拒。
 */
export function buildChromeArgs(opts: ChromeLaunchOptions): string[] {
  const args = [
    `--user-data-dir=${opts.profileDir}`,
    `--remote-debugging-port=${opts.port}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate'
  ]
  if (opts.headless) args.push('--headless=new', '--disable-gpu')
  if (opts.url) args.push(opts.url)
  return args
}

/** 起一个 Chrome 进程（不等待 DevTools 就绪，调用方用 waitForCdp 轮询） */
export function launchChrome(opts: ChromeLaunchOptions): ChildProcess {
  const exe = opts.executable ?? findChrome()
  if (!exe) throw new Error('没有找到 Chrome / Chromium；请先安装，或在设置中指定可执行文件')
  return spawn(exe, buildChromeArgs(opts), {
    stdio: 'ignore',
    detached: false,
    windowsHide: true
  })
}

/** 优雅停掉我们拉起的 Chrome（连带它的子进程树交给系统回收） */
export function stopChrome(child: ChildProcess | null): void {
  if (!child || child.killed) return
  try {
    child.kill()
  } catch {
    /* 已经退出 */
  }
}

/** 找一个空闲的本地端口（监听 0 后立刻释放，交给 Chrome 用） */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      const port = typeof address === 'object' && address ? address.port : 0
      srv.close(() => resolve(port))
    })
  })
}

/** 默认的独立 profile 目录（放在应用数据目录下，与内置浏览器隔离） */
export function defaultProfileDir(dataDir: string): string {
  return join(dataDir, 'chrome-profile')
}
