export interface BundledPluginResult {
  ok: boolean
  installed?: boolean
  status?: unknown
  value?: unknown
  error?: string
}
export interface BundledPluginsBridge {
  action(id: string, action: 'status' | 'install' | 'remove', params?: unknown): Promise<BundledPluginResult>
  invoke(id: string, action: string, params?: unknown): Promise<unknown>
}
