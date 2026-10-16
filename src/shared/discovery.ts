import { createHash } from 'node:crypto'

export type CandidateKind = 'skill' | 'mcp-server'
export type CandidateAuth = 'none' | 'configured' | 'required' | 'unknown'
export type CandidateInstallKind = 'skill-files' | 'pi-package' | 'mcp-package' | 'remote' | 'unknown'
export type CandidateVerification = 'metadata-only' | 'source-checked' | 'smoke-passed'
export type CandidateTransport = 'stdio' | 'streamable-http'

export type CandidateLocalPackage = {
  registryType: string
  identifier: string
  version?: string
  runtimeHint?: string
  fileSha256?: string
}

export type GithubSkillFile = { path: string; sha: string; size: number }

export type CapabilityCandidate = {
  candidateId: string
  kind: CandidateKind
  title: string
  summary: string
  discoveredAt: string
  sourceUrls: string[]
  publisher?: string
  repository?: string
  version?: string
  commit?: string
  integrity?: string
  transport?: CandidateTransport
  remoteUrl?: string
  localPackage?: CandidateLocalPackage
  requirements: string[]
  auth: CandidateAuth
  installKind: CandidateInstallKind
  verification: CandidateVerification
  skillFiles?: string[]
  skillFileHashes?: Record<string, string>
  skillFileUrls?: Record<string, string>
  githubSkill?: { owner: string; repo: string; commit: string; dir: string; files: GithubSkillFile[] }
}

export type DiscoverySourceReport = {
  sourceId: string
  kind: 'npm-registry' | 'mcp-registry' | 'skill-directory' | 'github-skills'
  url: string
  ok: boolean
  fetchedAt: string
  pages: number
  candidateCount: number
  error?: string
}

export type AcquisitionPlan = {
  planId: string
  revision: number
  candidateId: string
  goalId: string
  projectId: string
  pinnedSource: string
  artifactDigest?: string
  scope: 'project-managed'
  filesAndDependencies: string[]
  needsRestart: boolean
  policyResult: 'automatic' | 'needs-auth' | 'needs-authorization' | 'unsupported'
}

export const MAX_QUERY_REWRITES = 2
export const MAX_PAGES_PER_SOURCE = 2
export const MAX_CANDIDATES = 8
export const MAX_QUERY_CHARS = 120

export function sanitizeDiscoveryQuery(raw: string): string {
  let text = String(raw ?? '')
  text = text.replace(/https?:\/\/\S+/gi, ' ')
  text = text.replace(/[A-Za-z]:[\\/][^\s"']*/g, ' ')
  text = text.replace(/(?:\\\\[^\s\\]+\\|(?:\.\.?\\)?)[^\s"'\\]+(?:\\[^\s"'\\]+)+/g, ' ')
  text = text.replace(/(?:\/[\w.$-]+){2,}/g, ' ')
  text = text.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, ' ')
  text = text.replace(/\b(?:sk|pk|ghp|gho|api|token|secret|bearer)[-_][A-Za-z0-9_-]{12,}\b/gi, ' ')
  text = text.replace(/\b[A-Fa-f0-9]{32,}\b/g, ' ')
  text = text.replace(/["'`][^"'`]{0,160}["'`]/g, ' ')
  text = text.replace(/\s+/g, ' ').trim()
  return text.slice(0, MAX_QUERY_CHARS).trim()
}

export function discoveryQueryUsable(text: string): boolean {
  return sanitizeDiscoveryQuery(text).length >= 2
}

export type RankedCandidate = { candidate: CapabilityCandidate; score: number; reasons: string[] }

const INSTALL_COST_BONUS: Record<CandidateInstallKind, number> = {
  'skill-files': 4,
  'pi-package': 3,
  'mcp-package': 2,
  remote: 1,
  unknown: 0
}

const AUTH_BONUS: Record<CandidateAuth, number> = {
  none: 5,
  configured: 4,
  unknown: 0,
  required: -2
}

export function rankCandidates(
  candidates: readonly CapabilityCandidate[],
  options: { goalText?: string; platform?: string } = {}
): RankedCandidate[] {
  const words = (options.goalText ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2)

  const scored = candidates.map((candidate) => {
    const reasons: string[] = []
    let score = 0

    const haystack = `${candidate.title} ${candidate.summary} ${candidate.candidateId}`.toLowerCase()
    const hits = words.filter((w) => haystack.includes(w))
    if (hits.length > 0) {
      const bonus = Math.min(24, hits.length * 8)
      score += bonus
      reasons.push(`目标词命中 ${hits.length} 个（+${bonus}）`)
    }

    const reqText = candidate.requirements.join(' ').toLowerCase()
    const platformBlocked = /(only|requires?)\s+(macos|darwin|linux)\b/.test(reqText) && !/windows/.test(reqText)
    if (platformBlocked) {
      score -= 20
      reasons.push('声明只支持非 Windows 平台（-20）')
    } else if (/windows|cross-platform|any/.test(reqText) || candidate.requirements.length === 0) {
      score += 4
      reasons.push('没有平台冲突（+4）')
    }

    const authBonus = AUTH_BONUS[candidate.auth]
    score += authBonus
    reasons.push(`认证=${candidate.auth}（${authBonus >= 0 ? '+' : ''}${authBonus}）`)

    if (candidate.repository) {
      score += 3
      reasons.push('有源代码仓库可核实（+3）')
    }
    if (candidate.version) {
      score += 3
      reasons.push('有确切版本可固定（+3）')
    }
    const costBonus = INSTALL_COST_BONUS[candidate.installKind]
    score += costBonus
    reasons.push(`接入代价=${candidate.installKind}（+${costBonus}）`)
    if (candidate.verification === 'smoke-passed') {
      score += 6
      reasons.push('已冒烟通过（+6）')
    } else if (candidate.verification === 'source-checked') {
      score += 4
      reasons.push('已核对来源（+4）')
    } else {
      reasons.push('仅目录元数据（未验证，+0）')
    }

    return { candidate, score, reasons }
  })

  return scored.sort((a, b) => b.score - a.score || a.candidate.candidateId.localeCompare(b.candidate.candidateId))
}

export function selectCandidates(ranked: readonly RankedCandidate[], max = MAX_CANDIDATES): RankedCandidate[] {
  return ranked.slice(0, Math.max(0, max))
}

export function stableDigestOf(candidate: CapabilityCandidate): string {
  const stable = [
    candidate.candidateId,
    candidate.kind,
    candidate.version ?? '',
    candidate.commit ?? '',
    candidate.integrity ?? '',
    candidate.transport ?? '',
    candidate.remoteUrl ?? '',
    candidate.localPackage?.registryType ?? '',
    candidate.localPackage?.identifier ?? '',
    candidate.localPackage?.version ?? '',
    candidate.localPackage?.runtimeHint ?? '',
    candidate.localPackage?.fileSha256 ?? '',
    [...(candidate.skillFiles ?? [])].sort().join('|'),
    Object.entries(candidate.skillFileHashes ?? {}).sort().map(([path, hash]) => `${path}:${hash}`).join('|'),
    Object.entries(candidate.skillFileUrls ?? {}).sort().map(([path, url]) => `${path}:${url}`).join('|'),
    candidate.githubSkill
      ? `${candidate.githubSkill.owner}/${candidate.githubSkill.repo}@${candidate.githubSkill.commit}:${candidate.githubSkill.dir}:` +
        candidate.githubSkill.files.map((file) => `${file.path}=${file.sha}`).sort().join('|')
      : '',
    candidate.installKind,
    [...candidate.sourceUrls].sort().join('|')
  ].join('\u0000')
  return createHash('sha256').update(stable).digest('hex').slice(0, 16)
}

export function planIdOf(input: { candidateId: string; goalId: string; projectId: string; digest?: string }): string {
  return createHash('sha256')
    .update([input.candidateId, input.goalId, input.projectId, input.digest ?? ''].join('\u0000'))
    .digest('hex')
    .slice(0, 16)
}

export function buildAcquisitionPlan(input: {
  candidate: CapabilityCandidate
  goalId: string
  projectId: string
  revision?: number
  needsRestart?: boolean
  filesAndDependencies?: string[]
}): AcquisitionPlan {
  const { candidate } = input
  const exactSemver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
  const localPackageSupported =
    candidate.installKind === 'remote' ||
    candidate.installKind === 'skill-files' ||
    (candidate.installKind === 'pi-package' &&
      candidate.localPackage?.registryType === 'npm' &&
      candidate.localPackage.identifier.length > 0 &&
      !!candidate.localPackage.version && exactSemver.test(candidate.localPackage.version)) ||
    (candidate.installKind === 'mcp-package' &&
      candidate.localPackage?.registryType === 'npm' &&
      candidate.localPackage.identifier.length > 0 &&
      !!candidate.localPackage.version &&
      exactSemver.test(candidate.localPackage.version) &&
      ['node', 'npx'].includes(candidate.localPackage.runtimeHint ?? ''))
  const policyResult: AcquisitionPlan['policyResult'] =
    candidate.auth === 'required'
      ? 'needs-auth'
      : !localPackageSupported
        ? 'unsupported'
      : candidate.verification === 'metadata-only'
        ? 'needs-authorization'
        : 'automatic'
  return {
    planId: planIdOf({
      candidateId: candidate.candidateId,
      goalId: input.goalId,
      projectId: input.projectId,
      digest: stableDigestOf(candidate)
    }),
    revision: input.revision ?? 1,
    candidateId: candidate.candidateId,
    goalId: input.goalId,
    projectId: input.projectId,
    pinnedSource: candidate.candidateId,
    ...(candidate.integrity ? { artifactDigest: candidate.integrity } : {}),
    scope: 'project-managed',
    filesAndDependencies: input.filesAndDependencies ?? [],
    needsRestart: input.needsRestart ?? false,
    policyResult
  }
}
