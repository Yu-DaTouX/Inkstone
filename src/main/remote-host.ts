import { userMessageSent } from './browser/user-handoff'
import type { BrowserWindow } from 'electron'
import { nativeImage } from 'electron'
import { join, basename } from 'node:path'
import { stat } from 'node:fs/promises'
import { pick } from '../shared/ui-lang'
import { remoteHistoryPage, remoteToolCall } from '../shared/remote-history-page'
import { approvalDigest, applyHumanApproval, remoteApprovalQuestion } from './remote-approval'
import type { ApprovalBroker } from './approval-broker'
import { localizeImage } from './image-store'
import { cachedTitles, manualTitles, setManualTitle } from './title'
import { getSettings } from './settings'
import { listSessions } from './sessions'
import type { RemoteArtifactFile, RemoteCommand, RemoteOperationResult } from './remote-server'
import { REMOTE_ARTIFACT_MAX_BYTES, REMOTE_INSIGHT_MAX_FILES } from '../shared/remote-protocol'
import type { RemoteChangedFile, RemoteInsight, RemoteSessionChanges, RemoteSessionStats, RemoteAnswer, RemoteArtifact, RemotePendingQuestion, RemoteHumanApproval } from '../shared/remote-protocol'
import { normalizeChainKey, isRepresentative, chainForFile } from '../shared/session-chain'
import { YAN_DIR } from './paths'
import { managedAttachment } from './attachment-file'
import { readChanges } from './git-inspect'
import { listRefs, readRepoSnapshot, resolveRepo } from './git-service'
import { runGitAction } from './git-actions'
import { setSessionFlags } from './session-layout'
import { closeBrowserForSessions } from './session-browser-cleanup'
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
}

let host: RemoteHost

const REMOTE_SESSIONS_TTL_MS = 2000
let sessionsCache: { at: number; limit: number; list: SessionSummary[] } | null = null

export function withDesktopTitles(list: SessionSummary[], manual: Record<string, string>, generated: Record<string, string>): SessionSummary[] {
  return list.map((summary) => {
    const title = manual[summary.id]?.trim() || generated[summary.id]?.trim()
    return title && title !== summary.title ? { ...summary, title, named: summary.named || !!manual[summary.id]?.trim() } : summary
  })
}

async function remoteSessions(limit: number, fresh = false): Promise<SessionSummary[]> {
  const now = Date.now()
  let list: SessionSummary[]
  if (!fresh && sessionsCache && sessionsCache.limit === limit && now - sessionsCache.at < REMOTE_SESSIONS_TTL_MS) list = sessionsCache.list
  else {
    const settings = await getSettings()
    list = await listSessions(limit, settings.projects)
    sessionsCache = { at: now, limit, list }
  }
  const [manual, generated] = await Promise.all([manualTitles().catch(() => ({})), cachedTitles().catch(() => ({}))])
  return withDesktopTitles(list, manual, generated)
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
  const state = host ? host.runners()?.agentOf(status.runId)?.getState() : undefined
  const model = state?.model
  return {
    id: status.id,
    runId: status.runId,
    ...(status.sessionId ? { sessionId: status.sessionId } : {}),
    ...(status.projectId ? { projectId: status.projectId } : {}),
    generation: status.generation,
    cwdName: basename(status.cwd) || status.cwd,
    running: status.running,
    waiting: status.waiting,
    ...(state?.isCompacting ? { compacting: true } : {}),
    ...(state?.retry ? { retry: { attempt: state.retry.attempt, maxAttempts: state.retry.maxAttempts } } : {}),
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
  if (!run) return { ok: false, status: 404, error: pick('找不到这个子 Agent', 'Subagent not found') }
  if (run.status !== 'starting' && run.status !== 'running') return { ok: false, status: 409, error: pick('这个子 Agent已经结束', 'This subagent has already finished') }
  const result = await stop(run.id)
  return result.ok ? { ok: true, data: { id: run.id, status: 'cancelled' } } : { ok: false, status: 409, error: result.error ?? pick('停止失败', 'Stop failed') }
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
  const connection = host.ac()?.getConn() ?? { state: 'exited' as const, detail: pick('pi 未运行', 'pi is not running') }
  const win = host.win()
  const windowReady = !!win && !win.isDestroyed()
  const settings = await getSettings()
  return {
    apiVersion: 1,
    projects: settings.projects
      .filter((project) => !project.archived)
      .map((project) => ({ id: project.id, name: projectDisplayName(project, settings.projectNames), cwd: project.cwd })),
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
    return { ok: false, status: 404, error: pick('找不到目标会话，可能已被删除', 'Session not found. It may have been deleted') }
  }
  await host.sessionChains.load()
  const representativePath = host.sessionChains.representativeOf(requested.path)
  const requestedKey = normalizeChainKey(requested.path)
  if (!representativePath || normalizeChainKey(representativePath) === requestedKey) {
    return { ok: true, summary: requested }
  }
  const representativeKey = normalizeChainKey(representativePath)
  const representative = list.find((item) => normalizeChainKey(item.path) === representativeKey)
  if (!representative) return { ok: false, status: 409, error: pick('会话链的代表段已不可用，请刷新后重试', 'The session chain\'s representative segment is unavailable. Refresh and retry') }
  if ((representative.projectId ?? null) !== (requested.projectId ?? null)) {
    return { ok: false, status: 409, error: pick('该会话链跨项目，已拒绝把操作归一到代表段', 'This session chain spans projects. The operation was not routed to the representative segment') }
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

const QUEUE_ITEMS_MAX = 20
const QUEUE_TEXT_MAX = 500

export function remoteQueueOf(snapshot: { steering: string[]; followUp: string[] } | null | undefined): { steering: string[]; followUp: string[] } | undefined {
  if (!snapshot) return undefined
  const clip = (list: string[]) => list.filter((text) => text.trim() && !text.trimStart().startsWith('<subagent-notification')).slice(0, QUEUE_ITEMS_MAX).map((text) => text.length > QUEUE_TEXT_MAX ? `${text.slice(0, QUEUE_TEXT_MAX)}…` : text)
  const queue = { steering: clip(snapshot.steering), followUp: clip(snapshot.followUp) }
  return queue.steering.length || queue.followUp.length ? queue : undefined
}

function sessionQueue(sessionId: string): { steering: string[]; followUp: string[] } | undefined {
  const status = host.runners()?.statuses().find((item) => item.sessionId === sessionId)
  const agent = status ? host.runners()?.agentOf(status.runId) : null
  try {
    return remoteQueueOf(agent?.queueSnapshot())
  } catch {
    return undefined
  }
}

async function streamingMessage(sessionId: string) {
  const status = host.runners()?.statuses().find((item) => item.sessionId === sessionId)
  const agent = status ? host.runners()?.agentOf(status.runId) : null
  if (!agent) return null
  const [saved, withLive] = await Promise.all([agent.getMessages(), agent.getMessages({ includeStreaming: true })])
  return withLive.length > saved.length ? withLive.at(-1) ?? null : null
}

export async function remoteHistory(sessionId: string, limit: number, before?: string): Promise<RemoteOperationResult> {
  const summary = (await remoteSessions(500)).find((item) => item.id === sessionId)
  const live = before ? null : await streamingMessage(sessionId).catch(() => null)
  if (!summary) {
    const unsaved = unsavedSessionSummary(sessionId)
    if (unsaved) {
      const queue = before ? undefined : sessionQueue(sessionId)
      const messages = live ? [{ ...live, images: undefined }] : []
      return { ok: true, data: { session: remoteSessionSummary(unsaved), messages, ...(queue ? { queue } : {}), total: messages.length, returned: messages.length, hasMore: false, truncated: false, truncatedBytes: 0, bytes: 0 } }
    }
    return { ok: false, status: 404, error: pick('找不到目标会话，可能已被删除', 'Session not found. It may have been deleted') }
  }

  const result = await host.readHistoryWithArtifacts(summary.path)
  if (!result) return { ok: false, status: 502, error: pick('无法读取该会话历史', 'Cannot read this session\'s history') }
  const page = remoteHistoryPage(result.messages, limit, before)
  if (!page) return { ok: false, status: 409, error: pick('会话历史已变化，请重新打开', 'Session history changed. Reopen it'), code: 'history_cursor_expired' }
  const tail = live && !page.messages.some((message) => message.id === live.id) ? [live] : []
  const messages = [...page.messages, ...tail].map((message) => ({
    ...message,
    ...(message.images ? { images: message.images.map((image) => ({ mimeType: image.mimeType, data: '' })) } : {}),
    ...(message.toolCalls ? { toolCalls: remoteToolCallsWithImages(message.toolCalls, message.images?.length ?? 0) } : {}),
    ...(message.artifacts ? { artifacts: message.artifacts.map(remoteArtifactOf) } : {})
  }))
  const plan = before ? undefined : await remotePlan(summary.path, summary.id)
  const queue = before ? undefined : sessionQueue(summary.id)
  return {
    ok: true,
    data: {
      session: remoteSessionSummary(summary),
      messages,
      ...(plan ? { plan } : {}),
      ...(queue ? { queue } : {}),
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
    if (!started.ok) return { ok: false, status: 503, error: started.error ?? pick('pi 未运行', 'pi is not running') }
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
    scope: summary.scope,
    activate: false
  })
  if (result.ok && result.id) void host.pushRunnerSnapshot(result.id)
  host.pushRunners()
  return result.ok ? { ok: true, data: result } : { ok: false, status: 409, error: result.error }
}

export async function remoteNewSession(requestedProjectId?: string): Promise<RemoteOperationResult> {
  const settings = await getSettings()
  const project = requestedProjectId ? settings.projects.find((item) => item.id === requestedProjectId && !item.archived) : undefined
  if (requestedProjectId && !project) return { ok: false, status: 404, error: pick('找不到这个项目', 'Project not found') }
  if (!host.runners()) {
    const started = await host.startAgent()
    if (!started.ok) return { ok: false, status: 503, error: started.error ?? pick('pi 未运行', 'pi is not running') }
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

export async function withRemoteSession(sessionId: string, operation: (agent: AgentController, runId: string, summary: SessionSummary, generation: number, current: () => boolean) => Promise<RemoteOperationResult>, reserve = false): Promise<RemoteOperationResult> {
  const resolved = await resolveChainSession(sessionId, { allowUnsaved: true })
  if (!resolved.ok) return resolved
  const summary = resolved.summary
  const settings = await getSettings()

  if (!host.runners()) {
    const started = await host.startAgent()
    if (!started.ok) return { ok: false, status: 503, error: started.error ?? pick('pi 未运行', 'pi is not running') }
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
    return { ok: false, status: 409, error: selected.error ?? pick('无法为目标会话准备后台运行实例', 'Cannot prepare a background runtime for the session') }
  }
  if (registry.blocksConcurrentRun(cwdResult.cwd, selected.id)) {
    return { ok: false, status: 409, error: pick('同一工作目录的另一个运行实例正在工作，暂不向目标会话发送以避免并发写入', 'Another runtime in the same working folder is busy. Not sending to avoid concurrent writes') }
  }
  const agent = registry.agentOf(selected.id)
  const generation = selected.generation
  const current = () => host.runners() === registry && registry.agentOf(selected.id!) === agent &&
    generation !== undefined && registry.runtimeOf(selected.id!)?.generation === generation &&
    agent?.getState()?.sessionId === summary.id && selected.sessionId === summary.id
  const changed = { ok: false, status: 409, error: pick('目标会话运行实例已变化，请刷新后重试', 'The session\'s runtime changed. Refresh and retry') }
  if (!agent || !current() || generation === undefined) return changed
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
  if (!agent) return { ok: false, status: 503, error: pick('请先在电脑启动模型连接', 'Start the model connection on the computer first') }
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
    if (command.images?.some((image) => nativeImage.createFromBuffer(Buffer.from(image.data, 'base64')).isEmpty())) return { ok: false, status: 400, error: pick('图片无法解码，请重新选择', 'Cannot decode the image. Choose another') }
    return withRemoteSession(command.sessionId, async (agent, runId, summary, generation) => {
      const model = agent.getState()?.model
      if (command.images?.length && model?.input && !model.input.includes('image')) return { ok: false, status: 409, error: pick('当前模型不支持图片，请选择支持图片的模型', 'This model does not support images. Choose one that does') }
      userMessageSent(agent.getState()?.sessionId)
      const result = await agent.send(command.text, command.images, command.mode, undefined, generation)
      return result.ok ? { ok: true, data: { ...result, runId, sessionId: summary.id } } : { ok: false, status: 409, error: result.error ?? pick('目标会话未能接收消息', 'The session could not accept the message') }
    })
  }
  if (command.action === 'model') {
    return withRemoteSession(command.sessionId, async (agent, _runId, _summary, _generation, current) => {
      const model = (await agent.listModels()).find((item) => item.provider === command.provider && item.id === command.modelId)
      if (!model) return { ok: false, status: 400, error: pick('模型不在电脑可用列表中', 'Model is not in the computer\'s available list') }
      if (!current()) return { ok: false, status: 409, error: pick('目标会话运行实例已变化', 'The session\'s runtime changed') }
      const result = await agent.setModel(model.provider, model.id)
      host.pushRunners()
      return result.ok ? { ok: true, data: { current: { id: model.id, provider: model.provider, name: model.name, input: model.input }, pending: !!agent.getState()?.pendingModelChange } } : { ok: false, status: 409, error: result.error }
    }, !sessionBusy(command.sessionId))
  }

  if (command.action === 'thinking') {
    return withRemoteSession(command.sessionId, async (agent, _runId, _summary, _generation, current) => {
      const levels = await agent.listThinkingLevels()
      if (!current()) return { ok: false, status: 409, error: pick('目标会话运行实例已变化', 'The session\'s runtime changed') }
      if (!levels.includes(command.level)) return { ok: false, status: 400, error: pick('当前模型不支持这个思考档位', 'This model does not support this thinking level') }
      const result = await agent.setThinking(command.level)
      host.pushRunners()
      return result.ok ? { ok: true, data: { level: command.level, levels, pending: !!agent.getState()?.pendingModelChange } } : { ok: false, status: 409, error: result.error }
    }, !sessionBusy(command.sessionId))
  }

  if (command.action === 'abort') {
    const agent = host.runners()?.agentOf(command.runId)
    if (!agent) return { ok: false, status: 404, error: pick('找不到目标运行实例', 'Target runtime not found') }
    const state = agent.getState()
    if (!state?.isAgentRunning && !state?.isStreaming && !state?.isCompacting && !agent.hasRunningBash()) {
      return { ok: false, status: 409, error: pick('目标 runId 当前没有正在运行的任务', 'The target runId has no running task') }
    }
    return { ok: true, data: { runId: command.runId, ...(await agent.abort()) } }
  }

  const resolved = await resolveChainSession(command.sessionId)
  if (!resolved.ok) return resolved
  const summary = resolved.summary
  const saved = await setManualTitle(summary.id, command.name)
  if (!saved.ok) return { ok: false, status: 500, error: saved.error ?? pick('保存会话名称失败', 'Failed to save the session name') }
  if (host.ac()?.getState()?.sessionId === summary.id) {
    const renamed = await host.ac()!.renameSession(command.name, summary.id)
    if (!renamed.ok) return { ok: false, status: 409, error: renamed.error ?? pick('当前会话名称未能同步到 pi', 'The session name could not be synced to pi') }
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
      confirmed => host.approvals?.answer(questionId.slice('approval:'.length), !confirmed ? 'deny' : answer.scope === 'session' && request?.kind !== 'move' ? 'session' : 'once') ?? false)
  }
  const question = pendingRemoteQuestions().find(item => item.id === questionId && item.runId === answer.runId)
  const agent = host.runners()?.agentOf(answer.runId)
  if (!agent?.pendingUiRequests().some(item => item.id === questionId)) {
    return { ok: false, status: 404, code: 'question_not_pending', error: pick('该审批已处理或已过期', 'This approval was already handled or has expired') }
  }
  const accepted = applyHumanApproval(question, answer, () => true)
  if (!accepted.ok) return accepted
  const result = await agent.respondUiResult({ id: questionId, confirmed: answer.confirmed }, 'remote')
  return result.ok ? accepted : { ok: false, status: 409, code: 'question_not_pending', error: pick('该审批已处理或已过期', 'This approval was already handled or has expired') }
}

export async function remoteAnswer(questionId: string, answer: RemoteAnswer): Promise<RemoteOperationResult> {
  if (questionId.startsWith('approval:')) {
    const approvalId = questionId.slice('approval:'.length)
    const request = host.approvals?.list().find(item => item.id === approvalId)
    if (!request) return { ok: false, status: 404, code: 'question_not_pending', error: pick('该审批已处理或已过期', 'This approval was already handled or has expired') }
    const declines = ('cancelled' in answer && answer.cancelled === true) || ('confirmed' in answer && answer.confirmed === false)
    if (!declines) {
      return { ok: false, status: 403, code: 'sensitive_confirmation_requires_desktop', error: pick('这是敏感确认，请在电脑上确认，或通过已配对客户端的人工批准通道处理', 'This is a sensitive confirmation. Confirm on the computer or via a paired client\'s manual approval') }
    }
    if (!host.approvals?.answer(approvalId, 'deny')) return { ok: false, status: 409, code: 'question_not_pending', error: pick('该审批已处理或已过期', 'This approval was already handled or has expired') }
    return { ok: true, data: { questionId, runId: request.runId ?? questionId } }
  }
  for (const status of host.runners()?.statuses() ?? []) {
    const agent = host.runners()?.agentOf(status.runId)
    if (!agent?.pendingUiRequests().some((request) => request.id === questionId)) continue
    const result = await agent.answerUiRemotely(questionId, answer)
    if (result.ok) return { ok: true, data: { questionId, runId: status.runId } }
    if (result.code === 'sensitive_confirmation_requires_desktop') {
      return { ok: false, status: 403, code: result.code, error: pick('这是敏感确认，请在电脑上确认，或通过已配对客户端的人工批准通道处理', 'This is a sensitive confirmation. Confirm on the computer or via a paired client\'s manual approval') }
    }
    if (result.code === 'pi_down') {
      return { ok: false, status: 503, code: 'pi_down', error: pick('答案没能送进 pi，问题还没有结束，请重试', 'The answer did not reach pi and the question is still open. Please retry') }
    }
    return { ok: false, status: 409, code: result.code, error: pick('这个问题已经答复或已过期', 'This question was already answered or has expired') }
  }
  return { ok: false, status: 404, code: 'question_not_pending', error: pick('这个问题已经答复或已过期', 'This question was already answered or has expired') }
}

export async function remoteArtifact(sessionId: string, artifactId: string): Promise<RemoteArtifactFile | RemoteOperationResult> {
  const summary = (await remoteSessions(500)).find((item) => item.id === sessionId)
  if (!summary) return { ok: false, status: 404, error: pick('找不到目标会话，可能已被删除', 'Session not found. It may have been deleted') }
  const result = await host.readHistoryWithArtifacts(summary.path)
  const artifact = result?.messages.flatMap((message) => message.artifacts ?? []).find((item) => item.id === artifactId)
  if (!artifact) return { ok: false, status: 404, error: pick('这个会话里没有这份成果', 'This artifact is not in the session') }
  if (artifact.unavailable) return { ok: false, status: 410, error: pick('这份成果的文件已被移动或删除', 'The artifact\'s file was moved or deleted') }
  try {
    const info = await stat(artifact.path)
    if (!info.isFile()) return { ok: false, status: 410, error: pick('这份成果的文件已不可用', 'The artifact\'s file is unavailable') }
    if (info.size > REMOTE_ARTIFACT_MAX_BYTES) {
      return { ok: false, status: 413, error: pick('成果文件超过 10MB，请在电脑上查看', 'Artifact is over 10MB. View it on the computer') }
    }
    return { path: artifact.path, mediaType: artifact.mediaType, bytes: info.size, filename: artifact.filename }
  } catch {
    return { ok: false, status: 410, error: pick('这份成果的文件已不可用', 'The artifact\'s file is unavailable') }
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
  if (!summary) return { ok: false, status: 404, error: pick('找不到目标会话', 'Session not found') }
  const history = await host.readHistoryWithArtifacts(summary.path)
  const message = history?.messages.find((item) => item.id === messageId)
  const image = message ? [...(message.images ?? []), ...(message.toolCalls ?? []).flatMap((call) => call.images ?? [])][index] : undefined
  const url = image?.url || (image?.data ? localizeImage(join(YAN_DIR, 'attachments'), image.mimeType, image.data) : '')
  if (!url.startsWith('file:')) return { ok: false, status: 404, error: pick('图片已不可用', 'Image unavailable') }
  const file = await managedAttachment(url)
  if (!file) return { ok: false, status: 403, error: pick('图片不在受管目录中', 'Image is not in a managed folder') }
  if (file.size > REMOTE_ARTIFACT_MAX_BYTES) return { ok: false, status: 413, error: pick('图片过大，请在电脑查看', 'Image too large. View it on the computer') }
  return { path: file.path, mediaType: image!.mimeType, bytes: file.size, filename: file.name }
}

function projectDisplayName(project: { name?: string; cwd: string }, projectNames: Record<string, string> = {}): string {
  return project.name?.trim() || projectNames[project.cwd]?.trim() || basename(project.cwd) || project.cwd
}

export async function remoteSetSessionFlag(sessionId: string, flags: { pinned?: boolean; archived?: boolean }): Promise<RemoteOperationResult> {
  const resolved = await resolveChainSession(sessionId)
  if (!resolved.ok) return resolved
  const summary = resolved.summary
  if (flags.archived === true && host.runners()?.statuses().some((item) => item.sessionId === summary.id && (item.running || item.waiting))) {
    return { ok: false, status: 409, error: pick('会话正在运行，不能归档', 'Session is running and cannot be archived') }
  }
  try {
    await setSessionFlags({ sessionId: summary.id, sessionFile: summary.path, cwd: summary.cwd }, flags)
    if (flags.archived === true) await closeBrowserForSessions([summary.id], { skip: (id) => host.runners()?.sessionHasPendingWork(id) ?? false })
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
  if (host.runners()?.statuses().some((item) => (item.sessionId === resolved.summary.id || (!!item.sessionFile && normalizeChainKey(item.sessionFile) === normalizeChainKey(resolved.summary.path))) && (item.running || item.waiting))) {
    return { ok: false, status: 409, error: pick('会话正在运行，不能删除', 'Session is running and cannot be deleted') }
  }
  const result = await deleteSessionChain(host, resolved.summary.path)
  sessionsCache = null
  return result.ok ? { ok: true, data: { sessionId: resolved.summary.id } } : { ok: false, status: 409, error: result.error ?? pick('删除失败', 'Delete failed') }
}

export async function remoteCompact(sessionId: string): Promise<RemoteOperationResult> {
  return withRemoteSession(sessionId, async (agent) => {
    const state = agent.getState()
    if (state?.isAgentRunning || state?.isStreaming || state?.isCompacting || agent.hasRunningBash()) return { ok: false, status: 409, error: pick('任务完成后可压缩上下文', 'Compaction is available after the task finishes') }
    const result = await agent.compact()
    host.pushRunners()
    return result.ok ? { ok: true, data: { sessionId } } : { ok: false, status: 409, error: result.error ?? pick('压缩失败', 'Compaction failed') }
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
    return { ok: false, status: 409, error: pick('任务完成后可切换分支', 'Branches can be switched after the task finishes') }
  }
  try {
    const repo = await resolveRepo(summary.cwd)
    if (!repo) return { ok: false, status: 409, error: pick('这个目录不在 Git 仓库里', 'This folder is not in a Git repository') }
    const listing = await listRefs(repo.root)
    if (!listing.refs.some((ref) => ref.kind === 'local' && ref.ref === branch)) return { ok: false, status: 404, error: pick('找不到这个本地分支', 'Local branch not found') }
    const snapshot = await readRepoSnapshot(repo)
    const result = await runGitAction({ requestId: randomUUID(), cwd: summary.cwd, kind: 'switch-branch', branch, expected: snapshot.expected })
    if (!result.ok) return { ok: false, status: 409, error: (result as { failure?: { message?: string } }).failure?.message ?? pick('切换分支失败', 'Switch branch failed') }
    return { ok: true, data: { branch } }
  } catch (error) {
    return { ok: false, status: 500, error: error instanceof Error ? error.message : String(error) }
  }
}
