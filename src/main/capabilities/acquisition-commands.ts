/**
 * `yan capabilities search / discover / prepare / acquire` 的实现：能力目录（含已配置 MCP 服务的工具）、
 * 联网发现候选、生成接入计划、按计划接入（技能包 / 插件包 / 本地与远程 MCP）。
 *
 * 候选与计划只由宿主持有：模型只能回传 ID，内容从这里的缓存取（10 分钟过期）——
 * 主进程负责结构校验与来源一致性。控制器的状态经 `CapabilityAcquisitionHost` 读取。
 */
import type { CapabilityAuthorizationChoice, CapabilityAuthorizationPrompt, CapabilityRunOptions, GoalCommandHost } from '../agent'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CapabilityCommandError } from '../capability-server'
import { YAN_DIR } from '../paths'
import { searchCapabilities } from '../../shared/capabilities'
import { buildCatalog } from './catalog'
import type { McpCatalogEntry } from './catalog'
import { AcquisitionService, operationIdOf, stagingDirOf } from './acquisition-service'
import { PackageAuthorizationService } from './package-authorization-service'
import { readRepoState } from '../git-service'
import { fetchNpmPackageMetadata } from './npm-artifact'
import { stageNpmAcquisition } from './npm-acquisition'
import { resolveMcpPackage, smokeMcpPackage } from './mcp-package'
import { McpRegistrationService } from './registration-service'
import type { McpRegistrationOutcome } from './registration-service'
import { draftRemoteMcpRegistration } from '../../shared/mcp-registration'
import type { AcquireAuthorization } from '../../shared/mcp-registration'
import { discoverCapabilities, planForCandidate } from './discovery/discover'
import type { AcquisitionPlan, CapabilityCandidate } from '../../shared/discovery'
import { declaredSkillFile, SkillSecurityError, stageSkillFiles } from './skill-files'
import { fetchSkillFiles } from './skill-source'
import { formatSkillSecurityReview } from '../../shared/skill-security'
import { schemaRevisionOf } from '../../shared/mcp'
import type { McpConnectionManager } from '../mcp/connection-manager'
import type { RawSkillCommand } from './skill-service'
import type { MainPush, SessionState } from '../../shared/ipc'
import { paramNumber, paramString } from '../command-params'

export interface CapabilityAcquisitionHost {
  capabilityOpts(): CapabilityRunOptions | undefined
  cwd(): string
  mcpManager(): McpConnectionManager | undefined
  resetMcpManager(): void
  mcpConfigError(): string | undefined
  mcpConnectionManager(): McpConnectionManager
  goalHost(): GoalCommandHost | undefined
  rawCommands(): Promise<RawSkillCommand[]>
  push(msg: MainPush): void
  getState(): SessionState | null
  confirmCapabilityAuthorization(): ((request: CapabilityAuthorizationPrompt) => Promise<CapabilityAuthorizationChoice>) | undefined
  bundledSkills(): string[]
}

export class CapabilityAcquisition {
  constructor(private readonly host: CapabilityAcquisitionHost) {}

  /**
   * `yan capabilities search`：把「这个会话现在能用什么」变成模型可读的候选列表。
   *
   * 只覆盖**已装 / 已加载**范围（S2）；联网发现是 S5 的 `capabilities.discover`。
   * 目录里出现**不代表授权**：调用仍走各自命令的身份与边界校验（实施-04 §6）。
   */
  /**
   * 把已配置 MCP 服务的工具接进能力目录（实施-04 S4）。
   *
   * 为什么必须连一次服务：MCP 工具名对 pi **完全不可见**（S1 预检四条证据），
   * 模型唯一能“自己发现”它们的入口就是这份目录 —— 所以 `capabilities search`
   * 必须能列出工具，而不是只列内置命令与技能。这正是 S4 的出口：
   * 「工具不直接出现在初始 prompt 也能用」。
   *
   * 两个刻意的取舍：
   * 1. **连不上的服务不冒充可用**：单列一条 `mcpServers` 状态，
   *    带 `disconnected` / `needs-auth` 与真实原因，模型据此知道“有这个服务但连不上”，
   *    而不是去猜自己命令写错了。
   * 2. **总超时有界**：不能因为一个服务挂着就把整次 search 拖死；
   *    超时的服务与连不上同样处理。
   */
  async collectMcpCatalog(): Promise<{
    tools: McpCatalogEntry[]
    servers: Array<Record<string, unknown>>
  }> {
    const manager = this.host.mcpConnectionManager()
    const tools: McpCatalogEntry[] = []
    const servers: Array<Record<string, unknown>> = []
    const serverIds = manager.listServerIds()
    const projectScopeById = new Map(manager.list().map((server) => [server.id, server.projectScope]))
    if (serverIds.length === 0) {
      return {
        tools,
        servers: this.host.mcpConfigError() ? [{ serverId: null, status: 'config-error', error: this.host.mcpConfigError() }] : []
      }
    }

    await Promise.all(
      serverIds.map(async (serverId) => {
        try {
          const listed = await this.withCatalogTimeout(manager.listToolsCached(serverId), serverId)
          for (const tool of listed) {
            tools.push({
              serverId,
              toolName: tool.name,
              ...(tool.description ? { description: tool.description } : {}),
              schemaRevision: schemaRevisionOf(tool.inputSchema),
              /* 服务自报 readOnlyHint 不当权限（§4）：目录里一律标 unknown。 */
              effect: 'unknown',
              ...(projectScopeById.get(serverId) ? { projectScope: projectScopeById.get(serverId) } : {})
            })
          }
          const status = manager.statusOf(serverId)
          servers.push({
            serverId,
            status: status.status === 'disconnected' && listed.length > 0 ? 'ready' : status.status,
            toolCount: listed.length,
            ...(status.error ? { error: status.error } : {})
          })
        } catch (error) {
          const status = manager.statusOf(serverId)
          servers.push({
            serverId,
            status: status.status,
            toolCount: 0,
            error: status.error ?? (error instanceof Error ? error.message : String(error))
          })
        }
      })
    )

    if (this.host.mcpConfigError()) servers.push({ serverId: null, status: 'config-error', error: this.host.mcpConfigError() })
    tools.sort((a, b) => a.serverId.localeCompare(b.serverId) || a.toolName.localeCompare(b.toolName))
    servers.sort((a, b) => String(a.serverId).localeCompare(String(b.serverId)))
    return { tools, servers }
  }

  /** 目录收集的硬超时：比单次调用短得多，因为它在**每次 search** 都要跑。 */
  async withCatalogTimeout<T>(work: Promise<T>, serverId: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`列出 ${serverId} 的工具超时（3000ms）`)), 3000)
    })
    try {
      return await Promise.race([work, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * 本轮发现到的候选（仅宿主持有）。
   *
   * 为什么不让模型把候选原样传回 `prepare`：那等于让模型自己决定「要装什么」，
   * 而 §8 明确要求**主进程负责结构校验与来源一致性**。模型只能回传 ID，
   * 候选内容从这条缓存里取 —— 缓存过期（10 分钟）就要求重新检索。
   */
  readonly discoveryCandidates = new Map<string, { candidate: CapabilityCandidate; at: number }>()

  /**
   * 最近生成过的接入计划（仅宿主持有）。
   *
   * `prepare` 只把 `planId` 交给模型，`acquire` 拿回同一个 ID 时要从这里取回
   * 完整计划与候选 —— 否则模型可以把任意字符串当计划传回来（§8：主进程负责
   * 结构校验与来源一致性）。TTL 与候选一致（10 分钟）。
   */
  readonly acquisitionPlans = new Map<
    string,
    { plan: AcquisitionPlan; candidate: CapabilityCandidate; digest: string; at: number }
  >()

  /** `yan capabilities discover`：联网检索缺失能力（实施-04 §7）。 */
  async runCapabilitiesDiscover(params: Record<string, unknown>) {
    const strategy = await this.host.capabilityOpts()?.getCapabilityStrategy?.()
    if (strategy === 'existing-only') {
      throw new CapabilityCommandError(
        'capability_policy_existing_only',
        '当前能力策略为「仅已有能力」，不会联网搜索。可在设置 → 能力中更改策略。'
      )
    }
    const queryText = paramString(params, ['queryText', 'query-text', 'query', 'text']) ?? ''
    const goalText = paramString(params, ['goal', 'goalText', 'goal-text'])
    const timeoutMs = paramNumber(params, 'timeoutMs')
    const outcome = await discoverCapabilities({
      queryText,
      ...(goalText ? { goalText } : {}),
      ...(timeoutMs ? { timeoutMs } : {})
    })

    const now = Date.now()
    for (const { candidate } of outcome.candidates) {
      this.discoveryCandidates.set(candidate.candidateId, { candidate, at: now })
    }
    for (const [id, entry] of this.discoveryCandidates) {
      if (now - entry.at > 10 * 60_000) this.discoveryCandidates.delete(id)
    }

    return {
      data: {
        query: outcome.query,
        reason: outcome.reason,
        sources: outcome.sources,
        candidates: outcome.candidates.map(({ candidate, score, reasons }) => ({
          ...candidate,
          score,
          scoreReasons: reasons
        })),
        /*
         * 说清这一层能做到什么：目录元数据**只证明发布来源存在**，
         * 不等于已审计、也不等于能在这台机器上跑（§8）。
         */
        notice:
          '候选来自公开目录的元数据（verification=metadata-only）：只证明发布来源存在，不等于代码已审计，也不等于已验证可用。' +
          '下一步用 yan capabilities prepare --candidate <候选ID> 生成接入计划（S5 只生成，不执行）。'
      },
      summary: {
        kind: 'capabilities',
        action: 'discover',
        query: outcome.query,
        count: outcome.candidates.length,
        sourceOk: outcome.sources.filter((s) => s.ok).length,
        sourceFailed: outcome.sources.filter((s) => !s.ok).map((s) => s.sourceId),
        reason: outcome.reason,
        candidateIds: outcome.candidates.map((c) => c.candidate.candidateId)
      }
    }
  }

  /** `yan capabilities prepare`：把已检索到的候选变成接入计划（**不执行**）。 */
  async runCapabilitiesPrepare(params: Record<string, unknown>) {
    const candidateId = paramString(params, ['candidateId', 'candidate', 'candidate-id', 'id'])
    if (!candidateId) {
      throw new CapabilityCommandError(
        'candidate_required',
        '需要 --candidate <候选ID>（先跑 yan capabilities discover 拿候选）'
      )
    }
    const entry = this.discoveryCandidates.get(candidateId)
    if (!entry) {
      throw new CapabilityCommandError(
        'candidate_unknown',
        `没有这个候选：${candidateId}。候选只由宿主在 discover 后短暂保留（10 分钟），请重新检索。`
      )
    }
    let candidate = entry.candidate
    if (candidate.localPackage?.registryType === 'npm') {
      try {
        const metadata = await fetchNpmPackageMetadata({
          name: candidate.localPackage.identifier,
          version: candidate.localPackage.version ?? '',
          ...(candidate.integrity ? { expectedIntegrity: candidate.integrity } : {})
        })
        candidate = { ...candidate, integrity: metadata.integrity }
        /* prepare 之后候选指纹含精确 tarball SRI；后续不能被同版本 registry 漂移替换。 */
        this.discoveryCandidates.set(candidateId, { candidate, at: entry.at })
      } catch (error) {
        throw new CapabilityCommandError(
          'package_metadata_failed',
          `无法为固定 npm 候选取到可校验的 exact-version manifest：${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    const { plan, digest } = planForCandidate({
      candidate,
      goalId: this.host.capabilityOpts()?.sessionId ?? 'unknown-goal',
      projectId: this.host.capabilityOpts()?.projectId ?? 'unknown-project'
    })
    const now = Date.now()
    this.acquisitionPlans.set(plan.planId, { plan, candidate, digest, at: now })
    for (const [id, cached] of this.acquisitionPlans) {
      if (now - cached.at > 10 * 60_000) this.acquisitionPlans.delete(id)
    }
    return {
      data: {
        plan,
        artifactDigest: digest,
        candidate,
        executable: false,
        notice:
          'S5 到这里为止：计划已生成但**不会执行**（下载 / 安装 / 登记是 S6）。' +
          'policyResult=needs-authorization 表示需要用户或策略授权才能继续。'
      },
      summary: {
        kind: 'capabilities',
        action: 'prepare',
        candidateId,
        planId: plan.planId,
        policyResult: plan.policyResult,
        pinnedSource: plan.pinnedSource
      }
    }
  }

  /**
   * `yan capabilities acquire`：执行接入计划（实施-04 §10）。
   *
   * 分三档如实处理，**不把「建了事务」当「装好了」**：
   *   · `needs-auth` / `unsupported` —— 候选自身缺条件，直接停住（`--authorize` 也绕不过去）；
   *   · `remote` MCP —— **真的登记**：核验端点 → 写受管配置 → 复核 → `resumed`（S6b-1）；
   *   · npm `pi-package` —— 获精确项目级代码授权后下载 / 校验并落受管 staging，安装仍等安全边界；
   *   · 其它本地 installKind —— 未获精确授权时停住；相应下载 / 安装器未接通时保持 `pending-boundary`。
   */
  async runCapabilitiesAcquire(params: Record<string, unknown>) {
    const planId = paramString(params, ['plan', 'planId', 'plan-id', 'id'])
    if (!planId) {
      throw new CapabilityCommandError(
        'plan_required',
        '需要 --plan <计划ID>（先跑 yan capabilities prepare --candidate <候选ID>）'
      )
    }
    const entry = this.acquisitionPlans.get(planId)
    if (!entry) {
      throw new CapabilityCommandError(
        'plan_unknown',
        `没有这个计划：${planId}。计划只由宿主在 prepare 后短暂保留（10 分钟），请重新 prepare。`
      )
    }
    const { plan, candidate, digest } = entry
    const workMode = await this.host.capabilityOpts()?.getWorkMode?.()
    if (workMode === 'clarify') {
      throw new CapabilityCommandError(
        'capability_mode_clarify',
        '计划模式允许搜索与查看候选，但不允许接入能力；切换到标准或自主模式后再继续。'
      )
    }
    const strategy = await this.host.capabilityOpts()?.getCapabilityStrategy?.()
    if (strategy === 'existing-only') {
      return {
        data: {
          plan,
          candidate,
          executable: false,
          state: 'policy-blocked',
          notice: '当前能力策略为「仅已有能力」，接入被宿主阻止；可在设置 → 能力中更改策略。'
        },
        summary: { kind: 'capabilities', action: 'acquire', planId: plan.planId, state: 'policy-blocked', executed: false }
      }
    }
    if (strategy === 'search-and-recommend') {
      return {
        data: {
          plan,
          candidate,
          executable: false,
          state: 'recommendation-only',
          notice: '当前策略只搜索并推荐，不会连接、下载或安装候选；请在设置 → 能力中改用授权范围内自动接入。'
        },
        summary: { kind: 'capabilities', action: 'acquire', planId: plan.planId, state: 'recommendation-only', executed: false }
      }
    }
    const operationId = operationIdOf({ planId: plan.planId, planRevision: plan.revision })
    const explicitAuthorize = params.authorize === true || params.authorize === 'true'

    if (plan.policyResult === 'needs-auth' || plan.policyResult === 'unsupported') {
      const notice =
        plan.policyResult === 'needs-auth'
          ? '这个候选需要认证：先按其发布方说明配置凭证（砚不代填、也不把凭证写进提示词）。'
          : '当前环境不支持这个候选（缺运行时 / 平台不符），未执行任何安装。'
      return {
        data: { plan, candidate, operationId, executable: false, state: plan.policyResult, notice },
        summary: {
          kind: 'capabilities',
          action: 'acquire',
          planId: plan.planId,
          operationId,
          state: plan.policyResult,
          executed: false
        }
      }
    }

    /* §10：远程 MCP 不下载 —— 直接「核验端点 → 登记配置 → 连接 → 枚举工具」。 */
    if (candidate.installKind === 'remote') {
      return this.acquireRemoteMcp({ plan, candidate, digest, operationId, explicitAuthorize })
    }

    let packageGrant = await new PackageAuthorizationService(YAN_DIR).find({
      candidateId: candidate.candidateId,
      digest,
      projectId: plan.projectId
    })
    if (!packageGrant && explicitAuthorize) {
      const choice = await this.host.confirmCapabilityAuthorization()?.({
        kind: 'local-package',
        title: candidate.title,
        source: candidate.candidateId,
        projectId: plan.projectId,
        cwd: this.host.cwd(),
        digest
      }) ?? 'deny'
      if (choice !== 'deny') {
        packageGrant = await new PackageAuthorizationService(YAN_DIR).grant({
          candidateId: candidate.candidateId,
          digest,
          projectId: plan.projectId,
          allowLifecycleScripts: choice === 'allow-with-lifecycle-scripts'
        })
      }
    }
    if (!packageGrant) {
      return {
        data: {
          plan,
          candidate,
          operationId,
          executable: false,
          state: !packageGrant ? 'needs-authorization' : plan.policyResult,
          notice:
            '本地包 / Skill 可能执行代码或改变模型后续行为。模型不能自行授权；用 `--authorize` 发起砚的确认对话框并由你选择后，才会保存精确候选 + 指纹 + 项目级授权。'
        },
        summary: {
          kind: 'capabilities',
          action: 'acquire',
          planId: plan.planId,
          operationId,
          state: 'needs-authorization',
          executed: false
        }
      }
    }

    const service = new AcquisitionService({ root: YAN_DIR })
    /* begin 是幂等的：同一个计划第二次进来拿回同一条事务，不会又装一遍（§10）。 */
    const created = await service.begin({
      planId: plan.planId,
      planRevision: plan.revision,
      candidateId: candidate.candidateId,
      digest,
      projectId: plan.projectId
    })
    let tx = created
    const explicitRetry = params.retry === true || params.retry === 'true'
    if (tx.state === 'failed' && explicitRetry) tx = await service.retry(tx.operationId)

    /* skill-files：固定声明的本地文件先 staging；active 与 runner 重载交给安全边界调度器。 */
    if (candidate.installKind === 'skill-files') {
      const declared = candidate.skillFiles ?? []
      try {
        if (tx.state === 'prepared') {
          const remoteFileUrls = candidate.skillFileUrls
          const files = remoteFileUrls
            ? (await fetchSkillFiles({
                fileUrls: remoteFileUrls,
                expectedHashes: candidate.skillFileHashes ?? {},
                allowedOrigins: candidate.sourceUrls,
                timeoutMs: 15_000
              })).map(({ path, content }) => ({ path, content }))
            : await Promise.all(declared.map(async (path) => {
                const source = declaredSkillFile(this.host.cwd(), path)
                return { path: source.path, content: await readFile(source.absolute) }
              }))
          const staged = await stageSkillFiles({
            root: YAN_DIR,
            operationId: tx.operationId,
            candidateId: candidate.candidateId,
            projectId: plan.projectId,
            files,
            ...(candidate.skillFileHashes ? { expectedHashes: candidate.skillFileHashes } : {})
          })
          const securityNotice = staged.securityReview.findings.length > 0
            ? `${formatSkillSecurityReview(staged.securityReview)}；即使候选由用户指定，仍保留这份风险提醒。`
            : undefined
          if (securityNotice) {
            this.host.push({
              ch: 'log',
              payload: { text: `[能力接入] ${securityNotice}` }
            })
          }
          tx = await service.markBoundary(
            tx.operationId,
            'Skill 文件已完成 staging、hash 复核与内容安全审查；等待下一次 runner 安全启动',
            new Date().toISOString(),
            staged.securityReview
          )
        }
        const sessionFile = this.host.getState()?.sessionFile
        const runnerId = this.host.capabilityOpts()?.sessionId
        const projectId = this.host.capabilityOpts()?.projectId
        if (tx.state === 'pending-boundary' && !tx.skillFilesTarget && sessionFile && runnerId && projectId) {
          const goalHost = this.host.goalHost()
          const goalStatus = goalHost
            ? await goalHost.run('goal.status', {}, { sessionId: runnerId, projectId })
            : null
          const goal = (goalStatus?.data as { goal?: { goalId?: unknown; revision?: unknown } } | undefined)?.goal
          if (goalHost && (!goal || !Number.isSafeInteger(goal.revision) || (goal.revision as number) < 0)) {
            throw new CapabilityCommandError('goal_snapshot_unavailable', '无法固定当前目标修订，事务保持待处理且不会自动激活')
          }
          const goalIdFromStatus = typeof goal?.goalId === 'string' && goal.goalId ? goal.goalId : undefined
          const goalRevisionFromStatus = Number.isSafeInteger(goal?.revision) && (goal?.revision as number) >= 0
            ? (goal?.revision as number)
            : undefined
          const goalId = goalIdFromStatus ?? plan.goalId
          const goalRevision = goalRevisionFromStatus ?? 0
          const sourceHead = (await readRepoState(this.host.cwd(), { withRefs: false }))?.head ?? null
          tx = await service.bindSkillFilesTarget(tx.operationId, {
            runnerId,
            runnerGeneration: this.host.capabilityOpts()?.runnerGeneration ?? 1,
            cwd: this.host.cwd(),
            sessionFile,
            projectId,
            goalId,
            goalRevision,
            sourceHead,
            continueId: tx.operationId
          })
        }
        return {
          data: {
            plan,
            candidate,
            operationId,
            transaction: tx,
            securityReview: tx.securityReview,
            executable: false,
            state: tx.state,
            skills: declared,
            ...(tx.securityReview?.findings.length
              ? { notice: `${formatSkillSecurityReview(tx.securityReview)}；即使候选由用户指定，仍保留这份风险提醒。` }
              : {})
          },
          summary: {
            kind: 'capabilities',
            action: 'acquire',
            planId: plan.planId,
            operationId,
            state: tx.state,
            executed: tx.state === 'pending-boundary'
          }
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        const securityReview = error instanceof SkillSecurityError ? error.review : undefined
        if (securityReview) {
          this.host.push({ ch: 'log', payload: { text: `[能力接入] ${formatSkillSecurityReview(securityReview)}；已阻止激活。` } })
        }
        tx = securityReview
          ? await service.fail(tx.operationId, detail, new Date().toISOString(), securityReview)
          : await service.fail(tx.operationId, detail)
        return {
          data: { plan, candidate, operationId, state: 'failed', securityReview: tx.securityReview, notice: detail },
          summary: {
            kind: 'capabilities',
            action: 'acquire',
            planId: plan.planId,
            operationId,
            state: 'failed',
            executed: false
          }
        }
      }
    }

    let npmStaged = false
    let npmFailure: string | undefined
    const localPackage = candidate.localPackage
    const canStageNpmPackage =
      (candidate.installKind === 'pi-package' || candidate.installKind === 'mcp-package') &&
      localPackage?.registryType === 'npm' &&
      typeof localPackage.identifier === 'string' &&
      typeof (localPackage.version ?? candidate.version) === 'string' &&
      typeof candidate.integrity === 'string'

    if (tx.state === 'prepared' && canStageNpmPackage) {
      try {
        const staged = await stageNpmAcquisition({
          root: YAN_DIR,
          operationId: tx.operationId,
          candidateId: candidate.candidateId,
          digest,
          projectId: plan.projectId,
          name: localPackage.identifier,
          version: localPackage.version ?? candidate.version!,
          integrity: candidate.integrity!,
          ...(localPackage.fileSha256 ? { expectedSha256: localPackage.fileSha256 } : {})
        })
        tx = await service.get(tx.operationId) ?? tx
        if (tx.state === 'verifying') {
          const verified = await service.verifyStaged(tx.operationId)
          if (!verified.ok) throw new Error(`staging 复核失败：${verified.problems.join('；')}`)
          tx = await service.markBoundary(
            tx.operationId,
            `固定 npm 制品已校验并落入受管 staging（${staged.manifest.files.length} 个文件）；等待项目 runner 空闲后再安装`
          )
        }
        npmStaged = tx.state === 'pending-boundary'
      } catch (error) {
        npmFailure = error instanceof Error ? error.message : String(error)
        const latest = await service.get(tx.operationId)
        if (latest && latest.state !== 'failed' && latest.state !== 'cancelled' && latest.state !== 'resumed') {
          tx = await service.fail(tx.operationId, npmFailure)
        } else if (latest) {
          tx = latest
        }
      }
    } else if (tx.state === 'verifying') {
      /* 崩溃若发生在 stage 落盘后、pending-boundary 写入前，重放时补齐边界状态。 */
      const verified = await service.verifyStaged(tx.operationId)
      if (verified.ok) {
        tx = await service.markBoundary(tx.operationId, '受管 npm staging 已复核；等待项目 runner 空闲后再安装')
      } else {
        npmFailure = `staging 复核失败：${verified.problems.join('；')}`
        tx = await service.fail(tx.operationId, npmFailure)
      }
    } else if (tx.state === 'prepared') {
      tx = await service.markBoundary(
        tx.operationId,
        `等待对应下载 / 安装器（installKind=${candidate.installKind}${localPackage?.registryType ? `, registryType=${localPackage.registryType}` : ''}；当前不执行不支持的来源）`
      )
    }

    if (candidate.installKind === 'mcp-package' && tx.state === 'pending-boundary' && !npmStaged && !npmFailure) {
      const checked = await service.verifyStaged(tx.operationId)
      if (checked.ok) npmStaged = true
      else npmFailure = `受管 MCP staging 复核失败：${checked.problems.join('；')}`
    }

    /*
     * MCP npm 包由砚直接管理，不经过 pi install，也不要求重建当前 runner：
     * 受管 stdio 配置登记后，当前 AgentController 下一次调用会懒加载新服务。
     * 这里仍然保留 acquiring → verifying → activated → resumed 的证据链，
     * 以免「包在 staging」被误报成「服务可用」。
     */
    if (candidate.installKind === 'mcp-package') {
      return this.finishMcpPackageAcquire({
        service,
        tx,
        plan,
        candidate,
        digest,
        operationId,
        npmStaged,
        npmFailure,
        localPackage
      })
    }

    if (npmStaged && localPackage?.identifier && (localPackage.version ?? candidate.version)) {
      const sessionFile = this.host.getState()?.sessionFile
      const runnerId = this.host.capabilityOpts()?.sessionId
      const projectId = this.host.capabilityOpts()?.projectId
      if (sessionFile && runnerId && projectId) {
        const goalHost = this.host.goalHost()
        const goalStatus = goalHost
          ? await goalHost.run('goal.status', {}, { sessionId: runnerId, projectId })
          : null
        const goal = (goalStatus?.data as { goal?: { goalId?: unknown; revision?: unknown } } | undefined)?.goal
        if (goalHost && (!goal || !Number.isSafeInteger(goal.revision) || (goal.revision as number) < 0)) {
          throw new CapabilityCommandError('goal_snapshot_unavailable', '无法固定当前目标修订，事务保持待处理且不会自动激活')
        }
        const goalId = typeof goal?.goalId === 'string' && goal.goalId ? goal.goalId : plan.goalId
        const goalRevision = Number.isSafeInteger(goal?.revision) && (goal?.revision as number) >= 0
          ? (goal?.revision as number)
          : 0
        const sourceHead = (await readRepoState(this.host.cwd(), { withRefs: false }))?.head ?? null
        tx = await service.bindPiPackageTarget(tx.operationId, {
          runnerId,
          runnerGeneration: this.host.capabilityOpts()?.runnerGeneration ?? 1,
          cwd: this.host.cwd(),
          sessionFile,
          projectId,
          goalId,
          goalRevision,
          sourceHead,
          continueId: tx.operationId,
          packageName: localPackage.identifier,
          packageVersion: localPackage.version ?? candidate.version!
        })
      }
    }

    const stateNotice = npmFailure
      ? `npm 下载 / staging 失败：${npmFailure}。同一计划可显式使用 --retry 重试（最多一次）。`
      : npmStaged
        ? tx.piPackageTarget
          ? 'npm tarball 已按 prepare 固定的 SHA-512 校验并落入受管 staging；已持久绑定原项目 / runner / 会话，未运行 npm lifecycle、pi install 或包代码，等待目标项目 runner 安全边界调度。'
          : 'npm tarball 已按 prepare 固定的 SHA-512 校验并落入受管 staging；未运行 npm lifecycle、pi install 或包代码。当前会话尚无可持久恢复的目标绑定，需等会话保存后重试 acquire。'
        : tx.state === 'failed'
          ? `这个接入事务已失败：${tx.failure?.detail ?? '无更多错误细节'}。如尚有重试次数，可对同一计划使用 --retry。`
        : tx.state === 'pending-boundary'
          ? '事务正在等待安全边界；本次未执行安装、运行包代码或重启 runner。'
          : `这个候选的 installKind 是 ${candidate.installKind}，对应下载 / 安装 / 隔离验证仍待实施。`
    return {
      data: {
        plan,
        candidate,
        operationId: tx.operationId,
        transaction: tx,
        executable: false,
        state: tx.state,
        downloaded: npmStaged,
        installed: false,
        notice: stateNotice
      },
      summary: {
        kind: 'capabilities',
        action: 'acquire',
        planId: plan.planId,
        operationId: tx.operationId,
        state: tx.state,
        executed: false,
        downloaded: npmStaged,
        installed: false
      }
    }
  }

  async finishMcpPackageAcquire(input: {
    service: AcquisitionService
    tx: Awaited<ReturnType<AcquisitionService['get']>>
    plan: AcquisitionPlan
    candidate: CapabilityCandidate
    digest: string
    operationId: string
    npmStaged: boolean
    npmFailure?: string
    localPackage?: CapabilityCandidate['localPackage']
  }) {
    const { service, plan, candidate, digest, operationId, localPackage } = input
    let tx = input.tx
    if (!tx) throw new CapabilityCommandError('acquire_failed', '接入事务已经不存在')
    if (input.npmFailure || !input.npmStaged || !localPackage?.identifier || !(localPackage.version ?? candidate.version)) {
      return {
        data: {
          plan,
          candidate,
          operationId,
          transaction: tx,
          executable: false,
          state: tx.state,
          downloaded: input.npmStaged,
          installed: false,
          notice: input.npmFailure
            ? `MCP npm 包下载 / staging 失败：${input.npmFailure}。同一计划可显式使用 --retry 重试（最多一次）。`
            : 'MCP npm 包已登记接入事务，但固定制品尚未完成 staging；没有运行包代码。'
        },
        summary: {
          kind: 'capabilities',
          action: 'acquire',
          planId: plan.planId,
          operationId,
          state: tx.state,
          executed: false
        }
      }
    }

    const packageRoot = join(stagingDirOf(YAN_DIR, operationId), 'payload', 'package')
    let resolved: Awaited<ReturnType<typeof resolveMcpPackage>>
    try {
      resolved = await resolveMcpPackage({
        packageRoot,
        candidateId: candidate.candidateId,
        title: candidate.title,
        expectedName: localPackage.identifier,
        expectedVersion: localPackage.version ?? candidate.version!
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      await service.fail(operationId, `MCP 包入口解析失败：${detail}`).catch(() => undefined)
      throw new CapabilityCommandError('acquire_failed', detail)
    }

    const registration = new McpRegistrationService({ root: YAN_DIR })
    /* 幂等重放：已登记的本地 MCP 只重新核验，不重新写配置或启动多余副本。 */
    if (tx.state === 'activated' || tx.state === 'resumed') {
      const managed = (await registration.listManaged()).find((record) => record.serverId === resolved.config.id)
      const check = managed
        ? await registration.reverify(managed)
        : { ok: false, reasons: ['受管记录里没有这个本地 MCP 服务'] }
      if (!check.ok) {
        return {
          data: {
            plan,
            candidate,
            operationId,
            serverId: resolved.config.id,
            executable: false,
            state: tx.state,
            replayed: true,
            warnings: check.reasons,
            notice: `本地 MCP 服务 ${resolved.config.id} 的幂等复核未通过：${check.reasons.join('；')}`
          },
          summary: {
            kind: 'capabilities',
            action: 'acquire',
            planId: plan.planId,
            operationId,
            serverId: resolved.config.id,
            state: tx.state,
            executed: false,
            replayed: true
          }
        }
      }
      if (tx.state === 'activated') tx = await service.markResumed(operationId, '同一计划的本地 MCP 连接复核通过')
      this.host.resetMcpManager()
      return {
        data: {
          plan,
          candidate,
          operationId,
          serverId: resolved.config.id,
          executable: true,
          state: tx.state,
          replayed: true,
          tools: managed?.tools ?? [],
          notice: `这个计划已经登记过本地 MCP 服务 ${resolved.config.id}，本次只做连接复核。`
        },
        summary: {
          kind: 'capabilities',
          action: 'acquire',
          planId: plan.planId,
          operationId,
          serverId: resolved.config.id,
          state: tx.state,
          executed: false,
          replayed: true
        }
      }
    }

    if (tx.state !== 'pending-boundary') {
      return {
        data: {
          plan,
          candidate,
          operationId,
          executable: false,
          state: tx.state,
          transaction: tx,
          notice: `本地 MCP 事务当前处于 ${tx.state}，没有执行包代码。`
        },
        summary: {
          kind: 'capabilities',
          action: 'acquire',
          planId: plan.planId,
          operationId,
          state: tx.state,
          executed: false
        }
      }
    }

    try {
      tx = await service.markAcquiring(operationId, '受管 staging 已复核，开始本地 MCP 无副作用协议冒烟')
      const smoke = await smokeMcpPackage({ config: resolved.config })
      if (!smoke.ok) {
        await service.fail(operationId, `本地 MCP 冒烟失败：${smoke.problems.join('；')}`)
        throw new CapabilityCommandError('acquire_failed', smoke.problems.join('；'))
      }
      tx = await service.markVerifying(operationId, `MCP tools/list 冒烟通过，列到 ${smoke.tools.length} 个工具`)
      const outcome = await registration.registerStdio({
        config: resolved.config,
        projectId: plan.projectId,
        operationId,
        /* smoke 已经用同一份 command + args 真连并列出工具；把这份
         * receipt 交给登记层，避免在写配置前无意义地再启动一次第三方进程。 */
        probe: async (config) => {
          if (
            config.command !== resolved.config.command ||
            JSON.stringify(config.args ?? []) !== JSON.stringify(resolved.config.args ?? [])
          ) {
            throw new Error('本地 MCP 登记配置与刚通过 smoke 的入口不一致')
          }
          return { tools: smoke.tools.map((tool) => tool.name) }
        }
      })
      tx = await service.activate({
        operationId,
        receipt: {
          planId: plan.planId,
          planRevision: plan.revision,
          candidateId: candidate.candidateId,
          digest,
          scope: 'project-managed',
          projectId: plan.projectId,
          installedPaths: [outcome.configPath, resolved.packageRoot],
          verification: 'protocol-reachable'
        },
        verify: async () => ({ ok: true, problems: [] })
      })
      const managed = (await registration.listManaged()).find((record) => record.serverId === outcome.serverId)
      const check = managed
        ? await service.resumeCheck({
            operationId,
            expected: { planId: plan.planId, planRevision: plan.revision, digest },
            verify: async () => {
              const reverified = await registration.reverify(managed)
              return { ok: reverified.ok, problems: reverified.reasons }
            }
          })
        : { ok: false, reasons: ['受管登记记录缺失（本地 MCP 登记没完成）'] }
      tx = check.ok
        ? await service.markResumed(operationId, '本地 MCP 冒烟、登记与连接复核通过，可继续原目标')
        : await service.fail(operationId, `本地 MCP 激活后复核没通过：${check.reasons.join('；')}`)
      this.host.resetMcpManager()
      return {
        data: {
          plan,
          candidate,
          operationId,
          serverId: outcome.serverId,
          tools: outcome.tools,
          configPath: outcome.configPath,
          executable: check.ok,
          state: tx.state,
          installed: check.ok,
          resume: { goalId: plan.goalId, continueHint: '本地 MCP 已登记；原目标可以继续' },
          ...(check.ok ? {} : { problems: check.reasons }),
          notice: check.ok
            ? `已接入本地 MCP 服务 ${outcome.serverId}（工具 ${outcome.tools.length} 个）：固定 npm 制品、无副作用冒烟与项目隔离登记均通过。`
            : `本地 MCP 服务 ${outcome.serverId} 已处理，但激活后复核没通过：${check.reasons.join('；')}`
        },
        summary: {
          kind: 'capabilities',
          action: 'acquire',
          planId: plan.planId,
          operationId,
          serverId: outcome.serverId,
          state: tx.state,
          executed: check.ok
        }
      }
    } catch (error) {
      if (error instanceof CapabilityCommandError) throw error
      const detail = error instanceof Error ? error.message : String(error)
      await service.fail(operationId, detail).catch(() => undefined)
      throw new CapabilityCommandError('acquire_failed', detail)
    }
  }

  /**
   * 远程 MCP 的**自动登记**（实施-04 S6b-1）。
   *
   * 授权是这一片的关键分界（§9）：目录元数据（`metadata-only`）不足以自动接入，
   * `--authorize` 只请求 Electron 确认对话框；用户点允许后，同一 host + project
   * 才成为持久策略 —— 不每次都问一遍，也不把目录内容或模型参数当用户授权。
   */
  async acquireRemoteMcp(input: {
    plan: AcquisitionPlan
    candidate: CapabilityCandidate
    digest: string
    operationId: string
    explicitAuthorize: boolean
  }) {
    const { plan, candidate, digest, operationId, explicitAuthorize } = input
    const draftResult = draftRemoteMcpRegistration(candidate)
    if (!draftResult.ok) {
      return {
        data: {
          plan,
          candidate,
          operationId,
          executable: false,
          state: 'unsupported',
          notice: draftResult.detail
        },
        summary: {
          kind: 'capabilities',
          action: 'acquire',
          planId: plan.planId,
          operationId,
          state: 'unsupported',
          executed: false
        }
      }
    }
    const { draft } = draftResult
    const registration = new McpRegistrationService({ root: YAN_DIR })
    let authorization: AcquireAuthorization | null = null
    let authorized =
      plan.policyResult === 'automatic' || (await registration.isAuthorized(draft.endpoint, plan.projectId))
    if (!authorized && explicitAuthorize) {
      const choice = await this.host.confirmCapabilityAuthorization()?.({
        kind: 'remote-mcp',
        title: candidate.title,
        source: candidate.candidateId,
        projectId: plan.projectId,
        cwd: this.host.cwd(),
        digest,
        endpoint: draft.endpoint
      }) ?? 'deny'
      if (choice === 'allow') {
        authorization = await registration.authorize({
          url: draft.endpoint,
          via: 'user-confirmed-dialog',
          projectId: plan.projectId
        })
        authorized = true
      }
    }
    if (!authorized) {
      return {
        data: {
          plan,
          candidate,
          operationId,
          endpoint: draft.endpoint,
          serverId: draft.serverId,
          executable: false,
          state: 'needs-authorization',
          warnings: draft.warnings,
          notice:
            '候选来自公开目录（metadata-only），不足以自动登记。可以用 ' +
            '`yan capabilities acquire --plan <计划ID> --authorize` 请求砚显示确认对话框；只有你在对话框里允许后才会持久授权这个 host（只记 host，不记凭证）。'
        },
        summary: {
          kind: 'capabilities',
          action: 'acquire',
          planId: plan.planId,
          operationId,
          state: 'needs-authorization',
          executed: false,
          endpoint: draft.endpoint
        }
      }
    }

    const service = new AcquisitionService({ root: YAN_DIR })
    const created = await service.begin({
      planId: plan.planId,
      planRevision: plan.revision,
      candidateId: candidate.candidateId,
      digest,
      projectId: plan.projectId
    })
    /* 幂等重放：已经登记过的计划不重复写配置，只复核一次（§10「不能装两次」）。 */
    if (created.state === 'activated' || created.state === 'resumed') {
      const managed = (await registration.listManaged()).find((record) => record.serverId === draft.serverId)
      const check = managed ? await registration.reverify(managed) : { ok: false, reasons: ['受管记录里没有这个服务'] }
      const tx =
        check.ok && created.state === 'activated'
          ? await service.markResumed(created.operationId, '复核通过（同一计划的幂等重放）')
          : created
      return {
        data: {
          plan,
          candidate,
          operationId: tx.operationId,
          serverId: draft.serverId,
          executable: true,
          state: tx.state,
          replayed: true,
          ...(check.ok ? {} : { warnings: check.reasons }),
          notice: check.ok
            ? `这个计划已经登记过 ${draft.serverId}，本次只做复核，没有重复写入配置。`
            : `这个计划登记过 ${draft.serverId}，但复核没通过：${check.reasons.join('；')}`
        },
        summary: {
          kind: 'capabilities',
          action: 'acquire',
          planId: plan.planId,
          operationId: tx.operationId,
          state: tx.state,
          executed: false,
          replayed: true
        }
      }
    }

    await service.markAcquiring(operationId, `登记远程 MCP（核验 ${draft.endpoint} 后写入受管配置）`)
    let outcome: McpRegistrationOutcome
    try {
      outcome = await registration.registerRemote({
        draft,
        projectId: plan.projectId,
        operationId
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await service.fail(operationId, message).catch(() => undefined)
      throw new CapabilityCommandError('acquire_failed', message)
    }

    await service.markVerifying(operationId, `端点核验通过，列到 ${outcome.tools.length} 个工具`)
    await service.activate({
      operationId,
      receipt: {
        planId: plan.planId,
        planRevision: plan.revision,
        candidateId: candidate.candidateId,
        digest,
        scope: 'project-managed',
        projectId: plan.projectId,
        installedPaths: [outcome.configPath],
        /* 真的连上并枚举过工具 —— 不是「文件在」那种弱验证（§10 第 5 条）。 */
        verification: 'protocol-reachable'
      },
      /* 核验已由 registerRemote 的真实 probe 完成；这里不重复连一次。 */
      verify: async () => ({ ok: true, problems: [] })
    })
    /* `resumed` 必须由**真正的连接证据**置位（§10.2）：这里再复核一次。 */
    const managed = (await registration.listManaged()).find((record) => record.serverId === outcome.serverId)
    const check = managed
      ? await service.resumeCheck({
          operationId,
          expected: { planId: plan.planId, digest, planRevision: plan.revision },
          verify: async () => {
            const reverified = await registration.reverify(managed)
            return { ok: reverified.ok, problems: reverified.reasons }
          }
        })
      : { ok: false, reasons: ['受管登记记录缺失（登记没完成）'] }
    const tx = check.ok
      ? await service.markResumed(operationId, '登记 + 连接复核通过，可继续原目标')
      : await service.fail(operationId, `激活后复核没通过：${check.reasons.join('；')}`)

    /* 让下一次能力目录 / mcp 调用重新读配置：新服务**当场可见**，不需要重启（§10.1）。 */
    this.host.resetMcpManager()

    return {
      data: {
        plan,
        candidate,
        operationId,
        serverId: outcome.serverId,
        endpoint: draft.endpoint,
        tools: outcome.tools,
        configPath: outcome.configPath,
        executable: true,
        state: tx.state,
        ...(authorization ? { authorization } : {}),
        warnings: outcome.warnings,
        resume: { goalId: plan.goalId, continueHint: '登记完成；原目标可以继续（能力目录里已经能看到它）' },
        ...(check.ok ? {} : { problems: check.reasons }),
        notice: check.ok
          ? `已登记远程 MCP 服务 ${outcome.serverId}（工具 ${outcome.tools.length} 个）：一次真连核验通过后才写配置，写的是受管配置。`
          : `服务 ${outcome.serverId} 已写入配置，但激活后复核没通过：${check.reasons.join('；')}`
      },
      summary: {
        kind: 'capabilities',
        action: 'acquire',
        planId: plan.planId,
        operationId,
        serverId: outcome.serverId,
        state: tx.state,
        executed: check.ok,
        toolCount: outcome.tools.length
      }
    }
  }

  async runCapabilitiesSearch(params: Record<string, unknown>) {
    const queryText = paramString(params, ['queryText', 'query-text', 'query', 'text']) ?? ''
    const limit = paramNumber(params, 'limit')
    const scope = paramString(params, ['scope'])
    if (scope && scope !== 'available') {
      throw new CapabilityCommandError(
        'capability_scope_unsupported',
        `capabilities search 目前只支持 scope=available（收到 ${scope}）；联网发现是 capabilities.discover`
      )
    }
    const commands = await this.host.rawCommands()
    const mcp = await this.collectMcpCatalog()
    const catalog = buildCatalog(commands, mcp.tools)
    const result = searchCapabilities(catalog.capabilities, {
      queryText,
      limit,
      projectId: this.host.capabilityOpts()?.projectId
    })
    return {
      data: {
        query: queryText,
        considered: result.considered,
        reason: result.reason,
        conflicts: catalog.conflicts,
        /* 已登记的 MCP 服务状态：连不上时也要让模型看到原因（不是沉默地少列几条）。 */
        mcpServers: mcp.servers,
        hits: result.hits.map((hit) => ({
          id: hit.capability.id,
          kind: hit.capability.kind,
          title: hit.capability.title,
          description: hit.capability.description,
          location: hit.capability.source.location,
          owner: hit.capability.source.owner,
          availability: hit.capability.availability,
          effect: hit.capability.effect,
          ...(hit.capability.schemaRevision ? { schemaRevision: hit.capability.schemaRevision } : {}),
          score: hit.score,
          matched: hit.matched
        }))
      },
      summary: {
        kind: 'capabilities',
        action: 'search',
        count: result.hits.length,
        considered: result.considered,
        mcpToolCount: mcp.tools.length,
        ids: result.hits.map((hit) => hit.capability.id)
      }
    }
  }
}
