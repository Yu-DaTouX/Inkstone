import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ANTIGRAVITY_QUOTA_REFRESH_MS, ANTIGRAVITY_QUOTA_STALE_MS, antigravityQuotaFailure, type AntigravityQuotaGroup, type AntigravityQuotaSnapshot } from '../shared/antigravity'
import { pick } from '../shared/ui-lang'
import { antigravityExecutable } from './antigravity'
import { YAN_DIR } from './paths'
import { killProcessTree } from './process-tree'

const ERROR_CACHE_MS = 10_000
const FORCE_ERROR_CACHE_MS = 2_000
const FORCE_SUCCESS_CACHE_MS = 5_000
const MAX_OUTPUT_BYTES = 256_000

function execute(executable: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: opts.cwd, env: opts.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let killed = false
    let settled = false
    const finish = (error: Error | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve({ stdout, stderr })
    }
    const abort = (reason: Error) => {
      killed = true
      if (child.pid && child.exitCode === null && child.signalCode === null) void killProcessTree(child.pid)
      finish(reason)
    }
    const timer = setTimeout(() => {
      const err = Object.assign(new Error('timeout'), { stdout, stderr, killed: true })
      abort(err)
    }, opts.timeout)
    timer.unref()
    const append = (kind: 'stdout' | 'stderr', chunk: string) => {
      if (settled) return
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > MAX_OUTPUT_BYTES) {
        abort(Object.assign(new Error('maxBuffer exceeded'), { stdout, stderr, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }))
        return
      }
      if (kind === 'stdout') stdout += chunk
      else stderr += chunk
    }
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => append('stdout', chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => append('stderr', chunk))
    child.once('error', (err) => finish(Object.assign(err, { stdout, stderr, killed })))
    child.once('close', (code) => {
      if (code === 0) finish(null)
      else finish(Object.assign(new Error(`exit ${code ?? 'signal'}`), { stdout, stderr, code: code ?? 1, killed }))
    })
  })
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const items = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const label = (value: unknown): string => typeof value === 'string' ? value.trim().slice(0, 160) : ''

function usageGroups(stdout: string): unknown[] | undefined {
  const envelope = record(JSON.parse(stdout.replace(/^\uFEFF/, '')))
  const command = record(envelope.command)
  const groups = record(command.data).groups
  if (envelope.status !== 'SUCCESS' || envelope.conversation_id !== '' || envelope.num_turns !== 0 || command.name !== 'usage' || !Array.isArray(groups)) return undefined
  return groups
}

export function parseAntigravityQuota(stdout: string): AntigravityQuotaGroup[] {
  return parseGroups(usageGroups(stdout) ?? [])
}

function parseGroups(groups: unknown[]): AntigravityQuotaGroup[] {
  return groups.slice(0, 40).flatMap((rawGroup) => {
    const group = record(rawGroup)
    const name = label(group.name)
    if (!name) return []
    const models = typeof group.description === 'string'
      ? (group.description.match(/^Models within this group:\s*([^\r\n]+)/i)?.[1] ?? '').split(',').map(label).filter(Boolean)
      : []
    const windows = items(group.buckets).slice(0, 20).flatMap((rawBucket) => {
      const bucket = record(rawBucket)
      const id = label(bucket.id)
      const name = label(bucket.name)
      const remainingFraction = bucket.remaining_fraction
      if (!id || !name || bucket.disabled === true || bucket.status === 'disabled' || typeof remainingFraction !== 'number' || !Number.isFinite(remainingFraction) || remainingFraction < 0 || remainingFraction > 1) return []
      const resetAt = typeof bucket.reset_time === 'string' ? Date.parse(bucket.reset_time) : NaN
      return [{ id, name, period: label(bucket.window), remainingFraction, ...(Number.isFinite(resetAt) && resetAt >= Date.UTC(2020, 0, 1) ? { resetAt } : {}) }]
    })
    return windows.length ? [{ name, models, windows }] : []
  })
}

async function readQuota(): Promise<AntigravityQuotaGroup[]> {
  const cwd = join(YAN_DIR, 'antigravity-quota')
  await mkdir(cwd, { recursive: true })
  const { executable, env } = antigravityExecutable(cwd)
  const opts = { cwd, env, timeout: 18_000 }
  const { stdout: version } = await execute(executable, ['--version'], { ...opts, timeout: 5000 })
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim())
  const [, major, minor, patch] = match?.map(Number) ?? []
  if (!match || major < 1 || major === 1 && (minor < 1 || minor === 1 && patch < 11)) {
    throw new Error(pick('当前 CLI 版本不支持只读额度查询。请更新 Antigravity CLI。', 'Update Antigravity CLI to use its read-only quota command.'))
  }
  const { stdout, stderr } = await execute(executable, [
    '--sandbox', '--settings', JSON.stringify({ disableSlashCommands: false }), '--disable-slash-commands=false',
    '--print', '/usage', '--output-format', 'json', '--print-timeout', '12s'
  ], opts)
  return readAntigravityQuotaOutput(stdout, stderr)
}

export function readAntigravityQuotaOutput(stdout: string, stderr: string): AntigravityQuotaGroup[] {
  let groups: unknown[] | undefined
  try { groups = usageGroups(stdout) } catch { }
  if (!groups) throw Object.assign(new Error('Invalid usage response'), { stdout, stderr, code: 'INVALID_USAGE' })
  return parseGroups(groups)
}

export function createAntigravityQuota(read = readQuota, now = Date.now): (force?: boolean) => Promise<AntigravityQuotaSnapshot> {
  let latest: AntigravityQuotaSnapshot | undefined
  let pending: Promise<AntigravityQuotaSnapshot> | undefined

  return (force = false) => {
    if (pending) return pending
    const ttl = latest?.error
      ? (force ? FORCE_ERROR_CACHE_MS : ERROR_CACHE_MS)
      : (force ? FORCE_SUCCESS_CACHE_MS : ANTIGRAVITY_QUOTA_REFRESH_MS)
    const at = now()
    if (latest?.staleSince !== undefined && at - latest.staleSince >= ANTIGRAVITY_QUOTA_STALE_MS) {
      latest = { checkedAt: latest.checkedAt, groups: [], error: latest.error }
    }
    if (latest && at - latest.checkedAt < ttl) return Promise.resolve(latest)
    pending = Promise.resolve().then(read).then((groups): AntigravityQuotaSnapshot => ({ checkedAt: now(), groups,
      ...(groups.length ? {} : { error: pick('CLI 没有返回订阅额度。', 'The CLI returned no subscription allowance.') }) }), (error: unknown) => {
      const failure = error as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean } | null
      const diagnostic = `${failure?.stdout ?? ''}\n${failure?.stderr ?? ''}`
      const checkedAt = now()
      if (/authentication required|unauthenticated|unauthorized|not authenticated|not logged in|sign[ -]?in|run agy.*login|invalid.grant|(?:HTTP(?: status)?\s*[:=]?\s*|"(?:code|status)"\s*:\s*)401\b/i.test(diagnostic)) {
        return { checkedAt, groups: [], error: pick('请先登录 Antigravity CLI。', 'Sign in to Antigravity CLI first.') }
      }
      if (/no (?:account quota|subscription allowance|subscription)|subscription (?:is )?required/i.test(diagnostic) ||
        (failure?.code === 2 && /api.?key/i.test(diagnostic))) {
        return { checkedAt, groups: [], error: pick('CLI 当前登录方式没有订阅额度。', 'The current CLI authentication method has no subscription allowance.') }
      }
      const message = failure?.killed
        ? pick('Antigravity 额度查询超时。', 'The Antigravity quota query timed out.')
        : failure?.code !== undefined || !(error instanceof Error)
          ? pick('无法读取 Antigravity 订阅额度。', 'Could not read the Antigravity subscription allowance.')
          : error.message
      return antigravityQuotaFailure(latest, checkedAt, message)
    }).then((snapshot) => { latest = snapshot; return snapshot }).finally(() => { pending = undefined })
    return pending
  }
}

export const antigravityQuota = createAntigravityQuota()
