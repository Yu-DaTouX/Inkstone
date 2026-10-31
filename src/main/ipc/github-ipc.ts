import { shell } from 'electron'
import type { IpcRegistrar } from './registrar'
import type { AuthorizeReadCwd } from '../git-inspect'
import { ghPrDetail, ghPrDiff, ghPrList, readGithubStatus } from '../github/gh'
import { githubPrBackend } from '../github/actions'
import { readPrCreateDefaults } from '../github/defaults'
import { prFailure } from '../github/command'
import { cancelClone, cloneRepository, createLocalProject, defaultCloneDir, ghBranchesAndPulls, listGithubRepos, readGithubAccount, searchGithubRepos } from '../github/repos'
import { publishPeerBranch } from '../collab/github-publish'
import { repoRootOf, resolveCommit } from '../collab/git'
import { gitRun } from '../git-service'
import { getSettings, patchSettings } from '../settings'
import { trustStatus } from '../project-trust'
import type { GhPrCreateDefaultsResult, GhPrActionRequest, GhPrActionResult, GhPrCandidatesRequest, GhPrCandidatesResult, GhPrDetailResult, GhPrDiffResult, GhPrListOptions, GhPrListResult, GhPrListState, GithubStatus, GithubAccountStatus, GithubBranchListResult, GithubCloneProgress, GithubCloneRequest, GithubCloneResult, GithubCreateProjectResult, GithubRepoListRequest, GithubRepoListResult, GithubPeerPublishRequest } from '../../shared/github'

export interface GithubIpcDeps {
  authorizeReadCwd: AuthorizeReadCwd
  pushCloneProgress?: (progress: GithubCloneProgress) => void
}

async function cloneParent(parentDir?: unknown): Promise<string> {
  if (typeof parentDir === 'string' && parentDir.trim()) return parentDir.trim()
  return (await getSettings()).cloneDir ?? defaultCloneDir()
}

async function addProject(cwd: string): Promise<{ projectId?: string }> {
  const settings = await patchSettings({ cwd, recentCwds: [cwd, ...(await getSettings()).recentCwds.filter((path) => path !== cwd)].slice(0, 8) })
  return { projectId: settings.projects.find((project) => project.cwd === cwd)?.id }
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

  handle('yan:github:account', async (): Promise<GithubAccountStatus> => {
    try {
      return await readGithubAccount()
    } catch (error) {
      return { installed: false, authed: false, error: message(error) }
    }
  })

  handle('yan:github:defaultCloneDir', async (): Promise<string> => (await getSettings()).cloneDir ?? defaultCloneDir())

  handle('yan:github:repos', async (request: GithubRepoListRequest): Promise<GithubRepoListResult> => {
    try {
      return await listGithubRepos(request ?? {})
    } catch {
      const failure = prFailure('other', '获取仓库列表失败')
      return { ok: false, items: [], owners: [], error: failure.message, failure }
    }
  })

  handle('yan:github:searchRepos', async (query: unknown): Promise<GithubRepoListResult> => {
    try {
      return await searchGithubRepos(String(query ?? ''))
    } catch {
      const failure = prFailure('other', '搜索 GitHub 仓库失败')
      return { ok: false, items: [], owners: [], error: failure.message, failure }
    }
  })

  handle('yan:github:clone', async (request: GithubCloneRequest): Promise<GithubCloneResult> => {
    try {
      const parentDir = await cloneParent(request?.parentDir)
      return await cloneRepository({ ...request, parentDir }, {
        defaultDir: () => parentDir,
        onProgress: deps.pushCloneProgress,
        addProject,
        trusted: async (cwd) => (await trustStatus(cwd)).trusted
      })
    } catch (error) {
      return { ok: false, error: message(error) }
    }
  })

  handle('yan:github:cancelClone', async (id: unknown): Promise<{ ok: boolean }> => ({ ok: cancelClone(String(id ?? '')) }))

  handle('yan:github:createProject', async (name: unknown, parentDir?: unknown): Promise<GithubCreateProjectResult> => {
    try {
      return await createLocalProject(name, await cloneParent(parentDir), { addProject })
    } catch (error) {
      return { ok: false, error: message(error) }
    }
  })

  handle('yan:github:publishPeerBranch', async (cwd: string, request: GithubPeerPublishRequest): Promise<GhPrActionResult> => {
    try {
      const auth = await authorizeReadCwd(String(cwd ?? ''))
      if (!auth.ok) return { ok: false, failure: prFailure('cwd-rejected', '此项目目录未获授权') }
      const root = await repoRootOf(auth.cwd)
      if (!root) return { ok: false, failure: prFailure('invalid-input', '此项目不是 git 仓库') }
      return await publishPeerBranch(request, {
        login: async () => (await readGithubAccount()).login ?? null,
        resolve: (ref) => resolveCommit(root, ref),
        push: async (trackingRef, branch, remote) => {
          const pushed = await gitRun(root, ['push', '--', remote, `${trackingRef}:refs/heads/${branch}`], { allowFailure: true, timeout: 120_000 })
          return { ok: pushed.ok, error: pushed.ok ? undefined : (pushed.error ?? pushed.stderr ?? '').trim().split(/\r?\n/).pop() }
        },
        createPr: (input) => githubPrBackend.action(auth.cwd, { kind: 'create', ...input })
      })
    } catch {
      return { ok: false, failure: prFailure('other', '发布到 GitHub 未得到确认，请刷新确认', false) }
    }
  })

  handle('yan:github:branches', async (cwd: string): Promise<GithubBranchListResult> => {
    try {
      const auth = await authorizeReadCwd(String(cwd ?? ''))
      if (!auth.ok) return { ok: false, branches: [], pulls: [], error: auth.error, failure: prFailure('cwd-rejected', '此项目目录未获授权') }
      return await ghBranchesAndPulls(auth.cwd)
    } catch {
      return { ok: false, branches: [], pulls: [], error: '获取 GitHub 分支失败' }
    }
  })

  handle('yan:github:status', async (cwd: string): Promise<GithubStatus> => {
    try {
      const auth = await authorizeReadCwd(String(cwd ?? ''))
      if (!auth.ok) return { installed: false, authed: false, repo: null, error: auth.error }
      return await readGithubStatus(auth.cwd)
    } catch (error) {
      return { installed: false, authed: false, repo: null, error: message(error) }
    }
  })

  handle('yan:github:createDefaults', async (cwd: string): Promise<GhPrCreateDefaultsResult> => {
    const empty = { currentBranch: null, latestCommit: null, defaultBranch: null }
    try {
      const auth = await authorizeReadCwd(String(cwd ?? ''))
      if (!auth.ok) return { ok: false, ...empty, error: auth.error, failure: prFailure('cwd-rejected', '此项目目录未获授权') }
      return await readPrCreateDefaults(auth.cwd)
    } catch {
      const failure = prFailure('other', '读取新建 PR 默认值失败')
      return { ok: false, ...empty, error: failure.message, failure }
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
