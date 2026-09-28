import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  CONTEXT_BUDGET_V1_TIERS,
  isContextBudgetTierV1,
  type ContextBudgetMaterialRecordV1,
  type ContextBudgetPhasePolicyV1,
  type ContextBudgetSessionPolicyV1
} from '../shared/context-budget-v1'
import { isSafeSessionId } from './context-state-store'
import { YAN_DIR } from './paths'
import {
  type ContextMaintenanceBaseV1,
  canTransitionContextMaintenanceV1,
  isContextMaintenanceOperationV1,
  type ContextMaintenanceActivePointerV1,
  type ContextMaintenanceOperationV1,
  type ContextMaintenanceProjectionV1,
  type ContextMaintenanceStateV1
} from '../shared/context-maintenance'

const STORE_DIR = join(YAN_DIR, 'context-budget-v1')
const PHASE_ID_RE = /^[A-Za-z0-9._-]{1,120}$/
const MAX_POLICY_BYTES = 16 * 1024 * 1024
const MAX_SESSION_MATERIALS = 2_000
const OPERATION_ID_RE = /^[A-Za-z0-9._-]{1,120}$/
const MAX_MAINTENANCE_FILE_BYTES = 8 * 1024 * 1024

export class ContextBudgetStoreError extends Error {
  constructor(readonly code: 'invalid_session' | 'invalid_phase' | 'corrupt' | 'stale_revision' | 'write_failed', message: string) {
    super(message)
    this.name = 'ContextBudgetStoreError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function validRevision(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 100
}

function validWatermark(value: unknown): value is { entryCount: number; lastEntryId: string | null } {
  return isRecord(value) && Number.isSafeInteger(value.entryCount) && (value.entryCount as number) >= 0 &&
    (value.lastEntryId === null || (typeof value.lastEntryId === 'string' && value.lastEntryId.length > 0 && value.lastEntryId.length <= 200))
}

function validProjection(value: unknown, sessionId: string, projectionId: string): value is ContextMaintenanceProjectionV1 {
  if (!isRecord(value) || value.version !== 1 || value.sessionId !== sessionId || value.projectionId !== projectionId ||
    typeof value.operationId !== 'string' || !OPERATION_ID_RE.test(value.operationId) ||
    typeof value.runnerId !== 'string' || value.runnerId.length === 0 || value.runnerId.length > 200 ||
    typeof value.runnerEpoch !== 'string' || value.runnerEpoch.length === 0 || value.runnerEpoch.length > 100 ||
    !isRecord(value.base) || !validWatermark(value.base.rawWatermark) ||
    typeof value.base.sourceRevision !== 'string' || value.base.sourceRevision.length < 8 || value.base.sourceRevision.length > 300 ||
    typeof value.base.policyRevision !== 'string' || value.base.policyRevision.length < 8 || value.base.policyRevision.length > 100 ||
    typeof value.base.capabilityRevision !== 'string' || value.base.capabilityRevision.length === 0 || value.base.capabilityRevision.length > 1000 ||
    !Array.isArray(value.elidedEntryIds) || value.elidedEntryIds.length === 0 || value.elidedEntryIds.length > 20_000 ||
    !value.elidedEntryIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\\/\u0000-\u001f]/.test(id)) ||
    new Set(value.elidedEntryIds).size !== value.elidedEntryIds.length ||
    typeof value.summaryText !== 'string' || value.summaryText.trim().length === 0 || value.summaryText.length > 500_000 ||
    typeof value.summaryHash !== 'string' || !/^[a-f0-9]{64}$/i.test(value.summaryHash) ||
    typeof value.sourceRevision !== 'string' || value.sourceRevision !== value.base.sourceRevision ||
    !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0) return false
  return createHash('sha256').update(value.summaryText).digest('hex') === value.summaryHash
}

function safeCounter(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function initialRevision(identity: string): string {
  return `initial-${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`
}

function sanitizeMaterial(value: unknown, phaseId: string): ContextBudgetMaterialRecordV1 | null {
  if (!isRecord(value)) return null
  const { id, sourceRef, sourceVersion, contentHash, purpose } = value
  if (
    typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(id) ||
    typeof sourceRef !== 'string' || sourceRef.length === 0 || sourceRef.length > 2048 ||
    typeof sourceVersion !== 'string' || sourceVersion.length > 200 ||
    typeof contentHash !== 'string' || !/^[a-f0-9]{64}$/i.test(contentHash) ||
    typeof purpose !== 'string' || purpose.length === 0 || purpose.length > 1000 ||
    typeof value.tokenEstimate !== 'number' || !Number.isSafeInteger(value.tokenEstimate) || value.tokenEstimate < 0
  ) return null
  let range: ContextBudgetMaterialRecordV1['range']
  if (value.range !== undefined) {
    if (!isRecord(value.range) || !Number.isSafeInteger(value.range.start) || !Number.isSafeInteger(value.range.end) ||
      (value.range.start as number) < 0 || (value.range.end as number) < (value.range.start as number) ||
      (value.range.unit !== 'chars' && value.range.unit !== 'bytes')) return null
    range = { start: value.range.start as number, end: value.range.end as number, unit: value.range.unit }
  }
  return {
    id,
    phaseId,
    sourceRef,
    sourceVersion,
    contentHash,
    ...(range ? { range } : {}),
    requiredTogether: value.requiredTogether === true,
    pinnedByUser: value.pinnedByUser === true,
    tokenEstimate: value.tokenEstimate,
    status: value.status === 'missing' || value.status === 'stale' ? value.status : 'available',
    purpose
  }
}

function sanitizePhase(value: unknown, phaseId: string): ContextBudgetPhasePolicyV1 | null {
  if (!isRecord(value) || !PHASE_ID_RE.test(phaseId)) return null
  if (!isContextBudgetTierV1(value.selectedBudget) || !isContextBudgetTierV1(value.autoMaxBudget)) return null
  if (value.mode !== 'auto' && value.mode !== 'fixed') return null
  const materialsRaw = Array.isArray(value.materials) ? value.materials : []
  if (materialsRaw.length > 500) return null
  const materials = materialsRaw.map((material) => sanitizeMaterial(material, phaseId))
  if (materials.some((material) => material === null)) return null
  const source = value.selectionSource
  const selectionSource = source === 'agent' || source === 'host-reconcile' || source === 'user' ? source : 'default'
  return {
    phaseId,
    mode: value.mode,
    selectedBudget: value.selectedBudget,
    autoMaxBudget: value.autoMaxBudget,
    selectionSource,
    selectionReason: typeof value.selectionReason === 'string' ? value.selectionReason.slice(0, 2000) : 'loaded_policy',
    materialRevision: validRevision(value.materialRevision) ? value.materialRevision : randomUUID(),
    materials: materials as ContextBudgetMaterialRecordV1[],
    consecutiveLowBoundaries: safeCounter(value.consecutiveLowBoundaries),
    ...(typeof value.lastBoundaryRevision === 'string' && value.lastBoundaryRevision.length <= 200
      ? { lastBoundaryRevision: value.lastBoundaryRevision }
      : {}),
    ...(typeof value.lastAdjustBoundaryId === 'string' && value.lastAdjustBoundaryId.length > 0 && value.lastAdjustBoundaryId.length <= 200
      ? { lastAdjustBoundaryId: value.lastAdjustBoundaryId }
      : {}),
    ...(typeof value.lastRequiredInputTokens === 'number' && Number.isSafeInteger(value.lastRequiredInputTokens) && value.lastRequiredInputTokens >= 0
      ? { lastRequiredInputTokens: value.lastRequiredInputTokens }
      : {}),
    ...(value.lastCandidateBudget === null || isContextBudgetTierV1(value.lastCandidateBudget)
      ? { lastCandidateBudget: value.lastCandidateBudget as ContextBudgetPhasePolicyV1['lastCandidateBudget'] }
      : {}),
    ...(value.lastCandidateSoftLine === null ||
      (typeof value.lastCandidateSoftLine === 'number' && Number.isSafeInteger(value.lastCandidateSoftLine) && value.lastCandidateSoftLine >= 0)
      ? { lastCandidateSoftLine: value.lastCandidateSoftLine as number | null }
      : {})
  }
}

function defaultPhase(phaseId: string): ContextBudgetPhasePolicyV1 {
  return {
    phaseId,
    mode: 'auto',
    selectedBudget: CONTEXT_BUDGET_V1_TIERS[0],
    autoMaxBudget: CONTEXT_BUDGET_V1_TIERS[3],
    selectionSource: 'default',
    selectionReason: 'new_session_auto_default',
    materialRevision: initialRevision(`material:${phaseId}`),
    materials: [],
    consecutiveLowBoundaries: 0
  }
}

function sanitizeSession(value: unknown, sessionId: string): ContextBudgetSessionPolicyV1 | null {
  if (
    !isRecord(value) || value.version !== 1 || value.sessionId !== sessionId || !isRecord(value.phases) ||
    Object.keys(value.phases).length > 100 ||
    typeof value.activePhaseId !== 'string' || !PHASE_ID_RE.test(value.activePhaseId) ||
    !validRevision(value.revision) || !Number.isSafeInteger(value.updatedAt) || (value.updatedAt as number) < 0
  ) return null
  const phases: Record<string, ContextBudgetPhasePolicyV1> = {}
  for (const [phaseId, raw] of Object.entries(value.phases)) {
    const phase = sanitizePhase(raw, phaseId)
    if (!phase) return null
    phases[phaseId] = phase
  }
  if (Object.values(phases).reduce((sum, phase) => sum + phase.materials.length, 0) > MAX_SESSION_MATERIALS) return null
  const activePhaseId = value.activePhaseId
  if (!phases[activePhaseId]) return null
  return {
    version: 1,
    sessionId,
    activePhaseId,
    revision: value.revision,
    phases,
    updatedAt: value.updatedAt as number
  }
}

function newPolicy(sessionId: string): ContextBudgetSessionPolicyV1 {
  const phase = defaultPhase('main')
  return {
    version: 1,
    sessionId,
    activePhaseId: phase.phaseId,
    revision: initialRevision(`session:${sessionId}`),
    phases: { [phase.phaseId]: phase },
    updatedAt: 0
  }
}

/**
 * Session-scoped V1 policy storage. Invalid data is preserved in place and
 * reported as corrupt; the legacy context-state store's deletion recovery is
 * intentionally not used for this control record.
 */
export class ContextBudgetStoreV1 {
  private readonly tails = new Map<string, Promise<void>>()

  constructor(private readonly root = STORE_DIR) {}

  private async withSessionLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    if (!isSafeSessionId(sessionId)) throw new ContextBudgetStoreError('invalid_session', '会话身份无效')
    const previous = this.tails.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const currentLock = new Promise<void>((resolve) => { release = resolve })
    const lockTail = previous.then(() => currentLock)
    this.tails.set(sessionId, lockTail)
    await previous
    try {
      return await this.withFilesystemLock(sessionId, task)
    } finally {
      release()
      if (this.tails.get(sessionId) === lockTail) this.tails.delete(sessionId)
    }
  }

  private async withFilesystemLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const dir = join(this.root, sessionId)
    await mkdir(dir, { recursive: true })
    const lockPath = join(dir, '.context-budget-v1.lock')
    const owner = `${process.pid}:${randomUUID()}`
    const deadline = Date.now() + 30_000
    let handle: Awaited<ReturnType<typeof open>> | null = null
    while (!handle) {
      try {
        handle = await open(lockPath, 'wx')
        await handle.writeFile(owner, 'utf8')
      } catch (error) {
        const createdByThisAttempt = handle !== null
        await handle?.close().catch(() => undefined)
        handle = null
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
          if (createdByThisAttempt) {
            try { if ((await readFile(lockPath, 'utf8')) === owner) await unlink(lockPath) } catch { /* preserve any replacement lock */ }
          }
          throw new ContextBudgetStoreError('write_failed', `上下文事务锁创建失败：${error instanceof Error ? error.message : String(error)}`)
        }
        let stale = false
        try {
          const [contents, details] = await Promise.all([readFile(lockPath, 'utf8'), stat(lockPath)])
          const match = /^(\d+):[0-9a-f-]{36}$/.exec(contents)
          if (match) {
            try { process.kill(Number(match[1]), 0) } catch (probeError) {
              if ((probeError as NodeJS.ErrnoException)?.code === 'ESRCH') stale = true
            }
          } else if (Date.now() - details.mtimeMs > 10_000) {
            stale = true
          }
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException)?.code === 'ENOENT') continue
        }
        if (stale) {
          await unlink(lockPath).catch(() => undefined)
          continue
        }
        if (Date.now() >= deadline) throw new ContextBudgetStoreError('write_failed', '上下文事务锁等待超时')
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    try {
      return await task()
    } finally {
      await handle.close().catch(() => undefined)
      try {
        if ((await readFile(lockPath, 'utf8')) === owner) await unlink(lockPath)
      } catch { /* a replaced or already-cleared lock belongs to another transaction */ }
    }
  }

  private operationPath(sessionId: string, operationId: string): string {
    if (!isSafeSessionId(sessionId)) throw new ContextBudgetStoreError('invalid_session', '会话身份无效')
    if (!OPERATION_ID_RE.test(operationId) || operationId === '.' || operationId === '..') {
      throw new ContextBudgetStoreError('invalid_phase', '整理操作身份无效')
    }
    return join(this.root, sessionId, 'operations', `${operationId}.json`)
  }

  private projectionPath(sessionId: string, projectionId: string): string {
    if (!isSafeSessionId(sessionId)) throw new ContextBudgetStoreError('invalid_session', '会话身份无效')
    if (!OPERATION_ID_RE.test(projectionId) || projectionId === '.' || projectionId === '..') {
      throw new ContextBudgetStoreError('invalid_phase', '上下文投影身份无效')
    }
    return join(this.root, sessionId, 'projections', `${projectionId}.json`)
  }

  private async readBoundedJson(path: string): Promise<unknown | null> {
    try {
      const details = await stat(path)
      if (details.size > MAX_MAINTENANCE_FILE_BYTES) {
        throw new ContextBudgetStoreError('corrupt', '整理记录超过 8 MiB 上限，原文件已保留')
      }
      const raw = await readFile(path, 'utf8')
      return JSON.parse(raw) as unknown
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      if (error instanceof ContextBudgetStoreError) throw error
      throw new ContextBudgetStoreError('corrupt', `整理记录不可安全读取：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async writeJsonAtomically(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    try {
      const bytes = `${JSON.stringify(value, null, 2)}\n`
      if (Buffer.byteLength(bytes, 'utf8') > MAX_MAINTENANCE_FILE_BYTES) {
        throw new ContextBudgetStoreError('write_failed', '整理记录超过 8 MiB 上限')
      }
      await writeFile(temporary, bytes, { encoding: 'utf8', flag: 'wx' })
      await readFile(temporary, 'utf8')
      await rename(temporary, path)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      if (error instanceof ContextBudgetStoreError) throw error
      throw new ContextBudgetStoreError('write_failed', `整理记录原子写入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private path(sessionId: string): string {
    if (!isSafeSessionId(sessionId)) throw new ContextBudgetStoreError('invalid_session', '会话身份无效')
    return join(this.root, sessionId, 'policy.json')
  }

  async isConfigured(sessionId: string): Promise<boolean> {
    const path = this.path(sessionId)
    try {
      await stat(path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false
      throw error
    }
  }

  /** Persist the V1 default only when the host has identified a genuinely new session. */
  async ensureDefault(sessionId: string): Promise<ContextBudgetSessionPolicyV1> {
    if (await this.isConfigured(sessionId)) return this.read(sessionId)
    const initial = await this.read(sessionId)
    try {
      return await this.update(sessionId, initial.revision, (current) => current)
    } catch (error) {
      if (error instanceof ContextBudgetStoreError && error.code === 'stale_revision' && await this.isConfigured(sessionId)) {
        return this.read(sessionId)
      }
      throw error
    }
  }

  async read(sessionId: string): Promise<ContextBudgetSessionPolicyV1> {
    const path = this.path(sessionId)
    let raw: string
    try {
      const details = await stat(path)
      if (details.size > MAX_POLICY_BYTES) {
        throw new ContextBudgetStoreError('corrupt', '上下文预算策略超过 16 MiB 上限，原文件已保留')
      }
      raw = await readFile(path, 'utf8')
    } catch (error) {
      if (error instanceof ContextBudgetStoreError) throw error
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return newPolicy(sessionId)
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new ContextBudgetStoreError('corrupt', '上下文预算策略文件不是合法 JSON，原文件已保留')
    }
    const policy = sanitizeSession(parsed, sessionId)
    if (!policy) throw new ContextBudgetStoreError('corrupt', '上下文预算策略文件结构无效，原文件已保留')
    return policy
  }

  async update(
    sessionId: string,
    expectedRevision: string,
    mutate: (current: ContextBudgetSessionPolicyV1) => ContextBudgetSessionPolicyV1
  ): Promise<ContextBudgetSessionPolicyV1> {
    return await this.withSessionLock(sessionId, async () => {
      const current = await this.read(sessionId)
      if (current.revision !== expectedRevision) {
        throw new ContextBudgetStoreError('stale_revision', '上下文策略已更新，请重新读取状态后再调整')
      }
      const proposed = mutate(structuredClone(current))
      const sanitized = sanitizeSession({ ...proposed, version: 1, sessionId }, sessionId)
      if (!sanitized) throw new ContextBudgetStoreError('write_failed', '拒绝写入结构无效的上下文策略')
      const next = { ...sanitized, revision: randomUUID(), updatedAt: Date.now() }
      const path = this.path(sessionId)
      await mkdir(dirname(path), { recursive: true })
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
      const bytes = `${JSON.stringify(next, null, 2)}\n`
      try {
        await writeFile(temporary, bytes, { encoding: 'utf8', flag: 'wx' })
        const roundTrip = sanitizeSession(JSON.parse(await readFile(temporary, 'utf8')), sessionId)
        if (!roundTrip) throw new ContextBudgetStoreError('write_failed', '上下文策略临时文件回读校验失败')
        await rename(temporary, path)
      } catch (error) {
        await unlink(temporary).catch(() => undefined)
        if (error instanceof ContextBudgetStoreError) throw error
        throw new ContextBudgetStoreError('write_failed', `上下文策略原子写入失败：${error instanceof Error ? error.message : String(error)}`)
      }
      return next
    })
  }

  async readOperation(sessionId: string, operationId: string): Promise<ContextMaintenanceOperationV1 | null> {
    const raw = await this.readBoundedJson(this.operationPath(sessionId, operationId))
    if (raw === null) return null
    if (!isContextMaintenanceOperationV1(raw) || raw.identity.sessionId !== sessionId || raw.identity.operationId !== operationId) {
      throw new ContextBudgetStoreError('corrupt', '整理操作记录结构或会话归属无效；原记录已保留')
    }
    return raw
  }

  async latestOperation(sessionId: string): Promise<ContextMaintenanceOperationV1 | null> {
    if (!isSafeSessionId(sessionId)) throw new ContextBudgetStoreError('invalid_session', '会话身份无效')
    const dir = join(this.root, sessionId, 'operations')
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      throw new ContextBudgetStoreError('corrupt', '整理操作目录不可安全读取；现有文件已保留')
    }
    if (names.length > 2_000) throw new ContextBudgetStoreError('corrupt', '整理操作数量超过安全读取上限；现有文件已保留')
    const operations: ContextMaintenanceOperationV1[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const operationId = name.slice(0, -5)
      if (!OPERATION_ID_RE.test(operationId)) continue
      const operation = await this.readOperation(sessionId, operationId)
      if (operation) operations.push(operation)
    }
    operations.sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
    return operations[0] ?? null
  }

  async createOperation(operation: ContextMaintenanceOperationV1): Promise<ContextMaintenanceOperationV1> {
    if (!isContextMaintenanceOperationV1(operation)) throw new ContextBudgetStoreError('write_failed', '整理操作记录格式无效')
    const { sessionId, operationId } = operation.identity
    const path = this.operationPath(sessionId, operationId)
    return await this.withSessionLock(sessionId, async () => {
      const current = await this.readOperation(sessionId, operationId)
      if (current) {
        if (current.identity.runnerId === operation.identity.runnerId && current.identity.runnerEpoch === operation.identity.runnerEpoch) return current
        throw new ContextBudgetStoreError('stale_revision', '整理操作身份已被占用')
      }
      await this.writeJsonAtomically(path, operation)
      return operation
    })
  }

  async transitionOperation(
    sessionId: string,
    operationId: string,
    expectedRevision: string,
    state: ContextMaintenanceStateV1,
    changes: Partial<Pick<ContextMaintenanceOperationV1,
      'identity' | 'base' | 'candidateRef' | 'beforeSnapshot' | 'afterSnapshot' | 'resumeId' | 'resumeReceipt' |
      'projectionReceipt' |
      'lastSummarizedSourceRevision' | 'retryNonce' | 'failureCode' | 'protectedRefs' | 'requestKind' | 'reason'>> = {}
  ): Promise<ContextMaintenanceOperationV1> {
    const path = this.operationPath(sessionId, operationId)
    return await this.withSessionLock(sessionId, async () => {
      const current = await this.readOperation(sessionId, operationId)
      if (!current) throw new ContextBudgetStoreError('corrupt', '整理操作记录不存在')
      if (current.revision !== expectedRevision) throw new ContextBudgetStoreError('stale_revision', '整理操作状态已变化，请刷新后再试')
      /* 同状态 = 只更新字段（例如续跑回执），不算状态迁移 */
      if (current.state !== state && !canTransitionContextMaintenanceV1(current.state, state)) {
        throw new ContextBudgetStoreError('invalid_phase', `不允许整理状态从 ${current.state} 转为 ${state}`)
      }
      const next: ContextMaintenanceOperationV1 = {
        ...current,
        ...changes,
        revision: randomUUID(),
        state,
        updatedAt: Date.now()
      }
      if (!isContextMaintenanceOperationV1(next)) throw new ContextBudgetStoreError('write_failed', '整理操作更新结构无效')
      await this.writeJsonAtomically(path, next)
      return next
    })
  }

  async readProjectionCandidate(sessionId: string, projectionId: string): Promise<ContextMaintenanceProjectionV1 | null> {
    const raw = await this.readBoundedJson(this.projectionPath(sessionId, projectionId))
    if (raw === null) return null
    if (!validProjection(raw, sessionId, projectionId)) {
      throw new ContextBudgetStoreError('corrupt', '上下文投影候选无效；原文件已保留')
    }
    return raw as ContextMaintenanceProjectionV1
  }

  async commitProjection(
    sessionId: string,
    operationId: string,
    expectedOperationRevision: string,
    projection: ContextMaintenanceProjectionV1
  ): Promise<ContextMaintenanceActivePointerV1> {
    const operationPath = this.operationPath(sessionId, operationId)
    const projectionPath = this.projectionPath(sessionId, projection.projectionId)
    return await this.withSessionLock(sessionId, async () => {
      const operation = await this.readOperation(sessionId, operationId)
      if (!operation || operation.revision !== expectedOperationRevision || operation.state !== 'validating') {
        throw new ContextBudgetStoreError('stale_revision', '整理操作已变化，未提交上下文投影')
      }
      if (
        !validProjection(projection, sessionId, projection.projectionId) || projection.operationId !== operationId ||
        projection.runnerId !== operation.identity.runnerId || projection.runnerEpoch !== operation.identity.runnerEpoch ||
        operation.candidateRef !== `projections/${projection.projectionId}.json` ||
        projection.base.sourceRevision !== operation.base.sourceRevision ||
        projection.base.policyRevision !== operation.base.policyRevision ||
        projection.base.capabilityRevision !== operation.base.capabilityRevision ||
        projection.base.rawWatermark.entryCount !== operation.base.rawWatermark.entryCount ||
        projection.base.rawWatermark.lastEntryId !== operation.base.rawWatermark.lastEntryId ||
        !validWatermark(operation.base.rawWatermark)
      ) throw new ContextBudgetStoreError('write_failed', '上下文投影候选未通过完整性与版本校验')

      const persistedCandidate = await this.readProjectionCandidate(sessionId, projection.projectionId)
      if (!persistedCandidate || JSON.stringify(persistedCandidate) !== JSON.stringify(projection)) {
        throw new ContextBudgetStoreError('stale_revision', '已保存的候选与待提交内容不一致；未切换活动投影')
      }

      await this.writeJsonAtomically(projectionPath, projection)
      const pointer: ContextMaintenanceActivePointerV1 = {
        version: 1,
        sessionId,
        operationId,
        projectionId: projection.projectionId,
        revision: randomUUID(),
        rawWatermark: structuredClone(projection.base.rawWatermark),
        committedAt: Date.now()
      }
      await this.writeJsonAtomically(join(this.root, sessionId, 'active.json'), pointer)
      const committed: ContextMaintenanceOperationV1 = {
        ...operation,
        revision: randomUUID(),
        candidateRef: `projections/${projection.projectionId}.json`,
        state: 'committed',
        updatedAt: Date.now()
      }
      if (!isContextMaintenanceOperationV1(committed)) throw new ContextBudgetStoreError('write_failed', '提交后的整理记录无效')
      await this.writeJsonAtomically(operationPath, committed)
      return pointer
    })
  }

  /** Recover a saved candidate after a process restart without generating another summary. */
  async recoverAndCommitCandidate(
    sessionId: string,
    operationId: string,
    expectedRevision: string,
    currentBase: ContextMaintenanceBaseV1,
    runnerId: string,
    runnerEpoch: string,
    currentEntryIds: readonly string[]
  ): Promise<ContextMaintenanceActivePointerV1> {
    return await this.withSessionLock(sessionId, async () => {
      const operation = await this.readOperation(sessionId, operationId)
      if (!operation || operation.revision !== expectedRevision ||
        !['needs_action', 'failed', 'validating'].includes(operation.state)) {
        throw new ContextBudgetStoreError('stale_revision', '候选恢复状态已变化')
      }
      if (operation.resumeReceipt !== null || operation.identity.runnerId !== runnerId ||
        operation.base.sourceRevision !== currentBase.sourceRevision ||
        operation.base.policyRevision !== currentBase.policyRevision ||
        operation.base.capabilityRevision !== currentBase.capabilityRevision) {
        throw new ContextBudgetStoreError('stale_revision', '候选来源、策略、端点或续接状态已变化')
      }
      const availableIds = new Set(currentEntryIds)
      let candidate: ContextMaintenanceProjectionV1 | null = null
      if (operation.candidateRef) {
        const match = /^projections\/([A-Za-z0-9._-]{1,120})\.json$/.exec(operation.candidateRef)
        if (match) candidate = await this.readProjectionCandidate(sessionId, match[1])
      } else {
        const dir = join(this.root, sessionId, 'projections')
        let names: string[] = []
        try { names = await readdir(dir) } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
        }
        if (names.length > 2_000) throw new ContextBudgetStoreError('corrupt', '候选数量超过安全恢复上限')
        const matches: ContextMaintenanceProjectionV1[] = []
        for (const name of names) {
          if (!name.endsWith('.json')) continue
          const id = name.slice(0, -5)
          if (!OPERATION_ID_RE.test(id)) continue
          const projection = await this.readProjectionCandidate(sessionId, id)
          if (projection?.operationId === operationId) matches.push(projection)
        }
        if (matches.length === 1) candidate = matches[0]
        if (matches.length > 1) throw new ContextBudgetStoreError('corrupt', '同一整理操作存在多个候选，不能自动选择')
      }
      if (!candidate || candidate.operationId !== operationId || candidate.runnerId !== runnerId ||
        candidate.base.sourceRevision !== currentBase.sourceRevision ||
        candidate.base.policyRevision !== currentBase.policyRevision ||
        candidate.base.capabilityRevision !== currentBase.capabilityRevision ||
        !candidate.elidedEntryIds.every((id) => availableIds.has(id))) {
        throw new ContextBudgetStoreError('stale_revision', '已保存候选无法与当前会话原文安全对应')
      }

      const projection: ContextMaintenanceProjectionV1 = {
        ...candidate,
        runnerEpoch,
        base: structuredClone(currentBase)
      }
      const projectionPath = this.projectionPath(sessionId, projection.projectionId)
      await this.writeJsonAtomically(projectionPath, projection)
      const validating: ContextMaintenanceOperationV1 = {
        ...operation,
        revision: randomUUID(),
        identity: { ...operation.identity, runnerEpoch },
        base: structuredClone(currentBase),
        candidateRef: `projections/${projection.projectionId}.json`,
        state: 'validating',
        failureCode: null,
        updatedAt: Date.now()
      }
      await this.writeJsonAtomically(this.operationPath(sessionId, operationId), validating)
      const pointer: ContextMaintenanceActivePointerV1 = {
        version: 1,
        sessionId,
        operationId,
        projectionId: projection.projectionId,
        revision: randomUUID(),
        rawWatermark: structuredClone(currentBase.rawWatermark),
        committedAt: Date.now()
      }
      await this.writeJsonAtomically(join(this.root, sessionId, 'active.json'), pointer)
      const committed: ContextMaintenanceOperationV1 = {
        ...validating,
        revision: randomUUID(),
        state: 'committed',
        updatedAt: Date.now()
      }
      if (!isContextMaintenanceOperationV1(committed)) throw new ContextBudgetStoreError('write_failed', '恢复后的整理记录无效')
      await this.writeJsonAtomically(this.operationPath(sessionId, operationId), committed)
      return pointer
    })
  }

  async readActiveProjection(sessionId: string): Promise<{
    pointer: ContextMaintenanceActivePointerV1
    projection: ContextMaintenanceProjectionV1
  } | null> {
    if (!isSafeSessionId(sessionId)) throw new ContextBudgetStoreError('invalid_session', '会话身份无效')
    const rawPointer = await this.readBoundedJson(join(this.root, sessionId, 'active.json'))
    if (rawPointer === null) return null
    if (
      !rawPointer || typeof rawPointer !== 'object' || Array.isArray(rawPointer) ||
      (rawPointer as Record<string, unknown>).version !== 1 ||
      (rawPointer as Record<string, unknown>).sessionId !== sessionId ||
      typeof (rawPointer as Record<string, unknown>).operationId !== 'string' || !OPERATION_ID_RE.test(String((rawPointer as Record<string, unknown>).operationId)) ||
      typeof (rawPointer as Record<string, unknown>).projectionId !== 'string' || !OPERATION_ID_RE.test(String((rawPointer as Record<string, unknown>).projectionId)) ||
      typeof (rawPointer as Record<string, unknown>).revision !== 'string' || !validWatermark((rawPointer as Record<string, unknown>).rawWatermark)
    ) throw new ContextBudgetStoreError('corrupt', '活动上下文投影指针无效；原文件已保留')
    const pointer = rawPointer as ContextMaintenanceActivePointerV1
    const projection = await this.readProjectionCandidate(sessionId, pointer.projectionId)
    if (!projection || projection.operationId !== pointer.operationId ||
      projection.base.rawWatermark.entryCount !== pointer.rawWatermark.entryCount ||
      projection.base.rawWatermark.lastEntryId !== pointer.rawWatermark.lastEntryId) {
      throw new ContextBudgetStoreError('corrupt', '活动上下文投影文件无效；原文件已保留')
    }
    const operation = await this.readOperation(sessionId, pointer.operationId)
    if (!operation || operation.candidateRef !== `projections/${pointer.projectionId}.json` ||
      (operation.state !== 'validating' && operation.state !== 'committed' && operation.state !== 'applied')) {
      throw new ContextBudgetStoreError('corrupt', '活动上下文投影没有匹配的整理操作；原文件已保留')
    }
    return { pointer, projection }
  }

  async markProjectionApplied(sessionId: string, operationId: string, receipt: string): Promise<ContextMaintenanceOperationV1> {
    if (!receipt || receipt.length > 200) throw new ContextBudgetStoreError('write_failed', '应用回执格式无效')
    const path = this.operationPath(sessionId, operationId)
    return await this.withSessionLock(sessionId, async () => {
      const active = await this.readActiveProjection(sessionId)
      if (!active || active.pointer.operationId !== operationId) {
        throw new ContextBudgetStoreError('stale_revision', '活动投影已变化，不能确认旧操作应用')
      }
      const operation = await this.readOperation(sessionId, operationId)
      if (!operation) throw new ContextBudgetStoreError('corrupt', '整理操作记录不存在')
      if ((operation.state === 'applied' || operation.state === 'committed') && operation.projectionReceipt === receipt) return operation
      if (operation.state === 'applied') throw new ContextBudgetStoreError('stale_revision', '整理投影已由其他回执确认应用')
      if (operation.state !== 'committed') throw new ContextBudgetStoreError('invalid_phase', '整理投影尚未提交，不能确认应用')
      const applied: ContextMaintenanceOperationV1 = {
        ...operation,
        revision: randomUUID(),
        state: 'applied',
        projectionReceipt: receipt,
        updatedAt: Date.now()
      }
      await this.writeJsonAtomically(path, applied)
      return applied
    })
  }
}

export const contextBudgetStoreV1 = new ContextBudgetStoreV1()
