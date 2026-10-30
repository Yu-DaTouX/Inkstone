import type { GhPrActionRequest, GhPrActionResult, GhPrCandidatesRequest, GhPrCandidatesResult, GhPrDetailJson, GhPrFailure } from '../../shared/github'
import type { GitActionResult } from '../../shared/git-actions'
import { checkoutPrHead, pushCurrentBranchForPr } from '../git-actions'
import { DETAIL_FIELDS } from './gh'
import { classifyGhFailure, prFailure, runGh } from './command'
import type { GhRunner } from './command'
import { record, validateAction } from './validation'

const REPO = 'repos/{owner}/{repo}'

interface RestPr {
  number: number
  html_url: string
  merged: boolean
  head: { ref: string; sha: string; repo: { full_name: string } | null }
  base: { repo: { full_name: string; html_url: string; default_branch: string } }
}

class ActionFailure extends Error {
  constructor(readonly failure: GhPrFailure) {
    super(failure.message)
  }
}

function parse<T>(value: string): T {
  try {
    return JSON.parse(value) as T
  } catch {
    throw new ActionFailure(prFailure('other', 'GitHub 返回的数据无法解析', false))
  }
}

function gitFailure(result: GitActionResult): GhPrFailure {
  return {
    ...prFailure(result.failure?.code === 'timeout' ? 'timeout' : 'git-failed', result.failure?.code === 'timeout' ? 'Git 操作超时，结果未知，请刷新确认' : result.failure?.message ?? 'Git 操作未完成', result.failure?.retrySafe ?? false, result.failure?.hint ?? '刷新本地仓库状态后确认'),
    ...(result.failure ? { gitFailure: { ...result.failure, detail: undefined } } : {})
  }
}

export function createGithubPrBackend(run: GhRunner = runGh, git = { pushCurrentBranchForPr, checkoutPrHead }) {
  async function command(cwd: string, args: string[], writing: boolean, input?: string): Promise<string> {
    const result = await run(cwd, args, undefined, input)
    if (!result.ok) throw new ActionFailure(classifyGhFailure(result, writing))
    return result.stdout
  }

  async function api(cwd: string, endpoint: string, method = 'GET', input?: unknown): Promise<string> {
    return command(cwd, ['api', endpoint, '--method', method, ...(input === undefined ? [] : ['--input', '-'])], method !== 'GET', input === undefined ? undefined : JSON.stringify(input))
  }

  async function readPr(cwd: string, number: number): Promise<RestPr> {
    const pr = parse<RestPr>(await api(cwd, `${REPO}/pulls/${number}`))
    if (pr.number !== number || !pr.head || !/^[0-9a-f]{40,64}$/.test(pr.head.sha) || !pr.base?.repo) throw new ActionFailure(prFailure('other', 'PR 详情不完整', false))
    return pr
  }

  function deletionTarget(pr: RestPr): string {
    const name = pr.base.repo.full_name
    const branch = pr.head.ref
    if (!/^[a-z\d_.-]+\/[a-z\d_.-]+$/i.test(name) || pr.head.repo?.full_name !== name || !branch || !pr.base.repo.default_branch || branch === pr.base.repo.default_branch) throw new ActionFailure(prFailure('forbidden', '不能删除默认分支或 fork 的分支', true, '请在对应仓库中手动确认分支'))
    return `repos/${name}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`
  }

  async function deleteRemote(cwd: string, number: number): Promise<void> {
    const pr = await readPr(cwd, number)
    if (!pr.merged) throw new ActionFailure(prFailure('invalid-input', '仅允许删除已合并 PR 的远端分支'))
    const endpoint = deletionTarget(pr)
    const ref = parse<{ object?: { sha?: string } }>(await api(cwd, endpoint.replace('/git/refs/', '/git/ref/')))
    if (ref.object?.sha !== pr.head.sha) throw new ActionFailure(prFailure('invalid-input', '远端分支已有新提交，不删除', true, '请刷新并手动核对分支'))
    await api(cwd, endpoint, 'DELETE')
  }

  async function action(cwd: string, raw: GhPrActionRequest): Promise<GhPrActionResult> {
    const invalid = validateAction(raw)
    if (invalid) return { ok: false, failure: invalid }
    const request = raw
    let number = request.kind === 'create' ? undefined : request.number
    let url: string | undefined
    let gitResult: GitActionResult | undefined
    let branchDeletion: GhPrActionResult['branchDeletion']
    const completedSteps: string[] = []
    let writingStarted = false
    const step = async (name: string, fn: () => Promise<unknown>) => {
      writingStarted = true
      const result = await fn()
      completedSteps.push(name)
      return result
    }
    try {
      const pull = `${REPO}/pulls/${number}`
      const issue = `${REPO}/issues/${number}`
      switch (request.kind) {
        case 'create': {
          if (request.pushFirst) {
            gitResult = await git.pushCurrentBranchForPr(cwd, request.head, request.pushFirst)
            if (!gitResult.ok) return { ok: false, failure: gitFailure(gitResult), gitResult: { ...gitResult, failure: undefined } }
            completedSteps.push('push')
          }
          const created = parse<{ number: number; html_url: string }>(String(await step('create', () => api(cwd, `${REPO}/pulls`, 'POST', { title: request.title, body: request.body, base: request.base, head: request.head, draft: request.draft ?? false }))))
          if (!Number.isInteger(created.number) || created.number < 1 || typeof created.html_url !== 'string') throw new ActionFailure(prFailure('other', '创建请求已发送，但无法识别新 PR，请刷新确认', false))
          number = created.number
          url = created.html_url
          break
        }
        case 'edit': {
          if (request.title !== undefined || request.body !== undefined) await step('edit', () => api(cwd, pull, 'PATCH', { title: request.title, body: request.body }))
          if (request.addReviewers?.length) await step('add-reviewers', () => api(cwd, `${pull}/requested_reviewers`, 'POST', { reviewers: request.addReviewers }))
          if (request.removeReviewers?.length) await step('remove-reviewers', () => api(cwd, `${pull}/requested_reviewers`, 'DELETE', { reviewers: request.removeReviewers }))
          if (request.addLabels?.length) await step('add-labels', () => api(cwd, `${issue}/labels`, 'POST', { labels: request.addLabels }))
          for (const name of request.removeLabels ?? []) await step(`remove-label:${name}`, () => api(cwd, `${issue}/labels/${encodeURIComponent(name)}`, 'DELETE'))
          break
        }
        case 'comment':
          await step('comment', () => command(cwd, ['pr', 'comment', String(number), '--body-file', '-'], true, request.body))
          break
        case 'reply':
          await step('reply', () => api(cwd, `${pull}/comments/${request.commentId}/replies`, 'POST', { body: request.body }))
          break
        case 'merge': {
          const pr = await readPr(cwd, request.number)
          if (request.deleteBranch) deletionTarget(pr)
          await step('merge', () => command(cwd, ['pr', 'merge', String(number), `--${request.method}`, '--match-head-commit', pr.head.sha, ...(request.autoMerge ? ['--auto'] : [])], true))
          if (request.deleteBranch) {
            const current = await readPr(cwd, request.number)
            if (current.merged) {
              await step('delete-branch', () => deleteRemote(cwd, request.number))
              branchDeletion = 'deleted'
            } else {
              branchDeletion = 'pending'
            }
          }
          break
        }
        case 'delete-branch':
          await step('delete-branch', () => deleteRemote(cwd, request.number))
          branchDeletion = 'deleted'
          break
        case 'ready': case 'draft':
          await step(request.kind, () => command(cwd, ['pr', 'ready', String(number), ...(request.kind === 'draft' ? ['--undo'] : [])], true))
          break
        case 'close': case 'reopen':
          await step(request.kind, () => command(cwd, ['pr', request.kind, String(number)], true))
          break
        case 'review': {
          const pr = await readPr(cwd, request.number)
          await step('review', () => api(cwd, `${pull}/reviews`, 'POST', { event: request.event, body: request.body, commit_id: pr.head.sha, comments: request.comments ?? [] }))
          break
        }
        case 'checkout': {
          const pr = await readPr(cwd, request.number)
          gitResult = await git.checkoutPrHead(cwd, request.number, pr.base.repo.html_url, pr.head.sha)
          if (!gitResult.ok) return { ok: false, number, failure: gitFailure(gitResult), gitResult: { ...gitResult, failure: undefined } }
          completedSteps.push('checkout')
          break
        }
      }
      let pr: GhPrDetailJson | null = null
      let refreshFailure: GhPrFailure | undefined
      try {
        pr = parse<GhPrDetailJson>(await command(cwd, ['pr', 'view', String(number), '--json', DETAIL_FIELDS], false))
        if (!record(pr) || pr.number !== number) throw new ActionFailure(prFailure('other', '刷新 PR 详情失败'))
      } catch (error) {
        pr = null
        refreshFailure = error instanceof ActionFailure ? error.failure : prFailure('other', '刷新 PR 详情失败')
      }
      return { ok: true, number, url: url ?? (typeof pr?.url === 'string' ? pr.url : undefined), pr, refreshRequired: !pr, refreshFailure, completedSteps, branchDeletion, gitResult }
    } catch (error) {
      const failure = error instanceof ActionFailure ? error.failure : prFailure('other', 'GitHub 操作未得到确认', !writingStarted)
      if (completedSteps.some(step => step !== 'push')) failure.retrySafe = false
      return { ok: false, number, url, failure, completedSteps, refreshRequired: writingStarted || completedSteps.length > 0 }
    }
  }

  async function candidates(cwd: string, request: GhPrCandidatesRequest): Promise<GhPrCandidatesResult> {
    if (!record(request) || typeof request.kind !== 'string' || !['reviewers', 'labels'].includes(request.kind)) return { ok: false, failure: prFailure('invalid-input', '候选参数不合法') }
    const page = request.page ?? 1
    const perPage = request.perPage ?? 100
    if (!Number.isInteger(page) || page < 1 || page > 1000 || !Number.isInteger(perPage) || perPage < 1 || perPage > 100) return { ok: false, failure: prFailure('invalid-input', '候选分页参数不合法') }
    try {
      const result = parse<unknown[]>(await api(cwd, `${REPO}/${request.kind === 'labels' ? 'labels' : 'collaborators'}?per_page=${perPage}&page=${page}`))
      if (!Array.isArray(result)) throw new ActionFailure(prFailure('other', '候选列表无法解析'))
      return request.kind === 'labels'
        ? { ok: true, page, hasMore: result.length === perPage, labels: result.filter(record).map(item => ({ name: String(item.name ?? ''), color: String(item.color ?? ''), description: String(item.description ?? '') })) }
        : { ok: true, page, hasMore: result.length === perPage, reviewers: result.filter(record).map(item => ({ login: String(item.login ?? '') })) }
    } catch (error) {
      return { ok: false, failure: error instanceof ActionFailure ? error.failure : prFailure('other', '获取候选列表失败') }
    }
  }

  return { action, candidates }
}

export const githubPrBackend = createGithubPrBackend()
