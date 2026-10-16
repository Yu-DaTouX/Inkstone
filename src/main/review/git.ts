import { execFile } from 'node:child_process'
import { buildCommitArgs, buildPushArgs, classifyGitFailure, validateBranchName, validateCommitMessage } from '../../shared/git-actions'
import type { GitFailure } from '../../shared/git-actions'
import {
  buildGhPrCreateArgs,
  validatePullRequestInput,
  type ReviewConfirmRequest,
  type ReviewGitOutcome,
  type ReviewPullRequestInput,
  type ReviewPushInput
} from '../../shared/review'
import { createGitRunExec, type ReviewGitExec } from './changes'

export interface ReviewGhRunResult {
  ok: boolean
  stdout: string
  stderr: string
  error?: string
  notFound?: boolean
  timedOut?: boolean
}

export interface ReviewGhExec {
  run(cwd: string, args: string[], opts?: { timeoutMs?: number }): Promise<ReviewGhRunResult>
}

export function createNodeGhExec(): ReviewGhExec {
  return {
    run(cwd, args, opts) {
      return new Promise<ReviewGhRunResult>((resolveResult) => {
        execFile(
          'gh',
          args,
          { cwd, windowsHide: true, timeout: opts?.timeoutMs ?? 60_000, encoding: 'utf8' },
          (error, stdout, stderr) => {
            const out = String(stdout ?? '')
            const err = String(stderr ?? '')
            if (!error) {
              resolveResult({ ok: true, stdout: out, stderr: err })
              return
            }
            const code = (error as NodeJS.ErrnoException).code
            if (code === 'ENOENT') {
              resolveResult({ ok: false, stdout: out, stderr: err, notFound: true, error: '没有找到 gh' })
              return
            }
            const timedOut = (error as { killed?: boolean; signal?: string }).killed === true || (error as { signal?: string }).signal === 'SIGTERM'
            resolveResult({ ok: false, stdout: out, stderr: err, error: err.trim() || String(error.message ?? error), ...(timedOut ? { timedOut: true } : {}) })
          }
        )
      })
    }
  }
}

export interface ReviewConfirmPort {
  confirm(request: ReviewConfirmRequest): Promise<boolean>
}

export interface ReviewGitAdapterOptions {
  gitExec?: ReviewGitExec
  ghExec?: ReviewGhExec
  confirm: ReviewConfirmPort
}

export interface ReviewGhStatus {
  installed: boolean
  authenticated: boolean
  version?: string
  message?: string
  hint?: string
}

function gitFailureToOutcome(failure: GitFailure, timedOut: boolean): ReviewGitOutcome {
  const network = /could not resolve host|unable to access|connection refused|timed? ?out|network|ssl|proxy/i.test(
    `${failure.detail ?? ''} ${failure.message}`
  )
  return {
    ok: false,
    code: timedOut ? 'timeout' : network ? 'network' : 'failed',
    message: failure.message,
    ...(failure.hint ? { hint: failure.hint } : {}),
    ...(failure.detail ? { detail: failure.detail } : {}),
    recoverable: failure.retrySafe !== false
  }
}

export class ReviewGitAdapter {
  private readonly gitExec: ReviewGitExec
  private readonly ghExec: ReviewGhExec
  private readonly confirm: ReviewConfirmPort

  constructor(options: ReviewGitAdapterOptions) {
    this.gitExec = options.gitExec ?? createGitRunExec()
    this.ghExec = options.ghExec ?? createNodeGhExec()
    this.confirm = options.confirm
  }

  async ghStatus(cwd: string): Promise<ReviewGhStatus> {
    const version = await this.ghExec.run(cwd, ['--version'], { timeoutMs: 8_000 })
    if (version.notFound) {
      return {
        installed: false,
        authenticated: false,
        message: '没有找到 GitHub CLI（gh）',
        hint: '安装 gh 后重新检测：Windows 用 winget install GitHub.cli，macOS 用 brew install gh；本阶段 PR 只接 GitHub。'
      }
    }
    if (!version.ok) {
      return { installed: false, authenticated: false, message: version.error ?? 'gh 不可用', hint: '确认 gh 安装完整，然后重新检测。' }
    }
    const auth = await this.ghExec.run(cwd, ['auth', 'status'], { timeoutMs: 8_000 })
    if (!auth.ok) {
      return {
        installed: true,
        authenticated: false,
        version: version.stdout.trim().split('\n')[0] ?? '',
        message: 'GitHub CLI 尚未登录',
        hint: '在终端执行 gh auth login 后再创建 PR。'
      }
    }
    return { installed: true, authenticated: true, version: version.stdout.trim().split('\n')[0] ?? '' }
  }

  async commit(input: { cwd: string; message: string }): Promise<ReviewGitOutcome> {
    const invalid = validateCommitMessage(input.message)
    if (invalid) return { ok: false, code: 'invalid-input', message: invalid.message, recoverable: true }
    const res = await this.gitExec.run(input.cwd, buildCommitArgs(input.message), { timeoutMs: 120_000 })
    if (!res.ok) return gitFailureToOutcome(classifyGitFailure(res.stderr || res.stdout), res.timedOut === true)
    const sha = /\[[^\]]*?([0-9a-f]{7,40})\]/.exec(res.stdout)?.[1]
    return { ok: true, ...(sha ? { commit: sha } : {}), message: '已提交' }
  }

  async push(input: ReviewPushInput): Promise<ReviewGitOutcome> {
    const branch = input.branch ? String(input.branch).trim() : null
    if (branch) {
      const invalid = validateBranchName(branch)
      if (invalid) return { ok: false, code: 'invalid-input', message: invalid, recoverable: true }
    }
    const remote = input.remote ? String(input.remote).trim() : null
    const request: ReviewConfirmRequest = {
      action: 'push',
      cwd: input.cwd,
      remote,
      branch,
      base: null,
      title: null,
      draft: false,
      summary: `推送 ${branch ?? '当前分支'} 到 ${remote ?? '默认远端'}${input.setUpstream ? '（并设置上游）' : ''}`
    }
    const approved = await this.confirm.confirm(request)
    if (!approved) return { ok: false, code: 'not-confirmed', message: '你取消了推送', recoverable: true }

    const res = await this.gitExec.run(input.cwd, buildPushArgs(branch ?? '', remote, input.setUpstream), { timeoutMs: 90_000 })
    if (!res.ok) return gitFailureToOutcome(classifyGitFailure(res.stderr || res.stdout), res.timedOut === true)
    const upToDate = /everything up-to-date/i.test(res.stdout + res.stderr)
    return { ok: true, message: upToDate ? '远端已经是最新' : '已推送' }
  }

  async createPullRequest(input: ReviewPullRequestInput): Promise<ReviewGitOutcome> {
    const invalid = validatePullRequestInput(input)
    if (!invalid.ok) return { ok: false, code: 'invalid-input', message: invalid.error, recoverable: true }

    const status = await this.ghStatus(input.cwd)
    if (!status.installed) {
      return { ok: false, code: 'gh-missing', message: status.message ?? '没有找到 GitHub CLI（gh）', ...(status.hint ? { hint: status.hint } : {}), recoverable: true }
    }
    if (!status.authenticated) {
      return {
        ok: false,
        code: 'gh-not-authenticated',
        message: status.message ?? 'GitHub CLI 尚未登录',
        ...(status.hint ? { hint: status.hint } : {}),
        recoverable: true
      }
    }

    const args = buildGhPrCreateArgs({ ...input, title: input.title.trim() })
    const request: ReviewConfirmRequest = {
      action: 'create-pr',
      cwd: input.cwd,
      remote: input.remote,
      branch: input.head,
      base: input.base,
      title: input.title.trim(),
      draft: input.draft,
      summary: `创建${input.draft ? '草稿 ' : ''}PR：${input.head ?? '当前分支'} → ${input.base}`
    }
    const approved = await this.confirm.confirm(request)
    if (!approved) return { ok: false, code: 'not-confirmed', message: '你取消了创建 PR', recoverable: true }

    const res = await this.ghExec.run(input.cwd, args, { timeoutMs: 90_000 })
    if (!res.ok) {
      if (res.notFound) {
        return { ok: false, code: 'gh-missing', message: '没有找到 GitHub CLI（gh）', hint: '安装 gh 后重试。', recoverable: true }
      }
      const detail = res.stderr.trim() || res.error || ''
      const auth = /auth|login|token|credential/i.test(detail)
      return {
        ok: false,
        code: auth ? 'gh-not-authenticated' : res.timedOut ? 'timeout' : 'failed',
        message: auth ? 'GitHub 认证无效或未登录' : '创建 PR 失败',
        ...(auth ? { hint: '执行 gh auth login 后重试。' } : {}),
        ...(detail ? { detail } : {}),
        recoverable: true
      }
    }
    const url = /https?:\/\/\S+/.exec(res.stdout)?.[0]
    return { ok: true, ...(url ? { url } : {}), message: '已创建 PR' }
  }
}
