import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Account, DownloadSource, GameFolder, LauncherSettings, PclAccountRef, ThemePreference } from '../shared/api.ts'
import { accountFromPcl, mergeAccounts, normalizeAccount, offlineAccount, validOfflineName } from './accounts.ts'

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.INKSTONE_MC_DATA) return env.INKSTONE_MC_DATA
  if (process.platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'inkstone-minecraft')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'inkstone-minecraft')
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'inkstone-minecraft')
}

export const DEFAULT_SETTINGS: LauncherSettings = {
  folders: [],
  selectedFolder: null,
  selectedVersion: null,
  accounts: [],
  selectedAccountId: null,
  maxMemoryMb: 4096,
  extraJavaPaths: [],
  importedFromPclAt: null,
  downloadSource: 'auto',
  downloadConcurrency: 16,
  theme: 'system'
}

const DOWNLOAD_SOURCES: readonly DownloadSource[] = ['auto', 'official', 'bmclapi']
const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark']

function folders(value: unknown): GameFolder[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is GameFolder => !!item && typeof item.path === 'string' && item.path.length > 0)
    .map((item) => ({ name: typeof item.name === 'string' && item.name ? item.name : item.path, path: item.path }))
}

function accounts(value: Record<string, unknown>): Account[] {
  const list = Array.isArray(value.accounts) ? value.accounts.map(normalizeAccount).filter((item): item is Account => !!item) : []
  const unique = mergeAccounts([], list)
  if (unique.length > 0) return unique
  const legacy: Account[] = []
  if (validOfflineName(value.offlineName) && value.offlineName !== 'Player') legacy.push(offlineAccount(value.offlineName))
  if (Array.isArray(value.importedAccounts)) {
    for (const ref of value.importedAccounts as PclAccountRef[]) {
      const account = ref && typeof ref === 'object' ? accountFromPcl(ref) : null
      if (account) legacy.push(account)
    }
  }
  return mergeAccounts([], legacy)
}

export function normalizeSettings(raw: unknown): LauncherSettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const memory = Number(value.maxMemoryMb)
  const concurrency = Number(value.downloadConcurrency)
  const list = accounts(value)
  const selected = typeof value.selectedAccountId === 'string' && list.some((account) => account.id === value.selectedAccountId) ? value.selectedAccountId : (list[0]?.id ?? null)
  return {
    folders: folders(value.folders),
    selectedFolder: typeof value.selectedFolder === 'string' ? value.selectedFolder : null,
    selectedVersion: typeof value.selectedVersion === 'string' ? value.selectedVersion : null,
    accounts: list,
    selectedAccountId: selected,
    maxMemoryMb: Number.isFinite(memory) && memory >= 512 && memory <= 65536 ? Math.round(memory) : DEFAULT_SETTINGS.maxMemoryMb,
    extraJavaPaths: Array.isArray(value.extraJavaPaths) ? value.extraJavaPaths.filter((path): path is string => typeof path === 'string') : [],
    importedFromPclAt: typeof value.importedFromPclAt === 'number' ? value.importedFromPclAt : null,
    downloadSource: DOWNLOAD_SOURCES.includes(value.downloadSource as DownloadSource) ? (value.downloadSource as DownloadSource) : DEFAULT_SETTINGS.downloadSource,
    downloadConcurrency: Number.isInteger(concurrency) && concurrency >= 4 && concurrency <= 64 ? concurrency : DEFAULT_SETTINGS.downloadConcurrency,
    theme: THEMES.includes(value.theme as ThemePreference) ? (value.theme as ThemePreference) : DEFAULT_SETTINGS.theme
  }
}

export class SettingsStore {
  private cached: LauncherSettings | null = null
  private readonly file: string

  constructor(file: string) {
    this.file = file
  }

  async load(): Promise<LauncherSettings> {
    if (this.cached) return this.cached
    try {
      this.cached = normalizeSettings(JSON.parse(await readFile(this.file, 'utf8')))
    } catch {
      this.cached = { ...DEFAULT_SETTINGS }
    }
    return this.cached
  }

  async update(patch: Partial<LauncherSettings>): Promise<LauncherSettings> {
    const next = normalizeSettings({ ...(await this.load()), ...patch })
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    await rename(temp, this.file)
    this.cached = next
    return next
  }
}
