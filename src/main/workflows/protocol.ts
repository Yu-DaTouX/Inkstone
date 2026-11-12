import type { WorkflowAgentOptions } from './agent-options'
import type { AgentReply } from './sandbox'

export type WorkerToHost =
  | { type: 'agent'; seq: number; prompt: string; options: WorkflowAgentOptions }
  | { type: 'phase'; title: string }
  | { type: 'log'; text: string }
  | { type: 'fatal'; error: string }
  | { type: 'done'; json: string }
  | { type: 'failed'; error: string }

export type HostToWorker = { type: 'agent-result'; seq: number; reply: AgentReply }
