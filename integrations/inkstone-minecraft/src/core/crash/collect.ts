import { readdir, readFile } from 'node:fs/promises'
import { arch, cpus, homedir, release, totalmem, type } from 'node:os'
import { join } from 'node:path'
import type { LoaderKind } from '../../shared/api.ts'
import type { CrashEvidenceSource } from '../../shared/crash-api.ts'
import { scanMods, type ModFileInfo } from './mods.ts'

const MAX_TEXT_BYTES = 512 * 1024
const LOG_TAIL_LINES = 2000

export interface CrashFile {
  name: string
  text: string
}

export interface CrashSnapshot {
  reports: Set<string>
  hsErr: Set<string>
}

export interface CrashSourceText {
  source: CrashEvidenceSource
  text: string
}

export interface CrashBundle {
  processText: string
  latestLog: string
  crashReports: CrashFile[]
  hsErr: CrashFile[]
  launchArgs: string
  system: string
  mods: ModFileInfo[]
  modsList: string
  sources: CrashSourceText[]
}

export interface CrashCollectOptions {
  gameDir: string
  folder: string
  versionId: string
  loader: LoaderKind
  javaPath: string | null
  maxMemoryMb: number
  processLines: string[]
  launchArgs: string[]
  snapshot: CrashSnapshot
  exitCode: number | null
  windowShown: boolean
}

function tailLines(text: string, count: number): string {
  const lines = text.split(/\r?\n/)
  return lines.slice(Math.max(0, lines.length - count)).join('\n')
}

async function listNames(dir: string, filter: (name: string) => boolean): Promise<string[]> {
  try {
    return (await readdir(dir)).filter(filter).sort()
  } catch {
    return []
  }
}

async function readTextCapped(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, 'utf8')
    return text.length > MAX_TEXT_BYTES ? text.slice(0, MAX_TEXT_BYTES) : text
  } catch {
    return null
  }
}

export async function takeSnapshot(gameDir: string): Promise<CrashSnapshot> {
  const reports = await listNames(join(gameDir, 'crash-reports'), (name) => name.endsWith('.txt'))
  const hsErr = await listNames(gameDir, (name) => /^hs_err_pid\d+\.log$/i.test(name))
  return { reports: new Set(reports), hsErr: new Set(hsErr) }
}

export function normalizeExitCode(code: number | null): number | null {
  if (code === null) return null
  return code > 2147483647 ? code - 4294967296 : code
}

export function maskSecrets(text: string): string {
  let masked = text
  const home = homedir()
  if (home) masked = masked.split(home).join('<用户目录>')
  masked = masked.replace(/([A-Za-z]:[\\/]+Users[\\/]+)([^\\/\s"']+)/g, '$1<用户>')
  masked = masked.replace(/(\/home\/|\/Users\/)([^/\s"']+)/g, '$1<用户>')
  masked = masked.replace(/(--accessToken\s+)(\S+)/gi, '$1***')
  masked = masked.replace(/(--clientId\s+)(\S+)/gi, '$1***')
  masked = masked.replace(/((?:accessToken|refreshToken|clientToken|sessionId|password|token)\s*[=:]\s*"?)([^\s"'&,;]+)/gi, '$1***')
  return masked
}

function systemText(options: CrashCollectOptions): string {
  const cpu = cpus()[0]?.model ?? '未知'
  return [
    '启动器：Inkstone Minecraft',
    `版本：${options.versionId}（${options.loader}）`,
    `Java：${options.javaPath ?? '未指定'}`,
    `内存上限：${options.maxMemoryMb} MB`,
    `系统：${type()} ${release()} ${arch()}`,
    `物理内存：${Math.round(totalmem() / 1024 / 1024)} MB`,
    `CPU：${cpu}`,
    `退出码：${options.exitCode ?? 'null'}`,
    `游戏窗口出现：${options.windowShown ? '是' : '否'}`
  ].join('\n')
}

function modsListText(mods: ModFileInfo[]): string {
  if (mods.length === 0) return '（mods 目录里没有 jar）'
  return mods
    .map((mod) => `${mod.enabled ? '启用' : '停用'}  ${mod.fileName}  ${mod.modId ?? '?'}  ${mod.name ?? ''}  ${mod.version ?? ''}`.trimEnd())
    .join('\n')
}

export function bundleFrom(options: CrashCollectOptions, files: { latestLog: string; crashReports: CrashFile[]; hsErr: CrashFile[]; mods: ModFileInfo[] }): CrashBundle {
  const processText = tailLines(options.processLines.join('\n'), LOG_TAIL_LINES)
  const sources: CrashSourceText[] = [
    ...files.crashReports.map((file) => ({ source: 'crash-report' as const, text: file.text })),
    ...files.hsErr.map((file) => ({ source: 'hs_err' as const, text: file.text })),
    { source: 'process' as const, text: processText },
    { source: 'latest.log' as const, text: files.latestLog }
  ].filter((item) => item.text.trim().length > 0)
  return {
    processText,
    latestLog: files.latestLog,
    crashReports: files.crashReports,
    hsErr: files.hsErr,
    launchArgs: maskSecrets(options.launchArgs.join(' ')),
    system: maskSecrets(systemText(options)),
    mods: files.mods,
    modsList: modsListText(files.mods),
    sources
  }
}

export async function collectBundle(options: CrashCollectOptions): Promise<CrashBundle> {
  const reportDir = join(options.gameDir, 'crash-reports')
  const reportNames = (await listNames(reportDir, (name) => name.endsWith('.txt'))).filter((name) => !options.snapshot.reports.has(name))
  const hsErrNames = (await listNames(options.gameDir, (name) => /^hs_err_pid\d+\.log$/i.test(name))).filter((name) => !options.snapshot.hsErr.has(name))
  const latestLog = tailLines((await readTextCapped(join(options.gameDir, 'logs', 'latest.log'))) ?? '', LOG_TAIL_LINES)
  const crashReports: CrashFile[] = []
  for (const name of reportNames) {
    const text = await readTextCapped(join(reportDir, name))
    if (text) crashReports.push({ name, text })
  }
  const hsErr: CrashFile[] = []
  for (const name of hsErrNames) {
    const text = await readTextCapped(join(options.gameDir, name))
    if (text) hsErr.push({ name, text })
  }
  const mods = await scanMods(join(options.gameDir, 'mods'))
  return bundleFrom(options, { latestLog, crashReports, hsErr, mods })
}

export function haystack(bundle: CrashBundle): string {
  return bundle.sources.map((item) => item.text).join('\n')
}
