/**
 * 普通工具的自动调用依据（需求稿 4.3）：契约与纯逻辑。
 *
 * 按「能力 + 操作 + 资源范围 + 设备 + 场景」统计**用户的真实答复**，
 * 同类操作积累了足够、稳定、近期的同意后才允许自动调用；否则照常询问。
 *
 * ── 硬规则 ──
 *  · 只有用户在确认框里点的「允许 / 拒绝」算数。没回复、模型推断、自动调用本身、
 *    执行成功与否都不记为同意（执行结果只说明工具能不能用）。
 *  · 危险类别（删除或覆盖、对外发送或发布、付费、权限与凭证、安装）以及看不出风险的操作，
 *    永远询问，不看同意率。模型可以把操作标成危险，不能把它标成安全。
 *  · 远程场景不使用本机记录：别人的同意、外部工具自报的同意都不能提高这里的权重。
 *  · 用户可以对某一类关闭自动调用（始终询问），也可以清空记录。
 *
 * 具体阈值是首版取值，集中放在 CONSENT_POLICY，便于以后按真实数据调整。
 */

export interface ConsentKeyParts {
  /** 能力，例如 `image.local`、`tool:ffmpeg` */
  capability: string
  /** 操作，例如 `generate`、`convert` */
  action: string
  /** 资源范围，例如模型路径、项目内目录；不同资源分开统计 */
  resource: string
  /** 设备标识（本机为 hostname 派生），能力记录绑定设备 */
  device: string
  /** 场景：本机任务或远程连接 */
  scene: 'local' | 'remote'
}

export type ConsentDecision = 'allow' | 'deny'

export interface ConsentRecord {
  decision: ConsentDecision
  at: number
}

export interface ConsentEntry {
  key: string
  parts: ConsentKeyParts
  /** 最近的答复（新的在后），最多保留 CONSENT_POLICY.keep 条 */
  records: ConsentRecord[]
  /** 用户设定：`always-ask` 表示这一类永不自动 */
  override?: 'always-ask'
  /** 最近一次自动放行的时间（只作展示，不计入同意） */
  lastAutoAt?: number
}

export interface ConsentLedger {
  version: 1
  entries: ConsentEntry[]
}

export const CONSENT_POLICY = {
  /** 至少这么多次真实答复才考虑自动 */
  minRecords: 5,
  /** 按时间衰减后的有效样本数下限 */
  minEffective: 4,
  /** 半衰期（天）：旧答复逐渐失去分量 */
  halfLifeDays: 30,
  /**
   * 同意率的 Wilson 下界（单侧 95%）至少这么高。
   * 取 0.6：近期连续 5 次同意（下界约 0.65）即可自动；5 次里有 1 次拒绝（下界约 0.40）、
   * 或答复分散在较长时间里（衰减后样本不足）都仍会询问。
   */
  minLowerBound: 0.6,
  /** 最近这么多次里出现过拒绝就回到询问 */
  recentWindow: 3,
  keep: 50
} as const

/** 看得出是危险类别的词：能力、操作或资源名里出现就一律询问 */
const DANGER_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /(delete|remove|\brm\b|erase|wipe|purge|drop|truncate|overwrite|删除|清空|覆盖)/i, label: '删除或覆盖' },
  { re: /(send|email|mail|publish|post|upload|share|tweet|push|发送|发布|上传|分享|推送)/i, label: '对外发送或发布' },
  { re: /(pay|purchase|buy|order|checkout|billing|付款|购买|下单|充值)/i, label: '付费购买' },
  { re: /(permission|credential|password|token|secret|\bkey\b|sudo|admin|chmod|acl|registry|权限|凭证|密码|密钥)/i, label: '修改权限或凭证' },
  { re: /(install|uninstall|setup|卸载|安装)/i, label: '安装或卸载' }
]

export function consentKeyOf(parts: ConsentKeyParts): string {
  return [parts.scene, parts.device, parts.capability, parts.action, parts.resource].map((part) => encodeURIComponent(part)).join('|')
}

const PART_RE = /^[^\u0000-\u001f]{1,200}$/

/** 请求参数 → 规范化的键；缺字段或含控制字符返回错误 */
export function normalizeConsentParts(raw: {
  capability?: unknown
  action?: unknown
  resource?: unknown
}, device: string, scene: ConsentKeyParts['scene']): { ok: true; parts: ConsentKeyParts } | { ok: false; error: string } {
  const clean = (value: unknown): string => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '')
  const capability = clean(raw.capability).toLowerCase()
  const action = clean(raw.action).toLowerCase()
  const resource = clean(raw.resource) || '*'
  if (!PART_RE.test(capability) || !PART_RE.test(action) || !PART_RE.test(resource)) {
    return { ok: false, error: '需要 capability 与 action（各 1–200 字），resource 可选' }
  }
  return { ok: true, parts: { capability, action, resource, device, scene } }
}

/** 危险类别判定；返回命中的类别名，未命中返回 null */
export function dangerCategoryOf(parts: Pick<ConsentKeyParts, 'capability' | 'action' | 'resource'>): string | null {
  const text = `${parts.capability} ${parts.action} ${parts.resource}`
  return DANGER_PATTERNS.find((pattern) => pattern.re.test(text))?.label ?? null
}

export interface ConsentStats {
  total: number
  allows: number
  denies: number
  effective: number
  allowRate: number | null
  lowerBound: number | null
}

export function consentStats(records: readonly ConsentRecord[], now: number): ConsentStats {
  let allowWeight = 0
  let denyWeight = 0
  for (const record of records) {
    const ageDays = Math.max(0, now - record.at) / 86_400_000
    const weight = Math.pow(0.5, ageDays / CONSENT_POLICY.halfLifeDays)
    if (record.decision === 'allow') allowWeight += weight
    else denyWeight += weight
  }
  const effective = allowWeight + denyWeight
  const allowRate = effective > 0 ? allowWeight / effective : null
  return {
    total: records.length,
    allows: records.filter((r) => r.decision === 'allow').length,
    denies: records.filter((r) => r.decision === 'deny').length,
    effective,
    allowRate,
    lowerBound: allowRate === null ? null : wilsonLower(allowRate, effective)
  }
}

function wilsonLower(p: number, n: number): number {
  const z = 1.645
  const denom = 1 + (z * z) / n
  const centre = p + (z * z) / (2 * n)
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return Math.max(0, (centre - margin) / denom)
}

export interface ConsentVerdict {
  mode: 'auto' | 'ask'
  /** 给用户和模型看的依据 */
  reason: string
  danger: string | null
  stats: ConsentStats
}

/**
 * 这一次该不该问。
 * `declaredDanger`：调用方（模型）声明这是危险操作 —— 只能让结果更保守。
 */
export function consentVerdict(entry: ConsentEntry | undefined, parts: ConsentKeyParts, now: number, declaredDanger = false): ConsentVerdict {
  const records = entry?.records ?? []
  const stats = consentStats(records, now)
  const danger = dangerCategoryOf(parts) ?? (declaredDanger ? '调用方声明为危险操作' : null)
  const ask = (reason: string): ConsentVerdict => ({ mode: 'ask', reason, danger, stats })
  if (danger) return ask(`属于危险类别「${danger}」，每次都要询问`)
  if (parts.scene === 'remote') return ask('远程场景按连接所有者的授权处理，不使用本机同意记录')
  if (entry?.override === 'always-ask') return ask('你已将这一类设为始终询问')
  if (stats.total < CONSENT_POLICY.minRecords) return ask(`同类答复只有 ${stats.total} 次，至少 ${CONSENT_POLICY.minRecords} 次才考虑自动`)
  const recent = records.slice(-CONSENT_POLICY.recentWindow)
  if (recent.some((r) => r.decision === 'deny')) return ask(`最近 ${CONSENT_POLICY.recentWindow} 次里有拒绝`)
  if (stats.effective < CONSENT_POLICY.minEffective) return ask('近期答复太少（旧记录已随时间降低分量）')
  if ((stats.lowerBound ?? 0) < CONSENT_POLICY.minLowerBound) {
    return ask(`同意率不够稳定（${Math.round((stats.allowRate ?? 0) * 100)}%，下界 ${Math.round((stats.lowerBound ?? 0) * 100)}%）`)
  }
  return {
    mode: 'auto',
    reason: `同类操作已同意 ${stats.allows}/${stats.total} 次（近期同意率下界 ${Math.round((stats.lowerBound ?? 0) * 100)}%），自动放行`,
    danger: null,
    stats
  }
}

/** 记一次用户的真实答复（只有确认框的结果能走到这里） */
export function recordConsent(ledger: ConsentLedger, parts: ConsentKeyParts, decision: ConsentDecision, now: number): ConsentLedger {
  const key = consentKeyOf(parts)
  const entries = ledger.entries.filter((entry) => entry.key !== key)
  const current = ledger.entries.find((entry) => entry.key === key)
  const records = [...(current?.records ?? []), { decision, at: now }].slice(-CONSENT_POLICY.keep)
  return { version: 1, entries: [...entries, { ...(current ?? { key, parts }), key, parts, records }] }
}

export function emptyConsentLedger(): ConsentLedger {
  return { version: 1, entries: [] }
}

/** 读盘时宽容解析：认不出的条目丢弃，不猜 */
export function parseConsentLedger(value: unknown): ConsentLedger {
  const raw = value as { version?: unknown; entries?: unknown }
  if (!raw || raw.version !== 1 || !Array.isArray(raw.entries)) return emptyConsentLedger()
  const entries: ConsentEntry[] = []
  for (const item of raw.entries as ConsentEntry[]) {
    if (!item || typeof item.key !== 'string' || !item.parts || !Array.isArray(item.records)) continue
    const records = item.records.filter(
      (r): r is ConsentRecord => !!r && (r.decision === 'allow' || r.decision === 'deny') && typeof r.at === 'number'
    )
    entries.push({
      key: item.key,
      parts: item.parts,
      records: records.slice(-CONSENT_POLICY.keep),
      ...(item.override === 'always-ask' ? { override: 'always-ask' as const } : {}),
      ...(typeof item.lastAutoAt === 'number' ? { lastAutoAt: item.lastAutoAt } : {})
    })
  }
  return { version: 1, entries }
}

/** 设置页的一行 */
export interface ConsentEntryView {
  key: string
  parts: ConsentKeyParts
  verdict: ConsentVerdict
  override?: 'always-ask'
  lastAutoAt?: number
  lastAnswerAt?: number
}
