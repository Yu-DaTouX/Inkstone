import { randomUUID } from 'node:crypto'

export const NATIVE_COMMAND = '__inkstone_native'
export const RECEIPT_PREFIX = '__inkstone_native_receipt__:'
export const ENVELOPE_VERSION = 1

export const DEFAULT_TIMEOUT_MS = 15_000
export const RELOAD_TIMEOUT_MS = 120_000

export interface NativeReceipt {
  v: number
  id: string
  op: string
  ok: boolean
  phase?: string
  result?: Record<string, unknown>
  error?: { code?: string; message?: string }
}

export interface NativeRpcResponse {
  success?: boolean
  command?: string
  data?: unknown
  error?: unknown
}

function responseData(response: NativeRpcResponse): Record<string, unknown> {
  return response.data && typeof response.data === 'object' && !Array.isArray(response.data)
    ? (response.data as Record<string, unknown>)
    : {}
}

export interface NativeSessionTransport {
  command(
    type: string,
    payload?: Record<string, unknown>,
    opts?: { id?: string; timeoutMs?: number }
  ): Promise<NativeRpcResponse>
}

export class NativeBridgeError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'bridge_unavailable'
      | 'command_not_handled'
      | 'timeout'
      | 'busy'
      | 'rpc_failed'
      | 'extension_error'
  ) {
    super(message)
    this.name = 'NativeBridgeError'
  }
}

interface PendingRequest {
  op: string
  timer: ReturnType<typeof setTimeout>
  resolve: (receipt: NativeReceipt) => void
  reject: (error: Error) => void
}

export interface ScopedModelEntry {
  key: string
  provider: string
  id: string
  name: string
  thinkingLevel?: string
}

export interface ScopedModelsSnapshot {
  scopedModels: ScopedModelEntry[]
  enabledModels: string[]
  scopeIsAll: boolean
}

export interface ScopedModelsSaveResult {
  ok: boolean
  requiresRestart: boolean
  enabledModels: string[]
  settingsPath: string
  note: string
}

export interface ProjectTrustSnapshot {
  cwd: string
  effectiveTrusted: boolean
  explicitDecision: boolean
  ancestorTrustPath: string | null
  entry: string | null
}

export interface NavigateTreeResult {
  ok: boolean
  cancelled: boolean
  entryId: string
  leafId: string | null
  branchIds: string[]
  sessionFile?: string | null
}

export interface ReloadResult {
  ok: boolean
  requiresRestart?: boolean
}

export interface ProjectTrustSaveResult {
  ok: boolean
  requiresRestart: boolean
}

export function encodeEnvelope(id: string, op: string, args: Record<string, unknown>): string {
  const json = JSON.stringify({ v: ENVELOPE_VERSION, host: 'inkstone', id, op, args })
  return Buffer.from(json, 'utf8').toString('base64url')
}

export function parseReceipt(message: unknown): NativeReceipt | null {
  const text = String(message ?? '')
  if (!text.startsWith(RECEIPT_PREFIX)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(RECEIPT_PREFIX.length))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const receipt = parsed as Partial<NativeReceipt>
  if (receipt.v !== ENVELOPE_VERSION) return null
  if (typeof receipt.id !== 'string' || typeof receipt.op !== 'string') return null
  if (typeof receipt.ok !== 'boolean') return null
  return receipt as NativeReceipt
}

function toScopedModelEntry(raw: Record<string, unknown>): ScopedModelEntry {
  const provider = String(raw.provider ?? '')
  const id = String(raw.id ?? '')
  return {
    key: `${provider}/${id}`,
    provider,
    id,
    name: String(raw.name ?? id),
    ...(typeof raw.thinkingLevel === 'string' ? { thinkingLevel: raw.thinkingLevel } : {})
  }
}

export class NativeSessionRuntime {
  private readonly pending = new Map<string, PendingRequest>()
  private ready = false
  private capabilities: readonly string[] = []
  private helloInfo: { reason?: string } | null = null
  private readonly readyWaiters = new Set<() => void>()

  constructor(
    private readonly transport: NativeSessionTransport,
    private readonly defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS
  ) {}

  get isReady(): boolean {
    return this.ready
  }

  get bridgeCapabilities(): readonly string[] {
    return this.capabilities
  }

  get lastHello(): { reason?: string } | null {
    return this.helloInfo
  }

  handleNotify(message: unknown): boolean {
    const receipt = parseReceipt(message)
    if (!receipt) return false

    if (receipt.op === 'hello') {
      this.ready = true
      this.helloInfo = {
        ...(typeof receipt.result?.reason === 'string' ? { reason: receipt.result.reason } : {})
      }
      const list = receipt.result?.capabilities
      this.capabilities = Array.isArray(list)
        ? list.filter((item): item is string => typeof item === 'string')
        : []
      for (const wake of this.readyWaiters) wake()
      this.readyWaiters.clear()
      return true
    }

    const pending = this.pending.get(receipt.id)
    if (pending) {
      this.pending.delete(receipt.id)
      clearTimeout(pending.timer)
      if (receipt.ok) pending.resolve(receipt)
      else {
        const code = receipt.error?.code === 'busy' ? 'busy' : 'extension_error'
        pending.reject(new NativeBridgeError(receipt.error?.message ?? `原生操作失败：${pending.op}`, code))
      }
    }
    return true
  }

  handleUi(req: Record<string, unknown>): boolean {
    if (String(req?.method ?? '') !== 'notify') return false
    return this.handleNotify(req?.message)
  }

  whenReady(timeoutMs: number = this.defaultTimeoutMs): Promise<void> {
    if (this.ready) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const wake = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        this.readyWaiters.delete(wake)
        reject(
          new NativeBridgeError(
            '原生会话桥未就绪（未收到扩展报到），请确认已把 native-session-bridge.js 作为 --extension 注入',
            'bridge_unavailable'
          )
        )
      }, timeoutMs)
      this.readyWaiters.add(wake)
    })
  }

  dispose(reason = 'pi 进程已退出'): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new NativeBridgeError(reason, 'rpc_failed'))
    }
    this.pending.clear()
    this.ready = false
    this.capabilities = []
    this.helloInfo = null
    for (const wake of this.readyWaiters) wake()
    this.readyWaiters.clear()
  }

  private async invoke(op: string, args: Record<string, unknown>, timeoutMs: number): Promise<NativeReceipt> {
    if (!this.ready) {
      throw new NativeBridgeError(
        '原生会话桥未就绪：尚未收到扩展报到，命令不会发出（避免被当成提问交给模型）',
        'bridge_unavailable'
      )
    }
    const id = `inkstone-native-${randomUUID()}`
    const message = `/${NATIVE_COMMAND} ${encodeEnvelope(id, op, args)}`

    const receiptPromise = new Promise<NativeReceipt>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new NativeBridgeError(`原生操作 ${op} 超时（${timeoutMs}ms）`, 'timeout'))
      }, timeoutMs)
      this.pending.set(id, { op, timer, resolve, reject })
    })

    void receiptPromise.catch(() => undefined)

    const abandon = (error: NativeBridgeError): never => {
      const pending = this.pending.get(id)
      if (pending) {
        this.pending.delete(id)
        clearTimeout(pending.timer)
        pending.reject(error)
      }
      throw error
    }

    let response: NativeRpcResponse
    try {
      response = await this.transport.command('prompt', { message }, { id: `inkstone-native-rpc-${randomUUID()}`, timeoutMs })
    } catch (error) {
      return abandon(
        new NativeBridgeError(`${op} 的 RPC 发送失败：${error instanceof Error ? error.message : String(error)}`, 'rpc_failed')
      )
    }

    if (response.success !== true) {
      return abandon(
        new NativeBridgeError(`${op} 被 pi 拒绝：${JSON.stringify(response.error ?? response)}`, 'rpc_failed')
      )
    }
    if (responseData(response).disposition !== 'handled') {
      return abandon(
        new NativeBridgeError(
          `${op} 未被扩展命令识别（disposition=${String(responseData(response).disposition ?? 'unknown')}），命令可能已进入模型，已中止`,
          'command_not_handled'
        )
      )
    }
    return receiptPromise
  }

  async navigateTree(entryId: string, _options?: { summarize?: boolean }): Promise<NavigateTreeResult> {
    const receipt = await this.invoke('navigate_tree', { targetId: entryId }, this.defaultTimeoutMs)
    const result = (receipt.result ?? {}) as Record<string, unknown>
    return {
      ok: true,
      cancelled: result.cancelled === true,
      entryId,
      leafId: typeof result.leafId === 'string' ? result.leafId : null,
      branchIds: Array.isArray(result.branchIds)
        ? result.branchIds.filter((item): item is string => typeof item === 'string')
        : [],
      ...(result.sessionFile === undefined ? {} : { sessionFile: (result.sessionFile as string | null) ?? null })
    }
  }

  async reload(): Promise<ReloadResult> {
    await this.invoke('reload', {}, RELOAD_TIMEOUT_MS)
    return { ok: true }
  }

  async getScopedModels(): Promise<ScopedModelsSnapshot> {
    const receipt = await this.invoke('scoped_models_read', {}, this.defaultTimeoutMs)
    const result = (receipt.result ?? {}) as Record<string, unknown>
    const scopedModels = Array.isArray(result.scoped)
      ? result.scoped
          .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
          .map(toScopedModelEntry)
      : []
    const enabledModels = Array.isArray(result.enabledModels)
      ? result.enabledModels.filter((item): item is string => typeof item === 'string')
      : []
    return { scopedModels, enabledModels, scopeIsAll: enabledModels.length === 0 }
  }

  async saveScopedModels(modelIds: string[]): Promise<ScopedModelsSaveResult> {
    const receipt = await this.invoke('scoped_models_set', { patterns: modelIds }, this.defaultTimeoutMs)
    const result = (receipt.result ?? {}) as Record<string, unknown>
    const enabledModels = Array.isArray(result.patterns)
      ? result.patterns.filter((item): item is string => typeof item === 'string')
      : []
    return {
      ok: true,
      requiresRestart: true,
      enabledModels,
      settingsPath: String(result.settingsFile ?? ''),
      note:
        enabledModels.length === 0
          ? '已保存为「全部模型可用」；需要重建运行实例后生效。'
          : '已保存模型范围；需要重建运行实例后生效。'
    }
  }

  async getProjectTrust(): Promise<ProjectTrustSnapshot> {
    const receipt = await this.invoke('trust_read', {}, this.defaultTimeoutMs)
    const result = (receipt.result ?? {}) as Record<string, unknown>
    const cwd = String(result.cwd ?? '')
    const entry = typeof result.entry === 'string' ? result.entry : null
    const effectiveTrusted = typeof result.effectiveTrusted === 'boolean' ? result.effectiveTrusted : result.decision === true
    const explicitDecision = effectiveTrusted && entry === cwd
    return {
      cwd,
      effectiveTrusted,
      explicitDecision,
      ancestorTrustPath: effectiveTrusted && entry !== cwd ? entry : null,
      entry
    }
  }

  async saveProjectTrust(trusted: boolean): Promise<ProjectTrustSaveResult> {
    await this.invoke('trust_save', { decision: trusted }, this.defaultTimeoutMs)
    return { ok: true, requiresRestart: true }
  }
}
