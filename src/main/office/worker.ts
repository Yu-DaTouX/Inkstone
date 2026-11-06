import { parentPort, workerData } from 'node:worker_threads'
import { open } from 'node:fs/promises'
import { extractOffice } from './extract'
import type { OfficeFormat } from '../../shared/office'
import { pick } from '../../shared/ui-lang'

const MAX_BYTES = 64 * 1024 * 1024
async function run(): Promise<void> {
  const { path, format } = workerData as { path: string; format: OfficeFormat }
  const file = await open(path, 'r')
  try {
    const size = (await file.stat()).size
    if (size > MAX_BYTES) throw new Error(pick('文件超过 64MB，请用系统程序打开', 'File exceeds 64 MB; open it with a system app'))
    const buffer = Buffer.alloc(size + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > MAX_BYTES) throw new Error(pick('文件超过 64MB，请用系统程序打开', 'File exceeds 64 MB; open it with a system app'))
    if (length > size) throw new Error(pick('文件在读取期间发生变化，请重试', 'The file changed while reading; try again'))
    parentPort?.postMessage(await extractOffice(buffer.subarray(0, length), format))
  } finally { await file.close() }
}
void run().catch((error: unknown) => parentPort?.postMessage({ ok: false, error: String(error) }))
