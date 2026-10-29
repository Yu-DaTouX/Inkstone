import { homedir } from 'node:os'
import { join } from 'node:path'

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`
  const hit = process.argv.find((arg) => arg.startsWith(prefix))
  return hit ? hit.slice(prefix.length).trim() || undefined : undefined
}

function envOrArg(envName: string, argName: string): string | undefined {
  const current = process.env[envName]?.trim()
  if (current) return current
  const fallback = argValue(argName)
  if (fallback) process.env[envName] = fallback
  return fallback
}

const PORTABLE_EXECUTABLE_DIR = process.env.PORTABLE_EXECUTABLE_DIR?.trim()
export const PORTABLE_DATA_DIR = PORTABLE_EXECUTABLE_DIR
  ? join(PORTABLE_EXECUTABLE_DIR, '砚数据')
  : undefined

export const PI_AGENT_DIR =
  envOrArg('YAN_PI_DIR', 'yan-pi-dir') ||
  (PORTABLE_DATA_DIR ? join(PORTABLE_DATA_DIR, 'pi-agent') : join(homedir(), '.pi', 'agent'))

export const ELECTRON_USER_DATA_DIR =
  envOrArg('YAN_USER_DATA', 'yan-user-data') ||
  (PORTABLE_DATA_DIR ? join(PORTABLE_DATA_DIR, 'electron') : undefined)

export const ELECTRON_CRASH_DUMPS_DIR = PORTABLE_DATA_DIR
  ? join(PORTABLE_DATA_DIR, 'crash-dumps')
  : undefined

export const DOWNLOADS_DIR = envOrArg('YAN_DOWNLOADS_DIR', 'yan-downloads-dir') || undefined

export const YAN_DIR =
  envOrArg('YAN_DATA_DIR', 'yan-data-dir') ||
  (PORTABLE_DATA_DIR ? join(PORTABLE_DATA_DIR, 'yan') : join(PI_AGENT_DIR, 'yan'))
