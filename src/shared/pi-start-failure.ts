import { pick } from './ui-lang'
import { redactSecretText } from './redact-diagnostic'

export interface PiExtensionFailure {
  path: string
  name: string
  reason: string
  conflict: boolean
  owner?: string
}

const FAILURE_LINE = /Failed to load extension "([^"]+)":\s*(.*)$/
const CONFLICT_OWNER = /^(?:Tool|Flag) "[^"]+" conflicts with (.+)$/
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g
const REASON_MAX_CHARS = 200
const LISTED_FAILURES = 3

export function extensionName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  const last = parts.at(-1) ?? path
  if (/^index\.(?:[cm]?[jt]s)$/i.test(last) && parts.length > 1) return parts.at(-2)!
  return last
}

export function parsePiExtensionFailures(lines: readonly string[]): PiExtensionFailure[] {
  const failures: PiExtensionFailure[] = []
  for (const raw of lines) {
    const match = FAILURE_LINE.exec(raw.replace(ANSI, ''))
    if (!match) continue
    const path = match[1]
    if (failures.some((item) => item.path === path)) continue
    const detail = match[2].trim()
    const reason = redactSecretText(detail).slice(0, REASON_MAX_CHARS)
    const owner = CONFLICT_OWNER.exec(detail)?.[1]?.trim()
    failures.push({ path, name: extensionName(path), reason, conflict: /\bconflicts with\b/.test(reason), ...(owner ? { owner } : {}) })
  }
  return failures
}

export function piExtensionFailureMessage(failures: readonly PiExtensionFailure[]): string {
  const listed = failures.slice(0, LISTED_FAILURES).map((item) =>
    item.conflict
      ? pick(`扩展「${item.name}」与其他扩展冲突（${item.reason}）`, `Extension "${item.name}" conflicts with another extension (${item.reason})`)
      : pick(`扩展「${item.name}」加载失败（${item.reason}）`, `Extension "${item.name}" failed to load (${item.reason})`)
  )
  const more = failures.length - listed.length
  const paths = failures.slice(0, LISTED_FAILURES).map((item) => item.path).join(pick('；', '; '))
  const tail = more > 0 ? pick(`，另有 ${more} 个`, `, and ${more} more`) : ''
  return pick(`pi 因扩展问题无法启动：${listed.join('；')}${tail}。扩展位置：${paths}。修复或移走这个扩展后重试。`,
    `pi could not start because of an extension problem: ${listed.join('; ')}${tail}. Location: ${paths}. Fix or move the extension away and retry.`
  )
}

export function piStartFailureText(input: { spawnFailure?: string; running: boolean; stderr: readonly string[] }): string {
  const failures = parsePiExtensionFailures(input.stderr)
  if (failures.length > 0) return piExtensionFailureMessage(failures)
  if (input.spawnFailure) return pick(`无法启动 pi：${input.spawnFailure}。`, `Cannot start pi: ${input.spawnFailure}.`)
  return input.running
    ? pick('pi 启动超时（20s）。点「详情」看 stderr。', 'pi start timed out (20s). See stderr under Details.')
    : pick('pi 启动后立即退出。点「详情」看 stderr。', 'pi exited right after starting. See stderr under Details.')
}
