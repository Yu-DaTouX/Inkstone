/**
 * 远程宿主：手机接入（远程协议 v2）与砚对砚所有者一侧的业务处理。
 *
 * 远程入口只拿到这里的处理器：会话摘要与历史（不含绝对路径）、有限的会话操作、
 * 问题回答、成果与图片读取，以及按本次连接授权开放的项目数据。
 * 桌面 IPC 与远程共用同一套运行注册表与会话规则；入口在启动前用
 * `configureRemoteHost` 接上这些宿主能力。
 */
import type { BrowserWindow } from 'electron'
import { nativeImage } from 'electron'
import { join, dirname, basename, resolve } from 'node:path'
import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { hostname } from 'node:os'
import { remoteHistoryPage } from '../shared/remote-history-page'
import { localizeImage } from './image-store'
import { setManualTitle } from './title'
import { getSettings } from './settings'
import { listSessions } from './sessions'
import { PeerGrantRegistry } from './peer-grants'
import { PeerClient } from './peer-client'
import type { PeerHostHandlers, RemoteArtifactFile, RemoteCommand, RemoteOperationResult } from './remote-server'
import { PEER_ARTIFACT_MAX_BYTES } from '../shared/peer-protocol'
import type { PeerExportedArtifact, PeerKnowledgeExport, PeerSessionExport } from '../shared/peer-protocol'
import { REMOTE_ARTIFACT_MAX_BYTES } from '../shared/remote-protocol'
import type { RemoteAnswer, RemoteArtifact, RemotePendingQuestion } from '../shared/remote-protocol'
import { normalizeChainKey, isRepresentative, chainForFile } from '../shared/session-chain'
import { YAN_DIR } from './paths'
import { listKnowledge } from './project-memory-store'
import type { AssistantArtifact, RunnerStatus, SessionState, SessionSummary } from '../shared/ipc'
import type { RemoteAccess } from './remote-access'
import type { SessionHost } from './session-host'
import type { AgentController } from './agent'

export interface RemoteHost extends SessionHost {
  win(): BrowserWindow | null
  remoteAccess(): RemoteAccess | null
}

let host: RemoteHost

/** 入口启动时调用一次；远程服务只在这之后才会启动。 */
export function configureRemoteHost(next: RemoteHost): void {
  host = next
}

/* -------------------------------------------------------------------------- */
/* Android 远程管理                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 远程 API 不返回会话文件绝对路径：手机只需要稳定 id 和展示信息，
 * 路径解析始终由主进程按 id 查找，避免网络请求变成任意文件读取入口。
 */
export function remoteSessionSummary(summary: SessionSummary): Record<string, unknown> {
  return {
    id: summary.id,
    title: summary.title,
    named: summary.named,
    ...(summary.parentSession ? { parentSession: summary.parentSession } : {}),
    ...(summary.branchOrigin ? { branchOrigin: summary.branchOrigin } : {}),
    ...(summary.lastActivityAt !== undefined ? { lastActivityAt: summary.lastActivityAt } : {}),
    ...(summary.lastReply ? { lastReply: summary.lastReply } : {}),
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    messageCount: summary.messageCount,
    ...(summary.model ? { model: summary.model } : {}),
    ...(summary.projectId ? { projectId: summary.projectId } : {}),
    ...(summary.scope ? { scope: summary.scope } : {}),
    ...(summary.lastOpenedAt !== undefined ? { lastOpenedAt: summary.lastOpenedAt } : {}),
    ...(summary.projectCandidates?.length ? { projectCandidates: summary.projectCandidates } : {}),
    cwdName: basename(summary.cwd) || summary.cwd
  }
}

/** SessionState 的远程降敏版本；cwd 只留目录名，sessionFile 不出进程。 */
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
    ...(state.compaction ? { compaction: state.compaction } : {}),
    ...(state.lastCompaction ? { lastCompaction: state.lastCompaction } : {}),
    messageCount: state.messageCount,
    pendingMessageCount: state.pendingMessageCount,
    cwdName: basename(state.cwd) || state.cwd,
    ...(state.autoCompactionEnabled !== undefined ? { autoCompactionEnabled: state.autoCompactionEnabled } : {}),
    ...(state.contextPolicy ? { contextPolicy: state.contextPolicy } : {}),
    ...(state.steeringMode ? { steeringMode: state.steeringMode } : {}),
    ...(state.followUpMode ? { followUpMode: state.followUpMode } : {})
  }
}

export function remoteRunnerStatus(status: RunnerStatus): Record<string, unknown> {
  const model = host.runners()?.agentOf(status.runId)?.getState()?.model
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

export async function remoteSnapshot(): Promise<Record<string, unknown>> {
  const settings = await getSettings()
  const summaries = await listSessions(200, settings.projects)
  const state = host.ac()?.getState() ?? null
  const connection = host.ac()?.getConn() ?? { state: 'exited' as const, detail: 'pi 未运行' }
  const win = host.win()
  const windowReady = !!win && !win.isDestroyed()
  return {
    apiVersion: 1,
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

/**
 * 侧栏列表只显示**代表段**（实施-05 S5b-4）。
 *
 * 交接后磁盘上确实是两份 JSONL，但用户看到的是**同一条会话** —— 把旧段也列出来
 * 会让用户以为凭空多了两条。规则：
 *   · 不在任何链上 / 是链的最后一段 → 显示；
 *   · 是链上的旧段 → 隐藏；
 *   · 代表段的标题为空（新段往往还没标题）→ 用**链首段**的标题顶上，
 *     否则侧栏上那条会话会变成一行「未命名」（用户看到自己的会话“换了名字”）。
 *
 * 路径与 id 仍是代表段的：打开 / 发送都落在当前活动段。
 */
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

export async function remoteHistory(sessionId: string, limit: number, before?: string): Promise<RemoteOperationResult> {
  const settings = await getSettings()
  const summary = (await listSessions(500, settings.projects)).find((item) => item.id === sessionId)
  if (!summary) return { ok: false, status: 404, error: '找不到目标会话，可能已被删除' }

  /* 链感知：远程端看到的也是「一条会话」（与桌面端口径一致） */
  const result = await host.readHistoryWithArtifacts(summary.path)
  if (!result) return { ok: false, status: 502, error: '无法读取该会话历史' }
  const page = remoteHistoryPage(result.messages, limit, before)
  if (!page) return { ok: false, status: 409, error: '会话历史已变化，请重新打开', code: 'history_cursor_expired' }
  const messages = page.messages.map((message) => ({
    ...message,
    ...(message.images ? { images: message.images.map((image) => ({ mimeType: image.mimeType, data: '' })) } : {}),
    ...(message.toolCalls ? { toolCalls: message.toolCalls.map((tool) => ({ ...tool, images: undefined })) } : {}),
    ...(message.artifacts ? { artifacts: message.artifacts.map(remoteArtifactOf) } : {})
  }))
  return {
    ok: true,
    data: {
      session: remoteSessionSummary(summary),
      messages,
      total: result.total,
      returned: messages.length,
      hasMore: page.hasMore,
      nextBefore: page.nextBefore,
      truncated: result.truncated,
      bytes: result.bytes
    }
  }
}

/** 通过稳定 sessionId 切换当前桌面查看实例，并复用现有 runner 规则。 */
export async function remoteSelectSession(sessionId: string): Promise<RemoteOperationResult> {
  const settings = await getSettings()
  const summary = (await listSessions(500, settings.projects)).find((item) => item.id === sessionId)
  if (!summary) return { ok: false, status: 404, error: '找不到目标会话，可能已被删除' }

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
    sessionFile: summary.path,
    sessionId: summary.id,
    cwd: cwdResult.cwd,
    projectId,
    scope: summary.scope
  })
  await host.rememberRunnerSession(result, {
    sessionFile: summary.path,
    cwd: cwdResult.cwd,
    projectId,
    scope: summary.scope
  })
  if (result.ok && result.id) void host.pushRunnerSnapshot(result.id)
  host.pushRunners()
  return result.ok ? { ok: true, data: result } : { ok: false, status: 409, error: result.error }
}

export async function remoteNewSession(): Promise<RemoteOperationResult> {
  const settings = await getSettings()
  if (!host.runners()) {
    const started = await host.startAgent()
    if (!started.ok) return { ok: false, status: 503, error: started.error ?? 'pi 未运行' }
  }
  const cwdResult = await host.validateCwd(settings.cwd)
  if (!cwdResult.ok) return { ok: false, status: 409, error: cwdResult.error }
  const projectId = host.projectIdForCwd(settings, cwdResult.cwd)
  const scope = projectId ? 'project' as const : 'global' as const
  const result = await host.runners()!.select({ cwd: cwdResult.cwd, projectId, scope })
  await host.rememberRunnerSession(result, { cwd: cwdResult.cwd, projectId, scope })
  if (result.ok && result.id) void host.pushRunnerSnapshot(result.id)
  host.pushRunners()
  return result.ok ? { ok: true, data: result } : { ok: false, status: 409, error: result.error }
}

/** 直接向目标会话发送，不改变桌面当前视图；必要时创建后台 runner。 */
export async function withRemoteSession(sessionId: string, operation: (agent: AgentController, runId: string) => Promise<RemoteOperationResult>): Promise<RemoteOperationResult> {
  const settings = await getSettings()
  const summary = (await listSessions(500, settings.projects)).find((item) => item.id === sessionId)
  if (!summary) return { ok: false, status: 404, error: '找不到目标会话，可能已被删除' }

  if (!host.runners()) {
    const started = await host.startAgent()
    if (!started.ok) return { ok: false, status: 503, error: started.error ?? 'pi 未运行' }
  }
  const cwdResult = await host.validateCwd(summary.cwd)
  if (!cwdResult.ok) return { ok: false, status: 409, error: cwdResult.error }
  const projectId = summary.scope === 'global'
    ? undefined
    : (summary.projectId ?? host.projectIdForCwd(settings, cwdResult.cwd))
  const selected = await host.runners()!.select({
    sessionFile: summary.path,
    sessionId: summary.id,
    cwd: cwdResult.cwd,
    projectId,
    scope: summary.scope,
    activate: false
  })
  if (!selected.ok || !selected.id) {
    return { ok: false, status: 409, error: selected.error ?? '无法为目标会话准备后台运行实例' }
  }
  if (host.runners()!.hasBusyCwd(cwdResult.cwd, selected.id)) {
    return { ok: false, status: 409, error: '同一工作目录的另一个运行实例正在工作，暂不向目标会话发送以避免并发写入' }
  }
  await host.rememberRunnerSession(selected, {
    sessionFile: summary.path,
    cwd: cwdResult.cwd,
    projectId,
    scope: summary.scope
  })
  const agent = host.runners()!.agentOf(selected.id)
  if (!agent) return { ok: false, status: 503, error: '目标运行实例已退出' }
  host.pushRunners()
  return operation(agent, selected.runId!)
}

export async function remoteModels(sessionId: string): Promise<RemoteOperationResult> {
  const summary = (await listSessions(500, (await getSettings()).projects)).find((item) => item.id === sessionId)
  if (!summary) return { ok: false, status: 404, error: '找不到目标会话' }
  const status = host.runners()?.statuses().find((item) => item.sessionId === sessionId)
  const agent = status ? host.runners()?.agentOf(status.runId) : host.ac()
  if (!agent) return { ok: false, status: 503, error: '请先在电脑启动模型连接' }
  const models = await agent.listModels()
  const current = status ? agent.getState()?.model : models.find((model) => summary.model === model.id || summary.model === `${model.provider}/${model.id}` || summary.model === `${model.provider}:${model.id}`)
  return { ok: true, data: { models: models.map(({ id, provider, name, input }) => ({ id, provider, name, input })), current: current ? { id: current.id, provider: current.provider, name: current.name, input: current.input } : null } }
}

export async function executeRemoteCommand(command: RemoteCommand): Promise<RemoteOperationResult> {
  if (command.action === 'select') return remoteSelectSession(command.sessionId)
  if (command.action === 'new') return remoteNewSession()

  if (command.action === 'send') {
    if (command.images?.some((image) => nativeImage.createFromBuffer(Buffer.from(image.data, 'base64')).isEmpty())) return { ok: false, status: 400, error: '图片无法解码，请重新选择' }
    return withRemoteSession(command.sessionId, async (agent, runId) => {
      const model = agent.getState()?.model
      if (command.images?.length && model?.input && !model.input.includes('image')) return { ok: false, status: 409, error: '当前模型不支持图片，请选择支持图片的模型' }
      const result = await agent.send(command.text, command.images)
      return result.ok ? { ok: true, data: { ...result, runId, sessionId: command.sessionId } } : { ok: false, status: 409, error: result.error ?? '目标会话未能接收消息' }
    })
  }
  if (command.action === 'model') {
    return withRemoteSession(command.sessionId, async (agent) => {
      const state = agent.getState()
      if (state?.isAgentRunning || state?.isStreaming || state?.isCompacting || agent.hasRunningBash()) return { ok: false, status: 409, error: '任务完成后可切换模型' }
      const model = (await agent.listModels()).find((item) => item.provider === command.provider && item.id === command.modelId)
      if (!model) return { ok: false, status: 400, error: '模型不在电脑可用列表中' }
      const latest = agent.getState()
      if (latest?.isAgentRunning || latest?.isStreaming || latest?.isCompacting || agent.hasRunningBash()) return { ok: false, status: 409, error: '任务完成后可切换模型' }
      const result = await agent.setModel(model.provider, model.id)
      host.pushRunners()
      return result.ok ? { ok: true, data: { current: { id: model.id, provider: model.provider, name: model.name, input: model.input } } } : { ok: false, status: 409, error: result.error }
    })
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

  const settings = await getSettings()
  const summary = (await listSessions(500, settings.projects)).find((item) => item.id === command.sessionId)
  if (!summary) return { ok: false, status: 404, error: '找不到目标会话，可能已被删除' }
  const saved = await setManualTitle(command.sessionId, command.name)
  if (!saved.ok) return { ok: false, status: 500, error: saved.error ?? '保存会话名称失败' }
  if (host.ac()?.getState()?.sessionId === command.sessionId) {
    const renamed = await host.ac()!.renameSession(command.name)
    if (!renamed.ok) return { ok: false, status: 409, error: renamed.error ?? '当前会话名称未能同步到 pi' }
  }
  host.push({ ch: 'session-title', payload: { sessionId: command.sessionId, title: command.name } })
  return { ok: true, data: { sessionId: command.sessionId, name: command.name } }
}

/** 远程端能看到的成果字段：去掉电脑上的绝对路径（内容经 artifact 接口按 id 读取） */
export function remoteArtifactOf(artifact: AssistantArtifact): RemoteArtifact {
  return {
    id: artifact.id,
    filename: artifact.filename,
    mediaType: artifact.mediaType,
    kind: artifact.kind,
    bytes: artifact.bytes,
    createdAt: artifact.createdAt,
    previewable: artifact.previewable,
    ...(artifact.unavailable ? { unavailable: true } : {})
  }
}

/** 当前所有运行实例里等待回答的问题（手机端列出用） */
export async function remoteQuestions(): Promise<RemotePendingQuestion[]> {
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
        ...(request.placeholder ? { placeholder: request.placeholder } : {}),
        sensitive: request.sensitive === true,
        deadline: typeof (request as { deadline?: unknown }).deadline === 'number' ? (request as { deadline: number }).deadline : 0
      })
    }
  }
  return questions
}

/** 手机回答问题：找到持有这个问题的实例；敏感确认由 AgentController 拒绝 */
export async function remoteAnswer(questionId: string, answer: RemoteAnswer): Promise<RemoteOperationResult> {
  for (const status of host.runners()?.statuses() ?? []) {
    const agent = host.runners()?.agentOf(status.runId)
    if (!agent?.pendingUiRequests().some((request) => request.id === questionId)) continue
    const result = agent.answerUiRemotely(questionId, answer)
    if (result.ok) return { ok: true, data: { questionId, runId: status.runId } }
    return result.code === 'sensitive_confirmation_requires_desktop'
      ? { ok: false, status: 403, code: result.code, error: '这是敏感确认（删除、授权或付费等），需要在电脑上处理' }
      : { ok: false, status: 409, code: result.code, error: '这个问题已经答复或已过期' }
  }
  return { ok: false, status: 404, code: 'question_not_pending', error: '这个问题已经答复或已过期' }
}

/** 按会话 + 成果 id 找受管文件；只认该会话历史里登记过的成果，网络请求不能传路径 */
export async function remoteArtifact(sessionId: string, artifactId: string): Promise<RemoteArtifactFile | RemoteOperationResult> {
  const settings = await getSettings()
  const summary = (await listSessions(500, settings.projects)).find((item) => item.id === sessionId)
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

/** Only images registered in this session and localized in the managed attachment directory. */
export async function remoteMessageImage(sessionId: string, messageId: string, index: number): Promise<RemoteArtifactFile | RemoteOperationResult> {
  const summary = (await listSessions(500, (await getSettings()).projects)).find((item) => item.id === sessionId)
  if (!summary) return { ok: false, status: 404, error: '找不到目标会话' }
  const history = await host.readHistoryWithArtifacts(summary.path)
  const image = history?.messages.find((message) => message.id === messageId)?.images?.[index]
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

/* -------------------------------------------------------------------------- */
/* 砚对砚：所有者一侧（本次连接授权 + 按项目开放的数据）                      */
/* -------------------------------------------------------------------------- */

/**
 * 审批请求推给界面；决定经 `yan:peer-host:decide` 回来。
 * 某次连接作废（断开 / 撤销 / 超时）时断开它的事件流。
 */
/** 这台电脑去连接别的砚（连接者一侧） */
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
  const settings = await getSettings()
  return (await listSessions(500, settings.projects)).find((item) => item.id === sessionId)
}

export const peerHostHandlers: PeerHostHandlers = {
  async projects() {
    return (await getSettings()).projects.filter((project) => !project.archived).map((project) => ({ id: project.id, name: project.name }))
  },
  async sessions(projectIds) {
    const settings = await getSettings()
    return (await listSessions(500, settings.projects))
      .filter((summary) => !!summary.projectId && projectIds.includes(summary.projectId))
      .map(remoteSessionSummary)
  },
  async projectOfSession(sessionId) {
    return (await peerSummaryOf(sessionId))?.projectId ?? null
  },
  async projectOfRun(runId) {
    return host.runners()?.statuses().find((status) => status.runId === runId)?.projectId ?? null
  },
  /* 复制一份会话：消息降敏（不带绝对路径与内嵌图片），成果逐个标明源文件是否还在 */
  async exportSession(sessionId) {
    const summary = await peerSummaryOf(sessionId)
    if (!summary?.projectId) return { ok: false, status: 404, error: '找不到目标会话' }
    const history = await host.readHistoryWithArtifacts(summary.path)
    if (!history) return { ok: false, status: 502, error: '无法读取该会话历史' }
    const project = (await getSettings()).projects.find((item) => item.id === summary.projectId)
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
        projectName: project?.name ?? basename(summary.cwd),
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
  /*
   * 在开放项目里新开任务：后台准备运行实例（不切换桌面当前视图），
   * 新建会话后发出第一条消息。项目目录只从本机设置取，网络请求不能传路径。
   */
  async startSession(projectId, text) {
    const project = (await getSettings()).projects.find((item) => item.id === projectId && !item.archived)
    if (!project) return { ok: false, status: 404, error: '找不到这个项目' }
    if (!host.runners()) {
      const started = await host.startAgent()
      if (!started.ok) return { ok: false, status: 503, error: started.error ?? 'pi 未运行' }
    }
    const cwdResult = await host.validateCwd(project.cwd)
    if (!cwdResult.ok) return { ok: false, status: 409, error: cwdResult.error }
    const selected = await host.runners()!.select({ cwd: cwdResult.cwd, projectId: project.id, scope: 'project', activate: false })
    if (!selected.ok || !selected.id) return { ok: false, status: 409, error: selected.error ?? '无法为新任务准备运行实例' }
    const agent = host.runners()!.agentOf(selected.id)
    if (!agent) return { ok: false, status: 503, error: '运行实例已退出' }
    const sent = await agent.send(text)
    const sessionId = agent.getState()?.sessionId ?? selected.sessionId
    await host.rememberRunnerSession({ ...selected, sessionId }, { cwd: cwdResult.cwd, projectId: project.id, scope: 'project' })
    host.pushRunners()
    if (!sent.ok) return { ok: false, status: 409, error: sent.error ?? '新任务未能接收消息' }
    return { ok: true, data: { sessionId: sessionId ?? null, runId: selected.runId ?? selected.id, projectId: project.id } }
  },
  /* 共享项目记忆：只给已确认条目，保留来源电脑、条目 id 与版本 */
  async knowledge(projectId) {
    const project = (await getSettings()).projects.find((item) => item.id === projectId)
    if (!project) return { ok: false, status: 404, error: '找不到这个项目' }
    try {
      const entries = (await listKnowledge({ projectId, cwd: project.cwd })).filter((entry) => entry.status === 'active')
      const exported: PeerKnowledgeExport = {
        version: 1,
        source: { computer: hostname(), projectId, projectName: project.name, exportedAt: Date.now() },
        entries: entries.map((entry) => ({
          id: entry.id,
          revision: entry.revision,
          kind: entry.kind,
          text: entry.text,
          tags: entry.tags,
          confidenceClass: entry.confidenceClass,
          updatedAt: entry.updatedAt
        }))
      }
      return { ok: true, data: exported }
    } catch (error) {
      return { ok: false, status: 500, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
