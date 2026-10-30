import { shell } from 'electron'
import type { IpcRegistrar } from './registrar'
import type { AuthorizeReadCwd } from '../git-inspect'
import { ghPrDetail, ghPrDiff, ghPrList, readGithubStatus } from '../github/gh'
import { githubPrBackend } from '../github/actions'
import { prFailure } from '../github/command'
import type { GhPrActionRequest, GhPrActionResult, GhPrCandidatesRequest, GhPrCandidatesResult, GhPrDetailResult, GhPrDiffResult, GhPrListOptions, GhPrListResult, GhPrListState, GithubStatus } from '../../shared/github'

export interface GithubIpcDeps {
  authorizeReadCwd: AuthorizeReadCwd
}

const MAX_URL_LENGTH = 2048

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(parsed) ? parsed : 0
}

function externalUrl(raw: string): string | null {
  const text = raw.trim()
  if (!text || text.length > MAX_URL_LENGTH) return null
  try {
    const url = new URL(text)
    return url.protocol === 'https:' && url.hostname ? url.toString() : null
  } catch {
    return null
  }
}

export function registerGithubIpc(ipc: IpcRegistrar, deps: GithubIpcDeps): void {
  const { handle } = ipc
  const { authorizeReadCwd } = deps

  handle('yan:github:status', async (cwd: string): Promise<GithubStatus> => {
    try {
      const auth = await authorizeReadCwd(String(cwd ?? ''))
      if (!auth.ok) return { installed: false, authed: false, repo: null, error: auth.error }
      return await readGithubStatus(auth.cwd)
    } catch (error) {
      return { installed: false, authed: false, repo: null, error: message(error) }
    }
  })

  handle('yan:github:list', async (cwd: string, state?: unknown): Promise<GhPrListResult> => {
    const wanted = (state ?? 'open') as GhPrListState | GhPrListOptions
    try {
      const auth = await authorizeReadCwd(String(cwd ?? ''))
      if (!auth.ok) return { ok: false, items: [], error: auth.error, failure: prFailure('cwd-rejected', '此项目目录未获授权') }
      return await ghPrList(auth.cwd, wanted)
    } catch {
      const failure = prFailure('other', '获取 PR 列表失败')
      return { ok: false, items: [], error: failure.message, failure }
    }
  })

  handle('yan:github:action', async (cwd: string, request: GhPrActionRequest): Promise<GhPrActionResult> => {
    try {
      const auth = await authorizeReadCwd(String(cwd ?? ''))
      if (!auth.ok) return { ok: false, failure: prFailure('cwd-rejected', '此项目目录未获授权') }
      return await githubPrBackend.action(auth.cwd, request)
    } catch {
      return { ok: false, failure: prFailure('other', 'PR 操作未得到确认，请刷新确认', false) }
    }
  })

  handle('yan:github:candidates', async (cwd: string, request: GhPrCandidatesRequest): Promise<GhPrCandidatesResult> => {
    try {
      const auth = await authorizeReadCwd(String(cwd ?? ''))
      if (!auth.ok) return { ok: false, failure: prFailure('cwd-rejected', '此项目目录未获授权') }
      return await githubPrBackend.candidates(auth.cwd, request)
    } catch {
      return { ok: false, failure: prFailure('other', '获取 PR 候选列表失败') }
    }
  })

  handle('yan:github:detail', async (cwd: string, number?: unknown): Promise<GhPrDetailResult> => {
    try {
      const auth = await authorizeReadCwd(String(cwd ?? ''))
      if (!auth.ok) return { ok: false, pr: null, error: auth.error }
      return await ghPrDetail(auth.cwd, readNumber(number))
    } catch (error) {
      return { ok: false, pr: null, error: message(error) }
    }
  })

  handle('yan:github:diff', async (cwd: string, number?: unknown): Promise<GhPrDiffResult> => {
    try {
      const auth = await authorizeReadCwd(String(cwd ?? ''))
      if (!auth.ok) return { ok: false, patch: '', truncated: false, bytes: 0, error: auth.error }
      return await ghPrDiff(auth.cwd, readNumber(number))
    } catch (error) {
      return { ok: false, patch: '', truncated: false, bytes: 0, error: message(error) }
    }
  })

  handle('yan:github:openUrl', async (url: unknown): Promise<{ ok: boolean; error?: string }> => {
    const safe = externalUrl(String(url ?? ''))
    if (!safe) return { ok: false, error: '只支持用系统浏览器打开 https 链接' }
    try {
      await shell.openExternal(safe)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: message(error) }
    }
  })
}
