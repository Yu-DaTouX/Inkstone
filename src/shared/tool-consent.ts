export interface ConsentKeyParts {
  capability: string
  action: string
  resource: string
  device: string
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
  records: ConsentRecord[]
  override?: 'always-ask'
  lastAutoAt?: number
}

export interface ConsentLedger {
  version: 1
  entries: ConsentEntry[]
}

export const CONSENT_POLICY = {
  minRecords: 5,
  minEffective: 4,
  halfLifeDays: 30,
  minLowerBound: 0.6,
  recentWindow: 3,
  keep: 50
} as const

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
  reason: string
  danger: string | null
  stats: ConsentStats
}

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

export interface ConsentEntryView {
  key: string
  parts: ConsentKeyParts
  verdict: ConsentVerdict
  override?: 'always-ask'
  lastAutoAt?: number
  lastAnswerAt?: number
}
