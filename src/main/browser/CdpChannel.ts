export interface CdpChannel {
  attach(): Promise<void>
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>
  on(method: string, cb: (params: Record<string, unknown>, sessionId?: string) => void): () => void
  screenshot(): Promise<Buffer>
  detach(): Promise<void>
}

export const CDP_DOMAINS = [
  'Page.enable',
  'DOM.enable',
  'DOMSnapshot.enable',
  'Accessibility.enable',
  'Runtime.enable',
  'Network.enable'
] as const
