/**
 * 固定 npm 制品的下载与受限解包（实施-04 §8 / §10 S6b-2）。
 *
 * 这层只准备材料：它不会执行 install scripts、调用 `pi install`、改项目配置，
 * 或把目录元数据当授权。只有 registry manifest 与 tarball 的 SHA-512 一致，
 * 且包名 / 精确版本 / 归档结构都通过校验后，才会把内容放进 operationId 专属目录。
 */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import * as tar from 'tar'
import { acquisitionRoot } from './acquisition-service'

export const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org'
export const NPM_ARTIFACT_LIMITS = {
  archiveBytes: 32 * 1024 * 1024,
  metadataBytes: 1024 * 1024,
  unpackedBytes: 32 * 1024 * 1024,
  entries: 2000,
  pathLength: 200,
  depth: 24,
  metaEntryBytes: 1024 * 1024
} as const

export class NpmArtifactError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'NpmArtifactError'
  }
}

export type NpmArtifactFile = { path: string; bytes: number; sha256: string }

export type NpmArtifact = {
  name: string
  version: string
  integrity: string
  packageDir: string
  tarballPath: string
  files: NpmArtifactFile[]
  totalBytes: number
  packageJson: Record<string, unknown>
}

export type FetchLike = typeof fetch

function operationSegment(operationId: string): string {
  const value = String(operationId ?? '').trim()
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
    throw new NpmArtifactError('bad-operation-id', 'operationId 形状不合法')
  }
  return value
}

export function npmArtifactDirOf(root: string, operationId: string): string {
  return join(acquisitionRoot(root), 'downloads', operationSegment(operationId))
}

function validatePackageIdentity(name: string, version: string): void {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) {
    throw new NpmArtifactError('invalid-package-name', `npm 包名不合法：${name}`)
  }
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new NpmArtifactError('version-not-pinned', `必须是精确 SemVer 版本，不能用范围或 tag：${version}`)
  }
}

function registryPackageUrl(name: string, version: string): string {
  return `${NPM_REGISTRY_ORIGIN}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
}

function checkedResponseUrl(response: Response, requestedUrl: string): void {
  const actual = response.url || requestedUrl
  let parsed: URL
  try {
    parsed = new URL(actual)
  } catch {
    throw new NpmArtifactError('invalid-response-url', 'registry 响应没有合法 URL')
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'registry.npmjs.org' || parsed.port || parsed.username || parsed.password) {
    throw new NpmArtifactError('redirect-origin', `拒绝跳转到非官方 npm registry 主机：${parsed.origin}`)
  }
}

function sha512Integrity(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

function requireSha512Integrity(value: unknown): string {
  if (typeof value !== 'string') throw new NpmArtifactError('integrity-missing', 'npm registry 没有提供完整性字段')
  const sha512 = value.trim().split(/\s+/).find((item) => item.startsWith('sha512-'))
  if (!sha512 || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(sha512)) {
    throw new NpmArtifactError('integrity-unsupported', '只接受 registry 提供的 SHA-512 SRI')
  }
  const digest = Buffer.from(sha512.slice('sha512-'.length), 'base64')
  if (digest.byteLength !== 64 || digest.toString('base64') !== sha512.slice('sha512-'.length)) {
    throw new NpmArtifactError('integrity-unsupported', 'registry 的 SHA-512 SRI 编码不规范')
  }
  return sha512
}

function jsonFromBoundedBody<T>(bytes: Uint8Array): T {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as T
  } catch {
    throw new NpmArtifactError('registry-json', 'npm registry 返回的 metadata 不是合法 JSON')
  }
}

async function readBoundedBody(response: Response, limit: number): Promise<Buffer> {
  const rawLength = response.headers?.get('content-length')
  if (rawLength && Number.isFinite(Number(rawLength)) && Number(rawLength) > limit) {
    throw new NpmArtifactError('archive-too-large', `压缩包超过 ${limit} 字节上限`)
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = Buffer.from(value)
        total += chunk.byteLength
        if (total > limit) {
          await reader.cancel().catch(() => undefined)
          throw new NpmArtifactError('archive-too-large', `压缩包超过 ${limit} 字节上限`)
        }
        chunks.push(chunk)
      }
    } finally {
      reader.releaseLock()
    }
    return Buffer.concat(chunks, total)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength > limit) throw new NpmArtifactError('archive-too-large', `压缩包超过 ${limit} 字节上限`)
  return bytes
}

/** 校验 tar entry 的原始路径与类型；symlink / hardlink / 特殊文件一律拒绝。 */
export function validateNpmTarEntry(input: { path: string; type: string; size: number }): string | null {
  const raw = input.path
  if (!raw || raw.includes('\0') || raw.includes('\\') || raw.length > NPM_ARTIFACT_LIMITS.pathLength) {
    return `归档路径为空、含 NUL / 反斜杠或过长：${JSON.stringify(raw)}`
  }
  if (isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith('/')) return `拒绝绝对路径：${raw}`
  const normalized = raw.replace(/\/+$/, '')
  const segments = normalized.split('/')
  if (segments[0] !== 'package' || segments.some((part, index) => (index > 0 && !part) || part === '.' || part === '..')) {
    return `归档路径必须位于 package/ 下且不能穿越：${raw}`
  }
  if (input.type !== 'File' && input.type !== 'OldFile' && input.type !== 'Directory') {
    return `拒绝归档中的链接或特殊文件（${input.type}）：${raw}`
  }
  if (segments.some((part, index) => index > 0 && (/[:<>"|?*\u0000-\u001f]/.test(part) || /[ .]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)))) {
    return `归档路径含 Windows 不安全名称：${raw}`
  }
  if (!Number.isSafeInteger(input.size) || input.size < 0) return `归档条目大小不合法：${raw}`
  if (segments.length === 1 && input.type !== 'Directory') return `package/ 根条目必须是目录：${raw}`
  return null
}

function normalizeEntryPath(raw: string): string {
  return raw.replace(/\/$/, '').slice('package/'.length)
}

function within(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export type NpmPackageMetadata = { name: string; version: string; integrity: string; tarballUrl: string }

/* Same-process retries share one operation directory; serialize them to avoid partial writes racing. */
const artifactOperations = new Map<string, Promise<void>>()

/** prepare 阶段先固定官方 exact-version manifest 的 SRI；这里只读元数据，不取代码。 */
export async function fetchNpmPackageMetadata(input: {
  name: string
  version: string
  expectedIntegrity?: string
  fetchImpl?: FetchLike
  timeoutMs?: number
  metadataBytes?: number
}): Promise<NpmPackageMetadata> {
  validatePackageIdentity(input.name, input.version)
  const fetchImpl = input.fetchImpl ?? fetch
  const timeoutMs = input.timeoutMs ?? 20_000
  const metadataUrl = registryPackageUrl(input.name, input.version)
  const response = await fetchImpl(metadataUrl, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'manual',
    headers: { accept: 'application/json' }
  })
  checkedResponseUrl(response, metadataUrl)
  if (!response.ok) throw new NpmArtifactError('registry-http', `npm registry 返回 HTTP ${response.status}`)
  const metadata = jsonFromBoundedBody<{
    name?: unknown
    version?: unknown
    dist?: { tarball?: unknown; integrity?: unknown }
  }>(await readBoundedBody(response, input.metadataBytes ?? NPM_ARTIFACT_LIMITS.metadataBytes))
  if (metadata.name !== input.name || metadata.version !== input.version) {
    throw new NpmArtifactError('identity-mismatch', 'registry manifest 的包名或版本与固定候选不一致')
  }
  const integrity = requireSha512Integrity(metadata.dist?.integrity)
  if (input.expectedIntegrity && requireSha512Integrity(input.expectedIntegrity) !== integrity) {
    throw new NpmArtifactError('integrity-changed', '当前 registry integrity 与 prepare 时固定值不同，旧计划已失效')
  }
  if (typeof metadata.dist?.tarball !== 'string') throw new NpmArtifactError('tarball-missing', 'registry manifest 没有 tarball URL')
  let tarballUrl: URL
  try {
    tarballUrl = new URL(metadata.dist.tarball)
  } catch {
    throw new NpmArtifactError('tarball-url', 'registry tarball URL 不合法')
  }
  if (tarballUrl.protocol !== 'https:' || tarballUrl.hostname !== 'registry.npmjs.org' || tarballUrl.port || tarballUrl.username || tarballUrl.password) {
    throw new NpmArtifactError('tarball-origin', `只允许从官方 HTTPS npm registry 下载：${tarballUrl.origin}`)
  }
  return { name: input.name, version: input.version, integrity, tarballUrl: tarballUrl.href }
}

/**
 * 下载并安全解开精确 npm 版本。该函数仅可由宿主按 operationId 调用；
 * 来源是固定的官方 registry，重定向也必须留在同一 HTTPS 主机。
 */
export async function fetchNpmArtifact(input: {
  root: string
  operationId: string
  name: string
  version: string
  expectedIntegrity?: string
  expectedSha256?: string
  fetchImpl?: FetchLike
  timeoutMs?: number
  limits?: Partial<typeof NPM_ARTIFACT_LIMITS>
}): Promise<NpmArtifact> {
  const operationDir = npmArtifactDirOf(input.root, input.operationId)
  const previous = artifactOperations.get(operationDir)
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  artifactOperations.set(operationDir, current)
  await previous
  try {
    return await fetchNpmArtifactForOperation(input, operationDir)
  } finally {
    release()
    if (artifactOperations.get(operationDir) === current) artifactOperations.delete(operationDir)
  }
}

async function fetchNpmArtifactForOperation(input: {
  root: string
  operationId: string
  name: string
  version: string
  expectedIntegrity?: string
  expectedSha256?: string
  fetchImpl?: FetchLike
  timeoutMs?: number
  limits?: Partial<typeof NPM_ARTIFACT_LIMITS>
}, operationDir: string): Promise<NpmArtifact> {
  validatePackageIdentity(input.name, input.version)
  const fetchImpl = input.fetchImpl ?? fetch
  const timeoutMs = input.timeoutMs ?? 20_000
  const limits = { ...NPM_ARTIFACT_LIMITS, ...input.limits }
  if (input.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(input.expectedSha256)) {
    throw new NpmArtifactError('sha256-invalid', '固定的 SHA-256 必须是 64 位十六进制')
  }
  const downloadsRoot = join(acquisitionRoot(input.root), 'downloads')
  if (!within(downloadsRoot, operationDir)) throw new NpmArtifactError('path-escape', '下载目录逃出受管 downloads 根')

  let createdDir = false
  let reusedDir = false
  try {
    await mkdir(downloadsRoot, { recursive: true })
    const downloadsInfo = await lstat(downloadsRoot)
    if (!downloadsInfo.isDirectory() || downloadsInfo.isSymbolicLink()) {
      throw new NpmArtifactError('downloads-root-invalid', '受管 downloads 根必须是普通目录，拒绝重解析点')
    }
    const actualAcquisition = await realpath(acquisitionRoot(input.root))
    const actualDownloads = await realpath(downloadsRoot)
    if (!within(actualAcquisition, actualDownloads)) {
      throw new NpmArtifactError('path-escape', 'downloads 根真实路径逃出了受管 capabilities 目录')
    }
    try {
      await mkdir(operationDir)
      createdDir = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
      const info = await lstat(operationDir)
      const actualOperation = await realpath(operationDir)
      if (!info.isDirectory() || info.isSymbolicLink() || !within(actualDownloads, actualOperation)) {
        throw new NpmArtifactError('operation-directory-invalid', '已存在的 operation 目录不是受管普通目录')
      }
      const entries = (await readdir(operationDir)).sort()
      if (entries.some((entry) => entry !== 'artifact.tgz' && entry !== 'package')) {
        throw new NpmArtifactError('operation-directory-conflict', '已存在的 operation 目录包含未知内容；为保护原数据拒绝覆盖')
      }
      reusedDir = true
      if (entries.includes('package') && !entries.includes('artifact.tgz')) {
        throw new NpmArtifactError('operation-directory-conflict', '已存在的 package 目录没有对应的受校验归档；为保护原数据拒绝覆盖')
      }
    }

    const metadata = await fetchNpmPackageMetadata({
      name: input.name,
      version: input.version,
      ...(input.expectedIntegrity ? { expectedIntegrity: input.expectedIntegrity } : {}),
      fetchImpl,
      timeoutMs,
      metadataBytes: limits.metadataBytes
    })

    const tarballPath = join(operationDir, 'artifact.tgz')
    const packageDir = join(operationDir, 'package')
    let archive: Buffer
    let archiveWasCached = false
    try {
      const info = await lstat(tarballPath)
      if (!info.isFile() || info.isSymbolicLink() || info.size > limits.archiveBytes) {
        throw new NpmArtifactError('cached-archive-invalid', '缓存 tarball 不是上限内的普通文件')
      }
      archive = await readFile(tarballPath)
      archiveWasCached = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
      const archiveResponse = await fetchImpl(metadata.tarballUrl, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
        headers: { accept: 'application/octet-stream' }
      })
      checkedResponseUrl(archiveResponse, metadata.tarballUrl)
      if (!archiveResponse.ok) throw new NpmArtifactError('tarball-http', `npm tarball 返回 HTTP ${archiveResponse.status}`)
      archive = await readBoundedBody(archiveResponse, limits.archiveBytes)
    }
    if (sha512Integrity(archive) !== metadata.integrity) throw new NpmArtifactError('integrity-mismatch', 'npm tarball 的 SHA-512 与 registry SRI 不符')
    const archiveSha256 = createHash('sha256').update(archive).digest('hex')
    if (input.expectedSha256 && archiveSha256 !== input.expectedSha256.toLowerCase()) {
      throw new NpmArtifactError('integrity-mismatch', 'npm tarball 的 SHA-256 与 MCP Registry 固定值不符')
    }

    if (!archiveWasCached) {
      if (reusedDir) {
        const existingPackage = await lstat(packageDir).catch((error) => {
          if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
          throw error
        })
        if (existingPackage) {
          throw new NpmArtifactError('operation-directory-conflict', 'operation 目录已有 package 内容但没有可复用的受校验归档；拒绝覆盖')
        }
      }
      try {
        await writeFile(tarballPath, archive, { flag: 'wx' })
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
        throw new NpmArtifactError('cached-archive-conflict', '并发写入造成归档冲突，保留现有材料并拒绝覆盖')
      }
    }
    try {
      const packageInfo = await lstat(packageDir)
      if (!packageInfo.isDirectory() || packageInfo.isSymbolicLink()) {
        throw new NpmArtifactError('cached-package-invalid', '缓存解包目标不是普通目录；拒绝清理或覆盖')
      }
      await rm(packageDir, { recursive: true, force: false })
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
    await mkdir(packageDir)

    const files: NpmArtifactFile[] = []
    const seen = new Set<string>()
    let totalBytes = 0
    let entryCount = 0
    const inspect = (path: string, entry: tar.ReadEntry): boolean => {
      const problem = validateNpmTarEntry({ path, type: entry.type, size: entry.size })
      if (problem) throw new NpmArtifactError('archive-entry', problem)
      entryCount++
      if (entryCount > limits.entries) throw new NpmArtifactError('too-many-files', `归档条目超过 ${limits.entries}`)
      const relativePath = normalizeEntryPath(path)
      if (!relativePath) return true // package/ 根目录
      const key = relativePath.toLowerCase()
      if (seen.has(key)) throw new NpmArtifactError('duplicate-path', `归档包含重名路径：${relativePath}`)
      seen.add(key)
      if (entry.type !== 'Directory') {
        totalBytes += entry.size
        if (totalBytes > limits.unpackedBytes) throw new NpmArtifactError('unpacked-too-large', `解包内容超过 ${limits.unpackedBytes} 字节`)
        files.push({ path: relativePath, bytes: entry.size, sha256: '' })
      }
      return true
    }
    const allowExtraction = (path: string, entry: tar.ReadEntry): boolean => {
      const problem = validateNpmTarEntry({ path, type: entry.type, size: entry.size })
      if (problem) throw new NpmArtifactError('archive-entry', problem)
      return true
    }

    await tar.t({
      file: tarballPath,
      strict: true,
      maxDepth: limits.depth,
      maxMetaEntrySize: limits.metaEntryBytes,
      maxDecompressionRatio: 100,
      onReadEntry: (entry) => { inspect(entry.path, entry) }
    })
    if (!files.some((file) => file.path === 'package.json')) {
      throw new NpmArtifactError('package-json-missing', 'npm tarball 内缺少 package/package.json')
    }

    await tar.x({
      file: tarballPath,
      cwd: operationDir,
      strict: true,
      preservePaths: false,
      unlink: true,
      maxDepth: limits.depth,
      maxMetaEntrySize: limits.metaEntryBytes,
      maxDecompressionRatio: 100,
      filter: (path, entry) => {
        if (!('type' in entry)) return false
        return allowExtraction(path, entry as tar.ReadEntry)
      }
    })

    /* 重新读取抽出内容计算 hash；manifest/receipt 不采用 tar header 的声明值。 */
    const completedFiles: NpmArtifactFile[] = []
    for (const file of files) {
      const path = join(packageDir, ...file.path.split('/'))
      const resolved = resolve(path)
      if (!within(packageDir, resolved)) throw new NpmArtifactError('path-escape', `解包目标逃出 package 目录：${file.path}`)
      const info = await lstat(resolved)
      if (!info.isFile() || info.isSymbolicLink()) throw new NpmArtifactError('archive-entry', `解包后不是普通文件：${file.path}`)
      const actualRoot = await realpath(packageDir)
      const actualPath = await realpath(resolved)
      if (!within(actualRoot, actualPath)) throw new NpmArtifactError('path-escape', `解包文件真实路径逃出 package 目录：${file.path}`)
      const content = await readFile(resolved)
      if (content.byteLength !== file.bytes) throw new NpmArtifactError('entry-size-mismatch', `解包文件大小与归档不符：${file.path}`)
      completedFiles.push({ ...file, sha256: createHash('sha256').update(content).digest('hex') })
    }
    const packageJsonPath = join(packageDir, 'package.json')
    const packageJsonInfo = await lstat(packageJsonPath)
    if (!packageJsonInfo.isFile() || packageJsonInfo.isSymbolicLink() || packageJsonInfo.size > limits.metaEntryBytes) {
      throw new NpmArtifactError('package-json-invalid', '包内 package.json 必须是小于上限的普通文件')
    }
    let packageJson: Record<string, unknown>
    try {
      packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as Record<string, unknown>
    } catch {
      throw new NpmArtifactError('package-json-invalid', '包内 package.json 不是合法 JSON')
    }
    if (packageJson.name !== input.name || packageJson.version !== input.version) {
      throw new NpmArtifactError('package-metadata-mismatch', '包内 package.json 与 registry 固定身份不符')
    }
    return {
      name: input.name,
      version: input.version,
      integrity: metadata.integrity,
      packageDir,
      tarballPath,
      files: completedFiles,
      totalBytes,
      packageJson
    }
  } catch (error) {
    if (createdDir) await rm(operationDir, { recursive: true, force: true }).catch(() => undefined)
    if (error instanceof NpmArtifactError) throw error
    throw new NpmArtifactError('acquire-failed', error instanceof Error ? error.message : String(error))
  }
}
