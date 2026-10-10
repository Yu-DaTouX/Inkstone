import { parentPort, workerData } from 'node:worker_threads'
import { open } from 'node:fs/promises'
import { extractOffice } from './extract'
import type { OfficeFormat } from '../../shared/office'

const MAX_BYTES = 64 * 1024 * 1024
async function run(): Promise<void> {
  const { path, format } = workerData as { path: string; format: OfficeFormat }
  const file = await open(path, 'r')
  try {
    const size = (await file.stat()).size
    if (size > MAX_BYTES) throw new Error('文件超过 64MB，请用系统程序打开')
    // A bounded read also handles a file growing after the initial stat.
    const buffer = Buffer.alloc(size + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > MAX_BYTES) throw new Error('文件超过 64MB，请用系统程序打开')
    if (length > size) throw new Error('文件在读取期间发生变化，请重试')
    parentPort?.postMessage(extractOffice(buffer.subarray(0, length), format))
  } finally { await file.close() }
}
void run().catch((error: unknown) => parentPort?.postMessage({ ok: false, error: String(error) }))
