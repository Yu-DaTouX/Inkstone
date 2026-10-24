import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import type { JavaEntry } from '../shared/api.ts'

const JAVA_EXE = process.platform === 'win32' ? 'java.exe' : 'java'

export function javaFromHome(home: string): string {
  return join(home, 'bin', JAVA_EXE)
}

export function parseJavaVersion(text: string): { version: string; majorVersion: number } | null {
  const match = text.match(/(?:JAVA_VERSION="|version ")([0-9][0-9._+-]*)/)
  if (!match) return null
  const version = match[1]
  const parts = version.split(/[._+-]/).map((part) => Number(part))
  const majorVersion = parts[0] === 1 ? parts[1] : parts[0]
  return Number.isFinite(majorVersion) && majorVersion > 0 ? { version, majorVersion } : null
}

async function childDirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name))
  } catch {
    return []
  }
}

export async function potentialJavaPaths(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const paths: string[] = []
  if (env.JAVA_HOME) paths.push(javaFromHome(env.JAVA_HOME))
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) if (dir) paths.push(join(dir, JAVA_EXE))
  const homes: string[] = [join(homedir(), '.jdks')]
  if (process.platform === 'win32') {
    const programFiles = [env.ProgramFiles, env['ProgramFiles(x86)']].filter((dir): dir is string => !!dir)
    for (const base of programFiles) {
      for (const vendor of ['Java', 'Zulu', 'Eclipse Adoptium', 'Microsoft', 'BellSoft', 'Amazon Corretto', 'Eclipse Foundation', 'JetBrains']) homes.push(join(base, vendor))
    }
    const appData = env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    homes.push(join(appData, '.minecraft', 'runtime'))
    if (env.LOCALAPPDATA) {
      for (const pkg of await childDirs(join(env.LOCALAPPDATA, 'Packages'))) {
        if (/Microsoft\.4297127D64EC6_/i.test(pkg)) homes.push(join(pkg, 'LocalCache', 'Local', 'runtime'))
      }
    }
  } else {
    homes.push('/usr/lib/jvm', '/Library/Java/JavaVirtualMachines', join(homedir(), '.minecraft', 'runtime'))
  }
  for (const home of homes) {
    for (const dir of await childDirs(home)) {
      paths.push(javaFromHome(dir), javaFromHome(join(dir, 'Contents', 'Home')))
      for (const nested of await childDirs(dir)) paths.push(javaFromHome(nested))
    }
  }
  return paths
}

function versionFromProcess(path: string): Promise<{ version: string; majorVersion: number } | null> {
  return new Promise((resolve) => {
    execFile(path, ['-version'], { timeout: 8000, windowsHide: true }, (_error, stdout, stderr) => resolve(parseJavaVersion(`${stderr}\n${stdout}`)))
  })
}

export async function resolveJava(path: string): Promise<JavaEntry | null> {
  if (!existsSync(path)) return null
  const home = dirname(dirname(path))
  let info: { version: string; majorVersion: number } | null = null
  try {
    info = parseJavaVersion(await readFile(join(home, 'release'), 'utf8'))
  } catch {
  }
  info ??= await versionFromProcess(path)
  return info ? { path, ...info } : null
}

export async function detectJava(extraPaths: string[] = [], scanSystem = true): Promise<JavaEntry[]> {
  const candidates = new Map<string, string>()
  for (const path of [...extraPaths, ...(scanSystem ? await potentialJavaPaths() : [])]) {
    if (path && !candidates.has(path.toLowerCase()) && existsSync(path)) candidates.set(path.toLowerCase(), path)
  }
  const found = await Promise.all([...candidates.values()].map((path) => resolveJava(path).catch(() => null)))
  return found.filter((java): java is JavaEntry => !!java).sort((a, b) => b.majorVersion - a.majorVersion)
}

export function pickJava(list: JavaEntry[], major: number | null, preferred?: string | null): JavaEntry | undefined {
  if (preferred) {
    const hit = list.find((java) => java.path.toLowerCase() === preferred.toLowerCase())
    if (hit && (major === null || hit.majorVersion >= major)) return hit
  }
  if (major === null) return list[0]
  const exact = list.find((java) => java.majorVersion === major)
  if (exact) return exact
  return [...list].filter((java) => java.majorVersion > major).sort((a, b) => a.majorVersion - b.majorVersion)[0]
}
