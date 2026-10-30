import { classifyGhFailure, prFailure, runGh } from './command'
import { listArguments } from './validation'
import type {
  GhPrDetailJson,
  GhPrDetailResult,
  GhPrDiffResult,
  GhPrListResult,
  GhPrListState,
  GhPrListOptions,
  GhPrListItemJson,
  GithubStatus
} from '../../shared/github'

const DIFF_LIMIT_BYTES = 4 * 1024 * 1024
const DIFF_MAX_BUFFER = DIFF_LIMIT_BYTES + 1024 * 1024
const MAX_PR_NUMBER = 9_999_999

const LIST_FIELDS =
  'number,title,author,state,isDraft,headRefName,baseRefName,updatedAt,reviewDecision,labels,statusCheckRollup,additions,deletions,url'
export const DETAIL_FIELDS =
  'number,title,body,author,state,isDraft,headRefName,baseRefName,createdAt,updatedAt,mergedAt,closedAt,reviewDecision,statusCheckRollup,files,commits,comments,reviews,latestReviews,reviewRequests,labels,additions,deletions,changedFiles,url'

type GhRun = import('./command').GhRun

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

function failureText(run: GhRun): string {
  return classifyGhFailure(run).message
}

function isPrNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_PR_NUMBER
}

export async function readGithubStatus(cwd: string): Promise<GithubStatus> {
  const version = await runGh(cwd, ['--version'])
  if (!version.ok) {
    if (version.missingCwd) return { installed: false, authed: false, repo: null, error: `项目目录不存在：${cwd}` }
    return {
      installed: false,
      authed: false,
      repo: null,
      ...(version.missing ? {} : { error: failureText(version) })
    }
  }
  const auth = await runGh(cwd, ['auth', 'status'])
  if (!auth.ok) return { installed: true, authed: false, repo: null }
  const repo = await runGh(cwd, ['repo', 'view', '--json', 'nameWithOwner,url'])
  if (!repo.ok) return { installed: true, authed: true, repo: null, error: failureText(repo) }
  const parsed = parseJson<{ nameWithOwner?: unknown; url?: unknown }>(repo.stdout)
  const nameWithOwner = typeof parsed?.nameWithOwner === 'string' ? parsed.nameWithOwner : ''
  if (!nameWithOwner) return { installed: true, authed: true, repo: null, error: '无法识别当前项目对应的 GitHub 仓库' }
  return {
    installed: true,
    authed: true,
    repo: { nameWithOwner, url: typeof parsed?.url === 'string' ? parsed.url : '' }
  }
}

export async function ghPrList(cwd: string, options: GhPrListState | GhPrListOptions, run = runGh): Promise<GhPrListResult> {
  const built = listArguments(options)
  if (!built.ok) return { ok: false, items: [], error: built.failure.message, failure: built.failure }
  const res = await run(cwd, [...built.args, '--json', LIST_FIELDS])
  if (!res.ok) {
    const failure = classifyGhFailure(res)
    return { ok: false, items: [], error: failure.message, failure }
  }
  const parsed = parseJson<GhPrListItemJson[]>(res.stdout)
  if (!Array.isArray(parsed)) return { ok: false, items: [], error: 'gh 返回的 PR 列表无法解析', failure: prFailure('other', 'gh 返回的 PR 列表无法解析') }
  return { ok: true, items: parsed.slice(0, built.limit), limit: built.limit, hasMore: parsed.length > built.limit }
}

export async function ghPrDetail(cwd: string, number: number): Promise<GhPrDetailResult> {
  if (!isPrNumber(number)) return { ok: false, pr: null, error: 'PR 编号不合法' }
  const res = await runGh(cwd, ['pr', 'view', String(number), '--json', DETAIL_FIELDS])
  if (!res.ok) return { ok: false, pr: null, error: failureText(res) }
  const parsed = parseJson<GhPrDetailJson>(res.stdout)
  if (!parsed || typeof parsed !== 'object') return { ok: false, pr: null, error: 'gh 返回的 PR 详情无法解析' }
  return { ok: true, pr: parsed }
}

export async function ghPrDiff(cwd: string, number: number): Promise<GhPrDiffResult> {
  if (!isPrNumber(number)) return { ok: false, patch: '', truncated: false, bytes: 0, error: 'PR 编号不合法' }
  const res = await runGh(cwd, ['pr', 'diff', String(number)], DIFF_MAX_BUFFER)
  const bytes = Buffer.byteLength(res.stdout, 'utf8')
  if (!res.ok && !res.overflow) {
    return { ok: false, patch: '', truncated: false, bytes, error: failureText(res) }
  }
  let patch = res.stdout
  let truncated = res.overflow
  if (bytes > DIFF_LIMIT_BYTES) {
    const head = Buffer.from(patch, 'utf8').subarray(0, DIFF_LIMIT_BYTES).toString('utf8')
    const lineEnd = head.lastIndexOf('\n')
    patch = lineEnd > 0 ? head.slice(0, lineEnd + 1) : head
    truncated = true
  }
  if (!patch) {
    return {
      ok: false,
      patch: '',
      truncated,
      bytes,
      error: res.timedOut ? failureText(res) : '这个 PR 没有可显示的 diff'
    }
  }
  return { ok: true, patch, truncated, bytes }
}
