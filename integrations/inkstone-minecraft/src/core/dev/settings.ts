import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface DevSettings {
  maxMemoryMb: number
  extraJavaPaths: string[]
}

const DEFAULT_MEMORY_MB = 4096

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.INKSTONE_MC_DATA) return env.INKSTONE_MC_DATA
  if (process.platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'inkstone-minecraft')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'inkstone-minecraft')
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'inkstone-minecraft')
}

export function normalizeDevSettings(value: unknown): DevSettings {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const memory = Number(record.maxMemoryMb)
  return {
    maxMemoryMb: Number.isFinite(memory) && memory >= 512 && memory <= 65536 ? Math.round(memory) : DEFAULT_MEMORY_MB,
    extraJavaPaths: Array.isArray(record.extraJavaPaths) ? record.extraJavaPaths.filter((path): path is string => typeof path === 'string') : []
  }
}

export async function loadDevSettings(file = join(dataDir(), 'settings.json')): Promise<DevSettings> {
  try {
    return normalizeDevSettings(JSON.parse(await readFile(file, 'utf8')))
  } catch {
    return normalizeDevSettings({})
  }
}
