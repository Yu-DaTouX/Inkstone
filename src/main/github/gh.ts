import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isGhPrListState } from '../../shared/github'
import type {
  GhPrDetailJson,
  GhPrDetailResult,
  GhPrDiffResult,
  GhPrListResult,
  GhPrListState,
  GhPrListItemJson,
  GithubStatus
} from '../../shared/github'

const GH_TIMEOUT_MS = 20_000
const JSON_MAX_BUFFER = 8 * 1024 * 1024
const DIFF_LIMIT_BYTES = 4 * 1024 * 1024
const DIFF_MAX_BUFFER = DIFF_LIMIT_BYTES + 1024 * 1024
const MESSAGE_LIMIT = 400
const MAX_PR_NUMBER = 9_999_999

const LIST_FIELDS =
  'number,title,author,state,isDraft,headRefName,baseRefName,updatedAt,reviewDecision,statusCheckRollup,additions,deletions,url'
const DETAIL_FIELDS =
  'number,title,body,author,state,isDraft,headRefName,baseRefName,createdAt,updatedAt,mergedAt,closedAt,reviewDecision,statusCheckRollup,files,commits,comments,reviews,latestReviews,reviewRequests,labels,additions,deletions,changedFiles,url'

const GH_ENV = {
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  GH_PAGER: 'cat',
  NO_COLOR: '1',
  CLICOLOR: '0'
}

interface GhRun {
  ok: boolean
  stdout: string
  stderr: string
  missing: boolean
  missingCwd: boolean
  timedOut: boolean
  overflow: boolean
}

function runGh(cwd: string, args: string[], maxBuffer = JSON_MAX_BUFFER): Promise<GhRun> {
  return new Promise((resolve) => {
    execFile(
      'gh',
      args,
      { cwd, timeout: GH_TIMEOUT_MS, maxBuffer, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...GH_ENV } },
      (error, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : ''
        const err = typeof stderr === 'string' ? stderr : ''
        if (!error) {
          resolve({ ok: true, stdout: out, stderr: err, missing: false, missingCwd: false, timedOut: false, overflow: false })
          return
        }
        const code = (error as NodeJS.ErrnoException).code ?? ''
        const missing = code === 'ENOENT'
        resolve({
          ok: false,
          stdout: out,
          stderr: err || error.message,
          missing,
          missingCwd: missing && !existsSync(cwd),
          timedOut: code === 'ETIMEDOUT' || (error as { killed?: boolean }).killed === true,
          overflow: code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        })
      }
    )
  })
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

function failureText(run: GhRun): string {
  if (run.timedOut) return `gh 命令超过 ${GH_TIMEOUT_MS / 1000} 秒没有返回`
  const text = run.stderr.replace(/\s+/g, ' ').trim().slice(0, MESSAGE_LIMIT)
  return text || `gh 退出码 ${run.ok ? 0 : 1}`
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

export async function ghPrList(cwd: string, state: GhPrListState): Promise<GhPrListResult> {
  const safeState: GhPrListState = isGhPrListState(state) ? state : 'open'
  const res = await runGh(cwd, ['pr', 'list', '--state', safeState, '--limit', '50', '--json', LIST_FIELDS])
  if (!res.ok) return { ok: false, items: [], error: failureText(res) }
  const parsed = parseJson<GhPrListItemJson[]>(res.stdout)
  if (!Array.isArray(parsed)) return { ok: false, items: [], error: 'gh 返回的 PR 列表无法解析' }
  return { ok: true, items: parsed }
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
