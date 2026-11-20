import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isAntigravityMode, type AntigravityChoice, type AntigravityModel } from '../shared/antigravity'
import { atomicWriteFile } from './atomic-write'
import { YAN_DIR } from './paths'
import { isSafeSessionId } from './session-id'

interface Preference {
  model: AntigravityModel
  thinking?: AntigravityChoice
  modes?: AntigravityChoice
}

function fileOf(sessionId: string): string {
  if (!isSafeSessionId(sessionId)) throw new Error('Invalid Antigravity session ID')
  return join(YAN_DIR, 'antigravity-sessions', sessionId + '.json')
}

export function readAntigravityPreference(sessionId: string): Preference | undefined {
  try {
    const saved = JSON.parse(readFileSync(fileOf(sessionId), 'utf8')) as Preference | null
    if (!saved?.model || typeof saved.model.id !== 'string' || !saved.model.id || typeof saved.model.name !== 'string') return undefined
    const validChoice = (choice: AntigravityChoice | undefined) => typeof choice?.current === 'string' && Array.isArray(choice.options) &&
      choice.options.every((item) => typeof item?.id === 'string' && typeof item.name === 'string') &&
      choice.options.some((item) => item.id === choice.current)
    const { thinking, modes } = saved
    return { model: saved.model, ...(validChoice(thinking) ? { thinking } : {}),
      ...(validChoice(modes) && isAntigravityMode(modes?.current) && modes?.options.every((item) => isAntigravityMode(item.id)) ? { modes } : {}) }
  } catch {
    return undefined
  }
}

export async function saveAntigravityPreference(sessionId: string, preference: Preference | null): Promise<void> {
  const file = fileOf(sessionId)
  await mkdir(dirname(file), { recursive: true })
  await atomicWriteFile(file, JSON.stringify(preference), { durable: true })
}
