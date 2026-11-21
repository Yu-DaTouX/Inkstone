import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ANTIGRAVITY_QUOTA_REFRESH_MS, type AntigravityQuotaGroup, type AntigravityQuotaSnapshot } from '../shared/antigravity'
import { pick } from '../shared/ui-lang'
import { antigravityExecutable } from './antigravity'
import { YAN_DIR } from './paths'
import { killProcessTree } from './process-tree'

const ERROR_CACHE_MS = 10_000
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

export function parseAntigravityQuota(stdout: string): AntigravityQuotaGroup[] {
  const envelope = record(JSON.parse(stdout.replace(/^\uFEFF/, '')))
  const command = record(envelope.command)
  if (envelope.status !== 'SUCCESS' || envelope.conversation_id !== '' || envelope.num_turns !== 0 || command.name !== 'usage') return []
  return items(record(command.data).groups).slice(0, 40).flatMap((rawGroup) => {
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
      return [{ id, name, period: label(bucket.window), remainingFraction, ...(Number.isFinite(resetAt) ? { resetAt } : {}) }]
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
  const { stdout } = await execute(executable, [
    '--sandbox', '--settings', JSON.stringify({ disableSlashCommands: false }), '--disable-slash-commands=false',
    '--print', '/usage', '--output-format', 'json', '--print-timeout', '12s'
  ], opts)
  return parseAntigravityQuota(stdout)
}

let latest: AntigravityQuotaSnapshot | undefined
let pending: Promise<AntigravityQuotaSnapshot> | undefined

export function antigravityQuota(force = false): Promise<AntigravityQuotaSnapshot> {
  if (pending) return pending
  const ttl = latest?.error ? (force ? 0 : ERROR_CACHE_MS) : (force ? 5000 : ANTIGRAVITY_QUOTA_REFRESH_MS)
  if (latest && ttl > 0 && Date.now() - latest.checkedAt < ttl) return Promise.resolve(latest)
  pending = readQuota().then(
    (groups): AntigravityQuotaSnapshot => ({ checkedAt: Date.now(), groups,
      ...(groups.length ? {} : { error: pick('CLI 没有返回订阅额度。', 'The CLI returned no subscription allowance.') }) }),
    (error: unknown): AntigravityQuotaSnapshot => {
      const failure = error as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean }
      const diagnostic = `${failure?.stdout ?? ''}\n${failure?.stderr ?? ''}`
      const message = /authentication required|not authenticated|not logged in|sign in|run agy.*login/i.test(diagnostic)
        ? pick('请先登录 Antigravity CLI。', 'Sign in to Antigravity CLI first.')
        : /api.?key|no account quota/i.test(diagnostic) && failure?.code === 2
          ? pick('CLI 当前登录方式没有订阅额度。', 'The current CLI authentication method has no subscription allowance.')
          : failure?.killed
            ? pick('Antigravity 额度查询超时。', 'The Antigravity quota query timed out.')
            : failure?.code !== undefined || error instanceof SyntaxError
              ? pick('无法读取 Antigravity 订阅额度。', 'Could not read the Antigravity subscription allowance.')
              : error instanceof Error ? error.message : pick('额度查询失败。', 'Quota query failed.')
      return { checkedAt: Date.now(), groups: [], error: message }
    }
  ).then((snapshot) => { latest = snapshot; return snapshot }).finally(() => { pending = undefined })
  return pending
}
