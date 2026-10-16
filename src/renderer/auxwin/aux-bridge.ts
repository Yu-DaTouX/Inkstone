/**
 * 辅助小窗的渲染端桥（v3 WP-25d / WP-12）。
 *
 * 窗口由主进程创建，preload 通过 `contextBridge.exposeInMainWorld('auxBridge', …)`
 * 暴露白名单方法。类型在这里本地声明（不与主进程模块交叉 import），镜像
 * `src/main/windows/aux-types.ts` 的形状；两边由宿主接线与回归脚本共同看住。
 */

export type AuxLocale = 'zh-CN' | 'en-US'
export type AuxTarget = 'new' | 'current'
export type MiniStatusKey = 'needs-you' | 'stalled' | 'failed' | 'done' | 'queued' | 'running'
export type QuickAskErrorCode = 'empty' | 'no-current' | 'start-failed' | 'create-failed' | 'model-failed' | 'send-failed' | 'unavailable'

export interface AuxProjectOption {
  id: string
  name: string
  path: string
}

export interface AuxModelOption {
  key: string
  id: string
  label: string
  provider: string
}

export interface AuxSessionRef {
  sessionId?: string
  sessionPath?: string
  projectId?: string
  cwd?: string
  title?: string
}

export interface QuickAskStateView {
  locale: AuxLocale
  projects: AuxProjectOption[]
  models: AuxModelOption[]
  currentSession: AuxSessionRef | null
  defaultTarget: AuxTarget
  defaultProjectId: string | null
  defaultModelId: string | null
  accelerator: string
}

export interface QuickAskSubmit {
  prompt: string
  target: AuxTarget
  projectId?: string | null
  model?: { provider: string; id: string } | null
  expand?: boolean
}

export interface QuickAskResult {
  ok: boolean
  code?: QuickAskErrorCode
  message?: string
  sessionId?: string
  sessionPath?: string
  runId?: string
}

export interface MiniItem {
  runId: string
  code: string
  title: string
  statusKey: MiniStatusKey
  since: number
  unread: boolean
  sessionId: string
  sessionPath?: string
  projectId?: string
}

export interface MiniStateView {
  locale: AuxLocale
  enabled: boolean
  items: MiniItem[]
}

export type AuxPush =
  | { ch: 'quick-ask'; payload: { kind: 'show' } | { kind: 'submitting' } | { kind: 'result'; result: QuickAskResult } }
  | { ch: 'mini'; payload: MiniStateView }

export interface AuxBridge {
  quickAsk: {
    state(): Promise<QuickAskStateView>
    submit(payload: QuickAskSubmit): Promise<QuickAskResult>
    close(): void
  }
  mini: {
    state(): Promise<MiniStateView>
    open(item: MiniItem): void
    close(): void
    setEnabled(enabled: boolean): void
  }
  onPush(cb: (msg: AuxPush) => void): () => void
}

/** 取 preload 暴露的 `auxBridge`；独立打开 html 调试时可能不存在。 */
export function auxBridge(): AuxBridge | null {
  return (window as unknown as { auxBridge?: AuxBridge }).auxBridge ?? null
}
