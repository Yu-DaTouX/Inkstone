import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { autoCompactAt } from '../shared/context-limits'
import { PI_AGENT_DIR, YAN_DIR } from './paths'

const DEFAULT_RESERVE_TOKENS = 16_384

export interface LineModel {
  provider: string
  id: string
  contextWindow: number
}

type Json = Record<string, unknown>

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

export function applyLines(
  settings: Json,
  owned: Record<string, number>,
  models: LineModel[],
  cap: number
): { settings: Json; owned: Record<string, number> } | undefined {
  const compaction: Json = isObj(settings.compaction) ? { ...settings.compaction } : {}
  const overrides: Json = isObj(compaction.modelOverrides) ? { ...compaction.modelOverrides } : {}
  const base = typeof compaction.reserveTokens === 'number' && compaction.reserveTokens >= 0 ? compaction.reserveTokens : DEFAULT_RESERVE_TOKENS
  const nextOwned: Record<string, number> = {}
  let changed = false

  for (const model of models) {
    const window = Math.round(model.contextWindow)
    if (!(window > 0)) continue
    const key = `${model.provider}/${model.id}`
    const entry = isObj(overrides[key]) ? { ...(overrides[key] as Json) } : undefined
    const current = entry?.reserveTokens
    const ours = owned[key] !== undefined && current === owned[key]
    if (entry && current !== undefined && !ours) continue

    const want = window - autoCompactAt(cap, window)
    if (want > base) {
      if (current !== want) {
        overrides[key] = { ...entry, reserveTokens: want }
        changed = true
      }
      nextOwned[key] = want
    } else if (ours && entry) {
      delete entry.reserveTokens
      if (Object.keys(entry).length > 0) overrides[key] = entry
      else delete overrides[key]
      changed = true
    }
  }
  for (const [key, value] of Object.entries(owned)) {
    if (!(key in nextOwned) && !models.some(m => `${m.provider}/${m.id}` === key)) nextOwned[key] = value
  }
  if (!changed && JSON.stringify(nextOwned) === JSON.stringify(owned)) return undefined

  if (Object.keys(overrides).length > 0) compaction.modelOverrides = overrides
  else delete compaction.modelOverrides
  const next = { ...settings }
  if (Object.keys(compaction).length > 0) next.compaction = compaction
  else delete next.compaction
  return { settings: next, owned: nextOwned }
}

export async function readJson(path: string): Promise<Json | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    return isObj(parsed) ? parsed : undefined
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? {} : undefined
  }
}

export async function writeAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(tmp, path)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}

let queue: Promise<unknown> = Promise.resolve()

export function withPiSettingsLock<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run)
  queue = next.catch(() => undefined)
  return next
}

export function syncNativeCompactionLines(models: LineModel[], cap: number): Promise<void> {
  const run = async (): Promise<void> => {
    const file = join(PI_AGENT_DIR, 'settings.json')
    const recordFile = join(YAN_DIR, 'compaction-lines.json')
    const settings = await readJson(file)
    if (!settings) return
    const rawOwned = await readJson(recordFile)
    const owned: Record<string, number> = {}
    for (const [key, value] of Object.entries(rawOwned ?? {})) if (typeof value === 'number') owned[key] = value
    const result = applyLines(settings, owned, models, cap)
    if (!result) return
    await writeAtomic(file, result.settings)
    await writeAtomic(recordFile, result.owned)
  }
  return withPiSettingsLock(run)
}
