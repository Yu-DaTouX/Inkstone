import { createHash } from 'node:crypto'
import type { CapabilityCandidate, GithubSkillFile } from '../../shared/discovery'
import { parseSkillFrontmatter } from './acquired-skills'

type FetchLike = typeof fetch

export const GITHUB_API_URL = process.env.YAN_GITHUB_API_URL?.trim() || 'https://api.github.com'
export const GITHUB_RAW_URL = process.env.YAN_GITHUB_RAW_URL?.trim() || 'https://raw.githubusercontent.com'
export const DEFAULT_SKILL_REPOS = ['anthropics/skills']

export const GITHUB_SKILL_LIMITS = {
  files: 200,
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
  skillsPerRepo: 60
} as const

const REPO_PATTERN = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/
const INDEX_TTL_MS = 30 * 60_000
const SCRIPT_EXT = /\.(?:py|js|mjs|cjs|ts|sh|bash|ps1|bat|cmd|rb|pl)$/i

export class GithubSkillError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'GithubSkillError'
  }
}

export function parseSkillRepo(raw: string): { owner: string; repo: string } | null {
  const text = raw.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '')
  const parts = text.split('/')
  const match = REPO_PATTERN.exec(parts.slice(0, 2).join('/'))
  if (!match || match[2] === '.' || match[2] === '..') return null
  return { owner: match[1], repo: match[2] }
}

export function configuredSkillRepos(): string[] {
  const extra = (process.env.YAN_GITHUB_SKILL_REPOS ?? '')
    .split(',')
    .map((item) => parseSkillRepo(item))
    .filter((item): item is { owner: string; repo: string } => item !== null)
    .map(({ owner, repo }) => `${owner}/${repo}`)
  return [...new Set([...DEFAULT_SKILL_REPOS, ...extra])]
}

export function gitBlobSha(content: Uint8Array): string {
  return createHash('sha1').update(`blob ${content.byteLength}\0`).update(content).digest('hex')
}

function safeBase(url: string, label: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new GithubSkillError('source-url', `${label} 不是合法 URL`)
  }
  const localHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  if ((parsed.protocol !== 'https:' && !localHttp) || parsed.username || parsed.password) {
    throw new GithubSkillError('source-url', `${label} 只允许 HTTPS（本机测试可用 localhost HTTP），且不能带 URL 凭证`)
  }
  return parsed.href.replace(/\/+$/, '')
}

function encodePath(path: string): string {
  return path.split('/').map((part) => encodeURIComponent(part)).join('/')
}

export function rawFileUrl(owner: string, repo: string, commit: string, path: string): string {
  return `${safeBase(GITHUB_RAW_URL, 'GitHub raw 地址')}/${owner}/${repo}/${commit}/${encodePath(path)}`
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  const length = response.headers?.get('content-length')
  if (length && Number.isFinite(Number(length)) && Number(length) > limit) {
    await response.body?.cancel().catch(() => undefined)
    throw new GithubSkillError('too-large', `响应超过 ${limit} 字节`)
  }
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new GithubSkillError('too-large', `响应超过 ${limit} 字节`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function get(fetchImpl: FetchLike, url: string, accept: string, timeoutMs: number): Promise<Response> {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
    headers: { accept, 'user-agent': 'Inkstone' }
  })
  if (response.status === 403 || response.status === 429) {
    throw new GithubSkillError('rate-limited', 'GitHub 拒绝了请求（未登录的 API 每小时 60 次，可能已用完），稍后再试')
  }
  if (!response.ok) throw new GithubSkillError('http', `GitHub 返回 HTTP ${response.status}`)
  return response
}

async function rawFile(
  fetchImpl: FetchLike,
  source: { owner: string; repo: string; commit: string },
  path: string,
  file: { sha: string; size: number },
  timeoutMs: number
): Promise<Uint8Array> {
  const response = await get(fetchImpl, rawFileUrl(source.owner, source.repo, source.commit, path), '*/*', timeoutMs)
  const content = await readBounded(response, Math.min(GITHUB_SKILL_LIMITS.fileBytes, file.size + 1024))
  if (gitBlobSha(content) !== file.sha) throw new GithubSkillError('hash-mismatch', `文件内容与固定提交不符：${path}`)
  return content
}

type RepoSkill = { dir: string; name: string; description: string; files: GithubSkillFile[] }
type RepoIndex = { owner: string; repo: string; commit: string; skills: RepoSkill[] }

const indexCache = new Map<string, { index: RepoIndex; at: number }>()
const frontmatterCache = new Map<string, { name?: string; description?: string }>()

export function clearGithubSkillCache(): void {
  indexCache.clear()
  frontmatterCache.clear()
}

type TreeEntry = { path?: unknown; type?: unknown; sha?: unknown; size?: unknown }

export function skillDirsOfTree(entries: readonly TreeEntry[]): Array<{ dir: string; skillSha: string; files: GithubSkillFile[] }> {
  const blobs = entries.filter(
    (entry): entry is { path: string; type: 'blob'; sha: string; size: number } =>
      entry.type === 'blob' &&
      typeof entry.path === 'string' &&
      typeof entry.sha === 'string' &&
      /^[a-f0-9]{40}$/.test(entry.sha) &&
      typeof entry.size === 'number'
  )
  const dirs = blobs
    .filter((blob) => blob.path === 'SKILL.md' || blob.path.endsWith('/SKILL.md'))
    .map((blob) => ({ dir: blob.path === 'SKILL.md' ? '' : blob.path.slice(0, -'/SKILL.md'.length), skillSha: blob.sha }))
    .filter(({ dir }) => !dir.split('/').some((part) => part.startsWith('.') || part === 'template' || part === 'templates'))
  return dirs.map(({ dir, skillSha }) => {
    const prefix = dir ? `${dir}/` : ''
    const nested = dirs.filter((other) => other.dir !== dir && other.dir.startsWith(prefix)).map((other) => `${other.dir}/`)
    const files = blobs
      .filter((blob) => blob.path.startsWith(prefix) && !nested.some((inner) => blob.path.startsWith(inner)))
      .map((blob) => ({ path: blob.path.slice(prefix.length), sha: blob.sha, size: blob.size }))
      .sort((a, b) => a.path.localeCompare(b.path))
    return { dir, skillSha, files }
  })
}

async function loadRepoIndex(
  owner: string,
  repo: string,
  fetchImpl: FetchLike,
  timeoutMs: number
): Promise<RepoIndex> {
  const key = `${owner}/${repo}`.toLowerCase()
  const cached = indexCache.get(key)
  if (cached && Date.now() - cached.at < INDEX_TTL_MS) return cached.index

  const api = safeBase(GITHUB_API_URL, 'GitHub API 地址')
  const commitResponse = await get(fetchImpl, `${api}/repos/${owner}/${repo}/commits/HEAD`, 'application/vnd.github.sha', timeoutMs)
  const commit = new TextDecoder().decode(await readBounded(commitResponse, 256)).trim()
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new GithubSkillError('commit', `${owner}/${repo} 没有返回可固定的提交`)
  const treeResponse = await get(fetchImpl, `${api}/repos/${owner}/${repo}/git/trees/${commit}?recursive=1`, 'application/vnd.github+json', timeoutMs)
  let tree: { tree?: unknown }
  try {
    tree = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(treeResponse, 8 * 1024 * 1024)))
  } catch (error) {
    if (error instanceof GithubSkillError) throw error
    throw new GithubSkillError('tree', `${owner}/${repo} 的文件树不是合法 JSON`)
  }
  const dirs = skillDirsOfTree(Array.isArray(tree.tree) ? (tree.tree as TreeEntry[]) : []).slice(0, GITHUB_SKILL_LIMITS.skillsPerRepo)

  const skills: RepoSkill[] = []
  for (let start = 0; start < dirs.length; start += 6) {
    const batch = await Promise.all(dirs.slice(start, start + 6).map(async ({ dir, skillSha, files }) => {
      let meta = frontmatterCache.get(skillSha)
      if (!meta) {
        const skillFile = files.find((file) => file.path === 'SKILL.md')
        if (!skillFile || skillFile.size > 512 * 1024) return null
        try {
          const content = await rawFile(fetchImpl, { owner, repo, commit }, dir ? `${dir}/SKILL.md` : 'SKILL.md', skillFile, timeoutMs)
          meta = parseSkillFrontmatter(new TextDecoder().decode(content))
          frontmatterCache.set(skillSha, meta)
        } catch {
          return null
        }
      }
      const fallback = dir.split('/').at(-1) || repo
      return { dir, name: meta.name || fallback, description: meta.description ?? '', files }
    }))
    skills.push(...batch.filter((skill): skill is RepoSkill => skill !== null))
  }
  const index = { owner, repo, commit, skills }
  indexCache.set(key, { index, at: Date.now() })
  return index
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function githubSkillCandidate(index: RepoIndex, skill: RepoSkill, discoveredAt: string): CapabilityCandidate {
  const { owner, repo, commit } = index
  const total = skill.files.reduce((sum, file) => sum + file.size, 0)
  const scripts = skill.files.filter((file) => SCRIPT_EXT.test(file.path))
  const exts = [...new Set(scripts.map((file) => file.path.slice(file.path.lastIndexOf('.'))))].join(' ')
  const oversized = skill.files.length > GITHUB_SKILL_LIMITS.files ||
    total > GITHUB_SKILL_LIMITS.totalBytes ||
    skill.files.some((file) => file.size > GITHUB_SKILL_LIMITS.fileBytes)
  const location = skill.dir || '.'
  return {
    candidateId: `github:${owner}/${repo}/${location}@${commit.slice(0, 12)}`,
    kind: 'skill',
    title: skill.name,
    summary: skill.description || '（SKILL.md 没有描述）',
    discoveredAt,
    sourceUrls: [`https://github.com/${owner}/${repo}/tree/${commit}/${encodePath(skill.dir)}`.replace(/\/$/, '')],
    publisher: owner,
    repository: `https://github.com/${owner}/${repo}`,
    commit,
    requirements: [
      `固定到提交 ${commit.slice(0, 12)}：${skill.files.length} 个文件，共 ${formatBytes(total)}；接入时逐文件核对 Git 哈希`,
      ...(scripts.length > 0 ? [`含 ${scripts.length} 个脚本（${exts}），按技能做事时模型可能运行它们`] : []),
      ...(oversized ? ['超过单个技能的接入上限（200 个文件 / 16 MB）'] : [])
    ],
    auth: 'none',
    installKind: oversized ? 'unknown' : 'skill-files',
    verification: 'source-checked',
    githubSkill: { owner, repo, commit, dir: skill.dir, files: skill.files }
  }
}

export async function searchGithubSkills(input: {
  query: string
  repos?: string[]
  listAll?: boolean
  fetchImpl?: FetchLike
  timeoutMs?: number
  discoveredAt: string
}): Promise<{ candidates: CapabilityCandidate[]; pages: number; errors: string[] }> {
  const fetchImpl = input.fetchImpl ?? fetch
  const timeoutMs = input.timeoutMs ?? 12_000
  const words = input.query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 2)
  const candidates: CapabilityCandidate[] = []
  const errors: string[] = []
  let pages = 0
  for (const name of input.repos ?? configuredSkillRepos()) {
    const parsed = parseSkillRepo(name)
    if (!parsed) {
      errors.push(`${name}：不是 owner/repo`)
      continue
    }
    try {
      const index = await loadRepoIndex(parsed.owner, parsed.repo, fetchImpl, timeoutMs)
      pages++
      for (const skill of index.skills) {
        const haystack = `${skill.name} ${skill.dir} ${skill.description}`.toLowerCase()
        if (input.listAll || words.some((word) => haystack.includes(word))) {
          candidates.push(githubSkillCandidate(index, skill, input.discoveredAt))
        }
      }
    } catch (error) {
      errors.push(`${parsed.owner}/${parsed.repo}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (pages === 0 && errors.length > 0) throw new GithubSkillError('unavailable', errors.join('；'))
  return { candidates, pages, errors }
}

export async function fetchGithubSkillFiles(
  source: NonNullable<CapabilityCandidate['githubSkill']>,
  options: { fetchImpl?: FetchLike; timeoutMs?: number } = {}
): Promise<Array<{ path: string; content: Uint8Array }>> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 20_000
  if (!/^[a-f0-9]{40}$/.test(source.commit)) throw new GithubSkillError('commit', '候选没有固定提交')
  if (!source.files.some((file) => file.path === 'SKILL.md')) throw new GithubSkillError('no-skill', '候选目录里没有 SKILL.md')
  if (source.files.length > GITHUB_SKILL_LIMITS.files) throw new GithubSkillError('too-many', `文件超过 ${GITHUB_SKILL_LIMITS.files} 个`)
  const total = source.files.reduce((sum, file) => sum + file.size, 0)
  if (total > GITHUB_SKILL_LIMITS.totalBytes) throw new GithubSkillError('too-large', `技能总大小超过 ${formatBytes(GITHUB_SKILL_LIMITS.totalBytes)}`)
  const out: Array<{ path: string; content: Uint8Array }> = []
  for (let start = 0; start < source.files.length; start += 6) {
    const batch = await Promise.all(source.files.slice(start, start + 6).map(async (file) => {
      if (file.size > GITHUB_SKILL_LIMITS.fileBytes) throw new GithubSkillError('too-large', `文件过大：${file.path}`)
      const repoPath = source.dir ? `${source.dir}/${file.path}` : file.path
      return { path: file.path, content: await rawFile(fetchImpl, source, repoPath, file, timeoutMs) }
    }))
    out.push(...batch)
  }
  return out
}
