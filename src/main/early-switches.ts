import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { YAN_DIR } from './paths'

export function smoothTextEnabledSync(file = join(YAN_DIR, 'desktop.json')): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return (parsed as { smoothText?: unknown }).smoothText !== false
    }
  } catch {
  }
  return true
}
