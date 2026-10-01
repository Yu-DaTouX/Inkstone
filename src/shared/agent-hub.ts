/** 任务事实、执行尝试与外部会话分开；界面与手机复用同一宿主服务。 */
export type HubAgent = 'pi' | 'codex' | 'claude' | 'gemini' | 'grok'
/** npm packages of the external CLIs: detection reads their entry points, the install action installs them globally. */
export const HUB_CLI_PACKAGES: Record<Exclude<HubAgent, 'pi'>, string> = { codex: '@openai/codex', claude: '@anthropic-ai/claude-code', gemini: '@google/gemini-cli', grok: '@xai-official/grok' }
export type HubMode = 'managed' | 'terminal'
export type HubStatus = 'queued' | 'preparing' | 'running' | 'waiting_input' | 'needs_review' | 'completed' | 'failed' | 'cancelled' | 'uncertain'
/**
 * Agent 过程的活动条目：把执行流打成手机可读的对话，而不是终端文本。
 *   say     agent 的叙述（人话）
 *   tool    工具调用（Shell／读写文件），detail 是命令或参数
 *   patch   改动，detail 是 diff
 *   approval 需要用户动作的一步
 *   note    系统提示（如交接包到达）
 */
export interface HubActivity {
  id: string
  at: number
  kind: 'say' | 'tool' | 'patch' | 'approval' | 'note'
  title?: string
  text: string
  detail?: string
  status?: 'running' | 'done' | 'failed'
}
/** A file the user attached; stored by the host outside every workspace so it never enters a delivered patch. */
export interface HubAttachment { name: string; path: string; image: boolean }
/** Attachment upload from a client: base64 content, written by the host. */
export interface HubAttachmentInput { name: string; data: string; mime?: string }
/** Who started a task: shown as the source of its instruction. */
export type HubOrigin = 'desktop' | 'phone' | 'session' | 'run'
export interface HubTask {
  id: string
  createdBy?: HubOrigin
  parentTaskId?: string
  /** 关联主会话，由可信宿主核对项目，不从终端输出推断。 */
  parentSessionId?: string
  title: string
  prompt: string
  agent: HubAgent
  mode: HubMode
  projectId: string
  status: HubStatus
  createdAt: number
  updatedAt: number
  runId?: string
  externalSessionId?: string
  terminalId?: string
  baseline?: string
  workspace?: string
  reviewOf?: string
  artifact?: { patchPath: string; sha256: string; tree: string; reportPath: string }
  /** Start from the project's uncommitted changes: frozen at launch and applied before the agent starts; not part of the delivered patch. */
  includeWorkingChanges?: boolean
  startArtifact?: { patchPath: string; sha256: string; tree: string; reportPath: string; files: number }
  /** Tree the delivered patch is measured from when a start patch was applied. */
  startTree?: string
  /** Non-git folders run interactive terminals in place: no worktree, no frozen patch. */
  inPlace?: boolean
  workspaceRemoved?: boolean
  attachments?: HubAttachment[]
  report?: string
  error?: string
  model?: string
  reasoningEffort?: 'low' | 'medium' | 'high'
  timeoutMinutes: number
  inputOwner?: string
  inputEpoch?: number
  inputExpiresAt?: number
  /** 过程活动（有界）；受管运行由宿主事件投影，纯终端运行为空。 */
  activity?: HubActivity[]
  toolCoverage: 'managed-entrypoints' | 'uncoordinated'
}
export interface HubApproval {
  id: string
  taskId: string
  runId: string
  kind: 'command' | 'file' | 'question'
  title: string
  detail: string
  expiresAt: number
  status: 'pending' | 'sent' | 'resolved' | 'expired' | 'uncertain'
  answer?: 'accept' | 'decline'
  questions?: Array<{ id: string; question: string; options?: string[] }>
  answers?: Record<string, string>
}
export interface HubRun {
  id: string
  taskId: string
  startedAt: number
  finishedAt?: number
  status: HubStatus
  agent: HubAgent
  mode: HubMode
  model?: string
  reasoningEffort?: 'low' | 'medium' | 'high'
  externalSessionId?: string
  baseline?: string
  artifact?: HubTask['artifact']
  report?: string
  error?: string
}
/**
 * Agent 能力矩阵：交接与状态按能力降级，不假定所有 CLI 都能结构化调用。
 *   lifecycle  宿主能给出可靠运行状态（受管协议）
 *   handoff    能接收结构化交接包（注入成回合输入）
 *   terminal   可跑交互终端
 *   screenState 可读屏辅助判断状态（辅助，非权威）
 */
export type HubCapability = 'lifecycle' | 'handoff' | 'terminal' | 'screenState'
/**
 * 交接包：把一次运行的参考资料交给另一个运行。
 * 沿用现有契约——只传参考资料，不授予新权限，不自动合并或推送。
 */
export interface HubPacket {
  id: string
  fromTaskId?: string
  toTaskId: string
  projectId: string
  basis?: { baseline?: string; workspace?: string; artifact?: HubTask['artifact'] }
  summary: string
  request?: string
  context?: string
  createdAt: number
}
/** 时间线条目：谁在什么时候把什么发给了谁，以及投递结果。 */
export interface HubMessage {
  id: string
  taskId: string
  fromTaskId?: string
  fromRunId?: string
  toRunId?: string
  parentSessionId?: string
  requestKey?: string
  kind: 'packet' | 'note' | 'system'
  packet?: HubPacket
  text: string
  delivery: 'queued' | 'injected' | 'typed' | 'failed'
  createdAt: number
  attachments?: HubAttachment[]
}
export interface HubSnapshot {
  tasks: HubTask[]
  runs?: HubRun[]
  templates?: HubTemplate[]
  approvals: HubApproval[]
  resources: Array<{ resourceId: string; owner: string | null; operationId: string | null; epoch: number; uncertain: boolean; paused: boolean; waiting: number }>
  projects: Array<{ id: string; name: string }>
  adapters: Array<{ agent: HubAgent; available: boolean; version?: string; modes: HubMode[]; capabilities?: HubCapability[]; error?: string }>
  /** 时间线：只回最近的有界条数，避免手机端全量快照膨胀。 */
  messages?: HubMessage[]
}
export interface HubCreate {
  parentSessionId?: string
  agent: HubAgent
  mode: HubMode
  projectId: string
  prompt: string
  title?: string
  model?: string
  reasoningEffort?: 'low' | 'medium' | 'high'
  reviewOf?: string
  timeoutMinutes?: number
  requestId: string
  includeWorkingChanges?: boolean
  attachments?: HubAttachmentInput[]
}
export interface HubTemplate {
  id: string
  name: string
  agent: HubAgent
  mode: HubMode
  prompt: string
  model?: string
  reasoningEffort?: 'low' | 'medium' | 'high'
}
export type HubCommand =
  | { action: 'create'; request: HubCreate }
  | { action: 'save-template'; template: HubTemplate }
  | { action: 'delete-template'; id: string }
  | { action: 'cancel'; taskId: string }
  | { action: 'accept'; taskId: string }
  | { action: 'answer'; approvalId: string; answer: 'accept' | 'decline'; answers?: Record<string, string> }
  | { action: 'recover-resource'; resourceId: string; epoch: number }
  | { action: 'claim-input'; taskId: string; epoch: number }
  | { action: 'input'; taskId: string; epoch: number; data: string }
  | { action: 'resize'; taskId: string; epoch: number; cols: number; rows: number }
  | { action: 'resume'; taskId: string }
  | { action: 'inspect'; taskId: string; sinceSeq?: number }
  | { action: 'link-session'; taskId: string; sessionId: string }
  | { action: 'deliver-message'; messageId: string; epoch: number }
  /** 把一份交接包发给另一个运行；来源在宿主侧按调用者推断。 */
  | { action: 'send-packet'; requestId: string; toTaskId: string; summary: string; request?: string; context?: string; attachments?: HubAttachmentInput[] }
  /** Git state of a project's main working tree, for the "bring uncommitted changes" choice. */
  | { action: 'workspace-status'; projectId: string }
  /** Delete a finished task's worktree; the frozen patch and report stay. */
  | { action: 'remove-workspace'; taskId: string }
export const HUB_ACTIVE: readonly HubStatus[] = ['preparing', 'running', 'waiting_input']
export interface HubAttentionItem { id: string; taskId?: string; resourceId?: string }
/** 通知只投影身份与版本；不携带任务文本或审批内容。 */
export function hubAttention(tasks: readonly HubTask[], approvals: readonly HubApproval[], resources: HubSnapshot['resources']): HubAttentionItem[] {
  const items: HubAttentionItem[] = tasks.filter((t) => ['waiting_input', 'needs_review', 'failed', 'uncertain'].includes(t.status)).map((t) => ({
    id: `task:${t.id}:${t.runId ?? 'none'}:${t.status}:${approvals.filter((a) => a.taskId === t.id && a.status === 'pending').map((a) => a.id).sort().join(',')}`,
    taskId: t.id
  }))
  for (const r of resources) if (r.uncertain) items.push({ id: `resource:${r.resourceId}:${r.epoch}`, resourceId: r.resourceId })
  return items
}
