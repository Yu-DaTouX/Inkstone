/**
 * 旧宿主 MCP → pi 原生导入的设置页流程（纯逻辑，无 React / DOM / IPC 细节）。
 *
 * 为什么单独拆出来：真正容易出错的不是弹窗样式，而是**范围核对**与**分步结果的
 * 如实投影**——prepare 返回后、用户确认后、commit 前，只要运行实例、会话或项目
 * 范围变过，就绝不能把旧预览批准到新范围。这些规则脱离界面可以独立验证（见
 * `scripts/test-mcp-native-import-flow.mjs`，跑真实模块）。
 *
 * 边界：这里只编排顺序与投影，不做文件读写、不发 pi 命令、不接受渲染端指定目录。
 * 预览与提交都由主进程 `prepareNativeImport` / `commitNativeImport` 完成并最终校核。
 */
import type {
  NativeMcpImportCommitResponse,
  NativeMcpImportCommitResult,
  NativeMcpImportPrepareResponse,
  NativeMcpImportPreview,
  NativeMcpImportVerification
} from '../../../../shared/mcp-native-import'

/**
 * 发起导入时的范围快照。`mounted` 单独用于「组件已卸载就不提交」；
 * 其余三项任一变化都说明用户已经看向别处（换 runner / 切会话 / 换项目）。
 */
export interface McpImportScope {
  mounted: boolean
  activeRunnerId: string | null
  sessionId: string
  /** 项目范围键：当前会话 cwd（拿不到会话时退到设置 cwd）。 */
  projectKey: string
}

/** 两个范围快照是否是同一 runner / 会话 / 项目。 */
export function sameMcpImportScope(a: McpImportScope, b: McpImportScope): boolean {
  return (
    a.activeRunnerId === b.activeRunnerId &&
    a.sessionId === b.sessionId &&
    a.projectKey === b.projectKey
  )
}

/**
 * 提交结果里可直接展示的三步事实。**原生写入与旧条目停用是两件事**：
 * `nativeWritten:true` 只代表原生文件已写，`deactivated` 才代表旧条目已停用。
 */
export interface McpImportCommitProjection {
  /** 主进程接受了这次提交并给了分步结果（对应 IPC 的 `ok:true` + `result`）。 */
  accepted: true
  /** 三步整体成功才为 true；部分失败时为 false，但步骤细节仍要展示。 */
  ok: boolean
  serverId: string
  nativeName: string
  targetPath: string
  /** 原生配置是否已写入。 */
  nativeWritten: boolean
  /** 旧条目是否已停用。 */
  deactivated: boolean
  /** pi 校验是否通过。 */
  verified: boolean
  verification: NativeMcpImportVerification | 'skipped'
  steps: NativeMcpImportCommitResult['steps']
  /** 主进程给的分步说明，原样保留（不在这里改写错误细节）。 */
  notice: string
  warnings: string[]
}

/** 把主进程的分步结果投影成展示模型；缺字段时保守地当作 `skipped`，不假装成功。 */
export function projectMcpImportCommit(result: NativeMcpImportCommitResult): McpImportCommitProjection {
  const steps = result.steps ?? { nativeWrite: 'skipped' as const, verify: 'skipped' as const, hostDisable: 'skipped' as const }
  return {
    accepted: true,
    ok: result.ok === true,
    serverId: result.serverId,
    nativeName: result.nativeName,
    targetPath: result.targetPath,
    nativeWritten: result.nativeWritten === true,
    deactivated: result.deactivated === true,
    verified: result.verified === true,
    verification: result.verification ?? 'unavailable',
    steps: {
      nativeWrite: steps.nativeWrite ?? 'skipped',
      verify: steps.verify ?? 'skipped',
      hostDisable: steps.hostDisable ?? 'skipped'
    },
    notice: typeof result.notice === 'string' ? result.notice : '',
    warnings: Array.isArray(result.warnings) ? result.warnings.filter((item): item is string => typeof item === 'string') : []
  }
}

export type McpImportFlowOutcome =
  /** 已有一次导入在进行，忽略这次点击（防重复）。 */
  | { phase: 'busy' }
  /** 卸载 / 换 runner / 切会话 / 换项目：旧预览或被批准的令牌已经不适用，不提交。 */
  | { phase: 'scope-changed' }
  /** 用户在确认框取消（或确认框被范围取消结算）：不提交。 */
  | { phase: 'cancelled' }
  /** 预览或提交在写盘前被拒 / IPC 抛错；`code` 与 `error` 原样展示。 */
  | { phase: 'failed'; code: string; error: string }
  /** 拿到分步结果；是否整体成功看 `projection.ok`。 */
  | { phase: 'committed'; projection: McpImportCommitProjection }

export interface McpImportFlowDeps {
  prepare: (serverId: string) => Promise<NativeMcpImportPrepareResponse>
  commit: (token: string) => Promise<NativeMcpImportCommitResponse>
  /** 读取**当前**范围；每次核对都重新取，不能缓存调用时的值。 */
  currentScope: () => McpImportScope
  /** 弹应用内确认框；返回 false 表示取消。组件在这里把预览翻成用户可读文案。 */
  requestConfirm: (preview: NativeMcpImportPreview) => Promise<boolean>
  /** 只读取已有运行事实；确认期间任务变忙也不能断旧连接。 */
  isRunning?: () => boolean
}

export interface McpImportFlow {
  readonly busy: boolean
  run(serverId: string): Promise<McpImportFlowOutcome>
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  /* 跨 realm / IPC 还原的错误可能不是本 realm 的 Error，但有 message 就用它。 */
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(error)
}

/**
 * 每次 `run` 的顺序固定为：
 *   prepare → 核对范围 → 确认 → 核对范围 → commit → 投影。
 * `busy` 在整段期间为 true，重复点击直接返回 `busy`，不会发出第二次 commit。
 */
export function createMcpImportFlow(deps: McpImportFlowDeps): McpImportFlow {
  let busy = false
  const stillCurrent = (snapshot: McpImportScope): boolean => {
    const now = deps.currentScope()
    return now.mounted && snapshot.mounted && sameMcpImportScope(now, snapshot)
  }

  return {
    get busy() {
      return busy
    },
    async run(serverId: string): Promise<McpImportFlowOutcome> {
      if (busy) return { phase: 'busy' }
      busy = true
      try {
        const snapshot = deps.currentScope()
        if (!snapshot.mounted) return { phase: 'scope-changed' }
        if (deps.isRunning?.()) return { phase: 'busy' }

        let prepared: NativeMcpImportPrepareResponse
        try {
          prepared = await deps.prepare(serverId)
        } catch (error) {
          return { phase: 'failed', code: 'ipc_error', error: errorText(error) }
        }
        /* prepare 期间可能换了 runner / 会话 / 项目：旧预览不适用。 */
        if (!stillCurrent(snapshot)) return { phase: 'scope-changed' }
        if (!prepared.ok || !prepared.preview) {
          return { phase: 'failed', code: prepared.code ?? 'prepare_failed', error: prepared.error ?? '' }
        }

        let approved: boolean
        try {
          approved = await deps.requestConfirm(prepared.preview)
        } catch (error) {
          return { phase: 'failed', code: 'confirmation_error', error: errorText(error) }
        }
        /* 确认框期间范围变化（含卸载）一律结算为 false；先核对再判断是否取消。 */
        if (!stillCurrent(snapshot)) return { phase: 'scope-changed' }
        if (!approved) return { phase: 'cancelled' }

        /* 紧贴 commit 核对范围与忙碌；不在用户确认期间默默中断新任务。 */
        if (!stillCurrent(snapshot)) return { phase: 'scope-changed' }
        if (deps.isRunning?.()) return { phase: 'busy' }

        let committed: NativeMcpImportCommitResponse
        try {
          committed = await deps.commit(prepared.preview.token)
        } catch (error) {
          return { phase: 'failed', code: 'ipc_error', error: errorText(error) }
        }
        if (!committed.ok || !committed.result) {
          return { phase: 'failed', code: committed.code ?? 'commit_rejected', error: committed.error ?? '' }
        }
        return { phase: 'committed', projection: projectMcpImportCommit(committed.result) }
      } finally {
        busy = false
      }
    }
  }
}

/**
 * 已迁移条目的范围标签：旧标记只持久化 `targetPath`，没有 scope 字段。
 * 这里**只按真实路径形状**推断（`<cwd>/.pi/mcp.json` 是项目，其余按全局），
 * 不新增或猜测后端字段；推断不出来就返回 null，界面只显示路径。
 */
export function migratedTargetScope(targetPath: string): 'global' | 'project' | null {
  const normalized = targetPath.replace(/\\/g, '/')
  if (!normalized) return null
  if (/\/\.pi\/mcp\.json$/i.test(normalized)) return 'project'
  if (/\/mcp\.json$/i.test(normalized)) return 'global'
  return null
}
