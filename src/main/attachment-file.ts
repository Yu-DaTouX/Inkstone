import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lstat } from 'node:fs/promises'
import { YAN_DIR } from './paths'

const ATTACHMENT_NAME_RE = /^[a-f0-9]{40}\.(jpg|png|webp|gif)$/

export interface ManagedAttachment {
  path: string
  name: string
  size: number
  mimeType: string
}

export function attachmentMimeType(name: string): string {
  const ext = name.split('.')[1]
  return ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
}

export async function managedAttachment(url: unknown, directory = join(YAN_DIR, 'attachments')): Promise<ManagedAttachment | null> {
  let path: string
  try {
    path = resolve(fileURLToPath(String(url ?? '')))
  } catch {
    return null
  }
  const name = basename(path)
  if (dirname(path).toLowerCase() !== resolve(directory).toLowerCase() || !ATTACHMENT_NAME_RE.test(name)) return null
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) return null
    return { path, name, size: info.size, mimeType: attachmentMimeType(name) }
  } catch {
    return null
  }
}
