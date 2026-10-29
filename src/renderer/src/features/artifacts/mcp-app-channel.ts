import { AppBridge, McpUiHostContextSchema, McpUiHostCapabilitiesSchema, type McpUiHostContext, type McpUiDisplayMode } from '@modelcontextprotocol/ext-apps/app-bridge'
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/client'
import { McpAppTransport, type McpAppWindowLike, type McpAppFrameWindowLike } from './mcp-app-transport'
import { clampMcpAppSize, type McpAppChannelPhase } from './mcp-app-frame-model'

export type { McpAppMessageEvent, McpAppWindowLike, McpAppFrameWindowLike } from './mcp-app-transport'

export interface McpAppDispatchApi {
  dispatch(instanceId: string, message: unknown): Promise<unknown>
}

export interface McpAppChannelOptions {
  instanceId: string
  api: McpAppDispatchApi
  window: McpAppWindowLike
  getFrame: () => McpAppFrameWindowLike | null
  loadHostContext?: () => Promise<unknown>
  hooks?: {
    onPhase?(phase: McpAppChannelPhase): void
    onSizeChanged?(height: number): void
    onDisplayMode?(mode: McpUiDisplayMode): void
    onTeardown?(): void
    onRejected?(reason: string, method: string | null): void
  }
}

export class McpAppChannel {
  private bridge: AppBridge | null = null
  private transport: McpAppTransport | null = null
  private phase: McpAppChannelPhase = 'idle'
  private generation = 0
  private requestId = 0
  private readonly requestPrefix = `host-${globalThis.crypto.randomUUID()}`
  private contextRequest = 0
  private context: McpUiHostContext = {}
  private displayMode: McpUiDisplayMode = 'inline'
  private dimensions: McpUiHostContext['containerDimensions']
  private disposal: Promise<void> | null = null
  private readonly listeners = new Set<(phase: McpAppChannelPhase) => void>()

  constructor(private readonly options: McpAppChannelOptions) {}

  getPhase(): McpAppChannelPhase { return this.phase }
  getGeneration(): number { return this.generation }

  subscribe(listener: (phase: McpAppChannelPhase) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  attach(): void {
    if (this.transport || this.phase === 'closed') return
    const generation = this.generation
    const transport = new McpAppTransport(this.options.window, this.options.getFrame, (reason, method) => this.options.hooks?.onRejected?.(reason, method))
    this.transport = transport
    void this.start(transport, generation).catch(() => {
      if (generation !== this.generation || this.phase === 'closed') return
      void transport.close()
      this.options.hooks?.onRejected?.('host-error', null)
    })
  }

  nextGeneration(): number {
    if (this.phase === 'closed') return this.generation
    this.generation++
    this.contextRequest++
    void this.transport?.close()
    void this.bridge?.close()
    this.transport = null
    this.bridge = null
    this.context = {}
    this.setPhase('idle')
    this.attach()
    return this.generation
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.generation++
    this.setPhase('closed')
    const bridge = this.bridge
    const transport = this.transport
    this.bridge = null
    this.transport = null
    this.disposal = bridge
      ? bridge.teardownResource({}, { timeout: 500 }).catch(() => undefined).then(() => bridge.close())
      : transport?.close() ?? Promise.resolve()
    return this.disposal
  }

  setDisplayMode(mode: McpUiDisplayMode): void {
    this.displayMode = mode
    this.updateContext()
  }

  setContainerDimensions(width: number, height: number): void {
    this.dimensions = { width, height }
    this.updateContext()
  }

  requestHostContext(): void {
    const load = this.options.loadHostContext
    if (!load || this.phase === 'closed') return
    const generation = this.generation
    const request = ++this.contextRequest
    void load().then((raw) => {
      if (generation !== this.generation || request !== this.contextRequest || this.phase === 'closed') return
      const parsed = McpUiHostContextSchema.safeParse(raw)
      if (!parsed.success) return
      this.context = parsed.data
      this.updateContext()
    }).catch(() => undefined)
  }

  private async start(transport: McpAppTransport, generation: number): Promise<void> {
    const initial = await this.dispatch('inkstone/activate', {}) as Record<string, unknown>
    if (generation !== this.generation || this.phase === 'closed') return
    this.context = { ...McpUiHostContextSchema.parse(initial.hostContext ?? {}), ...this.context }
    const capabilities = McpUiHostCapabilitiesSchema.parse(initial.hostCapabilities ?? { serverTools: {}, serverResources: {}, sandbox: { permissions: {} } })
    const bridge = new AppBridge(null, { name: 'Inkstone', version: '0.13.0' }, capabilities, { hostContext: this.currentContext() })
    this.bridge = bridge
    bridge.oncalltool = async (params) => {
      this.assertReady(generation)
      return await this.dispatch('tools/call', params) as CallToolResult
    }
    bridge.onreadresource = async (params) => {
      this.assertReady(generation)
      return await this.dispatch('resources/read', params) as ReadResourceResult
    }
    bridge.onlistresources = async () => {
      this.assertReady(generation)
      return await this.dispatch('resources/list', {}) as { resources: [] }
    }
    bridge.onlistresourcetemplates = async () => {
      this.assertReady(generation)
      return { resourceTemplates: [] }
    }
    bridge.setRequestHandler('tools/list', async () => {
      this.assertReady(generation)
      return await this.dispatch('tools/list', {}) as { tools: [] }
    })
    if (capabilities.openLinks) bridge.onopenlink = async (params) => {
      this.assertReady(generation)
      return await this.dispatch('ui/open-link', params) as { isError?: boolean }
    }
    if (capabilities.message) bridge.onmessage = async (params) => {
      this.assertReady(generation)
      return await this.dispatch('ui/message', params) as { isError?: boolean }
    }
    if (capabilities.downloadFile) bridge.ondownloadfile = async (params) => {
      this.assertReady(generation)
      return await this.dispatch('ui/download-file', params) as { isError?: boolean }
    }
    bridge.onrequestdisplaymode = async ({ mode }) => {
      this.assertReady(generation)
      const modes = bridge.getAppCapabilities()?.availableDisplayModes
      if (!modes || modes.includes(mode)) {
        this.setDisplayMode(mode)
        this.options.hooks?.onDisplayMode?.(mode)
      }
      return { mode: this.displayMode }
    }
    bridge.addEventListener('initialized', () => {
      if (generation !== this.generation || this.phase === 'closed' || this.phase === 'ready') return
      this.setPhase('ready')
      this.updateContext()
      void this.dispatch('inkstone/tool-data', {}).then(async (raw) => {
        if (generation !== this.generation || this.phase !== 'ready') return
        const data = raw as { arguments?: Record<string, unknown>; result?: CallToolResult }
        await bridge.sendToolInput({ arguments: data.arguments ?? {} })
        if (data.result) await bridge.sendToolResult(data.result)
      }).catch(() => undefined)
    })
    bridge.addEventListener('sizechange', ({ height }) => {
      if (this.phase !== 'ready' || generation !== this.generation) return
      const value = clampMcpAppSize(height)
      if (value !== null) this.options.hooks?.onSizeChanged?.(value)
    })
    bridge.addEventListener('requestteardown', () => {
      if (this.phase !== 'ready' || generation !== this.generation) return
      void this.dispose().finally(() => this.options.hooks?.onTeardown?.())
    })
    this.setPhase('initializing')
    await bridge.connect(transport)
  }

  private assertReady(generation: number): void {
    if (generation !== this.generation || this.phase !== 'ready') throw new Error('App 尚未完成初始化或实例已释放')
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    const envelope = await this.options.api.dispatch(this.options.instanceId, { jsonrpc: '2.0', id: `${this.requestPrefix}-${++this.requestId}`, method, params }) as { result?: unknown; error?: { message?: string } }
    if (envelope?.error) throw new Error(envelope.error.message ?? '宿主拒绝请求')
    if (!envelope || !Object.prototype.hasOwnProperty.call(envelope, 'result')) throw new Error('宿主响应无效')
    return envelope.result
  }

  private currentContext(): McpUiHostContext {
    return { ...this.context, displayMode: this.displayMode, availableDisplayModes: ['inline', 'fullscreen', 'pip'], ...(this.dimensions ? { containerDimensions: this.dimensions } : {}) }
  }

  private updateContext(): void {
    if (this.phase === 'ready') this.bridge?.setHostContext(this.currentContext())
  }

  private setPhase(phase: McpAppChannelPhase): void {
    this.phase = phase
    this.options.hooks?.onPhase?.(phase)
    for (const listener of this.listeners) listener(phase)
  }
}
