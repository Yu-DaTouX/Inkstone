/**
 * 能力联网发现：候选、排名与接入计划（实施-04 §7 / §8）。
 *
 * ── 这一层为什么必须是纯逻辑 ──
 *   发现链里最容易出错的不是 HTTP，而是**判断**：谁更可能可用、能不能在本机跑、
 *   认证有没有、来源可不可核实。把这些写成纯函数，单测才能直接构造候选去验，
 *   不必真的联网 —— 而联网那部分（适配器）只负责把目录响应**如实**映射成候选。
 *
 * ── 三条不能碰的红线 ──
 *   1. **下载量不是可信证明**（§8）：排名因子由目标匹配、平台、认证、可固定性决定。
 *      把下载量写进评分，等于把「热门」当成「可信」。
 *   2. **`metadata-only` 不得声称已验证**：目录只证明发布来源，不等于代码被审计过。
 *   3. **源全挂时不编造包名**：返回空 + 明确原因，让模型说「暂时无法搜索」。
 */
import { createHash } from 'node:crypto'

export type CandidateKind = 'skill' | 'mcp-server'
export type CandidateAuth = 'none' | 'configured' | 'required' | 'unknown'
export type CandidateInstallKind = 'skill-files' | 'pi-package' | 'mcp-package' | 'remote'
export type CandidateVerification = 'metadata-only' | 'source-checked' | 'smoke-passed'
export type CandidateTransport = 'stdio' | 'streamable-http'

/** MCP Registry 给出的本地包线索；运行时/参数仍是不可信元数据，不能直接执行。 */
export type CandidateLocalPackage = {
  registryType: string
  identifier: string
  version?: string
  runtimeHint?: string
  fileSha256?: string
}

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
  /**
   * 可直接连接的远程端点（仅 `installKind: 'remote'` 时有）。
   *
   * 为什么显式给一个字段而不是从 `sourceUrls` 里猜：目录地址与端点都是 URL，
   * 猜错就会把**目录自己**当成要登记的服务（本地 fixture / 自建目录时尤其致命）。
   */
  remoteUrl?: string
  localPackage?: CandidateLocalPackage
  requirements: string[]
  auth: CandidateAuth
  installKind: CandidateInstallKind
  verification: CandidateVerification
  /** 固定声明的本地 Skill 文件；只允许宿主在接入时读取这些路径。 */
  skillFiles?: string[]
  skillFileHashes?: Record<string, string>
  /** 独立 Skill 目录给出的逐文件 HTTPS 来源；只允许宿主按这些 URL 读取。 */
  skillFileUrls?: Record<string, string>
}

/** 一个目录源这一轮的取数结果 —— 失败也如实报，不假装「没找到」。 */
export type DiscoverySourceReport = {
  sourceId: string
  kind: 'npm-registry' | 'mcp-registry' | 'skill-directory'
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

/* ------------------------------------------------------------------ 上限 */

/** §7.2：每轮默认最多两次查询改写。 */
export const MAX_QUERY_REWRITES = 2
/** §7.2：每源最多两页。 */
export const MAX_PAGES_PER_SOURCE = 2
/** §7.2：候选最多八项。 */
export const MAX_CANDIDATES = 8
/** 检索词上限：太长会把本地信息（路径、正文）带出去。 */
export const MAX_QUERY_CHARS = 120

/* ---------------------------------------------------------------- 检索词脱敏 */

/**
 * 把用户目标整理成**可以发给远端目录**的检索词（§7.1）。
 *
 * 去掉的是「只对本地有意义」的东西：URL、绝对路径、邮箱、密钥形状的串、
 * 长 hex（多半是 hash / 会话 id）、引号里的文件名或代码片段。
 * 不是万无一失的 DLP —— 它的职责是**默认不外发**，用户明确要检索远程数据时
 * 发送范围仍由任务授权决定。
 */
export function sanitizeDiscoveryQuery(raw: string): string {
  let text = String(raw ?? '')
  text = text.replace(/https?:\/\/\S+/gi, ' ')
  text = text.replace(/[A-Za-z]:\\[^\s"']*/g, ' ')
  text = text.replace(/(?:\/[\w.$-]+){2,}/g, ' ')
  text = text.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, ' ')
  text = text.replace(/\b(?:sk|pk|ghp|gho|api|token|secret|bearer)[-_][A-Za-z0-9_-]{12,}\b/gi, ' ')
  text = text.replace(/\b[A-Fa-f0-9]{32,}\b/g, ' ')
  text = text.replace(/["'`][^"'`]{0,160}["'`]/g, ' ')
  text = text.replace(/\s+/g, ' ').trim()
  return text.slice(0, MAX_QUERY_CHARS).trim()
}

/** 脱敏后没剩下东西就别发请求 —— 空检索词只会拿回一屏噪音。 */
export function discoveryQueryUsable(text: string): boolean {
  return sanitizeDiscoveryQuery(text).length >= 2
}

/* ------------------------------------------------------------------ 排名 */

export type RankedCandidate = { candidate: CapabilityCandidate; score: number; reasons: string[] }

const INSTALL_COST_BONUS: Record<CandidateInstallKind, number> = {
  'skill-files': 4,
  'pi-package': 3,
  'mcp-package': 2,
  remote: 1
}

const AUTH_BONUS: Record<CandidateAuth, number> = {
  none: 5,
  configured: 4,
  unknown: 0,
  required: -2
}

/**
 * 排名（§8）。
 *
 * ⚠️ **刻意不含下载量**：热门 ≠ 可信。评分的每一项都指向「它能不能在这台机器上、
 * 这个项目里、以可核实的方式真的用起来」。
 */
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

/** 截断到 §7.2 的上限，并保持排名。 */
export function selectCandidates(ranked: readonly RankedCandidate[], max = MAX_CANDIDATES): RankedCandidate[] {
  return ranked.slice(0, Math.max(0, max))
}

/* -------------------------------------------------------------- 稳定指纹 */

/**
 * 候选 / 计划的稳定指纹：源内容变化（版本、commit、digest 变了）就必须失效。
 *
 * **不包含 `discoveredAt` 与任何排名结果** —— 那些每轮都变，算进去等于让计划
 * 永远「刚失效」，用户会看到无意义的重复确认。
 */
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
    candidate.installKind,
    [...candidate.sourceUrls].sort().join('|')
  ].join('\u0000')
  return createHash('sha256').update(stable).digest('hex').slice(0, 16)
}

/**
 * 计划 ID 绑定候选内容指纹：元数据 / artifact 一漂移就生成新 ID，
 * 旧 CLI 引用仍指向旧计划，不能被主进程映射到更新后的制品。
 */
export function planIdOf(input: { candidateId: string; goalId: string; projectId: string; digest?: string }): string {
  return createHash('sha256')
    .update([input.candidateId, input.goalId, input.projectId, input.digest ?? ''].join('\u0000'))
    .digest('hex')
    .slice(0, 16)
}

/**
 * 生成接入计划（**只生成，不执行** —— 执行是 S6）。
 *
 * `policyResult` 是策略判定，不是安全审计结论：
 *   · 需要认证 → `needs-auth`（不伪装可自动接入）；
 *   · 平台不支持 / 来源不可固定 → `unsupported`。
 */
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
