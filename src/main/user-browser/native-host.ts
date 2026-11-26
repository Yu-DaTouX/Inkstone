import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { cmdLauncherText } from '../yan-cli'

export const BRIDGE_HOST_NAME = 'app.inkstone.browser_bridge'
export const CHROMIUM_EXTENSION_ID = 'lbceoiahmfjmmlpmndopbliceoalblcc'
export const FIREFOX_EXTENSION_ID = 'browser-bridge@inkstone.app'

export type BridgeBrowser = 'chrome' | 'edge' | 'firefox'

export const REGISTRY_KEYS: Record<BridgeBrowser, string> = {
  chrome: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${BRIDGE_HOST_NAME}`,
  edge: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${BRIDGE_HOST_NAME}`,
  firefox: `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${BRIDGE_HOST_NAME}`
}

export interface BridgeHostFiles {
  dir: string
  script: string
  launcher: string
  chromiumManifest: string
  firefoxManifest: string
}

export function bridgeHostFiles(dir: string): BridgeHostFiles {
  return {
    dir,
    script: join(dir, 'host.mjs'),
    launcher: join(dir, 'host.cmd'),
    chromiumManifest: join(dir, 'chromium.json'),
    firefoxManifest: join(dir, 'firefox.json')
  }
}

export function hostManifest(kind: 'chromium' | 'firefox', launcher: string): Record<string, unknown> {
  return {
    name: BRIDGE_HOST_NAME,
    description: 'Inkstone browser bridge',
    path: launcher,
    type: 'stdio',
    ...(kind === 'chromium'
      ? { allowed_origins: [`chrome-extension://${CHROMIUM_EXTENSION_ID}/`] }
      : { allowed_extensions: [FIREFOX_EXTENSION_ID] })
  }
}

export function shouldRegisterBridge(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  dataDir = '',
  defaultDir = ''
): boolean {
  if (platform !== 'win32') return false
  if (env.YAN_BROWSER_BRIDGE_REGISTER === '0') return false
  if (env.YAN_BROWSER_BRIDGE_REGISTER === '1') return true
  const actual = dataDir.trim()
  const expected = defaultDir.trim()
  return !!actual && !!expected && resolve(actual).toLowerCase() === resolve(expected).toLowerCase()
}

async function writeIfChanged(path: string, text: string): Promise<void> {
  const current = await readFile(path, 'utf8').catch(() => null)
  if (current !== text) await writeFile(path, text, 'utf8')
}

export interface RegistryAccess {
  read(key: string): Promise<string | null>
  write(key: string, value: string): Promise<void>
}

const runExec = (file: string, args: string[]): Promise<string> => new Promise((resolve, reject) => {
  execFile(file, args, { windowsHide: true, timeout: 10_000 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))))
})

async function readRegistryWithPwsh(key: string): Promise<string | null> {
  const escaped = key.replace(/'/g, "''")
  const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8;$v=(Get-ItemProperty -LiteralPath 'Registry::${escaped}' -ErrorAction SilentlyContinue).'(default)';if($null -ne $v){[Console]::Write($v)}`
  const out = (await runExec('pwsh', ['-NoProfile', '-Command', script])).replace(/^\uFEFF/, '')
  return out.length ? out : null
}

async function readRegistryWithCmd(key: string): Promise<string | null> {
  const safeKey = key.replace(/["&|<>^%]/g, '')
  const out = await runExec('cmd.exe', ['/d', '/s', '/c', `chcp 65001>nul & reg query "${safeKey}" /ve`])
  return /REG_SZ\s+([^\r\n]+)/.exec(out)?.[1]?.trim() ?? null
}

export const windowsRegistry: RegistryAccess = {
  async read(key) {
    try {
      return await readRegistryWithPwsh(key)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        try {
          return await readRegistryWithCmd(key)
        } catch {
          return null
        }
      }
      return null
    }
  },
  async write(key, value) {
    await runExec('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f'])
  }
}

export interface InstallBridgeHostOptions {
  dir: string
  hostSource: string
  execPath: string
  register: boolean
  registry?: RegistryAccess
}

export async function installBridgeHost(options: InstallBridgeHostOptions): Promise<{ files: BridgeHostFiles; registered: BridgeBrowser[] }> {
  const files = bridgeHostFiles(options.dir)
  await mkdir(options.dir, { recursive: true })
  await copyFile(options.hostSource, files.script)
  await writeIfChanged(files.launcher, cmdLauncherText(options.execPath, files.script))
  await writeIfChanged(files.chromiumManifest, `${JSON.stringify(hostManifest('chromium', files.launcher), null, 2)}\n`)
  await writeIfChanged(files.firefoxManifest, `${JSON.stringify(hostManifest('firefox', files.launcher), null, 2)}\n`)
  const registered: BridgeBrowser[] = []
  if (!options.register) return { files, registered }
  const registry = options.registry ?? windowsRegistry
  for (const browser of Object.keys(REGISTRY_KEYS) as BridgeBrowser[]) {
    const key = REGISTRY_KEYS[browser]
    const value = browser === 'firefox' ? files.firefoxManifest : files.chromiumManifest
    if ((await registry.read(key)) !== value) await registry.write(key, value)
    registered.push(browser)
  }
  return { files, registered }
}
