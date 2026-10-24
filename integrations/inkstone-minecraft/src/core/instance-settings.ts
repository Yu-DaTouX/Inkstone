import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { InstanceInfo, LauncherSettings } from '../shared/api.ts'
import type { InstanceOverride, InstanceOverview } from '../shared/mods-api.ts'
import { javaFromSelection } from './pcl-import.ts'

export const EMPTY_OVERRIDE: InstanceOverride = {
  javaPath: null,
  maxMemoryMb: null,
  jvmArgs: null,
  gameArgs: null,
  windowWidth: null,
  windowHeight: null,
  fullscreen: null,
  server: null,
  autoEnter: null
}

type OverrideMap = Record<string, InstanceOverride>

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function memory(value: unknown): number | null {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 512 || parsed > 65536) return null
  return Math.round(parsed)
}

function dimension(value: unknown): number | null {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 320 || parsed > 16384) return null
  return Math.round(parsed)
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : value === 'true' ? true : value === 'false' ? false : null
}

export function normalizeOverride(raw: unknown): InstanceOverride {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    javaPath: text(value.javaPath),
    maxMemoryMb: memory(value.maxMemoryMb),
    jvmArgs: text(value.jvmArgs),
    gameArgs: text(value.gameArgs),
    windowWidth: dimension(value.windowWidth),
    windowHeight: dimension(value.windowHeight),
    fullscreen: bool(value.fullscreen),
    server: text(value.server),
    autoEnter: bool(value.autoEnter)
  }
}

function key(folder: string, versionId: string): string {
  return `${folder.toLowerCase()}|${versionId}`
}

export class InstanceSettingsStore {
  private readonly file: string
  private data: OverrideMap | null = null

  constructor(file: string) {
    this.file = file
  }

  async load(): Promise<OverrideMap> {
    if (this.data) return this.data
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, unknown>
      const map: OverrideMap = {}
      for (const [id, value] of Object.entries(raw)) map[id] = normalizeOverride(value)
      this.data = map
    } catch {
      this.data = {}
    }
    return this.data
  }

  async get(folder: string, versionId: string): Promise<InstanceOverride> {
    const map = await this.load()
    return map[key(folder, versionId)] ?? { ...EMPTY_OVERRIDE }
  }

  async patch(folder: string, versionId: string, patch: Partial<InstanceOverride>): Promise<InstanceOverride> {
    const map = await this.load()
    const id = key(folder, versionId)
    const next = normalizeOverride({ ...(map[id] ?? EMPTY_OVERRIDE), ...patch })
    map[id] = next
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(map, null, 2)}\n`, 'utf8')
    await rename(temp, this.file)
    return next
  }
}

export interface EffectiveSettings {
  javaPath: string | null
  maxMemoryMb: number
  jvmArgs: string
  gameArgs: string
  windowWidth: number | null
  windowHeight: number | null
  fullscreen: boolean
  server: string | null
}

function pclMemory(pcl: Map<string, string>): number | null {
  const custom = Number(pcl.get('VersionRamCustom'))
  if (Number.isFinite(custom) && custom >= 512 && custom <= 65536) return Math.round(custom)
  return null
}

export function resolveSettings(
  override: InstanceOverride,
  pcl: Map<string, string>,
  settings: LauncherSettings
): { effective: EffectiveSettings; source: InstanceOverview['source'] } {
  const pclJava = javaFromSelection(pcl.get('VersionArgumentJavaSelect'))
  const effective: EffectiveSettings = {
    javaPath: override.javaPath ?? pclJava,
    maxMemoryMb: override.maxMemoryMb ?? pclMemory(pcl) ?? settings.maxMemoryMb,
    jvmArgs: override.jvmArgs ?? text(pcl.get('VersionArgumentJvm')) ?? '',
    gameArgs: override.gameArgs ?? text(pcl.get('VersionArgumentGame')) ?? '',
    windowWidth: override.windowWidth ?? dimension(pcl.get('VersionArgumentWindowWidth')),
    windowHeight: override.windowHeight ?? dimension(pcl.get('VersionArgumentWindowHeight')),
    fullscreen: override.fullscreen ?? (pcl.get('VersionArgumentWindowType') === 'Fullscreen'),
    server: override.server ?? text(pcl.get('VersionServerEnter'))
  }
  return {
    effective,
    source: {
      java: override.javaPath ? 'instance' : pclJava ? 'pcl' : 'global',
      memory: override.maxMemoryMb ? 'instance' : pclMemory(pcl) ? 'pcl' : 'global',
      window: override.windowWidth || override.windowHeight || override.fullscreen !== null ? 'instance' : 'global'
    }
  }
}

export async function directorySize(dir: string, depth = 0): Promise<number> {
  if (depth > 6) return 0
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await directorySize(path, depth + 1)
      continue
    }
    if (!entry.isFile()) continue
    total += await stat(path).then((info) => info.size, () => 0)
  }
  return total
}

export async function lastPlayedAt(instance: InstanceInfo, versionDir: string): Promise<number | null> {
  const candidates = [join(instance.gameDir, 'logs', 'latest.log'), join(instance.gameDir, 'options.txt'), versionDir]
  let newest: number | null = null
  for (const path of candidates) {
    const info = await stat(path).catch(() => null)
    if (!info) continue
    const stamp = info.mtimeMs
    if (newest === null || stamp > newest) newest = stamp
  }
  return newest
}

export interface OverviewInput {
  instance: InstanceInfo
  settings: LauncherSettings
  override: InstanceOverride
  pcl: Map<string, string>
  sizeBytes: number
  lastPlayedAt: number | null
  modTotal: number
  modIssues: number
  missingDeps: string[]
  javaAvailable: boolean
  missingFiles: number
}

export function buildOverview(input: OverviewInput): InstanceOverview {
  const { effective, source } = resolveSettings(input.override, input.pcl, input.settings)
  const problems: InstanceOverview['problems'] = []
  if (input.instance.error) problems.push({ kind: 'json', text: input.instance.error })
  if (input.missingDeps.length > 0) {
    problems.push({ kind: 'deps', text: `缺少前置：${[...new Set(input.missingDeps)].slice(0, 3).join('、')}` })
  } else if (input.modIssues > 0) {
    problems.push({ kind: 'deps', text: `${input.modIssues} 个 Mod 有问题，去 Mod 页查看` })
  }
  if (!input.javaAvailable) problems.push({ kind: 'java', text: `没有找到可用的 Java ${input.instance.javaMajor ?? ''}`.trim() })
  if (input.missingFiles > 0) problems.push({ kind: 'files', text: `有 ${input.missingFiles} 个文件缺失，去修复页补全` })
  return {
    folder: input.instance.folder,
    versionId: input.instance.id,
    override: input.override,
    effective,
    source,
    gameDir: input.instance.gameDir,
    isolated: input.instance.isolated,
    sizeBytes: input.sizeBytes,
    lastPlayedAt: input.lastPlayedAt,
    modCount: input.modTotal,
    minecraftVersion: input.instance.minecraftVersion,
    loader: input.instance.loader,
    loaderVersion: input.instance.loaderVersion,
    javaMajor: input.instance.javaMajor,
    error: input.instance.error,
    problems
  }
}
