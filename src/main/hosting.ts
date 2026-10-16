import { remoteWebUrl } from '../shared/git'
import { gitRun, resolveRepo } from './git-service'

export type PrState = 'none' | 'draft' | 'open' | 'merged' | 'closed'
export type ChecksState = 'none' | 'pending' | 'success' | 'failure'
export type PrErrorCode = 'unsupported' | 'auth' | 'rate-limit' | 'network' | 'not-found' | 'unknown'

export interface PrStatus {
  ok: boolean
  state: PrState
  checks: ChecksState
  title?: string
  number?: number
  url?: string
  base?: string
  localAhead?: boolean
  host?: string
  owner?: string
  repo?: string
  error?: PrErrorCode
  message?: string
}

export function splitRepo(webUrl: string | null): { host: string; owner: string; repo: string } | null {
  const raw = String(webUrl ?? '').trim()
  if (!raw) return null
  try {
    const u = new URL(raw)
    const parts = u.pathname.replace(/^\/+/, '').split('/').filter(Boolean)
    if (parts.length < 2) return null
    return { host: u.host, owner: parts[0], repo: parts[1].replace(/\.git$/, '') }
  } catch {
    return null
  }
}

export function mapPull(
  pull: { state?: string; draft?: boolean; merged_at?: string | null; title?: string; number?: number; html_url?: string; head?: { sha?: string; ref?: string }; base?: { ref?: string } } | null
): { state: PrState; title?: string; number?: number; url?: string; base?: string; headSha?: string } {
  if (!pull) return { state: 'none' }
  const base = { title: pull.title, number: pull.number, url: pull.html_url, base: pull.base?.ref, headSha: pull.head?.sha }
  if (pull.merged_at) return { state: 'merged', ...base }
  if (pull.state === 'closed') return { state: 'closed', ...base }
  if (pull.draft) return { state: 'draft', ...base }
  if (pull.state === 'open') return { state: 'open', ...base }
  return { state: 'none', ...base }
}

export function mapChecks(runs: { status?: string; conclusion?: string | null }[] | null | undefined): ChecksState {
  const list = Array.isArray(runs) ? runs : []
  if (list.length === 0) return 'none'
  if (list.some((r) => r.status === 'in_progress' || r.status === 'queued' || r.status === 'requested')) return 'pending'
  if (list.some((r) => r.conclusion && !['success', 'neutral', 'skipped'].includes(r.conclusion))) return 'failure'
  if (list.every((r) => r.conclusion === 'success' || r.conclusion === 'neutral' || r.conclusion === 'skipped')) return 'success'
  return 'pending'
}

export function classifyHttp(status: number, rateLimited: boolean): PrErrorCode {
  if (status === 401) return 'auth'
  if (status === 403) return rateLimited ? 'rate-limit' : 'auth'
  if (status === 404) return 'not-found'
  if (status >= 500) return 'network'
  return 'unknown'
}

interface FetchResult {
  ok: boolean
  status: number
  rateLimited: boolean
  json: unknown
  error?: string
}

async function api(path: string, token: string | null): Promise<FetchResult> {
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'yan-desktop',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      signal: AbortSignal.timeout(12_000)
    })
    const rateLimited = res.headers.get('x-ratelimit-remaining') === '0'
    let json: unknown = null
    try {
      json = await res.json()
    } catch {
      json = null
    }
    return { ok: res.ok, status: res.status, rateLimited, json }
  } catch (error) {
    return { ok: false, status: 0, rateLimited: false, json: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function git(cwd: string, args: string[]): Promise<string> {
  return gitRun(cwd, args, { allowFailure: true, timeout: 8000 }).then((r) => r.stdout.trim())
}

export async function prStatus(cwd: string, token: string | null): Promise<PrStatus> {
  const repo = await resolveRepo(String(cwd ?? ''))
  if (!repo) return { ok: false, state: 'none', checks: 'none', error: 'unsupported', message: '这个目录不是 Git 仓库' }

  const remotes = (await gitRun(repo.root, ['remote'], { allowFailure: true })).stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
  if (remotes.length === 0) {
    return { ok: false, state: 'none', checks: 'none', error: 'unsupported', message: '这个仓库没有配置远端' }
  }
  const name = remotes.includes('origin') ? 'origin' : remotes[0]
  const url = (await gitRun(repo.root, ['remote', 'get-url', name], { allowFailure: true })).stdout.trim()
  const web = remoteWebUrl(url)
  const parsed = splitRepo(web)
  if (!parsed) {
    return {
      ok: false,
      state: 'none',
      checks: 'none',
      error: 'unsupported',
      message: `认不出这个远端（${name}）对应的托管站 —— 只有 GitHub / GitLab / Bitbucket 支持`
    }
  }
  if (parsed.host !== 'github.com') {
    return {
      ok: false,
      state: 'none',
      checks: 'none',
      error: 'unsupported',
      host: parsed.host,
      owner: parsed.owner,
      repo: parsed.repo,
      message: `本阶段只接了 GitHub，${parsed.host} 还没接`
    }
  }

  const branch = await git(repo.root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!branch || branch === 'HEAD') {
    return { ok: false, state: 'none', checks: 'none', error: 'unsupported', host: parsed.host, owner: parsed.owner, repo: parsed.repo, message: '现在是 detached HEAD，没有可比较的分支' }
  }
  const localSha = await git(repo.root, ['rev-parse', 'HEAD'])

  const head = `${parsed.owner}:${branch}`
  const found = await api(
    `/repos/${parsed.owner}/${parsed.repo}/pulls?head=${encodeURIComponent(head)}&state=all&sort=updated&direction=desc&per_page=5`,
    token
  )
  const base = { host: parsed.host, owner: parsed.owner, repo: parsed.repo }

  if (!found.ok) {
    return {
      ok: false,
      state: 'none',
      checks: 'none',
      ...base,
      error: classifyHttp(found.status, found.rateLimited),
      message:
        found.status === 0
          ? `连不上 api.github.com：${found.error ?? '网络错误'}`
          : `GitHub 返回 ${found.status}${token ? '' : '（没有配 token 时只能读公开仓库）'}`
    }
  }

  const list = Array.isArray(found.json) ? found.json : []
  if (list.length === 0) {
    return { ok: true, state: 'none', checks: 'none', ...base }
  }
  const mapped = mapPull(list[0] as Parameters<typeof mapPull>[0])
  const localAhead = !!mapped.headSha && !!localSha && mapped.headSha !== localSha

  let checks: ChecksState = 'none'
  if (mapped.headSha) {
    const runs = await api(`/repos/${parsed.owner}/${parsed.repo}/commits/${mapped.headSha}/check-runs`, token)
    if (runs.ok) {
      const r = runs.json as { check_runs?: { status?: string; conclusion?: string | null }[] } | null
      checks = mapChecks(r?.check_runs)
    }
  }

  return {
    ok: true,
    state: mapped.state,
    checks,
    title: mapped.title,
    number: mapped.number,
    url: mapped.url,
    base: mapped.base,
    localAhead,
    ...base
  }
}
