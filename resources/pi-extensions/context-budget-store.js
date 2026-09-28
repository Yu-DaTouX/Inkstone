/**
 * 上下文整理的落盘与身份（被 context-budget-maintenance.js 使用，不是独立扩展）。
 *
 * 职责只有三件：
 *   · 目录与文件位置（YAN_DATA_DIR/context-budget-v1/<session>/…）；
 *   · 跨进程磁盘锁与原子写；
 *   · 整理操作记录的状态迁移，以及判断「源材料 / 策略 / 端点」是否仍是同一版本的指纹。
 *
 * 这里不做摘要、投影或续跑决策。
 */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { contextEndpointKeyV1 } from './generated/context-budget-v1.mjs'
import { entryProducesMessage } from './context-transform.js'

export const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,200}$/
export const ID_RE = /^[A-Za-z0-9._-]{1,120}$/

/** 进行中的状态：runner 重启后仍停在这些状态，说明事务被打断了 */
export const IN_FLIGHT_STATES = ['requested', 'preparing', 'summarizing', 'validating']
/** 已生效的状态：投影已提交，后续只剩应用与续跑 */
export const LIVE_STATES = ['committed', 'applied']

export function dataDir() {
  const value = process.env.YAN_DATA_DIR?.trim()
  return value || join(homedir(), '.pi', 'agent', 'yan')
}

export function runnerIdentity() {
  return {
    runnerId: process.env.YAN_RUNNER_ID || 'primary',
    runnerEpoch: String(process.env.YAN_RUNNER_EPOCH || 1)
  }
}

export function sessionIdOf(ctx) {
  try {
    const value = ctx?.sessionManager?.getSessionId?.()
    return typeof value === 'string' && SESSION_ID_RE.test(value) && value !== '.' && value !== '..' ? value : null
  } catch {
    return null
  }
}

export function safeJson(path, maxBytes = 8 * 1024 * 1024) {
  try {
    if (statSync(path).size > maxBytes) return null
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** 文件存在吗（ENOENT 返回 false，其它错误照常抛出） */
export function statSafe(path) {
  try {
    return !!statSync(path)
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}

export function sha256(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex')
}

export function contextBudgetFiles(sessionId) {
  const root = join(dataDir(), 'context-budget-v1', sessionId)
  const stateRoot = join(dataDir(), 'context-state')
  return {
    root,
    active: join(root, 'active.json'),
    operations: join(root, 'operations'),
    projections: join(root, 'projections'),
    archive: join(stateRoot, `${sessionId}.archive.json`)
  }
}

export function operationPath(sessionId, operationId) {
  if (!SESSION_ID_RE.test(sessionId) || !ID_RE.test(operationId) || operationId === '.' || operationId === '..') return null
  return join(dataDir(), 'context-budget-v1', sessionId, 'operations', `${operationId}.json`)
}

export function withDiskLock(sessionId, action) {
  const dir = join(dataDir(), 'context-budget-v1', sessionId)
  mkdirSync(dir, { recursive: true })
  const lockPath = join(dir, '.context-budget-v1.lock')
  const owner = `${process.pid}:${randomUUID()}`
  const deadline = Date.now() + 30_000
  let fd = null
  while (fd === null) {
    try {
      fd = openSync(lockPath, 'wx')
      writeFileSync(fd, owner, 'utf8')
    } catch (error) {
      if (fd !== null) {
        closeSync(fd)
        fd = null
        try { unlinkSync(lockPath) } catch { /* preserve another owner's lock */ }
      }
      if (error?.code !== 'EEXIST') throw error
      let stale = false
      try {
        const contents = readFileSync(lockPath, 'utf8')
        const details = statSync(lockPath)
        const match = /^(\d+):[0-9a-f-]{36}$/.exec(contents)
        if (match) {
          try { process.kill(Number(match[1]), 0) } catch (probeError) {
            if (probeError?.code === 'ESRCH') stale = true
          }
        } else if (Date.now() - details.mtimeMs > 10_000) stale = true
      } catch (readError) {
        if (readError?.code === 'ENOENT') continue
      }
      if (stale) {
        try { unlinkSync(lockPath) } catch { /* another process may already have recovered it */ }
        continue
      }
      if (Date.now() >= deadline) throw new Error('context_maintenance_lock_timeout')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
  try {
    return action()
  } finally {
    closeSync(fd)
    try {
      if (readFileSync(lockPath, 'utf8') === owner) unlinkSync(lockPath)
    } catch { /* lock disappeared or belongs to a newer transaction */ }
  }
}

export function writeJsonAtomic(path, value) {
  const dir = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))
  mkdirSync(dir, { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    JSON.parse(readFileSync(temporary, 'utf8'))
    renameSync(temporary, path)
  } catch (error) {
    try { unlinkSync(temporary) } catch { /* keep the previous record */ }
    throw error
  }
}

/* ---------------------------------------------------------------- 版本指纹 */

/**
 * 源材料版本：只看会进入模型上下文的消息。
 * 会话改名、诊断条目这类 custom entry 在摘要进行中也会写入，不算上下文变化。
 */
export function sourceRevision(entries) {
  const messages = Array.isArray(entries) ? entries.filter(entryProducesMessage) : []
  const lastMessage = messages.at(-1)
  return {
    rawWatermark: { entryCount: messages.length, lastEntryId: typeof lastMessage?.id === 'string' ? lastMessage.id : null },
    sourceRevision: `messages:${messages.length}:${typeof lastMessage?.id === 'string' ? lastMessage.id : 'empty'}`
  }
}

export function capabilityRevision(model) {
  if (!model) return ''
  const endpointKey = contextEndpointKeyV1({
    provider: model.provider,
    api: model.api,
    modelId: model.id,
    baseUrl: model.baseUrl
  })
  return [endpointKey, model.contextWindow, model.maxTokens].map((part) => String(part ?? '')).join('/')
}

export function operationBase(ctx, policy, entries) {
  const watermark = sourceRevision(entries)
  const endpointRevision = capabilityRevision(ctx?.model)
  if (!policy?.policyRevision || !endpointRevision) throw new Error('context_maintenance_capability_unavailable')
  return {
    rawWatermark: watermark.rawWatermark,
    sourceRevision: watermark.sourceRevision,
    policyRevision: policy.policyRevision,
    capabilityRevision: endpointRevision
  }
}

export function sameWatermark(left, right) {
  return left?.entryCount === right?.entryCount && left?.lastEntryId === right?.lastEntryId
}

export function sameBase(left, right) {
  return left?.sourceRevision === right?.sourceRevision &&
    left?.policyRevision === right?.policyRevision &&
    left?.capabilityRevision === right?.capabilityRevision &&
    sameWatermark(left?.rawWatermark, right?.rawWatermark)
}

/* ---------------------------------------------------------------- 操作记录 */

/**
 * 失败时能否直接重试。
 *
 * 「版本变了」「模型回复不合格」「超时」这类是瞬态的，同一个请求再来一次就可能成功；
 * 「源条目丢失」「归档冲突」「端点能力不可用」需要先处理原因（换模型、修复记录），
 * 盲目重试只会得到同样的结果。未列出的错误码按可重试处理，界面仍会显示原码。
 */
const NOT_RETRYABLE = new Set([
  'active_projection_source_missing',
  'context_recall_ref_conflict',
  'context_recall_archive_invalid',
  'context_recall_source_missing',
  'context_maintenance_capability_unavailable',
  'no_safe_summary_candidates',
  'resume_send_uncertain'
])

export function isRetryableFailure(code) {
  return !NOT_RETRYABLE.has(String(code ?? ''))
}

export function operationFailure(operation, code) {
  return withDiskLock(operation.identity.sessionId, () => operationFailureUnlocked(operation, code))
}

/**
 * 标记为「需要处理」，并记下**卡在哪一步**（failedStage）与能否直接重试。
 * 只在记录版本没变时写入：别的事务已推进这条记录，就不覆盖它。
 */
export function operationFailureUnlocked(operation, code) {
  const path = operationPath(operation.identity.sessionId, operation.identity.operationId)
  const current = path && safeJson(path)
  if (!current || current.revision !== operation.revision) return current ?? operation
  const failureCode = String(code ?? 'context_maintenance_failed').slice(0, 160)
  const next = {
    ...operation,
    revision: randomUUID(),
    state: 'needs_action',
    failureCode,
    failedStage: IN_FLIGHT_STATES.includes(current.state) || LIVE_STATES.includes(current.state) ? current.state : null,
    retryable: isRetryableFailure(failureCode),
    updatedAt: Date.now()
  }
  if (path) writeJsonAtomic(path, next)
  return next
}

export function setOperationState(operation, state, patch = {}) {
  return withDiskLock(operation.identity.sessionId, () => setOperationStateUnlocked(operation, state, patch))
}

export function setOperationStateUnlocked(operation, state, patch = {}) {
  const path = operationPath(operation.identity.sessionId, operation.identity.operationId)
  const current = path && safeJson(path)
  if (!current || current.revision !== operation.revision) throw new Error('context_operation_revision_changed')
  const next = { ...operation, ...patch, revision: randomUUID(), state, updatedAt: Date.now() }
  if (!path) throw new Error('context_operation_identity_invalid')
  writeJsonAtomic(path, next)
  return next
}
