import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { ANDROID_SYSTEM_IMAGE_API, type AndroidSdkStatus } from '../../shared/android-sdk'
import { YAN_DIR } from '../paths'

export const WIN = process.platform === 'win32'
export const MANAGED_SDK = join(YAN_DIR, 'android-sdk')
export const MANAGED_JDK = join(YAN_DIR, 'android-jdk')

export const exe = (name: string): string => (WIN ? `${name}.exe` : name)
export const abi = (): string => (process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64')

function studioSdk(): string {
  if (WIN) return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Android', 'Sdk')
  return process.platform === 'darwin' ? join(homedir(), 'Library', 'Android', 'sdk') : join(homedir(), 'Android', 'Sdk')
}

export function resolveSdkRoot(): { root: string; source: AndroidSdkStatus['sdkSource'] } {
  for (const value of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]) {
    if (value && existsSync(value)) return { root: value, source: 'env' }
  }
  const studio = studioSdk()
  if (existsSync(studio)) return { root: studio, source: 'studio' }
  return { root: MANAGED_SDK, source: 'managed' }
}

export function adbPath(root = resolveSdkRoot().root): string | null {
  const path = join(root, 'platform-tools', exe('adb'))
  return existsSync(path) ? path : null
}

export function emulatorPath(root = resolveSdkRoot().root): string | null {
  const path = join(root, 'emulator', exe('emulator'))
  return existsSync(path) ? path : null
}

export function systemImageDir(root: string): string {
  return join(root, 'system-images', `android-${ANDROID_SYSTEM_IMAGE_API}`, 'google_apis', abi())
}

export function installedSystemImage(root: string): string | null {
  if (existsSync(join(systemImageDir(root), 'system.img'))) return systemImageDir(root)
  const base = join(root, 'system-images')
  const list = (dir: string): string[] => {
    try { return readdirSync(dir).map((name) => join(dir, name)) } catch { return [] }
  }
  for (const api of list(base).reverse()) {
    for (const tag of list(api)) {
      const image = list(tag).find((dir) => existsSync(join(dir, 'system.img')))
      if (image) return image
    }
  }
  return null
}

export function avdHome(): string {
  if (process.env.ANDROID_AVD_HOME) return process.env.ANDROID_AVD_HOME
  return join(process.env.ANDROID_SDK_HOME ?? process.env.ANDROID_USER_HOME ?? homedir(), '.android', 'avd')
}

export function listAvds(): string[] {
  try {
    return readdirSync(avdHome()).filter((name) => name.endsWith('.ini')).map((name) => name.slice(0, -4)).sort()
  } catch {
    return []
  }
}

function javaHomeCandidates(): string[] {
  const managed = (() => {
    try { return readdirSync(MANAGED_JDK).map((name) => join(MANAGED_JDK, name)) } catch { return [] }
  })()
  const studio = WIN
    ? [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Android', 'Android Studio', 'jbr')]
    : process.platform === 'darwin'
      ? ['/Applications/Android Studio.app/Contents/jbr/Contents/Home']
      : ['/opt/android-studio/jbr', join(homedir(), 'android-studio', 'jbr')]
  return [...(process.env.JAVA_HOME ? [process.env.JAVA_HOME] : []), ...managed, ...studio]
}

export function resolveJavaHome(): string | null {
  return javaHomeCandidates().find((home) => existsSync(join(home, 'bin', exe('java')))) ?? null
}

export function javaOnPath(): boolean {
  try { return spawnSync('java', ['-version'], { windowsHide: true, timeout: 5000 }).status === 0 } catch { return false }
}

export function emulatorEnv(): Record<string, string> {
  const env = androidAgentEnv()
  if (!env.PATH) return env
  const own = join(env.ANDROID_HOME, 'platform-tools')
  const path = env.PATH.split(delimiter).filter((dir) => dir === own || !existsSync(join(dir, exe('adb'))))
  return { ...env, PATH: path.join(delimiter) }
}

export function androidAgentEnv(): Record<string, string> {
  const { root } = resolveSdkRoot()
  if (!adbPath(root)) return {}
  const dirs = [join(root, 'platform-tools'), ...(emulatorPath(root) ? [join(root, 'emulator')] : [])]
  const javaHome = resolveJavaHome()
  if (javaHome) dirs.push(join(javaHome, 'bin'))
  return {
    ANDROID_HOME: root,
    ANDROID_SDK_ROOT: root,
    ...(javaHome && !process.env.JAVA_HOME ? { JAVA_HOME: javaHome } : {}),
    PATH: `${dirs.join(delimiter)}${delimiter}${process.env.PATH ?? ''}`
  }
}
