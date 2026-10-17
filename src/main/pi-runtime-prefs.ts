import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PiRuntimePrefs, QueueMode } from '../shared/ipc'
import { PI_AGENT_DIR } from './paths'

function queueMode(value: unknown): QueueMode {
  return value === 'all' ? 'all' : 'one-at-a-time'
}

export function piRuntimePrefsOf(raw: unknown): PiRuntimePrefs {
  const settings = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const retry = settings.retry && typeof settings.retry === 'object' ? (settings.retry as Record<string, unknown>) : {}
  return {
    autoRetry: retry.enabled !== false,
    steeringMode: queueMode(settings.steeringMode),
    followUpMode: queueMode(settings.followUpMode)
  }
}

export async function readPiRuntimePrefs(file = join(PI_AGENT_DIR, 'settings.json')): Promise<PiRuntimePrefs> {
  try {
    return piRuntimePrefsOf(JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, '')))
  } catch {
    return piRuntimePrefsOf({})
  }
}
