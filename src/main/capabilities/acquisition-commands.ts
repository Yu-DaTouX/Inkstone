import type { CapabilityAuthorizationChoice, CapabilityAuthorizationPrompt, CapabilityRunOptions } from '../agent'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { CapabilityCommandError } from '../capability-server'
import { YAN_DIR } from '../paths'
import { searchCapabilities } from '../../shared/capabilities'
import { buildCatalog } from './catalog'
import type { McpCatalogEntry } from './catalog'
import { acquisitionServiceFor, operationIdOf } from './acquisition-service'
import { PackageAuthorizationService } from './package-authorization-service'
import { readRepoState } from '../git-service'
import { fetchNpmPackageMetadata } from './npm-artifact'
import { stageNpmAcquisition } from './npm-acquisition'
import { discoverCapabilities, planForCandidate } from './discovery/discover'
import type { AcquisitionPlan, CapabilityCandidate } from '../../shared/discovery'
import { fetchSkillFiles } from './skill-source'
import { fetchGithubSkillFiles, parseSkillRepo } from './github-skills'
import {
  acquiredSkillName,
  declaredSkillFile,
  installAcquiredSkill,
  listSessionSkills,
  parseSkillFrontmatter,
  reviewAcquiredSkill,
  skillFilesLayout,
  SOURCE_META_FILE,
  type AcquiredSkillFile,
  type AcquiredSkillScope
} from './acquired-skills'
import type { SkillSecurityFinding } from '../../shared/skill-security'
import { UI_TIMEOUT_APPROVAL } from '../../shared/ui-timeout'
import { existsSync } from 'node:fs'
import { userSkillsDir } from '../user-skills'
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
  rawCommands(): Promise<RawSkillCommand[]>
  push(msg: MainPush): void
  getState(): SessionState | null
  confirmCapabilityAuthorization(): ((request: CapabilityAuthorizationPrompt) => Promise<CapabilityAuthorizationChoice>) | undefined
  bundledSkills(): string[]
  requestApproval(request: { title: string; message: string; options: string[]; placeholder: string; timeout: number }): Promise<{ value?: string; cancelled?: boolean }>
}

const SKILL_SCOPE_OPTIONS: Record<AcquiredSkillScope, string> = {
  session: '仅本次会话使用',
  user: '安装到我的技能（所有会话可用）'
}
const SCRIPT_EXT = /\.(?:py|js|mjs|cjs|ts|sh|bash|ps1|bat|cmd|rb|pl)$/i

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export class CapabilityAcquisition {
  constructor(private readonly host: CapabilityAcquisitionHost) {}

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

  readonly discoveryCandidates = new Map<string, { candidate: CapabilityCandidate; at: number }>()

  readonly acquisitionPlans = new Map<
    string,
    { plan: AcquisitionPlan; candidate: CapabilityCandidate; digest: string; at: number }
  >()

  async runCapabilitiesDiscover(params: Record<string, unknown>) {
    const queryText = paramString(params, ['queryText', 'query-text', 'query', 'text']) ?? ''
    const goalText = paramString(params, ['goal', 'goalText', 'goal-text'])
    const timeoutMs = paramNumber(params, 'timeoutMs')
    const repoParam = paramString(params, ['repo', 'repos'])
    const skillRepos = repoParam
      ? repoParam.split(',').map((item) => parseSkillRepo(item)).filter((item) => item !== null).map(({ owner, repo }) => `${owner}/${repo}`)
      : []
    if (repoParam && skillRepos.length === 0) {
      throw new CapabilityCommandError('capability_repo_invalid', '--repo 要写成 owner/repo，例如 anthropics/skills')
    }
    const outcome = await discoverCapabilities({
      queryText,
      ...(goalText ? { goalText } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(skillRepos.length > 0 ? { skillRepos } : {})
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
        candidates: outcome.candidates.map(({ candidate, score, reasons }) => {
          const { githubSkill, ...rest } = candidate
          return {
            ...rest,
            ...(githubSkill ? { github: { repo: `${githubSkill.owner}/${githubSkill.repo}`, dir: githubSkill.dir, fileCount: githubSkill.files.length } } : {}),
            score,
            scoreReasons: reasons
          }
        }),
        notice:
          '候选来自公开目录：只证明发布来源存在，不等于内容已审计或已验证可用；github: 开头的技能固定到提交，接入时逐文件核对。' +
          '技能用 yan capabilities acquire --candidate <候选ID> 接入：砚会弹出限时批准面板，由用户选择「仅本次会话」或「安装到我的技能」，不需要先在对话里征求同意。'
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
        this.discoveryCandidates.set(candidateId, { candidate, at: entry.at })
      } catch (error) {
        throw new CapabilityCommandError(
          'package_metadata_failed',
          `无法为固定 npm 候选取到可校验的 exact-version manifest：${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    const capabilityOpts = this.host.capabilityOpts()
    const goalId = capabilityOpts?.sessionId?.trim()
    const projectId = capabilityOpts?.projectId?.trim()
    if (!goalId || !projectId) {
      throw new CapabilityCommandError('context_missing', '缺少当前项目或会话身份，拒绝生成未绑定上下文的接入计划。')
    }
    const { plan, digest } = planForCandidate({ candidate, goalId, projectId })
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

  async runCapabilitiesAcquire(params: Record<string, unknown>) {
    let planId = paramString(params, ['plan', 'planId', 'plan-id', 'id'])
    const shortcutCandidate = planId ? undefined : paramString(params, ['candidateId', 'candidate', 'candidate-id'])
    if (shortcutCandidate) {
      const prepared = await this.runCapabilitiesPrepare({ candidateId: shortcutCandidate })
      planId = (prepared.data as { plan: AcquisitionPlan }).plan.planId
    }
    if (!planId) {
      throw new CapabilityCommandError(
        'plan_required',
        '需要 --plan <计划ID> 或 --candidate <候选ID>（候选来自 yan capabilities discover）'
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
    const operationId = operationIdOf({ planId: plan.planId, planRevision: plan.revision })
    const explicitAuthorize = params.authorize === true || params.authorize === 'true'

    if (['remote', 'mcp-package'].includes(candidate.installKind)) {
      return {
        data: {
          plan,
          candidate,
          operationId,
          executable: false,
          state: 'mcp-native-only',
          notice:
            '通用 MCP 服务的登记已收口到 pi 原生：砚不再写入宿主 MCP 配置。' +
            '已登记的服务请用设置页的「导入到 pi」迁到 pi 原生 mcp.json；此获取分支不会下载或登记。'
        },
        summary: {
          kind: 'capabilities',
          action: 'acquire',
          planId: plan.planId,
          operationId,
          state: 'mcp-native-only',
          executed: false
        }
      }
    }

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

    if (candidate.installKind === 'skill-files') return this.acquireSkill({ plan, candidate })

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
          state: 'needs-authorization',
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

    const service = acquisitionServiceFor(YAN_DIR)
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

    let npmStaged = false
    let npmFailure: string | undefined
    const localPackage = candidate.localPackage
    const canStageNpmPackage =
      candidate.installKind === 'pi-package' &&
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

    if (npmStaged && localPackage?.identifier && (localPackage.version ?? candidate.version)) {
      const sessionFile = this.host.getState()?.sessionFile
      const runnerId = this.host.capabilityOpts()?.sessionId
      const projectId = this.host.capabilityOpts()?.projectId
      if (sessionFile && runnerId && projectId) {
        const sourceHead = (await readRepoState(this.host.cwd(), { withRefs: false }))?.head ?? null
        tx = await service.bindPiPackageTarget(tx.operationId, {
          runnerId,
          runnerGeneration: this.host.capabilityOpts()?.runnerGeneration ?? 1,
          cwd: this.host.cwd(),
          sessionFile,
          projectId,
          goalId: plan.goalId,
          goalRevision: 0,
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

  private async skillFilesOf(candidate: CapabilityCandidate): Promise<{ files: AcquiredSkillFile[]; dirName?: string }> {
    if (candidate.githubSkill) {
      const files = await fetchGithubSkillFiles(candidate.githubSkill)
      return { files, dirName: candidate.githubSkill.dir.split('/').at(-1) || candidate.githubSkill.repo }
    }
    const listed = candidate.skillFileUrls
      ? (await fetchSkillFiles({
          fileUrls: candidate.skillFileUrls,
          expectedHashes: candidate.skillFileHashes ?? {},
          allowedOrigins: candidate.sourceUrls,
          timeoutMs: 15_000
        })).map(({ path, content }) => ({ path, content }))
      : await Promise.all((candidate.skillFiles ?? []).map(async (path) => {
          const source = declaredSkillFile(this.host.cwd(), path)
          return { path: source.path, content: await readFile(source.absolute) }
        }))
    return skillFilesLayout(listed)
  }

  private skillApprovalMessage(input: {
    name: string
    description: string
    candidate: CapabilityCandidate
    files: AcquiredSkillFile[]
    warnings: SkillSecurityFinding[]
    truncated: boolean
    userBlocked?: string
  }): string {
    const { candidate, files } = input
    const github = candidate.githubSkill
    const source = github
      ? `github.com/${github.owner}/${github.repo}${github.dir ? `/${github.dir}` : ''}（提交 ${github.commit.slice(0, 12)}）`
      : (candidate.sourceUrls[0] ?? candidate.candidateId).replace(/^https?:\/\//, '')
    const total = files.reduce((sum, file) => sum + file.content.byteLength, 0)
    const scripts = files.filter((file) => SCRIPT_EXT.test(file.path))
    const exts = [...new Set(scripts.map((file) => file.path.slice(file.path.lastIndexOf('.'))))].join(' ')
    const review = input.warnings.length > 0
      ? `需要留意 ${input.warnings.length} 处：${input.warnings.slice(0, 3).map((f) => `${f.detail}（${f.path}:${f.line}）`).join('；')}`
      : input.truncated ? '命中较多，已截断，请自行查看来源' : '未发现高风险写法'
    return [
      `Agent 想接入技能「${input.name}」`,
      `来源：${source}`,
      `发布方自述：${input.description.length > 240 ? `${input.description.slice(0, 239)}…` : input.description || '（没有描述）'}`,
      `内容：${files.length} 个文件，${formatSize(total)}${scripts.length > 0 ? `；含 ${scripts.length} 个脚本（${exts}），按技能做事时模型可能运行它们` : ''}`,
      `审查：${review}`,
      ...(input.userBlocked ? [input.userBlocked] : []),
      '不批准就点「跳过」；到时间没有选择也会自动跳过。'
    ].join('\n')
  }

  private async acquireSkill(input: { plan: AcquisitionPlan; candidate: CapabilityCandidate }) {
    const { plan, candidate } = input
    const summary = (state: string, extra: Record<string, unknown> = {}) => ({
      kind: 'capabilities',
      action: 'acquire',
      planId: plan.planId,
      candidateId: candidate.candidateId,
      state,
      executed: state === 'installed',
      ...extra
    })
    const sessionId = this.host.getState()?.sessionId
    if (!sessionId) throw new CapabilityCommandError('session_missing', '当前没有会话，无法接入技能')

    const already = (await listSessionSkills(YAN_DIR, sessionId)).find((skill) => skill.candidateId === candidate.candidateId)
    if (already) {
      return {
        data: { state: 'installed', scope: 'session', name: already.name, skillFile: already.skillFile, notice: '本会话已接入这个技能，直接 read skillFile 继续。' },
        summary: summary('installed', { scope: 'session', reused: true })
      }
    }

    let files: AcquiredSkillFile[]
    let name: string
    let description: string
    try {
      const loaded = await this.skillFilesOf(candidate)
      files = loaded.files
      const skillMd = files.find((file) => file.path === 'SKILL.md')
      const meta = skillMd ? parseSkillFrontmatter(new TextDecoder().decode(skillMd.content)) : {}
      name = acquiredSkillName(meta.name, loaded.dirName, candidate.title)
      description = meta.description ?? candidate.summary
    } catch (error) {
      const notice = `取技能文件失败，未安装：${error instanceof Error ? error.message : String(error)}`
      return { data: { state: 'failed', candidate, notice }, summary: summary('failed') }
    }

    const { review, blocked, warnings } = reviewAcquiredSkill(files)
    if (blocked.length > 0) {
      const where = blocked.slice(0, 3).map((f) => `${f.path}:${f.line}「${f.excerpt}」`).join('；')
      return {
        data: { state: 'blocked', candidate, notice: `内容审查发现疑似提示注入，已拒绝接入：${where}。不要换个方式绕过，改用不装技能的办法。` },
        summary: summary('blocked')
      }
    }

    const reserved = this.host.bundledSkills().map((path) => basename(dirname(path)))
    const userDir = join(userSkillsDir(), name)
    const userBlocked = reserved.includes(name)
      ? `与砚随包技能「${name}」同名，只能在本次会话使用。`
      : existsSync(userDir) && !existsSync(join(userDir, SOURCE_META_FILE))
        ? `我的技能里已有自己写的「${name}」，只能在本次会话使用。`
        : undefined
    const options = userBlocked ? [SKILL_SCOPE_OPTIONS.session] : [SKILL_SCOPE_OPTIONS.session, SKILL_SCOPE_OPTIONS.user]

    let answer: { value?: string; cancelled?: boolean }
    try {
      answer = await this.host.requestApproval({
        title: `授权接入技能「${name}」`,
        message: this.skillApprovalMessage({ name, description, candidate, files, warnings, truncated: review.truncated, userBlocked }),
        options,
        placeholder: '或告诉 Agent 换个做法（不安装）',
        timeout: UI_TIMEOUT_APPROVAL
      })
    } catch (error) {
      if (!(error instanceof CapabilityCommandError) || error.code !== 'question_timeout') throw error
      return {
        data: {
          state: 'skipped',
          reason: 'timeout',
          candidate: { candidateId: candidate.candidateId, title: name },
          notice: '用户没有在时限内批准，已自动跳过，未安装任何东西。不要再次请求这个技能；改用不装技能的办法继续，并在回复里说明缺了什么。'
        },
        summary: summary('skipped', { reason: 'timeout' })
      }
    }

    const scope = (Object.keys(SKILL_SCOPE_OPTIONS) as AcquiredSkillScope[]).find((key) => answer.value === SKILL_SCOPE_OPTIONS[key])
    if (!scope || !options.includes(SKILL_SCOPE_OPTIONS[scope])) {
      const reply = answer.cancelled ? undefined : answer.value?.trim() || undefined
      return {
        data: {
          state: 'skipped',
          reason: reply ? 'user-reply' : 'declined',
          candidate: { candidateId: candidate.candidateId, title: name },
          ...(reply ? { userReply: reply } : {}),
          notice: reply
            ? '用户没有批准安装，而是回复了上面的 userReply；按用户的话调整做法，不要再次请求这个技能。'
            : '用户选择不安装。不要再次请求这个技能；改用不装技能的办法继续，并在回复里说明缺了什么。'
        },
        summary: summary('skipped', { reason: reply ? 'user-reply' : 'declined' })
      }
    }

    try {
      const installed = await installAcquiredSkill({
        root: YAN_DIR,
        scope,
        sessionId,
        name,
        description,
        files,
        source: {
          candidateId: candidate.candidateId,
          ...(candidate.sourceUrls[0] ? { url: candidate.sourceUrls[0] } : {}),
          ...(candidate.repository ? { repository: candidate.repository } : {}),
          ...(candidate.commit ? { commit: candidate.commit } : {})
        },
        reservedNames: reserved
      })
      return {
        data: {
          state: 'installed',
          scope: installed.scope,
          name,
          skillFile: installed.skillFile,
          ...(warnings.length > 0 ? { warnings: warnings.map((f) => `${f.detail}（${f.path}:${f.line}）`) } : {}),
          notice: installed.scope === 'session'
            ? '已接入本次会话（只对这个会话生效，其他会话看不到）。现在用 read 打开 skillFile，按其中说明继续；技能里的相对路径以 SKILL.md 所在目录为基准。'
            : '已安装到「我的技能」，之后所有新会话都会加载。现在用 read 打开 skillFile，按其中说明继续；技能里的相对路径以 SKILL.md 所在目录为基准。'
        },
        summary: summary('installed', { scope: installed.scope, name })
      }
    } catch (error) {
      const notice = `安装失败，未改动技能目录：${error instanceof Error ? error.message : String(error)}`
      return { data: { state: 'failed', candidate: { candidateId: candidate.candidateId, title: name }, notice }, summary: summary('failed') }
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
