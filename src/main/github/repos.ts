import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { classifyGhFailure, prFailure, runGh, type GhRun, type GhRunner } from './command'
import { sanitizeWorkFolderName } from '../work-folder'
import type {
  GhPrFailure,
  GhPrListItemJson,
  GithubAccountStatus,
  GithubBranchListResult,
  GithubCloneProgress,
  GithubCloneRequest,
  GithubCloneResult,
  GithubRepoListRequest,
  GithubRepoListResult,
  GithubRepoSummary
} from '../../shared/github'

export const REPO_LIST_FIELDS = 'nameWithOwner,description,isPrivate,isFork,updatedAt,defaultBranchRef,url'
export const CLONE_TIMEOUT_MS = 15 * 60_000
const REPO_LIMIT_DEFAULT = 100
const REPO_LIMIT_MAX = 300
const ORG_LIMIT = 8
const REPO_PATTERN = /^[A-Za-z0-9][\w.-]{0,99}\/[\w.-]{1,100}$/
const OWNER_PATTERN = /^[A-Za-z0-9][\w-]{0,99}$/

export function defaultCloneDir(): string {
  return join(homedir(), 'Inkstone', 'projects')
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function str(value: unknown, limit = 2000): string {
  return typeof value === 'string' ? value.replaceAll('\0', '').slice(0, limit) : ''
}

export function parseRepoItems(stdout: string): GithubRepoSummary[] | null {
  const parsed = parseJson<unknown>(stdout)
  if (!Array.isArray(parsed)) return null
  const items: GithubRepoSummary[] = []
  for (const raw of parsed) {
    if (!record(raw)) continue
    const nameWithOwner = str(raw.nameWithOwner, 200)
    if (!REPO_PATTERN.test(nameWithOwner)) continue
    const [owner, name] = nameWithOwner.split('/')
    const branch = record(raw.defaultBranchRef) ? str(raw.defaultBranchRef.name, 200) : ''
    items.push({
      nameWithOwner,
      owner,
      name,
      description: str(raw.description, 300),
      isPrivate: raw.isPrivate === true,
      isFork: raw.isFork === true,
      updatedAt: str(raw.updatedAt, 40),
      defaultBranch: branch,
      url: str(raw.url, 500)
    })
  }
  return items
}

export function filterRepos(items: GithubRepoSummary[], query: string): GithubRepoSummary[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return items
  return items.filter((item) => `${item.nameWithOwner} ${item.description}`.toLowerCase().includes(needle))
}

function failureResult(run: GhRun): { error: string; failure: GhPrFailure } {
  const failure = classifyGhFailure(run)
  return { error: failure.message, failure }
}

export async function readGithubAccount(run: GhRunner = runGh, cwd = homedir()): Promise<GithubAccountStatus> {
  const version = await run(cwd, ['--version'])
  if (!version.ok) {
    if (version.missing) return { installed: false, authed: false }
    return { installed: true, authed: false, error: classifyGhFailure(version).message }
  }
  const viewer = await run(cwd, ['api', 'user'])
  if (!viewer.ok) {
    const failure = classifyGhFailure(viewer)
    return { installed: true, authed: false, ...(failure.code === 'not-authenticated' ? {} : { error: failure.message }) }
  }
  const login = str((parseJson<Record<string, unknown>>(viewer.stdout) ?? {}).login, 80)
  return { installed: true, authed: true, ...(login ? { login } : {}) }
}

export async function listGithubRepos(request: GithubRepoListRequest, run: GhRunner = runGh, cwd = homedir()): Promise<GithubRepoListResult> {
  const limit = Number.isInteger(request?.limit) ? Math.min(Math.max(Number(request.limit), 1), REPO_LIMIT_MAX) : REPO_LIMIT_DEFAULT
  const query = typeof request?.query === 'string' ? request.query.slice(0, 200) : ''
  if (request?.owner !== undefined && (typeof request.owner !== 'string' || !OWNER_PATTERN.test(request.owner))) {
    return { ok: false, items: [], owners: [], error: '账号或组织名不合法', failure: prFailure('invalid-input', '账号或组织名不合法') }
  }
  const viewer = await run(cwd, ['api', 'user'])
  if (!viewer.ok) return { ok: false, items: [], owners: [], ...failureResult(viewer) }
  const login = str((parseJson<Record<string, unknown>>(viewer.stdout) ?? {}).login, 80)
  const orgRun = await run(cwd, ['api', 'user/orgs?per_page=50'])
  const orgs = orgRun.ok ? (parseJson<unknown[]>(orgRun.stdout) ?? []).filter(record).map((org) => str(org.login, 80)).filter((name) => OWNER_PATTERN.test(name)).slice(0, ORG_LIMIT) : []
  const owners = [...(login ? [login] : []), ...orgs]
  const targets = request.owner ? [request.owner] : owners
  const runs = await Promise.all(targets.map((owner) => run(cwd, ['repo', 'list', owner, '--limit', String(limit + 1), '--json', REPO_LIST_FIELDS])))
  const first = runs.find((item) => !item.ok)
  if (first && runs.every((item) => !item.ok)) return { ok: false, items: [], owners, ...failureResult(first) }
  let hasMore = false
  const merged: GithubRepoSummary[] = []
  for (const item of runs) {
    if (!item.ok) continue
    const parsed = parseRepoItems(item.stdout)
    if (!parsed) return { ok: false, items: [], owners, error: 'gh 返回的仓库列表无法解析', failure: prFailure('other', 'gh 返回的仓库列表无法解析') }
    if (parsed.length > limit) hasMore = true
    merged.push(...parsed.slice(0, limit))
  }
  merged.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  let items = filterRepos(merged, query)
  if (query && !items.length && REPO_PATTERN.test(query.trim())) {
    const direct = await run(cwd, ['repo', 'view', query.trim(), '--json', REPO_LIST_FIELDS])
    const parsed = direct.ok ? parseRepoItems(`[${direct.stdout}]`) : null
    if (parsed?.length) items = parsed
  }
  return { ok: true, items: items.slice(0, limit), owners, hasMore }
}

export const SEARCH_FIELDS = 'fullName,description,isPrivate,isFork,updatedAt,url,stargazersCount,defaultBranch'
export const SEARCH_LIMIT = 30
export const SEARCH_MIN_LENGTH = 2

export function parseSearchItems(stdout: string): GithubRepoSummary[] | null {
  const parsed = parseJson<unknown>(stdout)
  if (!Array.isArray(parsed)) return null
  const items: GithubRepoSummary[] = []
  for (const raw of parsed) {
    if (!record(raw)) continue
    const nameWithOwner = str(raw.fullName, 200)
    if (!REPO_PATTERN.test(nameWithOwner)) continue
    const [owner, name] = nameWithOwner.split('/')
    items.push({
      nameWithOwner,
      owner,
      name,
      description: str(raw.description, 300),
      isPrivate: raw.isPrivate === true,
      isFork: raw.isFork === true,
      updatedAt: str(raw.updatedAt, 40),
      defaultBranch: str(raw.defaultBranch, 200),
      url: str(raw.url, 500),
      stars: Number.isInteger(raw.stargazersCount) && Number(raw.stargazersCount) >= 0 ? Number(raw.stargazersCount) : 0
    })
    if (items.length >= SEARCH_LIMIT) break
  }
  return items
}

export async function searchGithubRepos(query: unknown, run: GhRunner = runGh, cwd = homedir()): Promise<GithubRepoListResult> {
  const text = typeof query === 'string' ? query.trim() : ''
  if (text.length < SEARCH_MIN_LENGTH || text.length > 200 || /[\0\r\n]/.test(text)) {
    return { ok: false, items: [], owners: [], error: '搜索关键字不合法', failure: prFailure('invalid-input', '搜索关键字不合法') }
  }
  const res = await run(cwd, ['search', 'repos', '--limit', String(SEARCH_LIMIT), '--json', SEARCH_FIELDS, '--', text])
  if (!res.ok) return { ok: false, items: [], owners: [], ...failureResult(res) }
  const items = parseSearchItems(res.stdout)
  if (!items) return { ok: false, items: [], owners: [], error: 'gh 返回的搜索结果无法解析', failure: prFailure('other', 'gh 返回的搜索结果无法解析') }
  return { ok: true, items, owners: [] }
}

export function validateCloneUrl(raw: unknown): { ok: true; url: string; name: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: '请输入仓库地址' }
  const text = raw.trim()
  if (!text || text.length > 2048) return { ok: false, error: '请输入仓库地址' }
  if (text.startsWith('-') || /[\s\0\\]/.test(text)) return { ok: false, error: '仓库地址不合法' }
  let name = ''
  const scp = /^git@([A-Za-z0-9.-]+):([\w.-]+(?:\/[\w.-]+)+?)(?:\.git)?\/?$/.exec(text)
  if (scp) {
    name = scp[2].split('/').pop() ?? ''
  } else {
    let url: URL
    try {
      url = new URL(text)
    } catch {
      return { ok: false, error: '只支持 https、ssh 或 git@ 地址' }
    }
    if (!['https:', 'ssh:', 'git:'].includes(url.protocol) || !url.hostname || url.password || url.search || url.hash) {
      return { ok: false, error: '只支持 https、ssh 或 git@ 地址' }
    }
    if (url.protocol === 'https:' && url.username) return { ok: false, error: '地址里不要带用户名或令牌' }
    const segments = url.pathname.replace(/\.git\/?$/, '').split('/').filter(Boolean)
    if (segments.length < 2 || segments.some((part) => !/^[\w.@~-]+$/.test(part) || part === '.' || part === '..')) return { ok: false, error: '仓库地址不合法' }
    name = segments[segments.length - 1]
  }
  name = sanitizeWorkFolderName(name.replace(/.git$/, ''))
  if (!name) return { ok: false, error: '无法从地址得到仓库名' }
  return { ok: true, url: text, name }
}

export async function resolveCloneTarget(parentDir: string, folderName: string): Promise<{ ok: true; target: string; created: boolean } | { ok: false; error: string }> {
  const folder = sanitizeWorkFolderName(folderName)
  if (!folder || folder !== folderName.trim()) return { ok: false, error: '文件夹名不合法' }
  if (typeof parentDir !== 'string' || !parentDir.trim() || parentDir.includes('\0') || !isAbsolute(parentDir.trim())) return { ok: false, error: '请选择有效的克隆目录' }
  const parent = resolve(parentDir.trim())
  const target = resolve(parent, folder)
  const rel = relative(parent, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes('/') || rel.includes('\\')) return { ok: false, error: '目标路径不安全' }
  if (existsSync(target)) {
    const info = await stat(target).catch(() => null)
    if (!info?.isDirectory()) return { ok: false, error: '目标位置已有同名文件' }
    if ((await readdir(target)).length) return { ok: false, error: '目标文件夹已存在且不为空' }
    return { ok: true, target, created: false }
  }
  return { ok: true, target, created: true }
}

export function parseCloneProgress(chunk: string, id: string): GithubCloneProgress | null {
  const lines = chunk.split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    const percent = /(\d{1,3})%/.exec(line)
    const value = percent ? Math.min(100, Number(percent[1])) : undefined
    if (/^(?:remote: )?(?:Receiving|Counting|Compressing|Enumerating) objects/i.test(line)) return { id, phase: 'receiving', ...(value === undefined ? {} : { percent: value }) }
    if (/^Resolving deltas/i.test(line)) return { id, phase: 'resolving', ...(value === undefined ? {} : { percent: value }) }
    if (/^Updating files/i.test(line)) return { id, phase: 'checkout', ...(value === undefined ? {} : { percent: value }) }
  }
  return null
}

export function classifyCloneFailure(stderr: string, timedOut: boolean, missing: boolean): GhPrFailure {
  if (missing) return prFailure('gh-missing', '未找到 git 或 GitHub CLI', true, '请安装后再克隆')
  if (timedOut) return prFailure('timeout', '克隆超时', true, '网络较慢时可重试，或换到终端克隆')
  const text = stderr.toLowerCase()
  if (/gh auth login|not logged|authentication failed|could not read username|permission denied \(publickey\)|http 401/.test(text)) return prFailure('not-authenticated', '没有克隆这个仓库的凭据', true, 'GitHub 仓库请在终端运行 gh auth login，其他地址请先配置 git 凭据或 ssh 密钥')
  if (/repository not found|could not resolve to a repository|http 404|not found/.test(text)) return prFailure('pr-not-found', '仓库不存在或当前账号不可见', true, '请核对地址与权限')
  if (/http 403|forbidden|permission/.test(text)) return prFailure('forbidden', '没有访问这个仓库的权限', true, '请核对仓库权限与组织策略')
  if (/could not resolve host|unable to access|timed out|connection (?:reset|refused)|tls/.test(text)) return prFailure('timeout', '网络连接失败', true, '请检查网络或代理后重试')
  return prFailure('other', '克隆失败', true, text.trim().split(/\r?\n/).pop()?.slice(0, 200) || '请在终端核对 git 输出')
}

type Spawn = (command: string, args: string[], options: Parameters<typeof nodeSpawn>[2]) => ChildProcess

export interface CloneDeps {
  spawn?: Spawn
  defaultDir: () => Promise<string> | string
  onProgress?: (progress: GithubCloneProgress) => void
  addProject: (cwd: string) => Promise<{ projectId?: string }>
  trusted: (cwd: string) => Promise<boolean>
  timeoutMs?: number
}

const active = new Map<string, { child: ChildProcess; cancelled: boolean }>()

export function cancelClone(id: string): boolean {
  const entry = active.get(id)
  if (!entry) return false
  entry.cancelled = true
  entry.child.kill()
  return true
}

export function cloneArguments(request: GithubCloneRequest, target: string): { command: string; args: string[]; name: string } | { error: string } {
  const source = request.source
  if (source?.kind === 'github') {
    if (typeof source.nameWithOwner !== 'string' || !REPO_PATTERN.test(source.nameWithOwner)) return { error: '仓库名不合法' }
    return { command: 'gh', args: ['repo', 'clone', source.nameWithOwner, target, '--', '--progress'], name: source.nameWithOwner.split('/')[1] }
  }
  if (source?.kind === 'url') {
    const checked = validateCloneUrl(source.url)
    if (!checked.ok) return { error: checked.error }
    return { command: 'git', args: ['clone', '--progress', '--', checked.url, target], name: checked.name }
  }
  return { error: '克隆来源不合法' }
}

export async function cloneRepository(request: GithubCloneRequest, deps: CloneDeps): Promise<GithubCloneResult> {
  const fail = (error: string, failure?: GhPrFailure): GithubCloneResult => ({ ok: false, error, ...(failure ? { failure } : {}) })
  if (!record(request) || typeof request.id !== 'string' || !request.id || request.id.length > 80) return fail('克隆请求不合法')
  if (active.has(request.id)) return fail('这个克隆已在进行')
  const preview = cloneArguments(request, 'target')
  if ('error' in preview) return fail(preview.error)
  const parent = typeof request.parentDir === 'string' && request.parentDir.trim() ? request.parentDir : await deps.defaultDir()
  const folder = typeof request.folderName === 'string' && request.folderName.trim() ? request.folderName.trim() : preview.name
  const resolved = await resolveCloneTarget(parent, folder)
  if (!resolved.ok) return fail(resolved.error)
  const built = cloneArguments(request, resolved.target)
  if ('error' in built) return fail(built.error)
  try {
    await mkdir(resolve(parent), { recursive: true })
  } catch (cause) {
    return fail(cause instanceof Error ? cause.message : String(cause))
  }
  deps.onProgress?.({ id: request.id, phase: 'starting' })
  const spawnFn = deps.spawn ?? (nodeSpawn as Spawn)
  const outcome = await new Promise<{ code: number | null; stderr: string; missing: boolean; timedOut: boolean; cancelled: boolean }>((done) => {
    let stderr = ''
    let missing = false
    let timedOut = false
    const child = spawnFn(built.command, built.args, {
      cwd: resolve(parent),
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GIT_ASKPASS: '', GCM_INTERACTIVE: 'never' }
    })
    const entry = { child, cancelled: false }
    active.set(request.id, entry)
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, deps.timeoutMs ?? CLONE_TIMEOUT_MS)
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000)
      const progress = parseCloneProgress(chunk, request.id)
      if (progress) deps.onProgress?.(progress)
    })
    child.on('error', (error) => {
      missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      stderr += String(error.message)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      active.delete(request.id)
      done({ code, stderr, missing, timedOut, cancelled: entry.cancelled })
    })
  })
  if (outcome.cancelled || outcome.code !== 0) {
    if (resolved.created) await rm(resolved.target, { recursive: true, force: true }).catch(() => undefined)
    if (outcome.cancelled) return { ok: false, cancelled: true, error: '已取消克隆' }
    const failure = classifyCloneFailure(outcome.stderr, outcome.timedOut, outcome.missing)
    return fail(failure.message, failure)
  }
  deps.onProgress?.({ id: request.id, phase: 'done', percent: 100 })
  const added = await deps.addProject(resolved.target)
  return { ok: true, cwd: resolved.target, projectId: added.projectId, trusted: await deps.trusted(resolved.target) }
}

export async function ghBranchesAndPulls(cwd: string, run: GhRunner = runGh): Promise<GithubBranchListResult> {
  const [branches, pulls, repo] = await Promise.all([
    run(cwd, ['api', 'repos/{owner}/{repo}/branches?per_page=100']),
    run(cwd, ['pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,author,state,isDraft,headRefName,baseRefName,updatedAt,url']),
    run(cwd, ['repo', 'view', '--json', 'nameWithOwner'])
  ])
  if (!branches.ok) return { ok: false, branches: [], pulls: [], ...failureResult(branches) }
  const list = parseJson<unknown[]>(branches.stdout)
  if (!Array.isArray(list)) return { ok: false, branches: [], pulls: [], error: 'gh 返回的分支列表无法解析', failure: prFailure('other', 'gh 返回的分支列表无法解析') }
  const pullItems = pulls.ok ? parseJson<GhPrListItemJson[]>(pulls.stdout) : null
  const repoName = repo.ok ? str((parseJson<Record<string, unknown>>(repo.stdout) ?? {}).nameWithOwner, 200) : ''
  return {
    ok: true,
    ...(repoName ? { repo: repoName } : {}),
    branches: list.filter(record).map((item) => ({
      name: str(item.name, 250),
      oid: record(item.commit) ? str(item.commit.sha, 64) : '',
      protected: item.protected === true
    })).filter((item) => item.name && /^[0-9a-f]{40,64}$/.test(item.oid)),
    pulls: Array.isArray(pullItems) ? pullItems : []
  }
}

export async function createLocalProject(
  name: unknown,
  parentDir: string,
  deps: { gitInit?: (dir: string) => Promise<void>; addProject: (cwd: string) => Promise<{ projectId?: string }> }
): Promise<{ ok: boolean; cwd?: string; projectId?: string; error?: string }> {
  const folder = sanitizeWorkFolderName(name)
  if (!folder) return { ok: false, error: '项目名称不合法' }
  const resolved = await resolveCloneTarget(parentDir, folder)
  if (!resolved.ok) return { ok: false, error: resolved.error }
  try {
    await mkdir(resolved.target, { recursive: true })
    await (deps.gitInit ?? defaultGitInit)(resolved.target)
  } catch (cause) {
    if (resolved.created) await rm(resolved.target, { recursive: true, force: true }).catch(() => undefined)
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
  const added = await deps.addProject(resolved.target)
  return { ok: true, cwd: resolved.target, projectId: added.projectId }
}

function defaultGitInit(dir: string): Promise<void> {
  return new Promise((done, reject) => {
    const child = nodeSpawn('git', ['init'], { cwd: dir, windowsHide: true, stdio: 'ignore' })
    child.on('error', (error) => reject((error as NodeJS.ErrnoException).code === 'ENOENT' ? new Error('未找到 git') : error))
    child.on('close', (code) => (code === 0 ? done() : reject(new Error('git init 失败'))))
  })
}
