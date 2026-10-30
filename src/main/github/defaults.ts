import { execFile } from 'node:child_process'
import type { GhPrCreateDefaultsResult } from '../../shared/github'
import { classifyGhFailure, prFailure, runGh } from './command'
import type { GhRunner } from './command'

export type ReadPrGit = (cwd: string, args: string[]) => Promise<{ ok: boolean; stdout: string }>

const readGit: ReadPrGit = (cwd, args) => new Promise(resolve => {
  execFile('git', args, { cwd, timeout: 10_000, maxBuffer: 256 * 1024, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } }, (error, stdout) => resolve({ ok: !error, stdout: typeof stdout === 'string' ? stdout : '' }))
})

export async function readPrCreateDefaults(cwd: string, run: GhRunner = runGh, git: ReadPrGit = readGit): Promise<GhPrCreateDefaultsResult> {
  const [branch, commit, repo] = await Promise.all([
    git(cwd, ['branch', '--show-current']),
    git(cwd, ['log', '-1', '--format=%s%x00%b']),
    run(cwd, ['repo', 'view', '--json', 'defaultBranchRef'])
  ])
  const currentBranch = branch.ok ? branch.stdout.trim() || null : null
  const separator = commit.stdout.indexOf('\0')
  const latestCommit = commit.ok && separator >= 0 ? { subject: commit.stdout.slice(0, separator), body: commit.stdout.slice(separator + 1).trimEnd() } : null
  let defaultBranch: string | null = null
  if (repo.ok) {
    try {
      const parsed = JSON.parse(repo.stdout) as { defaultBranchRef?: { name?: unknown } | null }
      if (typeof parsed.defaultBranchRef?.name === 'string') defaultBranch = parsed.defaultBranchRef.name
    } catch { }
  }
  const failure = !repo.ok ? classifyGhFailure(repo) : !branch.ok || !commit.ok ? prFailure('git-failed', '无法读取当前分支或最近提交') : !defaultBranch ? prFailure('other', '无法读取 GitHub 仓库默认分支') : undefined
  return { ok: !failure, currentBranch, latestCommit, defaultBranch, ...(failure ? { failure, error: failure.message } : {}) }
}
