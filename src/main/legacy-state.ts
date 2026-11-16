import { lstat, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'

export const LEGACY_DIRNAME = 'legacy'

export const LEGACY_STATE_NAMES: readonly string[] = [
  'handoffs.json',
  'handoff-transactions.json',
  'tool-consent.json',
  'task-inbox.json',
  'peers.json',
  'schedules.json',
  'sync-config.json',
  'collab.json',
  'auto-continue.json',
  'account-quota.json',
  'context-policy.effective.json',
  'agent-context',
  'agent-hub',
  'agent-profile',
  'context-actions',
  'context-background-usage',
  'context-budget-v1',
  'context-inspect',
  'context-state',
  'ego-browser',
  'ego-import',
  'goal-resume',
  'handoff',
  'handoff-request',
  'handoff-result',
  'memory-export',
  'personal-memory',
  'project-knowledge',
  'trimmed',
  'work-mode'
]

export interface LegacyStateResult {
  target: string | null
  moved: string[]
  failed: string[]
}

function dateStamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function moveLegacyState(yanDir: string, now: Date = new Date(), names: readonly string[] = LEGACY_STATE_NAMES): Promise<LegacyStateResult> {
  const present: string[] = []
  for (const name of names) {
    if (await exists(join(yanDir, name)).catch(() => false)) present.push(name)
  }
  if (!present.length) return { target: null, moved: [], failed: [] }
  const target = join(yanDir, LEGACY_DIRNAME, dateStamp(now))
  await mkdir(target, { recursive: true })
  const moved: string[] = []
  const failed: string[] = []
  for (const name of present) {
    let destination = join(target, name)
    let blocked = false
    for (let n = 2; ; n++) {
      try {
        if (!(await exists(destination))) break
      } catch {
        blocked = true
        break
      }
      if (n > 1000) {
        blocked = true
        break
      }
      destination = join(target, `${name}.${n}`)
    }
    if (blocked) {
      failed.push(name)
      continue
    }
    try {
      await rename(join(yanDir, name), destination)
      moved.push(name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failed.push(name)
    }
  }
  return { target, moved, failed }
}
