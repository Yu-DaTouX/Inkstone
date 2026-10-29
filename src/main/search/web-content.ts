import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ReadPageError, type ReadPageResult } from './page-types'

export type WebContentJob = { kind: 'html'; html: string; url: string } | { kind: 'pdf'; data: Uint8Array; maxChars: number }
export type WebContentResult = Pick<ReadPageResult, 'title' | 'text'> & Partial<ReadPageResult>

let active = 0
const waiting: Array<{ signal: AbortSignal; cancel: () => void; ready: () => void }> = []

async function acquire(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (active < 2) { active++; return }
  if (waiting.length >= 16) throw new ReadPageError('busy', '正文解析队列已满，请稍后重试')
  await new Promise<void>((resolve, reject) => {
    const entry = { signal, ready: resolve, cancel: () => {
      const index = waiting.indexOf(entry)
      if (index >= 0) waiting.splice(index, 1)
      signal.removeEventListener('abort', entry.cancel)
      reject(signal.reason)
    } }
    waiting.push(entry)
    signal.addEventListener('abort', entry.cancel, { once: true })
    if (signal.aborted) entry.cancel()
  })
}

function release(): void {
  const next = waiting.shift()
  if (next) { next.signal.removeEventListener('abort', next.cancel); next.ready() }
  else active--
}

export async function parseWebContent(job: WebContentJob, signal: AbortSignal): Promise<WebContentResult> {
  await acquire(signal)
  try { return await startParser(job, signal) }
  finally { release() }
}

async function startParser(job: WebContentJob, signal: AbortSignal): Promise<WebContentResult> {
  const { utilityProcess } = await import('electron')
  signal.throwIfAborted()
  const child = utilityProcess.fork(join(dirname(fileURLToPath(import.meta.url)), 'web-content-worker.js'), [], { serviceName: 'Inkstone web reader', stdio: 'ignore' })
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, value?: WebContentResult): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', cancel)
      child.kill()
      if (error) reject(error)
      else resolve(value!)
    }
    const cancel = (): void => finish(new ReadPageError('cancelled', '已取消正文解析'))
    signal.addEventListener('abort', cancel, { once: true })
    child.once('exit', (code) => finish(new ReadPageError('parse_error', `正文解析进程提前退出（${code}）`)))
    child.on('message', (reply: { data?: WebContentResult; error?: string; code?: string }) => {
      if (reply.data) finish(undefined, reply.data)
      else finish(new ReadPageError(reply.code ?? 'parse_error', reply.error ?? '正文解析失败'))
    })
    if (signal.aborted) cancel()
    else child.postMessage(job)
  })
}
