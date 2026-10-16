import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export async function atomicWriteFile(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, content, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
  try {
    await rename(temp, file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST' || code === 'EPERM' || code === 'EACCES') {
      await rm(file, { force: true }).catch(() => undefined)
      try {
        await rename(temp, file)
        return
      } catch (retryError) {
        await rm(temp, { force: true }).catch(() => undefined)
        throw retryError
      }
    }
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}
