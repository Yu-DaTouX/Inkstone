export type {
  AuxLocale,
  AuxModelOption,
  AuxProjectOption,
  AuxSessionRef,
  AuxTarget,
  QuickAskErrorCode,
  QuickAskResult,
  QuickAskStateView,
  QuickAskSubmit
} from '../../shared/aux-types'

import type { QuickAskResult, QuickAskStateView, QuickAskSubmit } from '../../shared/aux-types'

export type AuxPush = { ch: 'quick-ask'; payload: { kind: 'show' } | { kind: 'submitting' } | { kind: 'result'; result: QuickAskResult } }

export interface AuxBridge {
  quickAsk: {
    state(): Promise<QuickAskStateView>
    submit(payload: QuickAskSubmit): Promise<QuickAskResult>
    close(): void
  }
  onPush(cb: (msg: AuxPush) => void): () => void
}

export function auxBridge(): AuxBridge | null {
  return (window as unknown as { auxBridge?: AuxBridge }).auxBridge ?? null
}
