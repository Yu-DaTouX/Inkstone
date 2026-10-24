import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { abortError, downloadFiles, type DownloadOptions, type DownloadReport } from '../download/download.ts'
import type { InstallFile, InstallOptions, TaskProgress } from './types.ts'

export type VerifyMode = 'size' | 'sha1'

export function toDownloadOptions(options: InstallOptions): DownloadOptions {
  return {
    source: options.source,
    concurrency: options.concurrency,
    signal: options.signal,
    onProgress: options.onProgress,
    fetchImpl: options.fetchImpl,
    mirrorOrigin: options.mirrorOrigin,
    stats: options.stats
  }
}

export async function sha1OfFile(path: string): Promise<string> {
  const hash = createHash('sha1')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return hash.digest('hex')
}

async function needsDownload(file: InstallFile, mode: VerifyMode): Promise<boolean> {
  let info
  try {
    info = await stat(file.dest)
  } catch {
    return true
  }
  if (!info.isFile()) return true
  if (file.size != null && info.size !== file.size) return true
  if (mode === 'sha1' && file.sha1) return (await sha1OfFile(file.dest)) !== file.sha1.toLowerCase()
  return false
}

export async function pendingFiles(
  files: InstallFile[],
  mode: VerifyMode = 'sha1',
  options: { concurrency?: number; signal?: AbortSignal; onProgress?: (progress: TaskProgress, detail?: string) => void } = {}
): Promise<InstallFile[]> {
  const total = files.length
  const pending: InstallFile[] = []
  let done = 0
  let cursor = 0
  const workers = Math.min(Math.max(1, options.concurrency ?? 16), Math.max(total, 1))
  const report = () => options.onProgress?.({ done, total, unit: 'files' }, '校验文件')
  report()
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++
      if (index >= total) return
      if (options.signal?.aborted) throw abortError()
      const file = files[index]
      if (await needsDownload(file, mode)) pending.push(file)
      done += 1
      report()
    }
  }
  await Promise.all(Array.from({ length: workers }, worker))
  return pending
}

export async function downloadPending(files: InstallFile[], options: DownloadOptions): Promise<DownloadReport> {
  if (!files.length) return { files: 0, downloaded: 0, bytes: 0, sources: { official: { ok: 0, failed: 0, rate: null }, bmclapi: { ok: 0, failed: 0, rate: null } } }
  return downloadFiles(files, options)
}
