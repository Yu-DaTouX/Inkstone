import { userMessageSent } from './browser/user-handoff'
import type { BrowserWindow } from 'electron'
import { nativeImage } from 'electron'
import { join, dirname, basename, resolve } from 'node:path'
import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { hostname } from 'node:os'
import { remoteHistoryPage, remoteToolCall } from '../shared/remote-history-page'
import { approvalDigest, applyHumanApproval, remoteApprovalQuestion } from './remote-approval'
import type { ApprovalBroker } from './approval-broker'
import { localizeImage } from './image-store'
import { setManualTitle } from './title'
import { getSettings } from './settings'
import { listSessions } from './sessions'
import { PeerGrantRegistry } from './peer-grants'
import { PeerClient } from './peer-client'
import type { PeerHostHandlers, RemoteArtifactFile, RemoteCommand, RemoteOperationResult } from './remote-server'
import { PEER_ARTIFACT_MAX_BYTES } from '../shared/peer-protocol'
import type { PeerExportedArtifact, PeerSessionExport } from '../shared/peer-protocol'
import { REMOTE_ARTIFACT_MAX_BYTES, REMOTE_INSIGHT_MAX_FILES } from '../shared/remote-protocol'
import type { RemoteChangedFile, RemoteInsight, RemoteSessionChanges, RemoteSessionStats, RemoteAnswer, RemoteArtifact, RemotePendingQuestion, RemoteHumanApproval } from '../shared/remote-protocol'
import { normalizeChainKey, isRepresentative, chainForFile } from '../shared/session-chain'
import { YAN_DIR } from './paths'
import { readChanges } from './git-inspect'
import { listRefs, readRepoSnapshot, resolveRepo } from './git-service'
import { runGitAction } from './git-actions'
import { setSessionFlags } from './session-layout'
import { searchSessionText } from './session-search'
import { deleteSessionChain } from './session-delete'
import { randomUUID } from 'node:crypto'
import type { GitChangeEntry } from '../shared/git'
import type { AssistantArtifact, RunnerStatus, SessionStats, SessionState, SessionSummary, SessionTodo, SubagentRun, UIToolCall } from '../shared/ipc'
import { SessionEntriesLite } from './session-entries-lite'
import { readTaskPlanLog } from './task-plan-store'
import { taskPlanLogEntry } from '../shared/task-plan'
import { todoSnapshotsFromEntries } from './todo-snapshots'
import type { RemoteAccess } from './remote-access'
import type { SessionHost } from './session-host'
import type { AgentController } from './agent'

export interface RemoteHost extends SessionHost {
  win(): BrowserWindow | null
  remoteAccess(): RemoteAccess | null
  approvals?: Pick<ApprovalBroker, 'list' | 'answer'>
  worktreeOriginOf?(sessionId: string, cwd: string): Promise<string | null>
}

let host: RemoteHost

const REMOTE_SESSIONS_TTL_MS = 2000
let sessionsCache: { at: number; limit: number; list: SessionSummary[] } | null = null

async function remoteSessions(limit: number, fresh = false): Promise<SessionSummary[]> {
  const now = Date.now()
  if (!fresh && sessionsCache && sessionsCache.limit === limit && now - sessionsCache.at < REMOTE_SESSIONS_TTL_MS) return sessionsCache.list
  const settings = await getSettings()
  const list = await listSessions(limit, settings.projects)
  sessionsCache = { at: now, limit, list }
  return list
}

export function configureRemoteHost(next: RemoteHost): void {
  host = next
}

export function remoteSessionSummary(summary: SessionSummary): Record<string, unknown> {
  return {
    id: summary.id,
    title: summary.title,
    named: summary.named,
    ...(summary.parentSession ? { parentSessionId: basename(summary.parentSession, '.jsonl') } : {}),
    ...(summary.branchOrigin ? { branchOriginTitle: summary.branchOrigin.slice(0, 120) } : {}),
    ...(summary.lastActivityAt !== undefined ? { lastActivityAt: summary.lastActivityAt } : {}),
    ...(summary.lastReply ? { lastReply: summary.lastReply } : {}),
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    messageCount: summary.messageCount,
    ...(summary.model ? { model: summary.model } : {}),
    ...(summary.projectId ? { projectId: summary.projectId } : {}),
    ...(summary.scope ? { scope: summary.scope } : {}),
    ...(summary.lastOpenedAt !== undefined ? { lastOpenedAt: summary.lastOpenedAt } : {}),
    ...(summary.pinned ? { pinned: true } : {}),
    ...(summary.archivedAt ? { archivedAt: summary.archivedAt } : {}),
    ...(summary.projectCandidates?.length ? { projectCandidateCount: summary.projectCandidates.length } : {}),
    cwdName: basename(summary.cwd) || summary.cwd
  }
}

export function remoteSessionState(state: SessionState | null): Record<string, unknown> | null {
  if (!state) return null
  return {
    sessionId: state.sessionId,
    ...(state.sessionName ? { sessionName: state.sessionName } : {}),
    ...(state.model ? { model: state.model } : {}),
    thinkingLevel: state.thinkingLevel,
    availableThinkingLevels: state.availableThinkingLevels,
    ...(state.thinkingLevelsStatus ? { thinkingLevelsStatus: state.thinkingLevelsStatus } : {}),
    ...(state.capabilities ? { capabilities: state.capabilities } : {}),
    isStreaming: state.isStreaming,
    ...(state.isAgentRunning !== undefined ? { isAgentRunning: state.isAgentRunning } : {}),
    isCompacting: state.isCompacting,
    ...(state.pendingModelChange ? { pendingModelChange: true } : {}),
    ...(state.compaction ? { compaction: state.compaction } : {}),
    ...(state.lastCompaction ? { lastCompaction: state.lastCompaction } : {}),
    messageCount: state.messageCount,
    pendingMessageCount: state.pendingMessageCount,
    cwdName: basename(state.cwd) || state.cwd,
    ...(state.autoCompactionEnabled !== undefined ? { autoCompactionEnabled: state.autoCompactionEnabled } : {}),
    ...(state.steeringMode ? { steeringMode: state.steeringMode } : {}),
    ...(state.followUpMode ? { followUpMode: state.followUpMode } : {})
  }
}

export function remoteRunnerStatus(status: RunnerStatus): Record<string, unknown> {
  const model = host ? host.runners()?.agentOf(status.runId)?.getState()?.model : undefined
  return {
    id: status.id,
    runId: status.runId,
    ...(status.sessionId ? { sessionId: status.sessionId } : {}),
    ...(status.projectId ? { projectId: status.projectId } : {}),
    generation: status.generation,
    cwdName: basename(status.cwd) || status.cwd,
    running: status.running,
    waiting: status.waiting,
    ...(model ? { model: { id: model.id, provider: model.provider, name: model.name, input: model.input } } : {}),
    failed: status.failed,
    conn: status.conn,
    createdAt: status.createdAt,
    lastActiveAt: status.lastActiveAt,
    isActive: status.isActive
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function remoteTurnSettled(payload: unknown): Record<string, unknown> {
  const box = asRecord(payload)
  const outcome = box.outcome === 'failed' || box.outcome === 'stopped' || box.outcome === 'completed' ? box.outcome : 'completed'
  return {
    outcome,
    ...(typeof box.sessionId === 'string' ? { sessionId: box.sessionId } : {})
  }
}

function remoteModelError(payload: unknown): Record<string, unknown> {
  const box = asRecord(payload)
  return {
    message: typeof box.message === 'string' ? box.message : '',
    text: typeof box.text === 'string' ? box.text : '',
    ...(typeof box.source === 'string' ? { source: box.source } : {})
  }
}

const clip = (text: string | undefined, max: number): string | undefined =>
  text === undefined ? undefined : text.length > max ? `${text.slice(0, max)}…` : text

export function remoteSubagentRun(run: SubagentRun): Record<string, unknown> {
  const title = run.brief?.title?.trim() || run.task.split('\n')[0].trim()
  return {
    id: run.id,
    title: clip(title, 80),
    task: clip(run.task, 600),
    status: run.status,
    isolation: run.isolation,
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    ...(run.endReason ? { endReason: run.endReason } : {}),
    ...(run.model ? { model: run.model } : {}),
    ...(run.thinkingLevel ? { thinkingLevel: run.thinkingLevel } : {}),
    ...(typeof run.toolCalls === 'number' ? { toolCalls: run.toolCalls } : {}),
    ...(run.latestActivity ? { latestActivity: clip(run.latestActivity, 200) } : {}),
    ...(run.error ? { error: clip(run.error, 600) } : {}),
    ...(run.result?.summary ? { summary: clip(run.result.summary, 1200) } : {}),
    ...(typeof run.usage?.totalTokens === 'number' ? { tokens: run.usage.totalTokens } : {}),
    ...(typeof run.usage?.cost === 'number' ? { cost: run.usage.cost } : {})
  }
}

export function remoteSubagents(sessionId: string, runs: readonly SubagentRun[]): RemoteOperationResult {
  const own = runs.filter((run) => run.parentSessionId === sessionId).sort((a, b) => a.startedAt - b.startedAt)
  return { ok: true, data: { runs: own.map(remoteSubagentRun) } }
}

export function remoteSessionStats(stats: SessionStats | null | undefined): RemoteSessionStats | null {
  if (!stats) return null
  const usage = stats.contextUsage
  const finite = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  return {
    tokens: finite(stats.tokens?.total),
    cost: finite(stats.cost),
    toolCalls: finite(stats.toolCalls),
    messages: finite(stats.userMessages) + finite(stats.assistantMessages),
    ...(usage && finite(usage.contextWindow) > 0
      ? { context: { percent: typeof usage.percent === 'number' && Number.isFinite(usage.percent) ? usage.percent : null, tokens: typeof usage.tokens === 'number' ? usage.tokens : null, window: usage.contextWindow } }
      : {})
  }
}

function changedFileStatus(entry: GitChangeEntry): RemoteChangedFile['status'] {
  if (entry.untracked) return '?'
  if (entry.unmerged) return 'U'
  const code = [entry.y, entry.x].find((letter) => letter && letter !== '.' && letter !== ' ')
  return code === 'A' || code === 'D' || code === 'R' ? code : 'M'
}

export function remoteSessionChanges(result: { ok: boolean; branch: string | null; files: GitChangeEntry[]; added?: number; removed?: number; truncated: boolean }): RemoteSessionChanges | null {
  if (!result.ok) return null
  const files = result.files.slice(0, REMOTE_INSIGHT_MAX_FILES).map((entry) => ({
    path: clip(entry.path, 200) ?? '',
    status: changedFileStatus(entry),
    ...(typeof entry.added === 'number' ? { added: entry.added } : {}),
    ...(typeof entry.removed === 'number' ? { removed: entry.removed } : {})
  }))
  return {
    branch: result.branch,
    added: result.added ?? 0,
    removed: result.removed ?? 0,
    total: result.files.length,
    files,
    truncated: result.truncated || result.files.length > files.length
  }
}

export async function remoteInsight(sessionId: string): Promise<RemoteOperationResult> {
  const resolved = await resolveChainSession(sessionId, { allowUnsaved: true })
  if (!resolved.ok) return resolved
  const summary = resolved.summary
  const status = host.runners()?.statuses().find((item) => item.sessionId === summary.id)
  const agent = status ? host.runners()?.agentOf(status.runId) : null
  const [stats, changes] = await Promise.all([
    agent ? agent.refreshStats().catch(() => null) : Promise.resolve(null),
    readChanges(summary.cwd, async (cwd) => ({ ok: true, cwd }), { scope: { kind: 'working' } }).catch(() => null)
  ])
  const data: RemoteInsight = { stats: remoteSessionStats(stats), changes: changes ? remoteSessionChanges(changes) : null }
  return { ok: true, data }
}

export async function remoteStopSubagent(
  sessionId: string,
  runId: string,
  runs: readonly SubagentRun[],
  stop: (id: string) => Promise<{ ok: boolean; error?: string; noop?: boolean }>
): Promise<RemoteOperationResult> {
  const run = runs.find((item) => item.id === runId && item.parentSessionId === sessionId)
  if (!run) return { ok: false, status: 404, error: '找不到这个子代理' }
  if (run.status !== 'starting' && run.status !== 'running') return { ok: false, status: 409, error: '这个子代理已经结束' }
  const result = await stop(run.id)
  return result.ok ? { ok: true, data: { id: run.id, status: 'cancelled' } } : { ok: false, status: 409, error: result.error ?? '停止失败' }
}

export function remotePushPayload(channel: string, payload: unknown): unknown {
  if (channel === 'stats') return remoteSessionStats(payload as SessionStats | null) ?? {}
  if (channel === 'subagent') {
    const parent = asRecord(payload).parentSessionId
    return typeof parent === 'string' ? { sessionId: parent } : {}
  }
  if (channel === 'state') return remoteSessionState((payload ?? null) as SessionState | null)
  if (channel === 'runners') return Array.isArray(payload) ? payload.map((item) => remoteRunnerStatus(item as RunnerStatus)) : payload
  if (channel === 'turn-settled') return remoteTurnSettled(payload)
  if (channel === 'agent-error') return remoteModelError(payload)
  const sessionId = asRecord(payload).sessionId
  return typeof sessionId === 'string' ? { sessionId } : {}
}

export async function remoteSnapshot(): Promise<Record<string, unknown>> {
  const summaries = await filterChainRepresentatives(await remoteSessions(200))
  const state = host.ac()?.getState() ?? null
  const connection = host.ac()?.getConn() ?? { state: 'exited' as const, detail: 'pi 未运行' }
  const win = host.win()
  const windowReady = !!win && !win.isDestroyed()
  const settings = await getSettings()
  return {
    apiVersion: 1,
    projects: settings.projects
      .filter((project) => !project.archived)
      .map((project) => ({ id: project.id, name: peerProjectName(project, settings.projectNames), cwd: project.cwd })),
    currentProjectId: host.projectIdForCwd(settings, settings.cwd) ?? null,
    generatedAt: Date.now(),
    desktop: {
      ready: windowReady,
      visible: windowReady && win!.isVisible(),
      minimized: windowReady && win!.isMinimized()
    },
    agent: {
      connection,
      activeSessionId: state?.sessionId ?? null,
      state: remoteSessionState(state),
      runners: (host.runners()?.statuses() ?? []).map(remoteRunnerStatus)
    },
    sessions: summaries.map(remoteSessionSummary)
  }
}

export async function filterChainRepresentatives(list: SessionSummary[]): Promise<SessionSummary[]> {
  await host.sessionChains.load()
  const chains = host.sessionChains.chains()
  if (!chains.length) return list
  const out: SessionSummary[] = []
  for (const item of list) {
    if (!isRepresentative(chains, item.path)) continue
    const chain = chainForFile(chains, item.path)
    if (chain && chain.segments.length > 1 && !String(item.title ?? '').trim()) {
      const headPath = normalizeChainKey(chain.segments[0].sessionFile)
      const head = list.find((session) => normalizeChainKey(session.path) === headPath)
      out.push(head?.title ? { ...item, title: head.title } : item)
      continue
    }
    out.push(item)
  }
  return out
}

function unsavedSessionSummary(sessionId: string): SessionSummary | null {
  const status = host.runners()?.statuses().find((item) => item.sessionId === sessionId)
  if (!status?.cwd) return null
  const at = status.lastActiveAt ?? Date.now()
  return {
    id: sessionId,
    path: status.sessionFile ?? '',
    cwd: status.cwd,
    title: '',
    named: false,
    createdAt: status.createdAt ?? at,
    updatedAt: at,
    messageCount: 0,
    scope: status.projectId ? 'project' : 'global',
    ...(status.projectId ? { projectId: status.projectId } : {})
  }
}

async function resolveChainSession(sessionId: string, options: { allowUnsaved?: boolean } = {}): Promise<
  { ok: true; summary: SessionSummary } | { ok: false; status: number; error: string }
> {
  const list = await remoteSessions(500, true)
  const requested = list.find((item) => item.id === sessionId)
  if (!requested) {
    const unsaved = options.allowUnsaved ? unsavedSessionSummary(sessionId) : null
    if (unsaved) return { ok: true, summary: unsaved }
    return { ok: false, status: 404, error: '找不到目标会话，可能已被删除' }
  }
  await host.sessionChains.load()
  const representativePath = host.sessionChains.representativeOf(requested.path)
  const requestedKey = normalizeChainKey(requested.path)
  if (!representativePath || normalizeChainKey(representativePath) === requestedKey) {
    return { ok: true, summary: requested }
  }
  const representativeKey = normalizeChainKey(representativePath)
  const representative = list.find((item) => normalizeChainKey(item.path) === representativeKey)
  if (!representative) return { ok: false, status: 409, error: '会话链的代表段已不可用，请刷新后重试' }
  if ((representative.projectId ?? null) !== (requested.projectId ?? null)) {
    return { ok: false, status: 409, error: '该会话链跨项目，已拒绝把操作归一到代表段' }
  }
  return { ok: true, summary: representative }
}

async function remotePlan(sessionFile: string, sessionId: string): Promise<{ todos: SessionTodo[]; stale: boolean } | undefined> {
  const entries = await new SessionEntriesLite().entries(sessionFile).catch(() => null)
  if (!entries) return undefined
  const logged = await readTaskPlanLog(sessionId).catch(() => [])
  const latest = todoSnapshotsFromEntries([...entries, ...logged.map(taskPlanLogEntry)]).at(-1)
  if (!latest?.todos.length) return undefined
  const rounds = entries.filter((entry) => entry.type === 'message' && (entry.message as { role?: unknown } | undefined)?.role === 'user').length
  return { todos: latest.todos, stale: rounds > latest.round }
}

export async function remoteHistory(sessionId: string, limit: number, before?: string): Promise<RemoteOperationResult> {
  const summary = (await remoteSessions(500)).find((item) => item.id === sessionId)
  if (!summary) {
    const unsaved = unsavedSessionSummary(sessionId)
    if (unsaved) return { ok: true, data: { session: remoteSessionSummary(unsaved), messages: [], total: 0, returned: 0, hasMore: false, truncated: false, truncatedBytes: 0, bytes: 0 } }
    return { ok: false, status: 404, error: '找不到目标会话，可能已被删除' }
  }

  const result = await host.readHistoryWithArtifacts(summary.path)
  if (!result) return { ok: false, status: 502, error: '无法读取该会话历史' }
  const page = remoteHistoryPage(result.messages, limit, before)
  if (!page) return { ok: false, status: 409, error: '会话历史已变化，请重新打开', code: 'history_cursor_expired' }
  const messages = page.messages.map((message) => ({
    ...message,
    ...(message.images ? { images: message.images.map((image) => ({ mimeType: image.mimeType, data: '' })) } : {}),
    ...(message.toolCalls ? { toolCalls: remoteToolCallsWithImages(message.toolCalls, message.images?.length ?? 0) } : {}),
    ...(message.artifacts ? { artifacts: message.artifacts.map(remoteArtifactOf) } : {})
  }))
  const plan = before ? undefined : await remotePlan(summary.path, summary.id)
  return {
    ok: true,
    data: {
      session: remoteSessionSummary(summary),
      messages,
      ...(plan ? { plan } : {}),
      total: result.total,
      returned: messages.length,
      hasMore: page.hasMore,
      nextBefore: page.nextBefore,
      truncated: result.truncated > 0,
      truncatedBytes: result.truncated,
      bytes: result.bytes
    }
  }
}

export async function remoteSelectSession(sessionId: string): Promise<RemoteOperationResult> {
  const resolved = await resolveChainSession(sessionId, { allowUnsaved: true })
  if (!resolved.ok) return resolved
  const summary = resolved.summary
  const settings = await getSettings()

  if (!host.runners()) {
    const started = await host.startAgent()
    if (!started.ok) return { ok: false, status: 503, error: started.error ?? 'pi 未运行' }
  }
  const cwdResult = await host.validateCwd(summary.cwd)
  if (!cwdResult.ok) return { ok: false, status: 409, error: cwdResult.error }
  const projectId = summary.scope === 'global'
    ? undefined
    : (summary.projectId ?? host.projectIdForCwd(settings, cwdResult.cwd))
  const result = await host.runners()!.select({
    ...(summary.path ? { sessionFile: summary.path } : {}),
    sessionId: summary.id,
    cwd: cwdResult.cwd,
    projectId,
    scope: summary.scope
  })
  if (result.ok && result.id) void host.pushRunnerSnapshot(result.id)
  host.pushRunners()
  return result.ok ? { ok: true, data: result } : { ok: false, status: 409, error: result.error }
}

export async function remoteNewSession(requestedProjectId?: string): Promise<RemoteOperationResult> {
  const settings = await getSettings()
  const project = requestedProjectId ? settings.projects.find((item) => item.id === requestedProjectId && !item.archived) : undefined
  if (requestedProjectId && !project) return { ok: false, status: 404, error: '找不到这个项目' }
  if (!host.runners()) {
    const started = await host.startAgent()
    if (!started.ok) return { ok: false, status: 503, error: started.error ?? 'pi 未运行' }
  }
  const cwdResult = await host.validateCwd(project?.cwd ?? settings.cwd)
  if (!cwdResult.ok) return { ok: false, status: 409, error: cwdResult.error }
  const projectId = project?.id ?? host.projectIdForCwd(settings, cwdResult.cwd)
  const scope = projectId ? 'project' as const : 'global' as const
  const result = await host.runners()!.select({ cwd: cwdResult.cwd, projectId, scope, activate: false })
  await host.rememberRunnerSession(result, { cwd: cwdResult.cwd, projectId, scope })
  if (result.ok && result.id) void host.pushRunnerSnapshot(result.id)
  host.pushRunners()
  return result.ok ? { ok: true, data: result } : { ok: false, status: 409, error: result.error }
}

export async function withRemoteSession(sessionId: string, operation: (agent: AgentController, runId: string, summary: SessionSummary, generation: number, current: () => boolean) => Promise<RemoteOperationResult>, authorize?: (targetSessionId?: string) => Promise<RemoteOperationResult | null>, reserve = false): Promise<RemoteOperationResult> {
  const resolved = await resolveChainSession(sessionId, { allowUnsaved: true })
  if (!resolved.ok) return resolved
  const summary = resolved.summary
  const settings = await getSettings()

  if (!host.runners()) {
    const started = await host.startAgent()
    if (!started.ok) return { ok: false, status: 503, error: started.error ?? 'pi 未运行' }
  }
  const cwdResult = await host.validateCwd(summary.cwd)
  if (!cwdResult.ok) return { ok: false, status: 409, error: cwdResult.error }
  const projectId = summary.scope === 'global'
    ? undefined
    : (summary.projectId ?? host.projectIdForCwd(settings, cwdResult.cwd))
  const registry = host.runners()!
  const selected = await registry.select({
    ...(summary.path ? { sessionFile: summary.path } : {}),
    sessionId: summary.id,
    cwd: cwdResult.cwd,
    projectId,
    scope: summary.scope,
    activate: false
  })
  if (!selected.ok || !selected.id) {
    return { ok: false, status: 409, error: selected.error ?? '无法为目标会话准备后台运行实例' }
  }
  if (registry.blocksConcurrentRun(cwdResult.cwd, selected.id)) {
    return { ok: false, status: 409, error: '同一工作目录的另一个运行实例正在工作，暂不向目标会话发送以避免并发写入' }
  }
  const agent = registry.agentOf(selected.id)
  const generation = selected.generation
  const current = () => host.runners() === registry && registry.agentOf(selected.id!) === agent &&
    generation !== undefined && registry.runtimeOf(selected.id!)?.generation === generation &&
    agent?.getState()?.sessionId === summary.id && selected.sessionId === summary.id
  const changed = { ok: false, status: 409, error: '目标会话运行实例已变化，请刷新后重试' }
  if (!agent || !current() || generation === undefined) return changed
  if (authorize) {
    const denied = await authorize(summary.id)
    if (denied) return denied
    if (!current()) return changed
  }
  const admission = reserve ? registry.admitExecute(selected.id) : null
  if (admission && !admission.ok) return { ok: false, status: 409, error: admission.error }
  try {
    host.pushRunners()
    if (!current()) return changed
    return await operation(agent, selected.runId ?? selected.id, summary, generation, current)
  } finally {
    if (admission?.ok) registry.releaseExecute(selected.id, admission.token)
  }
}

export async function remoteModels(sessionId: string): Promise<RemoteOperationResult> {
  const resolved = await resolveChainSession(sessionId, { allowUnsaved: true })
  if (!resolved.ok) return resolved
  const summary = resolved.summary
  const status = host.runners()?.statuses().find((item) => item.sessionId === summary.id)
  const agent = status ? host.runners()?.agentOf(status.runId) : host.ac()
  if (!agent) return { ok: false, status: 503, error: '请先在电脑启动模型连接' }
  const models = await agent.listModels()
  const levels = status ? await agent.listThinkingLevels().catch(() => []) : []
  const thinking = status && levels.length > 1 ? { level: agent.getState()?.thinkingLevel ?? 'off', levels } : null
  const current = status ? agent.getState()?.model : models.find((model) => summary.model === model.id || summary.model === `${model.provider}/${model.id}` || summary.model === `${model.provider}:${model.id}`)
  const pending = status ? !!agent.getState()?.pendingModelChange : false
  return { ok: true, data: { pending, models: models.map(({ id, provider, name, input }) => ({ id, provider, name, input })), current: current ? { id: current.id, provider: current.provider, name: current.name, input: current.input } : null, thinking } }
}

function sessionBusy(sessionId: string): boolean {
  return host.runners()?.statuses().some((item) => item.sessionId === sessionId && (item.running || item.waiting)) === true
}

export async function executeRemoteCommand(command: RemoteCommand): Promise<RemoteOperationResult> {
  if (command.action === 'select') return remoteSelectSession(command.sessionId)
  if (command.action === 'new') return remoteNewSession(command.projectId)

  if (command.action === 'send') {
    if (command.images?.some((image) => nativeImage.createFromBuffer(Buffer.from(image.data, 'base64')).isEmpty())) return { ok: false, status: 400, error: '图片无法解码，请重新选择' }
    return withRemoteSession(command.sessionId, async (agent, runId, summary, generation) => {
      const model = agent.getState()?.model
      if (command.images?.length && model?.input && !model.input.includes('image')) return { ok: false, status: 409, error: '当前模型不支持图片，请选择支持图片的模型' }
      userMessageSent(agent.getState()?.sessionId)
      const result = await agent.send(command.text, command.images, command.mode, undefined, generation)
      return result.ok ? { ok: true, data: { ...result, runId, sessionId: summary.id } } : { ok: false, status: 409, error: result.error ?? '目标会话未能接收消息' }
    }, command.authorize)
  }
  if (command.action === 'model') {
    return withRemoteSession(command.sessionId, async (agent, _runId, _summary, _generation, current) => {
      const model = (await agent.listModels()).find((item) => item.provider === command.provider && item.id === command.modelId)
      if (!model) return { ok: false, status: 400, error: '模型不在电脑可用列表中' }
      if (!current()) return { ok: false, status: 409, error: '目标会话运行实例已变化' }
      const result = await agent.setModel(model.provider, model.id)
      host.pushRunners()
      return result.ok ? { ok: true, data: { current: { id: model.id, provider: model.provider, name: model.name, input: model.input }, pending: !!agent.getState()?.pendingModelChange } } : { ok: false, status: 409, error: result.error }
    }, undefined, !sessionBusy(command.sessionId))
  }

  if (command.action === 'thinking') {
    return withRemoteSession(command.sessionId, async (agent, _runId, _summary, _generation, current) => {
      const levels = await agent.listThinkingLevels()
      if (!current()) return { ok: false, status: 409, error: '目标会话运行实例已变化' }
      if (!levels.includes(command.level)) return { ok: false, status: 400, error: '当前模型不支持这个思考档位' }
      const result = await agent.setThinking(command.level)
      host.pushRunners()
      return result.ok ? { ok: true, data: { level: command.level, levels, pending: !!agent.getState()?.pendingModelChange } } : { ok: false, status: 409, error: result.error }
    }, undefined, !sessionBusy(command.sessionId))
  }

  if (command.action === 'abort') {
    const agent = host.runners()?.agentOf(command.runId)
    if (!agent) return { ok: false, status: 404, error: '找不到目标运行实例' }
    const state = agent.getState()
    if (!state?.isAgentRunning && !state?.isStreaming && !state?.isCompacting && !agent.hasRunningBash()) {
      return { ok: false, status: 409, error: '目标 runId 当前没有正在运行的任务' }
    }
    return { ok: true, data: { runId: command.runId, ...(await agent.abort()) } }
  }

  const resolved = await resolveChainSession(command.sessionId)
  if (!resolved.ok) return resolved
  const summary = resolved.summary
  const saved = await setManualTitle(summary.id, command.name)
  if (!saved.ok) return { ok: false, status: 500, error: saved.error ?? '保存会话名称失败' }
  if (host.ac()?.getState()?.sessionId === summary.id) {
    const renamed = await host.ac()!.renameSession(command.name, summary.id)
    if (!renamed.ok) return { ok: false, status: 409, error: renamed.error ?? '当前会话名称未能同步到 pi' }
  }
  host.push({ ch: 'session-title', payload: { sessionId: summary.id, title: command.name } })
  return { ok: true, data: { sessionId: summary.id, name: command.name } }
}

export function remoteArtifactOf(artifact: AssistantArtifact): RemoteArtifact {
  return {
    id: artifact.id,
    sourceId: artifact.sourceId,
    ...(artifact.version ? { version: artifact.version } : {}),
    filename: artifact.filename,
    mediaType: artifact.mediaType,
    kind: artifact.kind,
    bytes: artifact.bytes,
    createdAt: artifact.createdAt,
    previewable: artifact.previewable,
    ...(artifact.unavailable ? { unavailable: true } : {})
  }
}

function pendingRemoteQuestions(): RemotePendingQuestion[] {
  const questions: RemotePendingQuestion[] = []
  for (const status of host.runners()?.statuses() ?? []) {
    const agent = host.runners()?.agentOf(status.runId)
    if (!agent) continue
    for (const request of agent.pendingUiRequests()) {
      if (!['select', 'input', 'confirm', 'editor'].includes(request.method)) continue
      questions.push({
        id: request.id,
        sessionId: status.sessionId ?? null,
        runId: status.runId,
        method: request.method as RemotePendingQuestion['method'],
        title: request.title ?? '',
        message: request.message ?? '',
        ...(request.options ? { options: request.options } : {}),
        ...(request.form?.length ? { form: request.form } : {}),
        ...(request.placeholder ? { placeholder: request.placeholder } : {}),
        sensitive: request.sensitive === true,
        deadline: typeof (request as { deadline?: unknown }).deadline === 'number' ? (request as { deadline: number }).deadline : 0
      })
    }
  }
  questions.push(...(host.approvals?.list() ?? []).map(remoteApprovalQuestion))
  return questions.map(question => question.sensitive && question.method === 'confirm'
    ? { ...question, approvalDigest: approvalDigest(question) }
    : question)
}

export async function remoteQuestions(): Promise<RemotePendingQuestion[]> {
  return pendingRemoteQuestions()
}

export async function remoteHumanApproval(questionId: string, answer: RemoteHumanApproval): Promise<RemoteOperationResult> {
  if (questionId.startsWith('approval:')) {
    const request = host.approvals?.list().find(item => `approval:${item.id}` === questionId)
    return applyHumanApproval(request ? remoteApprovalQuestion(request) : undefined, answer,
      confirmed => host.approvals?.answer(questionId.slice('approval:'.length), confirmed ? 'once' : 'deny') ?? false)
  }
  const question = pendingRemoteQuestions().find(item => item.id === questionId && item.runId === answer.runId)
  const agent = host.runners()?.agentOf(answer.runId)
  if (!agent?.pendingUiRequests().some(item => item.id === questionId)) {
    return { ok: false, status: 404, code: 'question_not_pending', error: '该审批已处理或已过期' }
  }
  return applyHumanApproval(question, answer, confirmed => agent.respondUi({ id: questionId, confirmed }, 'remote'))
}

export async function remoteAnswer(questionId: string, answer: RemoteAnswer): Promise<RemoteOperationResult> {
  if (questionId.startsWith('approval:')) {
    const approvalId = questionId.slice('approval:'.length)
    const request = host.approvals?.list().find(item => item.id === approvalId)
    if (!request) return { ok: false, status: 404, code: 'question_not_pending', error: '该审批已处理或已过期' }
    const declines = ('cancelled' in answer && answer.cancelled === true) || ('confirmed' in answer && answer.confirmed === false)
    if (!declines) {
      return { ok: false, status: 403, code: 'sensitive_confirmation_requires_desktop', error: '这是敏感确认，请在电脑上确认，或通过已配对客户端的人工批准通道处理' }
    }
    if (!host.approvals?.answer(approvalId, 'deny')) return { ok: false, status: 409, code: 'question_not_pending', error: '该审批已处理或已过期' }
    return { ok: true, data: { questionId, runId: request.runId ?? questionId } }
  }
  for (const status of host.runners()?.statuses() ?? []) {
    const agent = host.runners()?.agentOf(status.runId)
    if (!agent?.pendingUiRequests().some((request) => request.id === questionId)) continue
    const result = agent.answerUiRemotely(questionId, answer)
    if (result.ok) return { ok: true, data: { questionId, runId: status.runId } }
    return result.code === 'sensitive_confirmation_requires_desktop'
      ? { ok: false, status: 403, code: result.code, error: '这是敏感确认，请在电脑上确认，或通过已配对客户端的人工批准通道处理' }
      : { ok: false, status: 409, code: result.code, error: '这个问题已经答复或已过期' }
  }
  return { ok: false, status: 404, code: 'question_not_pending', error: '这个问题已经答复或已过期' }
}

export async function remoteArtifact(sessionId: string, artifactId: string): Promise<RemoteArtifactFile | RemoteOperationResult> {
  const summary = (await remoteSessions(500)).find((item) => item.id === sessionId)
  if (!summary) return { ok: false, status: 404, error: '找不到目标会话，可能已被删除' }
  const result = await host.readHistoryWithArtifacts(summary.path)
  const artifact = result?.messages.flatMap((message) => message.artifacts ?? []).find((item) => item.id === artifactId)
  if (!artifact) return { ok: false, status: 404, error: '这个会话里没有这份成果' }
  if (artifact.unavailable) return { ok: false, status: 410, error: '这份成果的文件已被移动或删除' }
  try {
    const info = await stat(artifact.path)
    if (!info.isFile()) return { ok: false, status: 410, error: '这份成果的文件已不可用' }
    if (info.size > REMOTE_ARTIFACT_MAX_BYTES) {
      return { ok: false, status: 413, error: '成果文件超过 10MB，请在电脑上查看' }
    }
    return { path: artifact.path, mediaType: artifact.mediaType, bytes: info.size, filename: artifact.filename }
  } catch {
    return { ok: false, status: 410, error: '这份成果的文件已不可用' }
  }
}

function remoteToolCallsWithImages(calls: UIToolCall[], start: number) {
  let next = start
  return calls.map((call) => {
    const count = call.images?.length ?? 0
    const imageIndexes = Array.from({ length: count }, (_, i) => next + i)
    next += count
    return count ? { ...remoteToolCall(call), imageIndexes } : remoteToolCall(call)
  })
}

export async function remoteMessageImage(sessionId: string, messageId: string, index: number): Promise<RemoteArtifactFile | RemoteOperationResult> {
  const summary = (await remoteSessions(500)).find((item) => item.id === sessionId)
  if (!summary) return { ok: false, status: 404, error: '找不到目标会话' }
  const history = await host.readHistoryWithArtifacts(summary.path)
  const message = history?.messages.find((item) => item.id === messageId)
  const image = message ? [...(message.images ?? []), ...(message.toolCalls ?? []).flatMap((call) => call.images ?? [])][index] : undefined
  const url = image?.url || (image?.data ? localizeImage(join(YAN_DIR, 'attachments'), image.mimeType, image.data) : '')
  if (!url.startsWith('file:')) return { ok: false, status: 404, error: '图片已不可用' }
  try {
    const path = resolve(fileURLToPath(url))
    const directory = resolve(join(YAN_DIR, 'attachments')).toLowerCase()
    if (dirname(path).toLowerCase() !== directory || !/^[a-f0-9]{40}\.(jpg|png|webp|gif)$/.test(basename(path))) return { ok: false, status: 403, error: '图片不在受管目录中' }
    const info = await stat(path)
    if (!info.isFile() || info.size > REMOTE_ARTIFACT_MAX_BYTES) return { ok: false, status: 413, error: '图片过大，请在电脑查看' }
    return { path, mediaType: image!.mimeType, bytes: info.size, filename: basename(path) }
  } catch { return { ok: false, status: 410, error: '图片已不可用' } }
}

export const peerClient = new PeerClient()

export const peerGrants = new PeerGrantRegistry({
  ask: (request) => {
    host.push({ ch: 'peer-request', payload: request })
    const win = host.win()
    if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true)
  },
  closed: (requestId) => host.push({ ch: 'peer-request-closed', payload: { requestId } }),
  changed: (_grants, revoked) => {
    if (revoked) host.remoteAccess()?.disconnectConnection(revoked)
  }
})

export async function peerSummaryOf(sessionId: string): Promise<SessionSummary | undefined> {
  return (await remoteSessions(Number.MAX_SAFE_INTEGER, true)).find((item) => item.id === sessionId)
}

function cwdKey(value: string): string {
  return resolve(value).replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
}

export function cwdWithin(child: string | undefined, parent: string | undefined): boolean {
  if (!child || !parent) return false
  const inner = cwdKey(child)
  const outer = cwdKey(parent)
  return inner === outer || inner.startsWith(`${outer}/`)
}

async function peerProjectOf(summary: SessionSummary | undefined): Promise<string | null> {
  if (!summary?.projectId) return null
  const project = (await getSettings()).projects.find((item) => item.id === summary.projectId && !item.archived)
  if (!project) return null
  if (cwdWithin(summary.cwd, project.cwd)) return project.id
  const origin = await host.worktreeOriginOf?.(summary.id, summary.cwd).catch(() => null)
  return origin && cwdWithin(origin, project.cwd) ? project.id : null
}

export function peerProjectName(project: { name?: string; cwd: string }, projectNames: Record<string, string> = {}): string {
  return project.name?.trim() || projectNames[project.cwd]?.trim() || basename(project.cwd) || project.cwd
}

export const peerHostHandlers: PeerHostHandlers = {
  async projects() {
    const settings = await getSettings()
    return settings.projects
      .filter((project) => !project.archived)
      .map((project) => ({ id: project.id, name: peerProjectName(project, settings.projectNames) }))
  },
  async sessions(projectIds) {
    const candidates = (await remoteSessions(500, true))
      .filter((summary) => !!summary.projectId && projectIds.includes(summary.projectId))
    const scoped = await Promise.all(candidates.map(async (summary) => ((await peerProjectOf(summary)) === summary.projectId ? summary : null)))
    const list = scoped.filter((summary): summary is SessionSummary => summary !== null)
    return (await filterChainRepresentatives(list)).map(remoteSessionSummary)
  },
  async projectOfSession(sessionId) {
    return await peerProjectOf(await peerSummaryOf(sessionId))
  },
  async projectOfRun(runId) {
    const sessionId = host.runners()?.agentOf(runId)?.getState()?.sessionId
    return sessionId ? await peerProjectOf(await peerSummaryOf(sessionId)) : null
  },
  async exportSession(sessionId) {
    const summary = await peerSummaryOf(sessionId)
    if (!summary?.projectId || !(await peerProjectOf(summary))) return { ok: false, status: 404, error: '找不到目标会话' }
    const history = await host.readHistoryWithArtifacts(summary.path)
    if (!history) return { ok: false, status: 502, error: '无法读取该会话历史' }
    const settings = await getSettings()
    const project = settings.projects.find((item) => item.id === summary.projectId)
    const artifacts: PeerExportedArtifact[] = []
    for (const artifact of history.messages.flatMap((message) => message.artifacts ?? [])) {
      let available = !artifact.unavailable
      if (available) {
        available = await stat(artifact.path).then((info) => info.isFile() && info.size <= PEER_ARTIFACT_MAX_BYTES).catch(() => false)
      }
      artifacts.push({ id: artifact.id, filename: artifact.filename, mediaType: artifact.mediaType, bytes: artifact.bytes, available })
    }
    const exported: PeerSessionExport = {
      version: 1,
      source: {
        computer: hostname(),
        sessionId: summary.id,
        projectId: summary.projectId,
        projectName: peerProjectName(project ?? { cwd: summary.cwd }, settings.projectNames),
        title: summary.title,
        exportedAt: Date.now(),
        updatedAt: summary.updatedAt,
        messageCount: summary.messageCount
      },
      messages: history.messages.map((message) => ({
        ...message,
        ...(message.images ? { images: message.images.map((image) => ({ mimeType: image.mimeType, data: '' })) } : {}),
        ...(message.toolCalls ? { toolCalls: message.toolCalls.map((tool) => ({ ...tool, images: undefined })) } : {}),
        ...(message.artifacts ? { artifacts: message.artifacts.map(remoteArtifactOf) } : {})
      })),
      artifacts,
      truncated: history.truncated > 0
    }
    return { ok: true, data: exported }
  },
  async startSession(projectId, text) {
    const project = (await getSettings()).projects.find((item) => item.id === projectId && !item.archived)
    if (!project) return { ok: false, status: 404, error: '找不到这个项目' }
    if (!host.runners()) {
      const started = await host.startAgent()
      if (!started.ok) return { ok: false, status: 503, error: started.error ?? 'pi 未运行' }
    }
    const cwdResult = await host.validateCwd(project.cwd)
    if (!cwdResult.ok) return { ok: false, status: 409, error: cwdResult.error }
    const registry = host.runners()!
    const selected = await registry.select({ cwd: cwdResult.cwd, projectId: project.id, scope: 'project', activate: false })
    if (!selected.ok || !selected.id) return { ok: false, status: 409, error: selected.error ?? '无法为新任务准备运行实例' }
    const agent = registry.agentOf(selected.id)
    const generation = selected.generation
    const sessionId = selected.sessionId
    const current = () => host.runners() === registry && registry.agentOf(selected.id!) === agent &&
      generation !== undefined && registry.runtimeOf(selected.id!)?.generation === generation &&
      agent?.getState()?.sessionId === sessionId
    if (!agent || !sessionId || generation === undefined || !current()) return { ok: false, status: 409, error: '新任务运行实例已变化' }
    await host.rememberRunnerSession(selected, { cwd: cwdResult.cwd, projectId: project.id, scope: 'project' })
    if (!current()) return { ok: false, status: 409, error: '新任务运行实例已变化' }
    const sent = await agent.send(text, undefined, undefined, undefined, generation)
    host.pushRunners()
    if (!sent.ok) return { ok: false, status: 409, error: sent.error ?? '新任务未能接收消息' }
    return { ok: true, data: { sessionId: sessionId ?? null, runId: selected.runId ?? selected.id, projectId: project.id } }
  }
}

export async function remoteSetSessionFlag(sessionId: string, flags: { pinned?: boolean; archived?: boolean }): Promise<RemoteOperationResult> {
  const resolved = await resolveChainSession(sessionId)
  if (!resolved.ok) return resolved
  const summary = resolved.summary
  if (flags.archived === true && host.runners()?.statuses().some((item) => item.sessionId === summary.id && (item.running || item.waiting))) {
    return { ok: false, status: 409, error: '会话正在运行，不能归档' }
  }
  try {
    await setSessionFlags({ sessionId: summary.id, sessionFile: summary.path, cwd: summary.cwd }, flags)
  } catch (error) {
    return { ok: false, status: 500, error: error instanceof Error ? error.message : String(error) }
  }
  sessionsCache = null
  host.pushRunners()
  return { ok: true, data: { sessionId: summary.id, ...flags } }
}

export async function remoteDeleteSession(sessionId: string): Promise<RemoteOperationResult> {
  const resolved = await resolveChainSession(sessionId)
  if (!resolved.ok) return resolved
  const result = await deleteSessionChain(host, resolved.summary.path)
  sessionsCache = null
  return result.ok ? { ok: true, data: { sessionId: resolved.summary.id } } : { ok: false, status: 409, error: result.error ?? '删除失败' }
}

export async function remoteCompact(sessionId: string): Promise<RemoteOperationResult> {
  return withRemoteSession(sessionId, async (agent) => {
    const state = agent.getState()
    if (state?.isAgentRunning || state?.isStreaming || state?.isCompacting || agent.hasRunningBash()) return { ok: false, status: 409, error: '任务完成后可压缩上下文' }
    const result = await agent.compact()
    host.pushRunners()
    return result.ok ? { ok: true, data: { sessionId } } : { ok: false, status: 409, error: result.error ?? '压缩失败' }
  })
}

export async function remoteSearch(query: string, limit = 30): Promise<RemoteOperationResult> {
  const text = query.trim().slice(0, 200)
  if (!text) return { ok: true, data: { hits: [] } }
  const [found, summaries] = await Promise.all([searchSessionText(text, Math.min(Math.max(limit, 1), 50), 'remote'), remoteSessions(500)])
  const byPath = new Map(summaries.map((item) => [normalizeChainKey(item.path), item]))
  const hits = found.hits.flatMap((hit) => {
    const summary = byPath.get(normalizeChainKey(hit.path))
    return summary ? [{ sessionId: summary.id, snippet: clip(hit.snippet, 200) ?? '', matches: hit.matches }] : []
  })
  return { ok: true, data: { hits } }
}

async function gitContextOf(sessionId: string): Promise<{ ok: true; summary: SessionSummary } | { ok: false; status: number; error: string }> {
  const resolved = await resolveChainSession(sessionId, { allowUnsaved: true })
  return resolved
}

export async function remoteBranches(sessionId: string): Promise<RemoteOperationResult> {
  const resolved = await gitContextOf(sessionId)
  if (!resolved.ok) return resolved
  try {
    const repo = await resolveRepo(resolved.summary.cwd)
    if (!repo) return { ok: true, data: { repo: false, branches: [], current: null, detached: false } }
    const listing = await listRefs(repo.root)
    const busy = new Set(listing.busyBranches)
    const branches = listing.refs
      .filter((ref) => ref.kind === 'local')
      .slice(0, 100)
      .map((ref) => ({ name: ref.ref, current: ref.current, ...(busy.has(ref.ref) && !ref.current ? { busy: true } : {}) }))
    return { ok: true, data: { repo: true, branches, current: listing.currentBranch, detached: listing.currentBranch === null } }
  } catch (error) {
    return { ok: false, status: 500, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function remoteSwitchBranch(sessionId: string, branch: string): Promise<RemoteOperationResult> {
  const resolved = await gitContextOf(sessionId)
  if (!resolved.ok) return resolved
  const summary = resolved.summary
  if (host.runners()?.statuses().some((item) => item.sessionId === summary.id && (item.running || item.waiting))) {
    return { ok: false, status: 409, error: '任务完成后可切换分支' }
  }
  try {
    const repo = await resolveRepo(summary.cwd)
    if (!repo) return { ok: false, status: 409, error: '这个目录不在 Git 仓库里' }
    const listing = await listRefs(repo.root)
    if (!listing.refs.some((ref) => ref.kind === 'local' && ref.ref === branch)) return { ok: false, status: 404, error: '找不到这个本地分支' }
    const snapshot = await readRepoSnapshot(repo)
    const result = await runGitAction({ requestId: randomUUID(), cwd: summary.cwd, kind: 'switch-branch', branch, expected: snapshot.expected })
    if (!result.ok) return { ok: false, status: 409, error: (result as { failure?: { message?: string } }).failure?.message ?? '切换分支失败' }
    return { ok: true, data: { branch } }
  } catch (error) {
    return { ok: false, status: 500, error: error instanceof Error ? error.message : String(error) }
  }
}
