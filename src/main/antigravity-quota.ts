import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ANTIGRAVITY_QUOTA_REFRESH_MS, type AntigravityQuotaGroup, type AntigravityQuotaSnapshot } from '../shared/antigravity'
import { pick } from '../shared/ui-lang'
import { antigravityExecutable } from './antigravity'
import { YAN_DIR } from './paths'

const execute = promisify(execFile)
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
  const opts = { cwd, env, windowsHide: true, timeout: 18_000, maxBuffer: 256_000, encoding: 'utf8' as const }
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
  if (latest && Date.now() - latest.checkedAt < (force ? 5000 : ANTIGRAVITY_QUOTA_REFRESH_MS)) return Promise.resolve(latest)
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
