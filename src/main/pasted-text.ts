import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { YAN_DIR } from './paths'
import { PASTED_TEXT_MAX_BYTES, isPastedTextName, type SavedPastedText } from '../shared/pasted-text'

export function pastedTextRoot(): string {
  return join(YAN_DIR, 'pasted-text')
}

function stamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

export async function savePastedText(text: unknown, name: unknown, root = pastedTextRoot()): Promise<SavedPastedText> {
  if (typeof text !== 'string' || !text) return { ok: false, error: 'empty' }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > PASTED_TEXT_MAX_BYTES) return { ok: false, error: 'too_large' }
  const fileName = typeof name === 'string' && isPastedTextName(name) ? name : 'pasted-text.txt'
  const dir = join(root, `${stamp(new Date())}-${randomUUID().slice(0, 8)}`)
  const path = join(dir, fileName)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(path, text, { encoding: 'utf8', flag: 'wx' })
  } catch {
    return { ok: false, error: 'write' }
  }
  return { ok: true, path, name: fileName, bytes }
}
