import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { GhPrFailure } from '../../shared/github'

export const GH_TIMEOUT_MS = 20_000
export const JSON_MAX_BUFFER = 8 * 1024 * 1024
const GH_ENV = {
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  GH_PAGER: 'cat',
  NO_COLOR: '1',
  CLICOLOR: '0'
}

export interface GhRun {
  ok: boolean
  stdout: string
  stderr: string
  missing: boolean
  missingCwd: boolean
  timedOut: boolean
  overflow: boolean
}

export type GhRunner = (cwd: string, args: string[], maxBuffer?: number, input?: string) => Promise<GhRun>

export function createGhRunner(execute: typeof execFile = execFile): GhRunner {
  return (cwd, args, maxBuffer = JSON_MAX_BUFFER, input) => new Promise((resolve) => {
    const child = execute(
      'gh', args,
      { cwd, timeout: GH_TIMEOUT_MS, maxBuffer, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...GH_ENV } },
      (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException | null)?.code ?? ''
        const missing = code === 'ENOENT'
        const overflow = code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        resolve({
          ok: !error,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
          missing,
          missingCwd: missing && !existsSync(cwd),
          timedOut: !overflow && (code === 'ETIMEDOUT' || (error as { killed?: boolean } | null)?.killed === true),
          overflow
        })
      }
    )
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(input)
  })
}

export const runGh = createGhRunner()

export function prFailure(code: GhPrFailure['code'], message: string, retrySafe = true, hint = '刷新后确认状态再操作'): GhPrFailure {
  return { code, message, hint, retrySafe }
}

export function classifyGhFailure(run: GhRun, writing = false): GhPrFailure {
  if (run.missingCwd) return prFailure('cwd-rejected', '项目目录不存在')
  if (run.missing) return prFailure('gh-missing', '未安装 GitHub CLI', true, '请安装 gh 后再操作')
  if (run.timedOut) return prFailure('timeout', writing ? '请求超时，结果未知，请刷新确认' : 'GitHub 请求超时', !writing, '请刷新确认远端状态，不要直接重复写操作')
  const text = `${run.stderr}\n${run.stdout}`.toLowerCase()
  if (/not logged|gh auth login|authentication required|http 401|bad credentials|authentication failed/.test(text)) return prFailure('not-authenticated', 'GitHub CLI 未登录或登录已失效', true, '请在终端运行 gh auth login')
  if (/http 403|forbidden|resource not accessible|permission|not permitted/.test(text)) return prFailure('forbidden', '没有执行此操作的权限', true, '请核对仓库权限与组织策略')
  if (/http 404|not found|could not resolve to a pullrequest|no pull requests found/.test(text)) return prFailure('pr-not-found', 'PR 或关联资源不存在或不可见')
  if (/protected branch|required status|status check|checks? (?:have |has )?failed|branch policy|review is required|base branch policy|review required/.test(text)) return prFailure('checks-rejected', '检查或保护分支规则拒绝合并', true, '请先满足检查、评审及保护分支要求')
  if (/not mergeable|not cleanly mergeable|merge conflict|mergeable state|cannot be merged/.test(text)) return prFailure('not-mergeable', 'PR 有冲突或当前不可合并', true, '请刷新并先解决合并冲突')
  if (/timed? out|timeout|deadline exceeded|tls handshake timeout/.test(text)) return prFailure('timeout', writing ? '网络超时，结果未知，请刷新确认' : 'GitHub 网络超时', !writing, '先刷新确认，不要直接重复写操作')
  return prFailure('other', writing ? 'GitHub 操作未得到确认，结果可能未知' : 'GitHub 请求失败', !writing, '请刷新确认；必要时在终端核对 gh 状态')
}
