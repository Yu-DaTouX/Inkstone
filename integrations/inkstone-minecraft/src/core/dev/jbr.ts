import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { JavaEntry } from '../../shared/dev-api.ts'
import type { JbrInfo } from '../../shared/dev-api.ts'
import { detectJava, javaFromHome } from './java.ts'

export const JBR_RELEASES_URL = 'https://github.com/JetBrains/JetBrainsRuntime/releases'

export function jbrDownloadHint(major: number, runtimesDir: string): string {
  return [
    `没有找到 JetBrains Runtime（JBR）${major}。普通 JDK 只能热替换方法体；JBR 支持 -XX:+AllowEnhancedClassRedefinition，可以热替换新增方法、字段等结构改动。`,
    `来源：JetBrains 官方 ${JBR_RELEASES_URL}（页面里的 Binaries 表格，选 JBR ${major} 的 windows-x64 "JBR" 运行时包，不需要 JCEF / SDK 版本，压缩包约 80–100MB）。`,
    `解压后把含 bin\\java.exe 的目录放到 ${runtimesDir} 或 ${join(homedir(), '.jdks')} 下，或在设置里添加它的 java.exe；也可以设置环境变量 INKSTONE_JBR 指向该目录。`
  ].join('\n')
}

export function isJbrRelease(text: string): boolean {
  return /IMPLEMENTOR="JetBrains/i.test(text) || /JBR|JetBrains Runtime/i.test(text.match(/IMPLEMENTOR_VERSION="([^"]*)"/)?.[1] ?? '')
}

async function readRelease(javaPath: string): Promise<string> {
  try {
    return await readFile(join(dirname(dirname(javaPath)), 'release'), 'utf8')
  } catch {
    return ''
  }
}

function probeVmVersion(javaPath: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(javaPath, [...args, '-version'], { timeout: 10_000, windowsHide: true }, (error, stdout, stderr) => resolve(error ? null : `${stderr}${stdout}`))
  })
}

export async function supportsEnhancedRedefinition(javaPath: string): Promise<boolean> {
  return (await probeVmVersion(javaPath, ['-XX:+AllowEnhancedClassRedefinition'])) !== null
}

async function childHomes(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name))
  } catch {
    return []
  }
}

export async function jbrCandidatePaths(runtimesDir: string, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const paths: string[] = []
  if (env.INKSTONE_JBR) paths.push(javaFromHome(env.INKSTONE_JBR))
  for (const home of await childHomes(runtimesDir)) paths.push(javaFromHome(home), javaFromHome(join(home, 'Contents', 'Home')))
  const local = env.LOCALAPPDATA
  if (local) {
    for (const app of await childHomes(join(local, 'Programs'))) paths.push(javaFromHome(join(app, 'jbr')))
    for (const app of await childHomes(join(local, 'JetBrains', 'Toolbox', 'apps'))) {
      paths.push(javaFromHome(join(app, 'jbr')))
      for (const channel of await childHomes(app)) {
        paths.push(javaFromHome(join(channel, 'jbr')))
        for (const build of await childHomes(channel)) paths.push(javaFromHome(join(build, 'jbr')))
      }
    }
  }
  return paths
}

export async function findJbrs(runtimesDir: string, extraPaths: string[] = [], known?: JavaEntry[]): Promise<JavaEntry[]> {
  const list = [...(known ?? (await detectJava(extraPaths))), ...(await detectJava(await jbrCandidatePaths(runtimesDir), false))]
  const seen = new Set<string>()
  const jbrs: JavaEntry[] = []
  for (const java of list) {
    const key = java.path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (isJbrRelease(await readRelease(java.path)) || /[\\/]jbr[^\\/]*[\\/]/i.test(java.path)) jbrs.push(java)
  }
  return jbrs.sort((a, b) => b.majorVersion - a.majorVersion)
}

export async function resolveJbr(major: number, runtimesDir: string, extraPaths: string[] = []): Promise<JbrInfo> {
  const jbrs = await findJbrs(runtimesDir, extraPaths)
  const exact = jbrs.find((java) => java.majorVersion === major) ?? jbrs.find((java) => java.majorVersion > major)
  if (!exact) {
    return { found: false, path: null, version: null, majorVersion: null, enhancedRedefinition: false, downloadHint: jbrDownloadHint(major, runtimesDir) }
  }
  const enhanced = await supportsEnhancedRedefinition(exact.path)
  return {
    found: true,
    path: exact.path,
    version: exact.version,
    majorVersion: exact.majorVersion,
    enhancedRedefinition: enhanced,
    downloadHint: enhanced ? '' : `这个 JBR（${exact.path}）不支持 -XX:+AllowEnhancedClassRedefinition，请换 ${JBR_RELEASES_URL} 上的 JBR ${major}`
  }
}
