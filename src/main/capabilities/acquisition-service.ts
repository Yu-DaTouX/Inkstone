/**
 * 接入事务的宿主实现（实施-04 S6a）：**受管 staging + 校验 + receipt + 恢复复核**。
 *
 * ── 这一层负责什么 ──
 *   发现链（S5）给出「计划」，这里负责把「计划」变成「本机真的有一份东西，
 *   并且我们知道它是什么」：落盘到**受管目录**、按上限校验、算 hash、
 *   写 receipt、失败只清本次。真正的下载器 / 安装器（联网、`pi install`）
 *   是 S6b —— 本片**不联网、不装包、不碰用户已有安装**。
 *
 * ── 三条不能省的检查 ──
 *   1. **写之前先校验**：`../` / 绝对路径 / symlink / 解压膨胀一律拒收（§10 第 2 条）。
 *      落盘之后再查就已经晚了 —— 文件已经出去了。
 *   2. **落盘之后算 hash 并写进 manifest**：`resumeCheck` 靠它发现「文件被人换过」。
 *   3. **日志不是证据**：`activated` 只说明我们记过这一步；恢复时必须重新核对
 *      receipt + 文件 hash，否则「事务记录写过 activated」会掩盖资源已损坏（§10.2）。
 *
 * ── 为什么 operationId 是**确定性**的 ──
 *   §10：`acquire` 重试要用同一个 operationId，不能装两次。把它算成
 *   `planId + 计划版本` 的指纹，就天然满足「同一计划 → 同一事务」，
 *   不依赖谁来记住上次的 ID；而源内容真的变了（digest 不同）时，
 *   它会被当成「同一事务的内容变了」而**报错**，而不是悄悄又开一个事务。
 */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, dirname, isAbsolute, resolve, sep } from 'node:path'
import {
  ARTIFACT_LIMITS,
  advanceAcquisition,
  canRetryAcquisition,
  classifyAcquisitionFailure,
  newAcquisitionTransaction,
  normalizeArtifactPath,
  receiptMatches,
  retryAcquisition,
  validateArtifactEntries,
  type AcquisitionFailureCode,
  type AcquisitionTransaction,
  type ArtifactEntry,
  type ArtifactLimits,
  type CapabilityReceipt,
  type PiPackageActivationTarget,
  type SkillFilesActivationTarget
} from '../../shared/acquisition'

export const ACQUISITION_DIRNAME = 'capabilities'
export const ACQUISITION_LOG_FILENAME = 'acquisition.json'
export const ACQUISITION_LOG_VERSION = 1
export const STAGING_DIRNAME = 'staging'
export const MANIFEST_FILENAME = 'manifest.json'
export const PAYLOAD_DIRNAME = 'payload'

export type AcquisitionLogFile = {
  version: number
  transactions: Record<string, AcquisitionTransaction>
}

export type StagedFileInput = { path: string; content: string | Uint8Array }
export type StagedManifestFile = { path: string; bytes: number; sha256: string }
export type StagedManifest = {
  version: 1
  operationId: string
  createdAt: string
  files: StagedManifestFile[]
  totalBytes: number
}

export class AcquisitionStagingError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'AcquisitionStagingError'
  }
}

export function acquisitionRoot(root: string): string {
  return join(root, ACQUISITION_DIRNAME)
}

export function stagingRoot(root: string): string {
  return join(acquisitionRoot(root), STAGING_DIRNAME)
}

export function stagingDirOf(root: string, operationId: string): string {
  return join(stagingRoot(root), safeSegment(operationId))
}

export function acquisitionLogPath(root: string): string {
  return join(acquisitionRoot(root), ACQUISITION_LOG_FILENAME)
}

/** operationId 只允许出现在路径里的安全字符（它来自哈希，这里只是双保险）。 */
function safeSegment(operationId: string): string {
  const text = String(operationId ?? '').trim()
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(text)) {
    throw new AcquisitionStagingError('bad-operation-id', `operationId 形状不合法：${JSON.stringify(operationId)}`)
  }
  return text
}

/**
 * 确定性事务 ID（§10）：同一计划 + 同一计划版本 → 同一 ID。
 *
 * 为什么**不把 digest 算进去**：算了它，源一变（版本 / commit / integrity 变了）就变成
 * 一个新事务 —— 等于「悄悄又装一遍」，而 §8 要求源内容变化时**旧计划失效**、
 * 由用户或策略重新确认。不含 digest，这种漂移才会撞到 «已存在但指纹不同» 而报错。
 */
export function operationIdOf(input: { planId: string; planRevision?: number }): string {
  const stable = [input.planId, String(input.planRevision ?? 1)].join('\u0000')
  return createHash('sha256').update(stable).digest('hex').slice(0, 24)
}

async function writeFileAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

function sha256Of(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

function toBuffer(content: string | Uint8Array): Buffer {
  return typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
}

export type AcquisitionServiceOptions = {
  /** 受管根目录（生产是 `YAN_DIR`；测试用临时目录，两者互不影响）。 */
  root: string
  limits?: ArtifactLimits
}

export class AcquisitionService {
  private readonly root: string
  private readonly limits: ArtifactLimits
  private writeTail: Promise<void> = Promise.resolve()

  constructor(options: AcquisitionServiceOptions) {
    this.root = resolve(options.root)
    this.limits = options.limits ?? ARTIFACT_LIMITS
  }

  get stagingRoot(): string {
    return stagingRoot(this.root)
  }

  async list(): Promise<AcquisitionTransaction[]> {
    const log = await this.readLog()
    return Object.values(log.transactions).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  async get(operationId: string): Promise<AcquisitionTransaction | null> {
    const log = await this.readLog()
    return log.transactions[operationId] ?? null
  }

  /**
   * 开始（或取回）一个接入事务。
   *
   * 幂等是**产品要求**而不是优化：同一个计划第二次进来必须拿回同一条事务，
   * 否则重试会变成「又装一遍」（§10）。
   */
  async begin(input: {
    planId: string
    planRevision?: number
    candidateId: string
    digest: string
    projectId: string
    at?: string
  }): Promise<AcquisitionTransaction> {
    const at = input.at ?? new Date().toISOString()
    const operationId = operationIdOf({
      planId: input.planId,
      ...(input.planRevision !== undefined ? { planRevision: input.planRevision } : {})
    })
    const log = await this.readLog()
    const existing = log.transactions[operationId]
    if (existing) {
      /* 同一 operationId 但内容指纹不同 = 有人在同一次尝试里换了源，拒绝复用。 */
      if (existing.digest !== input.digest) {
        throw new AcquisitionStagingError(
          'digest-mismatch',
          `事务 ${operationId} 已存在但内容指纹不同（${existing.digest} → ${input.digest}）：计划已失效，请重新 prepare`
        )
      }
      return existing
    }
    const tx = newAcquisitionTransaction({
      operationId,
      planId: input.planId,
      planRevision: input.planRevision ?? 1,
      candidateId: input.candidateId,
      digest: input.digest,
      projectId: input.projectId,
      at
    })
    await this.saveTransaction(tx)
    return tx
  }

  /**
   * 把文件集落到本次受管 staging，并写 manifest。
   *
   * 顺序是刻意的：**先校验元数据 → 再落盘 → 最后写 manifest**。
   * 任何一步失败都会把**本次** staging 整个删掉再抛 —— 不给下一次留下半份。
   */
  async stage(input: { operationId: string; files: readonly StagedFileInput[]; at?: string }): Promise<StagedManifest> {
    const at = input.at ?? new Date().toISOString()
    const current = await this.get(input.operationId)
    if (!current) {
      throw new AcquisitionStagingError('unknown-operation', `没有这个接入事务：${input.operationId}`)
    }
    if (current.state === 'failed') {
      throw new AcquisitionStagingError(
        'operation-failed',
        canRetryAcquisition(current)
          ? '这个事务失败过，请先重试（retryAcquisition）再 stage'
          : '这个事务的尝试次数已用满，不能再 stage'
      )
    }

    const entries: ArtifactEntry[] = input.files.map((file) => ({
      path: file.path,
      bytes: toBuffer(file.content).byteLength
    }))
    const rejection = validateArtifactEntries(entries, this.limits)
    if (rejection) {
      await this.fail(input.operationId, `归档被拒：${rejection.code} — ${rejection.detail}`, at)
      throw new AcquisitionStagingError(rejection.code, `归档被拒：${rejection.detail}`)
    }

    let tx = current
    if (tx.state === 'prepared') {
      tx = await this.saveTransaction(advanceAcquisition(tx, 'acquiring', { at, detail: '开始写入受管 staging' }))
    }

    const dir = this.stagingDirChecked(input.operationId)
    const payloadDir = join(dir, PAYLOAD_DIRNAME)
    const manifestFiles: StagedManifestFile[] = []
    let totalBytes = 0
    try {
      await rm(dir, { recursive: true, force: true })
      await mkdir(payloadDir, { recursive: true })
      for (const file of input.files) {
        const relativePath = normalizeArtifactPath(file.path)
        if (relativePath === null) {
          /* validateArtifactEntries 已经拦过一轮；这里是「两道锁」中的第二道。 */
          throw new AcquisitionStagingError('bad-path', `不接受的归档路径：${JSON.stringify(file.path)}`)
        }
        const target = resolve(payloadDir, relativePath)
        if (target !== payloadDir && !target.startsWith(payloadDir + sep)) {
          throw new AcquisitionStagingError('escape', `路径逃出受管目录：${relativePath}`)
        }
        const buffer = toBuffer(file.content)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, buffer)
        manifestFiles.push({ path: relativePath, bytes: buffer.byteLength, sha256: sha256Of(buffer) })
        totalBytes += buffer.byteLength
      }
      const manifest: StagedManifest = {
        version: 1,
        operationId: input.operationId,
        createdAt: at,
        files: manifestFiles,
        totalBytes
      }
      await writeFileAtomic(join(dir, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2))
      await this.saveTransaction(
        advanceAcquisition(tx, 'verifying', { at, stagingDir: dir, detail: `${manifestFiles.length} 个文件已落盘` })
      )
      return manifest
    } catch (error) {
      /* 失败只清**本次** staging（§10.2）；别的 operationId 目录一个字节都不动。 */
      await rm(dir, { recursive: true, force: true })
      await this.fail(input.operationId, error instanceof Error ? error.message : String(error), at)
      throw error
    }
  }

  /**
   * 远程分支专用：没有文件要落 staging，直接把事务从 `prepared` / `pending-boundary`
   * 推进到 `acquiring`。§10：远程 MCP 走「验证端点 → 登记配置」，**不伪造下载步骤**。
   */
  async markAcquiring(operationId: string, detail: string, at = new Date().toISOString()): Promise<AcquisitionTransaction> {
    const tx = await this.get(operationId)
    if (!tx) throw new AcquisitionStagingError('unknown-operation', `没有这个接入事务：${operationId}`)
    if (tx.state === 'acquiring') return tx
    return this.saveTransaction(advanceAcquisition(tx, 'acquiring', { at, detail }))
  }

  /** 远程分支专用：登记完成、核验开始（核验是**真连一次**，见 `McpRegistrationService`）。 */
  async markVerifying(operationId: string, detail: string, at = new Date().toISOString()): Promise<AcquisitionTransaction> {
    const tx = await this.get(operationId)
    if (!tx) throw new AcquisitionStagingError('unknown-operation', `没有这个接入事务：${operationId}`)
    if (tx.state === 'verifying') return tx
    return this.saveTransaction(advanceAcquisition(tx, 'verifying', { at, detail }))
  }

  /** 重算 hash 复核 staging 与 manifest 是否一致（**不信任日志**）。 */
  async verifyStaged(operationId: string): Promise<{ ok: boolean; problems: string[] }> {
    const dir = this.stagingDirChecked(operationId)
    const problems: string[] = []
    let manifest: StagedManifest
    try {
      manifest = JSON.parse(await readFile(join(dir, MANIFEST_FILENAME), 'utf8')) as StagedManifest
    } catch {
      return { ok: false, problems: ['manifest.json 读不到（staging 不完整）'] }
    }
    if (
      !manifest || manifest.version !== 1 || manifest.operationId !== operationId ||
      !Array.isArray(manifest.files) || !Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 0
    ) {
      return { ok: false, problems: ['manifest.json 结构或 operationId 无效'] }
    }

    const expectedFiles = new Set<string>()
    const verifiedManifestFiles: StagedManifestFile[] = []
    let declaredBytes = 0
    for (const file of manifest.files) {
      if (
        !file || typeof file.path !== 'string' || normalizeArtifactPath(file.path) !== file.path ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)
      ) {
        problems.push(`manifest.json 含无效文件记录：${JSON.stringify(file)}`)
        continue
      }
      if (expectedFiles.has(file.path)) problems.push(`manifest.json 含重复路径：${file.path}`)
      expectedFiles.add(file.path)
      verifiedManifestFiles.push(file)
      declaredBytes += file.bytes
    }
    const manifestRejection = validateArtifactEntries(
      verifiedManifestFiles.map((file) => ({ path: file.path, bytes: file.bytes })),
      this.limits
    )
    if (manifestRejection) problems.push(`manifest.json 文件集无效：${manifestRejection.detail}`)
    if (declaredBytes !== manifest.totalBytes) problems.push('manifest.json totalBytes 与文件记录合计不符')

    const payloadDir = join(dir, PAYLOAD_DIRNAME)
    const actualFiles = new Set<string>()
    try {
      const payloadInfo = await lstat(payloadDir)
      if (!payloadInfo.isDirectory() || payloadInfo.isSymbolicLink()) {
        problems.push('payload 不是普通目录')
      } else {
        const pending = [{ absolute: payloadDir, relative: '' }]
        while (pending.length > 0) {
          const current = pending.pop()!
          const entries = await readdir(current.absolute, { withFileTypes: true })
          for (const entry of entries) {
            const relativePath = current.relative ? `${current.relative}/${entry.name}` : entry.name
            const absolutePath = join(current.absolute, entry.name)
            if (entry.isSymbolicLink()) {
              problems.push(`${relativePath}：payload 含符号链接`)
            } else if (entry.isDirectory()) {
              pending.push({ absolute: absolutePath, relative: relativePath })
            } else if (entry.isFile()) {
              actualFiles.add(relativePath)
              if (actualFiles.size > this.limits.maxFiles) {
                problems.push(`payload 文件数超过上限 ${this.limits.maxFiles}`)
                pending.length = 0
                break
              }
            } else {
              problems.push(`${relativePath}：payload 含特殊文件`)
            }
          }
        }
      }
    } catch {
      problems.push('payload 目录读不到（staging 不完整）')
    }
    for (const path of expectedFiles) {
      if (!actualFiles.has(path)) problems.push(`${path}：文件不在 payload 中`)
    }
    for (const path of actualFiles) {
      if (!expectedFiles.has(path)) problems.push(`${path}：文件未列入 manifest`)
    }

    for (const file of verifiedManifestFiles) {
      const target = join(dir, PAYLOAD_DIRNAME, file.path)
      try {
        const info = await lstat(target)
        if (!info.isFile() || info.isSymbolicLink()) {
          problems.push(`${file.path}：不是普通文件`)
          continue
        }
        const content = await readFile(target)
        if (content.byteLength !== file.bytes) {
          problems.push(`${file.path}：字节数 ${content.byteLength} ≠ manifest ${file.bytes}`)
          continue
        }
        const actual = sha256Of(content)
        if (actual !== file.sha256) problems.push(`${file.path}：sha256 与 manifest 不符`)
      } catch {
        problems.push(`${file.path}：文件不在`)
      }
    }
    return { ok: problems.length === 0, problems }
  }

  /**
   * 验证通过 → 登记 receipt 并激活。未通过则**不激活**。
   *
   * `verify` 可注入：文件类走 staging 重算 hash，远程 MCP 走「再连一次枚举工具」。
   * 默认值保持原行为，这样已有调用点不受影响。
   */
  async activate(input: {
    operationId: string
    receipt: Omit<CapabilityReceipt, 'operationId' | 'activatedAt'> & { activatedAt?: string }
    at?: string
    verify?: () => Promise<{ ok: boolean; problems: string[] }>
  }): Promise<AcquisitionTransaction> {
    const at = input.at ?? new Date().toISOString()
    const tx = await this.get(input.operationId)
    if (!tx) throw new AcquisitionStagingError('unknown-operation', `没有这个接入事务：${input.operationId}`)
    const verification = await (input.verify ?? (() => this.verifyStaged(input.operationId)))()
    if (!verification.ok) {
      await this.fail(input.operationId, `激活前复核失败：${verification.problems.join('；')}`, at)
      throw new AcquisitionStagingError('verify-failed', verification.problems.join('；'))
    }
    const receipt: CapabilityReceipt = {
      ...input.receipt,
      operationId: input.operationId,
      activatedAt: input.receipt.activatedAt ?? at
    }
    return this.saveTransaction(
      advanceAcquisition(tx, 'activated', { at, receipt, detail: `receipt 已登记（${receipt.verification}）` })
    )
  }

  /**
   * 恢复复核：receipt + 资源实体都要对。**日志写没写过不算**（§10.2）。
   * 文件类复核 staging 的 hash；远程类由调用方注入「再连一次」的复核。
   */
  async resumeCheck(input: {
    operationId: string
    expected: { planId: string; digest: string; planRevision?: number }
    verify?: () => Promise<{ ok: boolean; problems: string[] }>
  }): Promise<{ ok: boolean; reasons: string[] }> {
    const reasons: string[] = []
    const tx = await this.get(input.operationId)
    if (!tx) return { ok: false, reasons: ['事务不存在（可能被清理或从未开始）'] }
    if (tx.state !== 'activated' && tx.state !== 'resumed') {
      reasons.push(`事务状态是 ${tx.state}，不是已激活`)
    }
    if (!tx.receipt) {
      reasons.push('没有 receipt（接入没有登记完成）')
    } else if (!receiptMatches(tx.receipt, input.expected)) {
      reasons.push('receipt 与当前计划 / 内容指纹不符（源已变化，计划失效）')
    }
    if (tx.receipt) {
      const verify = input.verify ?? (() => this.verifyStaged(input.operationId))
      const checked = await verify()
      if (!checked.ok) reasons.push(...checked.problems)
    }
    return { ok: reasons.length === 0, reasons }
  }

  /**
   * 等边界（§10.1）：确实需要安装但**本轮不能装**（例如 pi 包要等当前回合安全结束）时，
   * 停在 `pending-boundary` 而不是假装激活 —— 调度器随后从这条事务继续。
   */
  async markBoundary(operationId: string, detail: string, at = new Date().toISOString()): Promise<AcquisitionTransaction> {
    const tx = await this.get(operationId)
    if (!tx) throw new AcquisitionStagingError('unknown-operation', `没有这个接入事务：${operationId}`)
    if (tx.state === 'pending-boundary') return tx
    return this.saveTransaction(advanceAcquisition(tx, 'pending-boundary', { at, detail }))
  }

  /**
   * Bind a staged npm pi package to the exact project session that requested it.
   * This is persisted before returning to pi so a later idle scheduler can recover
   * the target without trusting transient model arguments.
   */
  async bindPiPackageTarget(
    operationId: string,
    target: PiPackageActivationTarget
  ): Promise<AcquisitionTransaction> {
    const tx = await this.get(operationId)
    if (!tx) throw new AcquisitionStagingError('unknown-operation', `没有这个接入事务：${operationId}`)
    if (tx.state !== 'pending-boundary') {
      throw new AcquisitionStagingError('bad-target-state', `只有 pending-boundary 事务可绑定激活目标（当前 ${tx.state}）`)
    }
    if (
      !/^[A-Za-z0-9._-]{1,120}$/.test(target.runnerId) ||
      !Number.isSafeInteger(target.runnerGeneration) || target.runnerGeneration < 1 ||
      !isAbsolute(target.cwd) ||
      !isAbsolute(target.sessionFile) ||
      !target.projectId || target.projectId !== tx.projectId ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(target.goalId) ||
      !Number.isSafeInteger(target.goalRevision) || target.goalRevision < 0 ||
      (target.sourceHead !== null && !/^[a-f0-9]{40,64}$/i.test(target.sourceHead)) ||
      target.continueId !== tx.operationId ||
      !target.packageName || target.packageName.length > 214 || /[\u0000-\u0020]/.test(target.packageName) ||
      !target.packageVersion || target.packageVersion.length > 128 || /[\u0000-\u0020]/.test(target.packageVersion)
    ) {
      throw new AcquisitionStagingError('bad-target', 'pi 包激活目标字段无效')
    }
    if (tx.piPackageTarget) {
      if (JSON.stringify(tx.piPackageTarget) !== JSON.stringify(target)) {
        throw new AcquisitionStagingError('target-conflict', '同一事务已绑定不同的项目 / runner / 会话，拒绝覆盖')
      }
      return tx
    }
    return this.saveTransaction({ ...tx, piPackageTarget: { ...target }, updatedAt: new Date().toISOString() })
  }

  /** Bind a staged Skill-file transaction to the exact project runner that requested it. */
  async bindSkillFilesTarget(
    operationId: string,
    target: SkillFilesActivationTarget
  ): Promise<AcquisitionTransaction> {
    const tx = await this.get(operationId)
    if (!tx) throw new AcquisitionStagingError('unknown-operation', `没有这个接入事务：${operationId}`)
    if (tx.state !== 'pending-boundary') {
      throw new AcquisitionStagingError('bad-target-state', `只有 pending-boundary 事务可绑定激活目标（当前 ${tx.state}）`)
    }
    if (
      !/^[A-Za-z0-9._-]{1,120}$/.test(target.runnerId) ||
      !Number.isSafeInteger(target.runnerGeneration) || target.runnerGeneration < 1 ||
      !isAbsolute(target.cwd) || !isAbsolute(target.sessionFile) ||
      !target.projectId || target.projectId !== tx.projectId ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(target.goalId) ||
      !Number.isSafeInteger(target.goalRevision) || target.goalRevision < 0 ||
      (target.sourceHead !== null && !/^[a-f0-9]{40,64}$/i.test(target.sourceHead)) ||
      target.continueId !== tx.operationId
    ) {
      throw new AcquisitionStagingError('bad-target', 'Skill 文件激活目标字段无效')
    }
    if (tx.skillFilesTarget) {
      if (JSON.stringify(tx.skillFilesTarget) !== JSON.stringify(target)) {
        throw new AcquisitionStagingError('target-conflict', '同一事务已绑定不同的项目 / runner / 会话，拒绝覆盖')
      }
      return tx
    }
    return this.saveTransaction({ ...tx, skillFilesTarget: { ...target }, updatedAt: new Date().toISOString() })
  }

  /**
   * 激活复核通过 → `resumed`（§10.2：`resumed` 只能由**磁盘 / 连接证据**置位）。
   * 调用方负责先跑 `resumeCheck`；这里只负责把这一步如实记进事务日志。
   */
  async markResumed(operationId: string, detail: string, at = new Date().toISOString()): Promise<AcquisitionTransaction> {
    const tx = await this.get(operationId)
    if (!tx) throw new AcquisitionStagingError('unknown-operation', `没有这个接入事务：${operationId}`)
    if (tx.state === 'resumed') return tx
    return this.saveTransaction(advanceAcquisition(tx, 'resumed', { at, detail }))
  }

  /**
   * 把可重试的失败退回 prepared，并清理**只属于该 operationId** 的 staging。
   * 下载缓存不在 staging 根内，故不会被顺手删除；下一次安装仍须重新校验它。
   */
  async retry(operationId: string, at = new Date().toISOString()): Promise<AcquisitionTransaction> {
    const tx = await this.get(operationId)
    if (!tx) throw new AcquisitionStagingError('unknown-operation', `没有这个接入事务：${operationId}`)
    if (!canRetryAcquisition(tx)) {
      throw new AcquisitionStagingError(
        'retry-not-allowed',
        `这个事务不能重试（state=${tx.state}, attempts=${tx.attempts}）`
      )
    }
    await rm(this.stagingDirChecked(operationId), { recursive: true, force: true })
    return this.saveTransaction(retryAcquisition(tx, at))
  }

  /** 标记失败：分类由 `classifyAcquisitionFailure` 决定，认不出来就如实说 unknown。 */
  async fail(operationId: string, detail: string, at = new Date().toISOString()): Promise<AcquisitionTransaction> {
    const tx = await this.get(operationId)
    if (!tx) throw new AcquisitionStagingError('unknown-operation', `没有这个接入事务：${operationId}`)
    if (tx.state === 'failed' || tx.state === 'cancelled') return tx
    const code: AcquisitionFailureCode = classifyAcquisitionFailure(detail)
    return this.saveTransaction(
      advanceAcquisition(tx, 'failed', { at, failure: { code, detail }, detail: `失败（${code}）` })
    )
  }

  /** 只删本次受管 staging（§10.2）；路径必须落在 staging 根下。 */
  async rollback(operationId: string): Promise<void> {
    const dir = this.stagingDirChecked(operationId)
    await rm(dir, { recursive: true, force: true })
  }

  /* ------------------------------------------------------------- 内部 */

  private stagingDirChecked(operationId: string): string {
    const dir = stagingDirOf(this.root, operationId)
    const rootResolved = resolve(this.stagingRoot)
    const target = resolve(dir)
    if (target !== rootResolved && !target.startsWith(rootResolved + sep)) {
      throw new AcquisitionStagingError('escape', `staging 目录落在受管根之外：${target}`)
    }
    return target
  }

  private async readLog(): Promise<AcquisitionLogFile> {
    let raw: string
    try {
      raw = await readFile(acquisitionLogPath(this.root), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: ACQUISITION_LOG_VERSION, transactions: {} }
      }
      throw new AcquisitionStagingError(
        'log-read-failed',
        `接入事务日志无法读取，拒绝按空日志继续：${error instanceof Error ? error.message : String(error)}`
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new AcquisitionStagingError('log-corrupt', `接入事务日志损坏，拒绝覆盖：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AcquisitionStagingError('log-corrupt', '接入事务日志结构无效，拒绝覆盖')
    }
    const file = parsed as Partial<AcquisitionLogFile>
    if (!file.transactions || typeof file.transactions !== 'object' || Array.isArray(file.transactions)) {
      throw new AcquisitionStagingError('log-corrupt', '接入事务列表结构无效，拒绝覆盖')
    }
    return { version: file.version ?? ACQUISITION_LOG_VERSION, transactions: file.transactions }
  }

  private async saveTransaction(tx: AcquisitionTransaction): Promise<AcquisitionTransaction> {
    const work = this.writeTail.then(async () => {
      const log = await this.readLog()
      log.transactions[tx.operationId] = tx
      await mkdir(acquisitionRoot(this.root), { recursive: true })
      await writeFileAtomic(
        acquisitionLogPath(this.root),
        JSON.stringify({ version: ACQUISITION_LOG_VERSION, transactions: log.transactions }, null, 2)
      )
      return tx
    })
    this.writeTail = work.then(() => undefined, () => undefined)
    return work
  }
}
