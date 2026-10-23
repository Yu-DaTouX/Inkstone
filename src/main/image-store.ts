import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileUrl } from '../shared/file-url'

function extOf(mimeType: string): string | null {
  const m = mimeType.toLowerCase()
  if (m.includes('png')) return 'png'
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg'
  if (m.includes('webp')) return 'webp'
  if (m.includes('gif')) return 'gif'
  return null
}

export function imageFile(dir: string, mimeType: string, data: string): string | null {
  const ext = extOf(mimeType)
  return ext ? join(dir, `${createHash('sha1').update(data).digest('hex')}.${ext}`) : null
}

export function localizeImage(dir: string, mimeType: string, data: string): string {
  const file = imageFile(dir, mimeType, data)
  if (!file) return ''
  const expected = Buffer.from(data, 'base64')
  try {
    const existing = readFileSync(file)
    if (existing.length === expected.length && createHash('sha1').update(existing).digest('hex') === createHash('sha1').update(expected).digest('hex')) return fileUrl(file)
  } catch { }
  mkdirSync(dir, { recursive: true })
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, expected, { flag: 'wx' })
    try { renameSync(temp, file) }
    catch (error) {
      try { unlinkSync(file) } catch { }
      renameSync(temp, file)
    }
  } finally {
    try { unlinkSync(temp) } catch { }
  }
  return fileUrl(file)
}
