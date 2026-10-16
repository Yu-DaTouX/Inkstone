/**
 * 原子写：临时文件 + rename。
 *
 * 同步目录可能正好在被 OneDrive / 坚果云 / Syncthing 扫描，读端可能看到只写了一半
 * 的文件。写入方保证「要么看不到、要么看到完整文件」，读端遇到坏文件时跳过而不删。
 */
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
    /*
     * Windows 上 rename 覆盖已存在文件可能被拒（EEXIST / EPERM / EACCES）。
     * 先删目标再 rename —— 这里没有真正原子的退路，但写入方使用的是临时文件，
     * 最多在极短窗口里看不到旧文件，不会看到半截内容。
     */
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
