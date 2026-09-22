/**
 * 独立目录 Skill 文件的受限读取器（实施-04 S6b-2）。
 *
 * 目录只提供固定文件 URL 和 SHA-256；这里才真正读取正文。读取结果仍只是待 staging
 * 的字节，不执行 Markdown、脚本或包生命周期。调用方必须先完成现有的精确候选授权。
 */
import { createHash } from 'node:crypto'
import { normalizeSkillFilePath, type SkillFileInput } from './skill-files'

export const SKILL_SOURCE_LIMITS = {
  files: 32,
  fileBytes: 512 * 1024,
  totalBytes: 4 * 1024 * 1024
} as const

export class SkillSourceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'SkillSourceError'
  }
}

type FetchLike = typeof fetch

const TRANSIENT_SOURCE_ATTEMPTS = 3
const TRANSIENT_SOURCE_DELAYS_MS = [250, 750]

function retryableSourceStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

async function fetchSkillSource(
  fetchImpl: FetchLike,
  url: string,
  timeoutMs: number
): Promise<Response> {
  let response: Response | undefined
  for (let attempt = 0; attempt < TRANSIENT_SOURCE_ATTEMPTS; attempt += 1) {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
      headers: { accept: 'text/markdown, text/plain;q=0.9, application/octet-stream;q=0.5' }
    })
    if (response.ok || !retryableSourceStatus(response.status) || attempt === TRANSIENT_SOURCE_ATTEMPTS - 1) {
      return response
    }
    await new Promise((resolve) => setTimeout(resolve, TRANSIENT_SOURCE_DELAYS_MS[attempt] ?? 750))
  }
  return response as Response
}

function safeOrigin(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new SkillSourceError('source-url', `Skill 来源 URL 不合法：${value}`)
  }
  const localHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  if ((parsed.protocol !== 'https:' && !localHttp) || parsed.username || parsed.password) {
    throw new SkillSourceError('source-origin', 'Skill 来源只允许 HTTPS（本机测试可用 localhost HTTP），且不能带 URL 凭证')
  }
  return parsed.origin
}

function checkedUrl(value: string, allowedOrigins: ReadonlySet<string>): string {
  const origin = safeOrigin(value)
  if (!allowedOrigins.has(origin)) throw new SkillSourceError('source-not-allowed', `Skill 文件来源不在已允许的目录来源内：${origin}`)
  return new URL(value).href
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  const length = response.headers?.get('content-length')
  if (length && Number.isFinite(Number(length)) && Number(length) > limit) {
    throw new SkillSourceError('file-too-large', `Skill 文件超过 ${limit} 字节上限`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > limit) throw new SkillSourceError('file-too-large', `Skill 文件超过 ${limit} 字节上限`)
  try {
    /* SKILL.md 是文本；拒绝替换字符，避免 hash 对应的内容与模型实际看到的内容不一致。 */
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new SkillSourceError('invalid-utf8', 'SKILL.md 不是合法 UTF-8 文本')
  }
  if (bytes.byteLength === 0 || new TextDecoder().decode(bytes).trim().length === 0) {
    throw new SkillSourceError('empty-skill', 'SKILL.md 不能为空')
  }
  return bytes
}

/**
 * 从独立目录给出的固定 URL 读取 Skill 文件。
 *
 * `fileUrls` 与 `expectedHashes` 都必须覆盖完全相同的安全相对路径集合；多余、缺失、
 * 路径穿越、跨来源跳转、超大文件、hash 漂移和非 2xx 响应都会 fail-closed。
 */
export async function fetchSkillFiles(input: {
  fileUrls: Record<string, string>
  expectedHashes: Record<string, string>
  allowedOrigins: readonly string[]
  fetchImpl?: FetchLike
  timeoutMs?: number
  limits?: Partial<typeof SKILL_SOURCE_LIMITS>
}): Promise<Array<SkillFileInput & { sha256: string; url: string }>> {
  const limits = { ...SKILL_SOURCE_LIMITS, ...input.limits }
  const entries = Object.entries(input.fileUrls)
  if (entries.length === 0 || entries.length > limits.files) {
    throw new SkillSourceError('file-count', `Skill 文件数量必须在 1-${limits.files} 之间`)
  }
  const paths = entries.map(([path]) => {
    try {
      return normalizeSkillFilePath(path)
    } catch {
      throw new SkillSourceError('file-path', `Skill 文件路径不安全：${path}`)
    }
  })
  if (new Set(paths).size !== paths.length || paths.some((path) => !/^skills\/[^/]+\/SKILL\.md$/i.test(path))) {
    throw new SkillSourceError('file-path', 'Skill 文件必须是唯一的 skills/<name>/SKILL.md')
  }
  const expectedKeys = Object.keys(input.expectedHashes).map((path) => {
    try { return normalizeSkillFilePath(path) } catch { throw new SkillSourceError('hash-path', `固定 hash 的路径不安全：${path}`) }
  })
  if (expectedKeys.length !== paths.length || expectedKeys.some((path) => !paths.includes(path))) {
    throw new SkillSourceError('hash-manifest', 'Skill 文件 URL 与 hash manifest 的文件集合不一致')
  }
  for (const path of paths) {
    if (!/^[a-f0-9]{64}$/i.test(input.expectedHashes[path] ?? input.expectedHashes[entries.find(([raw]) => raw === path)?.[0] ?? ''] ?? '')) {
      throw new SkillSourceError('hash-manifest', `Skill 文件缺少有效 SHA-256：${path}`)
    }
  }

  const allowedOrigins = new Set(input.allowedOrigins.map((origin) => safeOrigin(origin)))
  const fetchImpl = input.fetchImpl ?? fetch
  const timeoutMs = input.timeoutMs ?? 15_000
  let totalBytes = 0
  const files: Array<SkillFileInput & { sha256: string; url: string }> = []
  for (const [rawPath, rawUrl] of entries) {
    const path = normalizeSkillFilePath(rawPath)
    const url = checkedUrl(rawUrl, allowedOrigins)
    const response = await fetchSkillSource(fetchImpl, url, timeoutMs)
    if (!response.ok) throw new SkillSourceError('http', `Skill 文件返回 HTTP ${response.status}：${path}`)
    const actualUrl = response.url || url
    if (safeOrigin(actualUrl) !== safeOrigin(url)) {
      throw new SkillSourceError('redirect-origin', `Skill 文件跳转到了未登记来源：${path}`)
    }
    const content = await readBounded(response, limits.fileBytes)
    totalBytes += content.byteLength
    if (totalBytes > limits.totalBytes) throw new SkillSourceError('total-too-large', `Skill 文件总大小超过 ${limits.totalBytes} 字节上限`)
    const sha256 = createHash('sha256').update(content).digest('hex')
    const expected = input.expectedHashes[path] ?? input.expectedHashes[rawPath]
    if (sha256 !== expected?.toLowerCase()) throw new SkillSourceError('hash-mismatch', `Skill 文件 hash 与目录声明不符：${path}`)
    files.push({ path, content, sha256, url })
  }
  return files
}
