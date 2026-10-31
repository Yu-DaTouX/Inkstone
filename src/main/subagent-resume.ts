import { createHash } from 'node:crypto'
import type { SubagentForkSource } from './subagent-fork'

export interface ResumeLaunch {
  appendSystemPrompt?: string
  extensions?: string[]
  readOnlyExtension?: string
}

export interface PersistedForkLaunch {
  cwd: string
  piBin?: string
  args: string[]
  env: Record<string, string>
  model: string
  thinkingLevel?: string
  contextTokens?: number
  contextWindow?: number
}

export interface ResumeMeta {
  launch?: ResumeLaunch
  launchDigest?: string
  forkLaunch?: PersistedForkLaunch
}

export interface Resumability {
  ok: boolean
  reason?: string
}

export interface ResumabilityInput {
  status: string
  isolation: string
  review?: string
  fork?: boolean
  launchFailed?: boolean
  live: boolean
  worktreeAlive: boolean
  forkLaunchSaved: boolean
}

export function launchDigest(launch: ResumeLaunch): string {
  const canonical = JSON.stringify([launch.appendSystemPrompt ?? '', launch.extensions ?? [], launch.readOnlyExtension ?? ''])
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

export function resolveResumeLaunch(
  stored: { launch?: ResumeLaunch; digest?: string } | undefined,
  current: ResumeLaunch,
  exists: (path: string) => boolean
): { launch: ResumeLaunch; kept: boolean; prefixChanged: boolean } {
  if (!stored?.launch || !stored.digest) return { launch: current, kept: false, prefixChanged: false }
  if (launchDigest(current) === stored.digest) return { launch: current, kept: false, prefixChanged: false }
  const paths = [...(stored.launch.extensions ?? []), ...(stored.launch.readOnlyExtension ? [stored.launch.readOnlyExtension] : [])]
  if (paths.every(exists)) return { launch: stored.launch, kept: true, prefixChanged: false }
  return { launch: current, kept: false, prefixChanged: true }
}

export function subagentResumability(input: ResumabilityInput): Resumability {
  if (input.status === 'running' || input.status === 'starting') return { ok: false, reason: '子代理仍在运行' }
  if (input.launchFailed) return { ok: false, reason: '这个子代理没有成功启动过' }
  if (input.isolation === 'worktree' && !input.worktreeAlive) {
    return { ok: false, reason: 'worktree 已合并、放弃或归档清理，原工作树不在了；需要继续时重新派一个，并附上它的结论' }
  }
  if (input.fork && !input.live && !input.forkLaunchSaved) {
    return { ok: false, reason: '这个 fork 子代理没有保存来源信息，重启后不能续接' }
  }
  return { ok: true }
}

const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|API_?KEY|CREDENTIAL|AUTH)/i
const PERSISTED_ENV = /^(YAN_|PI_)/

export function persistableForkLaunch(source: SubagentForkSource): PersistedForkLaunch {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source.env ?? {})) {
    if (typeof value !== 'string' || !PERSISTED_ENV.test(key) || SECRET_ENV.test(key) || key === 'YAN_CLI_URL') continue
    env[key] = value
  }
  return {
    cwd: source.cwd,
    ...(source.piBin ? { piBin: source.piBin } : {}),
    args: [...source.args],
    env,
    model: source.model,
    ...(source.thinkingLevel ? { thinkingLevel: source.thinkingLevel } : {}),
    ...(source.contextTokens !== undefined ? { contextTokens: source.contextTokens } : {}),
    ...(source.contextWindow !== undefined ? { contextWindow: source.contextWindow } : {})
  }
}

export function restoreForkSource(saved: PersistedForkLaunch, sessionFile: string): SubagentForkSource {
  return { ...saved, sessionFile }
}

export interface PruneItem {
  id: string
  lastActiveAt: number
  rank: number
  terminal: boolean
  reviewed: boolean
  live: boolean
}

export function planSubagentPrune(items: readonly PruneItem[], opts: { now: number; maxAgeMs: number; keep: number }): string[] {
  return items
    .filter((item) => !item.live && item.terminal && item.reviewed)
    .filter((item) => item.rank >= opts.keep && opts.now - item.lastActiveAt > opts.maxAgeMs)
    .map((item) => item.id)
}
