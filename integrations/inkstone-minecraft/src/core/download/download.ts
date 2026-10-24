import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'
import type { DownloadSource, TaskProgress } from '../../shared/api.ts'
import { SourceStats, candidateUrls, USER_AGENT, type SourceId, type UrlCandidate } from './sources.ts'

export const DEFAULT_TIMEOUT_MS = 15_000
export const DEFAULT_RETRIES = 2
export const DEFAULT_CONCURRENCY = 16
export const MIN_CONCURRENCY = 4
export const MAX_CONCURRENCY = 64

export interface RemoteFile {
  url: string
  dest: string
  sha1?: string | null
  size?: number | null
}

export interface DownloadOptions {
  source?: DownloadSource
  concurrency?: number
  signal?: AbortSignal
  onProgress?(progress: TaskProgress, detail?: string): void
  fetchImpl?: typeof fetch
  stats?: SourceStats
  retries?: number
  timeoutMs?: number
  mirrorOrigin?: string
}

export interface DownloadReport {
  files: number
  downloaded: number
  bytes: number
  sources: Record<SourceId, { ok: number; failed: number; rate: number | null }>
}

export class HttpStatusError extends Error {
  readonly status: number
  readonly url: string

  constructor(status: number, url: string) {
    super(`请求 ${url} 失败：HTTP ${status}`)
    this.name = 'HttpStatusError'
    this.status = status
    this.url = url
  }
}

export function requestFailure(url: string, error: unknown): Error {
  if (error instanceof HttpStatusError) return new HttpStatusError(error.status, url)
  return new Error(`请求 ${url} 失败：${messageOf(error)}`)
}

export function abortError(message = '已取消'): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export function clampConcurrency(value: number | undefined): number {
  if (!Number.isFinite(value) || !value) return DEFAULT_CONCURRENCY
  return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.round(value)))
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function cancelledByUser(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function retryable(error: unknown): boolean {
  if (!(error instanceof HttpStatusError)) return true
  return error.status === 408 || error.status === 429 || error.status >= 500
}

async function request(url: string, options: DownloadOptions): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch
  const candidates = candidateUrls(url, options.source, options.mirrorOrigin)
  const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES)
  let lastError: unknown
  for (const candidate of candidates) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      throwIfAborted(options.signal)
      try {
        const response = await fetchImpl(candidate.url, {
          headers: { 'user-agent': USER_AGENT },
          redirect: 'follow',
          signal: combineSignals(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
        })
        if (!response.ok) throw new HttpStatusError(response.status, url)
        options.stats?.note(candidate.source, true)
        return response
      } catch (error) {
        if (cancelledByUser(options.signal)) throw abortError()
        options.stats?.note(candidate.source, false)
        lastError = error
        if (!retryable(error)) break
      }
    }
  }
  throw requestFailure(url, lastError)
}

export async function fetchText(url: string, options: DownloadOptions = {}): Promise<string> {
  const response = await request(url, options)
  const text = await response.text()
  if (cancelledByUser(options.signal)) throw abortError()
  return text
}

export async function fetchJson<T>(url: string, options: DownloadOptions = {}): Promise<T> {
  const text = await fetchText(url, options)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`${url} 返回的不是 JSON`)
  }
}

async function writeFromRemote(candidate: UrlCandidate, file: RemoteFile, options: DownloadOptions & { signal?: AbortSignal }): Promise<number> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const relay = () => controller.abort()
  options.signal?.addEventListener('abort', relay, { once: true })
  let timer = setTimeout(() => controller.abort(), timeoutMs)
  const touch = () => {
    clearTimeout(timer)
    timer = setTimeout(() => controller.abort(), timeoutMs)
  }
  const temp = `${file.dest}.part`
  try {
    const response = await fetchImpl(candidate.url, {
      headers: { 'user-agent': USER_AGENT },
      redirect: 'follow',
      signal: controller.signal
    })
    if (!response.ok) throw new HttpStatusError(response.status, candidate.url)
    if (!response.body) throw new Error('响应没有内容')
    touch()
    const declared = Number(response.headers.get('content-length') ?? '')
    if (file.size && Number.isFinite(declared) && declared > 0 && declared !== file.size) {
      throw new Error(`大小不符：服务器 ${declared} ≠ 期望 ${file.size}`)
    }
    const hash = createHash('sha1')
    const tap = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        touch()
        hash.update(chunk)
        callback(null, chunk)
      }
    })
    await mkdir(dirname(file.dest), { recursive: true })
    await rm(temp, { force: true })
    await pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), tap, createWriteStream(temp), { signal: controller.signal })
    const written = (await stat(temp)).size
    if (file.size && written !== file.size) throw new Error(`大小不符：${written} ≠ ${file.size}`)
    const sha1 = hash.digest('hex')
    if (file.sha1 && sha1 !== file.sha1.toLowerCase()) throw new Error(`sha1 不符：${sha1} ≠ ${file.sha1}`)
    await rm(file.dest, { force: true })
    await rename(temp, file.dest)
    return written
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    if (options.signal?.aborted) throw abortError()
    if (error instanceof HttpStatusError) throw error
    throw new Error(`下载 ${candidate.url} 失败：${messageOf(error)}`)
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', relay)
  }
}

async function downloadFile(file: RemoteFile, options: DownloadOptions & { signal?: AbortSignal }): Promise<number> {
  const candidates = candidateUrls(file.url, options.source, options.mirrorOrigin)
  const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES)
  let lastError: unknown
  for (const candidate of candidates) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      throwIfAborted(options.signal)
      try {
        const written = await writeFromRemote(candidate, file, options)
        options.stats?.note(candidate.source, true)
        return written
      } catch (error) {
        if (cancelledByUser(options.signal)) throw abortError()
        options.stats?.note(candidate.source, false)
        lastError = error
        if (!retryable(error)) break
      }
    }
  }
  throw requestFailure(file.url, lastError)
}

export async function downloadFiles(files: RemoteFile[], options: DownloadOptions = {}): Promise<DownloadReport> {
  const stats = options.stats ?? new SourceStats()
  const total = files.length
  const concurrency = clampConcurrency(options.concurrency)
  let done = 0
  let bytes = 0
  throwIfAborted(options.signal)
  const controller = new AbortController()
  const relay = () => controller.abort()
  options.signal?.addEventListener('abort', relay, { once: true })
  const report = (detail?: string) => options.onProgress?.({ done, total, unit: 'files' }, detail)
  report(files[0] ? basename(files[0].dest) : undefined)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++
      if (index >= total) return
      const file = files[index]
      const written = await downloadFile(file, { ...options, stats, signal: controller.signal })
      done += 1
      bytes += written
      report(basename(file.dest))
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(total, 1)) }, worker))
  } catch (error) {
    controller.abort()
    if (cancelledByUser(options.signal)) throw abortError()
    throw error
  } finally {
    options.signal?.removeEventListener('abort', relay)
  }
  return { files: total, downloaded: total, bytes, sources: stats.snapshot() }
}
