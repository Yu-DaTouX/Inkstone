import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pick } from '../../shared/ui-lang'
import { defaultNativeConfigReader as readTextOrNull } from './app-native-witness'

export function nativeMcpTextFingerprint(text: string | null): string {
  return createHash('sha256').update(text === null ? '\u0000absent' : text).digest('hex')
}

export async function atomicWrite(path: string, text: string, expectedFingerprint?: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`
  try {
    const handle = await open(temp, 'wx', 0o600)
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
  if (expectedFingerprint !== undefined) {
    try {
      const current = await readTextOrNull(path)
      if (nativeMcpTextFingerprint(current) !== expectedFingerprint) {
        throw new Error(pick('目标文件在替换前发生了变化，已放弃写入', 'Target file changed before replacement; write abandoned'))
      }
    } catch (error) {
      await unlink(temp).catch(() => undefined)
      throw error
    }
  }
  try {
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}
