import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { modelBrand, type ModelRef } from '../shared/model-brand'

export type NotificationBotMood = 'done' | 'fail' | 'ask' | 'rest'

export type NotificationBotKind = 'done' | 'error' | 'question' | undefined

const MOOD_OF_KIND: Record<'done' | 'error' | 'question', NotificationBotMood> = {
  done: 'done',
  error: 'fail',
  question: 'ask'
}

export function notificationBotMood(kind: NotificationBotKind): NotificationBotMood {
  return kind ? MOOD_OF_KIND[kind] ?? 'rest' : 'rest'
}

export interface BotIconLookup {
  dir: string
  exists?: (file: string) => boolean
}

export function botIconFile(model: ModelRef, mood: NotificationBotMood, dark: boolean, lookup: BotIconLookup): string | null {
  if (!model || (typeof model === 'object' && !model.id && !model.provider)) return null
  if (typeof model === 'string' && !model.trim()) return null
  const brand = modelBrand(model)
  const exists = lookup.exists ?? existsSync
  const candidates = [`${brand}-${mood}-${dark ? 'dark' : 'light'}.png`, `${brand}-${mood}.png`]
  for (const name of candidates) {
    const file = join(lookup.dir, name)
    if (exists(file)) return file
  }
  return null
}

export function botIconDirs(resourcesPath: string | undefined, moduleDir: string, cwd: string): string[] {
  return [
    resourcesPath ? join(resourcesPath, 'bot-icons') : '',
    join(moduleDir, '..', '..', 'resources', 'bot-icons'),
    join(cwd, 'resources', 'bot-icons')
  ].filter(Boolean)
}
