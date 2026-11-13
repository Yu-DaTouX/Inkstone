import type { ApprovalReceipt } from './approval'

export type CapabilityStatus = 'known' | 'unsupported' | 'unknown'

export interface SessionContextUsage {
  tokens: number | null
  contextWindow: number
  percent: number | null
  modelKey?: string
  availability?: CapabilityStatus
  estimated?: boolean
}

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: number
  costEstimated?: boolean
  costCatalog?: boolean
  reasoning?: number
}

export type ResponseDetail = 'brief' | 'standard' | 'detailed' | 'unknown'

export interface QuestionLogEntry {
  id: string
  question: string
  options: string[]
  answer: string | null
  cancelled: boolean
  at: number
}

export interface UIMessageImage {
  mimeType: string
  data: string
  url?: string
}

export interface UIToolCall {
  parentToolCallId?: string
  historySummary?: boolean
  incomplete?: boolean
  nestedCallsIncomplete?: boolean
  id: string
  name: string
  args: unknown
  argsRaw?: string
  status: 'pending' | 'running' | 'ok' | 'error'
  cancelled?: boolean
  denied?: boolean
  approval?: ApprovalReceipt
  serverSide?: boolean
  output?: string
  images?: UIMessageImage[]
  details?: unknown
  startedAt?: number
  endedAt?: number
}

export type TurnTerminalReason = 'completed' | 'stopped' | 'failed' | 'interrupted'

export interface TurnTimingMeta {
  logicalTurnId: string
  startedAt: number
  endedAt: number
  elapsedMs: number
  terminalReason: TurnTerminalReason
}

export interface GenerationTiming {
  durationMs: number
  ttftMs?: number
  decodeMs?: number
  outputDecodeMs?: number
  startEvent?: 'turn_start'
}

export interface UIMessage {
  id: string
  entryId?: string
  role: 'user' | 'assistant' | 'bash' | 'note'
  note?: { kind: 'custom' | 'branchSummary'; customType?: string }
  question?: boolean
  qa?: { question: string; answer?: string }[]
  sourceCwd?: string
  text: string
  images?: UIMessageImage[]
  thinking?: string
  thinkingStartedAt?: number
  thinkingMs?: number
  thinkingLive?: boolean
  thinkingEmpty?: boolean
  toolCalls?: UIToolCall[]
  artifacts?: AssistantArtifact[]
  imageProgress?: ImageGenerationProgress[]
  usage?: Usage
  speed?: number
  elapsedMs?: number
  generationTiming?: GenerationTiming
  turnTiming?: TurnTimingMeta
  responseDetail?: ResponseDetail
  model?: string
  timestamp?: number
  bash?: { command: string; exitCode: number | null; cancelled: boolean }
  error?: string
}

export type ImageGenerationStage =
  | 'queued'
  | 'preparing'
  | 'confirming'
  | 'requesting'
  | 'generating'
  | 'saving'
  | 'done'
  | 'error'

export interface ImageGenerationProgress {
  id: string
  stage: ImageGenerationStage
  startedAt: number
  updatedAt: number
  endedAt?: number
  provider?: string
  model?: string
  detail?: string
}

export interface AssistantArtifact {
  id: string
  sourceId: string
  version?: number
  sha256?: string
  filename: string
  path: string
  sourcePath?: string
  mediaType: string
  kind: 'image' | 'svg' | 'code' | 'document' | 'binary'
  bytes: number
  createdAt: number
  previewable: boolean
  unavailable?: boolean
  error?: string
  provider?: string
  model?: string
  description?: string
}
