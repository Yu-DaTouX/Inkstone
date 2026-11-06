import { pick } from '../../shared/ui-lang'
import { isPublishBranchName } from '../../shared/collab-github'
import { validateBranchName } from '../../shared/git-actions'
import type { GhPrActionResult, GhPrFailure, GithubPeerPublishRequest } from '../../shared/github'
import { prFailure } from '../github/command'
import { checkTrackingRef } from './git'

export interface PublishDeps {
  login: () => Promise<string | null>
  resolve: (ref: string) => Promise<string | null>
  push: (trackingRef: string, branch: string, remote: string) => Promise<{ ok: boolean; error?: string }>
  createPr: (input: { title: string; body: string; base: string; head: string; draft: boolean }) => Promise<GhPrActionResult>
}

export function validatePublishRequest(raw: unknown): GhPrFailure | null {
  const invalid = (message: string): GhPrFailure => prFailure('invalid-input', message)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid(pick('发布参数不合法', 'Invalid publish parameters'))
  const value = raw as Record<string, unknown>
  if (value.confirmed !== true) return prFailure('confirmation-required', pick('推送到 GitHub 并开 PR 需要你确认', 'Pushing to GitHub and opening a PR needs your confirmation'), true, pick('确认后再执行', 'Confirm to continue'))
  if (checkTrackingRef(value.trackingRef)) return invalid(pick('只能发布从对端取回的分支', 'Only branches fetched from the peer can be published'))
  if (typeof value.branch !== 'string' || validateBranchName(value.branch)) return invalid(pick('目标分支名不合法', 'Invalid target branch name'))
  if (typeof value.base !== 'string' || validateBranchName(value.base) || value.base.startsWith('+')) return invalid(pick('基础分支不合法', 'Invalid base branch'))
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 256 || value.title.includes('\0')) return invalid(pick('PR 标题不合法', 'Invalid PR title'))
  if (typeof value.body !== 'string' || value.body.length > 65_536 || value.body.includes('\0')) return invalid(pick('PR 说明不合法', 'Invalid PR description'))
  if (value.remote !== undefined && (typeof value.remote !== 'string' || !/^[a-z\d][a-z\d._-]{0,99}$/i.test(value.remote))) return invalid(pick('远程名不合法', 'Invalid remote name'))
  return null
}

export async function publishPeerBranch(raw: unknown, deps: PublishDeps): Promise<GhPrActionResult> {
  const invalid = validatePublishRequest(raw)
  if (invalid) return { ok: false, failure: invalid }
  const request = raw as GithubPeerPublishRequest
  const login = await deps.login()
  if (!login) return { ok: false, failure: prFailure('not-authenticated', pick('需要先登录 GitHub CLI', 'Sign in to GitHub CLI first'), true, pick('请在终端运行 gh auth login', 'Run gh auth login in a terminal')) }
  if (!isPublishBranchName(request.branch, login)) return { ok: false, failure: prFailure('invalid-input', pick(`目标分支需要写成 ${login.toLowerCase()}/<主题>`, `Target branch must be named ${login.toLowerCase()}/<topic>`)) }
  if (!(await deps.resolve(request.trackingRef))) return { ok: false, failure: prFailure('invalid-input', pick('这个对端分支还没有取回到本机，请先取回', 'This peer branch has not been fetched yet. Fetch it first')) }
  const pushed = await deps.push(request.trackingRef, request.branch, request.remote ?? 'origin')
  if (!pushed.ok) return { ok: false, failure: prFailure('git-failed', pushed.error || pick('推送到 GitHub 失败', 'Push to GitHub failed'), false, pick('请核对远程仓库与权限；分支未被改写', 'Check the remote repository and permissions; the branch was not rewritten')), completedSteps: [] }
  const created = await deps.createPr({ title: request.title.trim(), body: request.body, base: request.base, head: request.branch, draft: request.draft === true })
  return { ...created, completedSteps: ['push', ...(created.completedSteps ?? [])] }
}
