import { pick } from '../../shared/ui-lang'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
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

export function ghFallbackPaths(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return []
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432].filter((root): root is string => !!root)
  const paths = roots.map((root) => join(root, 'GitHub CLI', 'gh.exe'))
  if (env.LOCALAPPDATA) paths.push(join(env.LOCALAPPDATA, 'Programs', 'GitHub CLI', 'gh.exe'))
  return [...new Set(paths)]
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

export function createGhRunner(execute: typeof execFile = execFile, fallbacks: () => string[] = () => ghFallbackPaths().filter((path) => existsSync(path))): GhRunner {
  const run = (cwd: string, args: string[], maxBuffer: number, input: string | undefined, binary: string | null): Promise<GhRun> => new Promise((resolve) => {
    const debugScript = process.env.YAN_PROBE && process.env.YAN_USER_DATA ? process.env.YAN_DEBUG_GH_SCRIPT : undefined
    const child = execute(
      debugScript ? process.execPath : binary ?? 'gh', debugScript ? [debugScript, ...args] : args,
      { cwd, timeout: GH_TIMEOUT_MS, maxBuffer, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...GH_ENV, ...(debugScript ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } },
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
  return async (cwd, args, maxBuffer = JSON_MAX_BUFFER, input) => {
    const first = await run(cwd, args, maxBuffer, input, null)
    if (!first.missing || first.missingCwd) return first
    for (const candidate of fallbacks()) {
      const next = await run(cwd, args, maxBuffer, input, candidate)
      if (!next.missing) return next
    }
    return first
  }
}

export const runGh = createGhRunner()

export function prFailure(code: GhPrFailure['code'], message: string, retrySafe = true, hint = pick('刷新后确认状态再操作', 'Refresh to confirm the state before acting')): GhPrFailure {
  return { code, message, hint, retrySafe }
}

export function classifyGhFailure(run: GhRun, writing = false): GhPrFailure {
  if (run.missingCwd) return prFailure('cwd-rejected', pick('项目目录不存在', 'Project folder does not exist'))
  if (run.missing) return prFailure('gh-missing', pick('未安装 GitHub CLI', 'GitHub CLI is not installed'), true, pick('请安装 gh 后再操作', 'Install gh first'))
  if (run.timedOut) return prFailure('timeout', writing ? pick('请求超时，结果未知，请刷新确认', 'Request timed out. Result unknown. Refresh to confirm') : pick('GitHub 请求超时', 'GitHub request timed out'), !writing, pick('请刷新确认远端状态，不要直接重复写操作', 'Refresh to confirm the remote state. Do not repeat the write'))
  const text = `${run.stderr}\n${run.stdout}`.toLowerCase()
  if (/not logged|gh auth login|authentication required|http 401|bad credentials|authentication failed/.test(text)) return prFailure('not-authenticated', pick('GitHub CLI 未登录或登录已失效', 'GitHub CLI is not signed in or the sign-in expired'), true, pick('请在终端运行 gh auth login', 'Run gh auth login in a terminal'))
  if (/http 403|forbidden|resource not accessible|permission|not permitted/.test(text)) return prFailure('forbidden', pick('没有执行此操作的权限', 'No permission for this operation'), true, pick('请核对仓库权限与组织策略', 'Check repository permissions and organization policy'))
  if (/http 404|not found|could not resolve to a pullrequest|no pull requests found/.test(text)) return prFailure('pr-not-found', pick('PR 或关联资源不存在或不可见', 'PR or related resource does not exist or is not visible'))
  if (/protected branch|required status|status check|checks? (?:have |has )?failed|branch policy|review is required|base branch policy|review required/.test(text)) return prFailure('checks-rejected', pick('检查或保护分支规则拒绝合并', 'Checks or branch protection rules block the merge'), true, pick('请先满足检查、评审及保护分支要求', 'Satisfy the checks, reviews and branch protection first'))
  if (/not mergeable|not cleanly mergeable|merge conflict|mergeable state|cannot be merged/.test(text)) return prFailure('not-mergeable', pick('PR 有冲突或当前不可合并', 'PR has conflicts or cannot be merged now'), true, pick('请刷新并先解决合并冲突', 'Refresh and resolve the merge conflicts first'))
  if (/timed? out|timeout|deadline exceeded|tls handshake timeout/.test(text)) return prFailure('timeout', writing ? pick('网络超时，结果未知，请刷新确认', 'Network timed out. Result unknown. Refresh to confirm') : pick('GitHub 网络超时', 'GitHub network timed out'), !writing, pick('先刷新确认，不要直接重复写操作', 'Refresh to confirm first. Do not repeat the write'))
  return prFailure('other', writing ? pick('GitHub 操作未得到确认，结果可能未知', 'GitHub operation was not confirmed. The result may be unknown') : pick('GitHub 请求失败', 'GitHub request failed'), !writing, pick('请刷新确认；必要时在终端核对 gh 状态', 'Refresh to confirm. Check gh in a terminal if needed'))
}
