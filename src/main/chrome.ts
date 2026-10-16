import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { delimiter, join } from 'node:path'

const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'

export function chromeCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = []
  if (isWin) {
    for (const base of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]) {
      if (base) out.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    }
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

export function findChrome(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const p of chromeCandidates(env)) if (p && existsSync(p)) return p
  return null
}

export interface ChromeLaunchOptions {
  profileDir: string
  port: number
  url?: string
  headless?: boolean
  executable?: string
}

export function buildChromeArgs(opts: ChromeLaunchOptions): string[] {
  const args = [
    `--user-data-dir=${opts.profileDir}`,
    `--remote-debugging-port=${opts.port}`,
    '--remote-allow-origins=http://localhost,http://127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate'
  ]
  if (opts.headless) args.push('--headless=new', '--disable-gpu')
  if (opts.url) args.push(opts.url)
  return args
}

export function launchChrome(opts: ChromeLaunchOptions): ChildProcess {
  const exe = opts.executable ?? findChrome()
  if (!exe) throw new Error('没有找到 Chrome / Chromium；请先安装，或在设置中指定可执行文件')
  return spawn(exe, buildChromeArgs(opts), {
    stdio: 'ignore',
    detached: false,
    windowsHide: true
  })
}

export function stopChrome(child: ChildProcess | null): void {
  if (!child || child.killed) return
  try {
    child.kill()
  } catch {
  }
}

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

export function defaultProfileDir(dataDir: string): string {
  return join(dataDir, 'chrome-profile')
}
