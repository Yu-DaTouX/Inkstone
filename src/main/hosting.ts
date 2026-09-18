/**
 * 托管平台的 PR 状态（方案 §7 的 G3）。
 *
 * ── 为什么是 REST API 而不是 GitHub CLI ──
 * 方案原文是「可先采用 GitHub CLI 结构化输出……**后续再评估直接 API**」。
 * 实测本机没有 `gh`（且用户不一定装、更不一定登录过），而 Yan 已经有
 * 内置浏览器与外发请求的能力 —— 直接调 API 少一层外部依赖。没有 token 时
 * GitHub 允许匿名读**公开**仓库（60 次/小时），私有仓库会返回 404/403，
 * 那时如实显示「需要认证」而不是编一个状态。
 *
 * ── 关联依据是 head/base 的实际信息（方案 §7 的硬要求）──
 * 「不能仅按同名分支猜测」：查询用 `head={远端 owner}:{分支}` —— 带上 owner
 * 才能正确处理 fork；返回的 PR 里也带 `head.sha` / `base.ref`，Yan 把它和
 * **本地** head 比一次，本地有未推送的提交时明说（那正是用户此刻最想知道的）。
 *
 * ── 只读 ──
 * 这里没有任何写操作：**不创建、不合并、不评论**。方案 §7 明确「创建 PR 是单独
 * 后续动作，不与读取状态混合；本阶段不自动合并 PR」。
 */
import { remoteWebUrl } from '../shared/git'
import { gitRun, resolveRepo } from './git-service'

export type PrState = 'none' | 'draft' | 'open' | 'merged' | 'closed'
export type ChecksState = 'none' | 'pending' | 'success' | 'failure'
export type PrErrorCode = 'unsupported' | 'auth' | 'rate-limit' | 'network' | 'not-found' | 'unknown'

export interface PrStatus {
  ok: boolean
  /** 查询中 —— 界面用（主进程这里总是同步返回，所以不会出现，保留给渲染端） */
  state: PrState
  checks: ChecksState
  /** 人类可读的标题（有 PR 时） */
  title?: string
  number?: number
  url?: string
  /** PR 的目标分支（base） */
  base?: string
  /** 「本地有未推送的提交」：PR 的 head.sha 与本地 head 不一致时置位 */
  localAhead?: boolean
  /** 托管站与应用名（github 等） */
  host?: string
  owner?: string
  repo?: string
  /** 失败时的分类与原始信息 */
  error?: PrErrorCode
  message?: string
}

/** 从 remote 的网页地址解析出 owner/repo（`https://github.com/o/r` → o/r） */
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

/** GitHub 的 PR JSON → 我们的状态（纯函数，能单测） */
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

/** check-runs 的 JSON → 我们的三态（纯函数） */
export function mapChecks(runs: { status?: string; conclusion?: string | null }[] | null | undefined): ChecksState {
  const list = Array.isArray(runs) ? runs : []
  if (list.length === 0) return 'none'
  if (list.some((r) => r.status === 'in_progress' || r.status === 'queued' || r.status === 'requested')) return 'pending'
  if (list.some((r) => r.conclusion && !['success', 'neutral', 'skipped'].includes(r.conclusion))) return 'failure'
  if (list.every((r) => r.conclusion === 'success' || r.conclusion === 'neutral' || r.conclusion === 'skipped')) return 'success'
  return 'pending'
}

/** HTTP 状态码 → 分类（纯函数） */
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

/**
 * 查当前目录所在仓库的 PR 状态（只读）。
 *
 * `token` 由调用方注入（环境变量 `GITHUB_TOKEN` / `GH_TOKEN`，或用户在设置里填的）。
 * 没有 token 也能查公开仓库。
 */
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
    /* 方案第一阶段只做 GitHub；其余平台如实说「本阶段不支持」，不显示假状态 */
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

  /*
   * `head={owner}:{branch}` —— **带上 owner** 才能正确处理 fork
   *（方案 §7：「不能仅按同名分支猜测」，处理多个 remote 和 fork）。
   * `state=all` 是为了能看到已合并/已关闭的 PR（那是最常见的"为什么没有 PR"）。
   */
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

  /* checks 用 PR 的 head.sha 查（那是 GitHub 真正跑 CI 的那个提交） */
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
