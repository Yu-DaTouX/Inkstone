/**
 * 原生会话桥（宿主侧）—— 走薄扩展 `resources/pi-extensions/native-session-bridge.js`
 * 触达 pi 的命令级原生能力，并把结果与宿主 Promise 对上。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它解决什么问题
 * ══════════════════════════════════════════════════════════════════
 * pi 1.2.0 的 `ctx.navigateTree()` / `ctx.reload()` 只在
 * `ExtensionCommandContext` 上（官方 extensions.md「Context and session changes」），
 * RPC 没有对应命令。宿主不能直接调用 pi 引擎，于是让随包扩展注册一个**宿主专用**
 * 命令，宿主用 RPC `prompt` 发 `/__inkstone_native <base64url(JSON)>`，扩展在命令处理器
 * 里代调，再用 `ctx.ui.notify` 发 JSON 回执。本模块负责：编码请求、拦截回执、
 * 匹配 request id、处理超时与「命令没被 pi 识别」这两种失败。
 *
 * ── 为什么不会进入模型 ──
 *   pi 收到以 `/` 开头的输入会先查扩展命令表，命中即执行并回 `disposition: "handled"`，
 *   不会进入模型上下文。本模块在发命令前要求**已收到过 hello 报到**（说明命令确实
 *   注册成功）；若响应不是 `handled`，立刻以 `command_not_handled` 报错，绝不重发成
 *   普通提问。这样即使扩展加载失败，也不会把命令交给模型。
 *
 * ── 接线 ──
 *   `AgentController` 用现有 `PiRpc` 构造本类（`{ command }`），并在
 *   `rpc.on('ui', ...)` 里对 `method === 'notify'` 先调 `handleNotify(req.message)`；
 *   返回 true 表示这是本桥回执、已消费，不要再往界面转发。宿主操作前应确保会话空闲
 *   （Agent 侧已挡一道，扩展侧还会用 `ctx.isIdle()` 再挡一道）。
 *   扩展本身只由宿主用 `--extension` 显式加载（`nativeSessionExtensionPath()`）。
 *
 * ── 边界 ──
 *   · 只发一个宿主专用命令，不注册模型工具；模型的输入通道到不了这里；
 *   · `reload` 用「完成后回执」判定成功，宿主不能拿 `prompt` 被接受当已完成；
 *   · `saveScopedModels` / `saveProjectTrust` 只写 pi 的官方格式文件，标注生效范围，
 *     不谎称当前进程已改变；项目信任只应由用户显式确认后写入；
 *   · 桥不可用、命令没被识别、超时都抛**带 code 的错误**，由调用方如实报限制。
 */
import { randomUUID } from 'node:crypto'

/** 与扩展侧保持一致的常量。 */
export const NATIVE_COMMAND = '__inkstone_native'
export const RECEIPT_PREFIX = '__inkstone_native_receipt__:'
export const ENVELOPE_VERSION = 1

/** 默认等待回执的时间；reload 另给更长上限。 */
export const DEFAULT_TIMEOUT_MS = 15_000
export const RELOAD_TIMEOUT_MS = 120_000

/** 桥回执里携带的宿主可消费数据。 */
export interface NativeReceipt {
  v: number
  id: string
  op: string
  ok: boolean
  phase?: string
  result?: Record<string, unknown>
  error?: { code?: string; message?: string }
}

/** RPC `prompt` 响应里与本桥相关的字段（兼容 `shared/ipc.ts` 的 `RpcResponse`）。 */
export interface NativeRpcResponse {
  success?: boolean
  command?: string
  data?: unknown
  error?: unknown
}

/** 从 RPC 响应里取 `data` 记录，非对象按空处理。 */
function responseData(response: NativeRpcResponse): Record<string, unknown> {
  return response.data && typeof response.data === 'object' && !Array.isArray(response.data)
    ? (response.data as Record<string, unknown>)
    : {}
}

/**
 * 依赖注入面：只要求一个与 `PiRpc.command()` 同形的发送函数。
 * 这样本模块不 import 任何宿主单例，测试也能直接注入假 transport。
 */
export interface NativeSessionTransport {
  command(
    type: string,
    payload?: Record<string, unknown>,
    opts?: { id?: string; timeoutMs?: number }
  ): Promise<NativeRpcResponse>
}

/** 桥不可用 / 命令没被识别 / 超时 / 扩展报错 / RPC 失败的统一错误类型。 */
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

/** 一条 scoped model；`key` 是保存给 pi 的 `provider/id` pattern。 */
export interface ScopedModelEntry {
  key: string
  provider: string
  id: string
  name: string
  thinkingLevel?: string
}

export interface ScopedModelsSnapshot {
  /** 当前运行时实际解析出的 scoped models。 */
  scopedModels: ScopedModelEntry[]
  /** 用户级设置里的原始 pattern。 */
  enabledModels: string[]
  /** `enabledModels` 为空 = 全部可用（pi 语义）。 */
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
  /** 查询目录的规范化绝对路径。 */
  cwd: string
  /** pi 是否认该目录的项目级资源。 */
  effectiveTrusted: boolean
  /** 该目录自身是否有明确的 `true` 条目。 */
  explicitDecision: boolean
  /** 由某个祖先目录授予信任时，那条祖先路径；否则 null。 */
  ancestorTrustPath: string | null
  /** `trust.json` 里向上命中的条目路径（不论 true/false），没有则 null。 */
  entry: string | null
}

export interface NavigateTreeResult {
  ok: boolean
  cancelled: boolean
  /** 请求导航到的条目 id（原样回显，便于宿主核对）。 */
  entryId: string
  /** 导航后会话真正的叶子；用户消息目标会落在其父节点。 */
  leafId: string | null
  /** 当前实际分支（叶子 → 根）的条目 id。 */
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

/** base64url 编码宿主请求信封（扩展侧 `parseEnvelope` 的逆运算）。 */
export function encodeEnvelope(id: string, op: string, args: Record<string, unknown>): string {
  const json = JSON.stringify({ v: ENVELOPE_VERSION, host: 'inkstone', id, op, args })
  return Buffer.from(json, 'utf8').toString('base64url')
}

/**
 * 从 notify 文本解析回执；不是本桥回执返回 null。
 * 与扩展侧 `parseReceipt` 同一份格式定义。
 */
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

/** 把扩展返回的 scoped 条目映射成宿主类型。 */
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

/**
 * 宿主侧桥。生命周期与一个 pi 子进程实例一致；pi 重建后应重新构造。
 */
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

  /** 是否已经收到过扩展报到（命令已注册）。 */
  get isReady(): boolean {
    return this.ready
  }

  /** 扩展自报的能力清单（诊断用）。 */
  get bridgeCapabilities(): readonly string[] {
    return this.capabilities
  }

  /** 最近一次 hello 的原因（startup / reload）。 */
  get lastHello(): { reason?: string } | null {
    return this.helloInfo
  }

  /**
   * 处理一条 pi `extension_ui_request` 的 notify 文本。
   *
   * 返回 true 表示「这是本桥回执，已消费」——调用方不应再把它当通知展示。
   */
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
    /* 前缀匹配但已无对应请求（例如宿主已超时）时仍消费掉，避免漏给界面。 */
    return true
  }

  /**
   * 便捷入口：直接吃 `extension_ui_request` 对象（测试与其它调用方用）。
   * 只有 `method === 'notify'` 才可能是本桥回执。
   */
  handleUi(req: Record<string, unknown>): boolean {
    if (String(req?.method ?? '') !== 'notify') return false
    return this.handleNotify(req?.message)
  }

  /** 等待扩展报到；超时抛 `bridge_unavailable`。 */
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

  /** pi 进程退出 / 重建时清掉挂起请求。 */
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

    // Attach rejection handling before awaiting RPC acceptance; the receipt can time out first.
    void receiptPromise.catch(() => undefined)

    /** 取消挂起并清计时器；失败分支不应留下永不结算的请求。 */
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
      /*
       * 关键安全分支：命令没被扩展识别。此时 pi 可能已经把它当普通提问处理，
       * 宿主必须报错并停止，绝不能重发 —— 重发就是「把命令交给模型」。
       */
      return abandon(
        new NativeBridgeError(
          `${op} 未被扩展命令识别（disposition=${String(responseData(response).disposition ?? 'unknown')}），命令可能已进入模型，已中止`,
          'command_not_handled'
        )
      )
    }
    return receiptPromise
  }

  /**
   * 跳到会话树里的某条。扩展固定 `summarize:false`：导航不会自动触发模型摘要。
   * `options.summarize` 只做兼容接收，任何值都不会开启摘要。
   * 返回**导航后的实际叶子**与当前分支条目 id。
   */
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

  /**
   * 重载扩展 / 技能 / 提示 / 主题 / 上下文文件。以扩展「reload 完成」回执为准；
   * `prompt` 被接受不代表已完成。
   */
  async reload(): Promise<ReloadResult> {
    await this.invoke('reload', {}, RELOAD_TIMEOUT_MS)
    return { ok: true }
  }

  /** 读当前 scoped models（运行时解析结果 + 用户级原始 pattern）。 */
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

  /**
   * 持久化用户级 `enabledModels`（scoped models 的官方设置字段）。
   *
   * ⚠️ 真实限制：pi 没有给扩展「设置当前运行时 scoped models」的公共 API
   * （`AgentSession.setScopedModels` 只被 interactive 的 `/scoped-models` 用），
   * 所以这条命令只写设置文件，**当前会话不会立刻改变**，生效于下一次会话 / 进程；
   * 需要 `requiresRestart: true` 时的处理由调用方决定（重建运行实例）。
   */
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

  /** 读 pi 的 trust.json 决定的、作用于当前会话目录的项目信任状态。 */
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

  /**
   * 保存当前会话目录的项目信任决定。
   *
   * ⚠️ 只应由**用户显式确认**后调用（IPC 层已先走 approval 面板）。这里不做确认，
   * 也不允许模型触发 —— 命令不是模型工具，宿主入口也只在小空闲时开。
   */
  async saveProjectTrust(trusted: boolean): Promise<ProjectTrustSaveResult> {
    await this.invoke('trust_save', { decision: trusted }, this.defaultTimeoutMs)
    return { ok: true, requiresRestart: true }
  }
}
