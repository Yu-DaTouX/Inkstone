import { denyFeedbackNote, normalizeApprovalFeedback } from './approval'

export interface ConsentKeyParts {
  capability: string
  action: string
  resource: string
  device: string
  scene: 'local' | 'remote'
}

export type ConsentDecision = 'allow' | 'deny'

export interface ConsentAnswer {
  decision: ConsentDecision
  feedback?: string
}

export function consentFeedbackSummary(decision: ConsentDecision, feedback: unknown): { feedback?: string; message?: string } {
  if (decision !== 'deny') return {}
  const reason = normalizeApprovalFeedback(feedback)
  if (!reason) return {}
  return { feedback: reason, message: denyFeedbackNote(reason) }
}

const DANGER_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /(delete|remove|\brm\b|erase|wipe|purge|drop|truncate|overwrite|删除|清空|覆盖)/i, label: '删除或覆盖' },
  { re: /(send|email|mail|publish|post|upload|share|tweet|push|发送|发布|上传|分享|推送)/i, label: '对外发送或发布' },
  { re: /(pay|purchase|buy|order|checkout|billing|付款|购买|下单|充值)/i, label: '付费购买' },
  { re: /(permission|credential|password|token|secret|\bkey\b|sudo|admin|chmod|acl|registry|权限|凭证|密码|密钥)/i, label: '修改权限或凭证' },
  { re: /(install|uninstall|setup|卸载|安装)/i, label: '安装或卸载' }
]

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

export interface ConsentVerdict {
  reason: string
  danger: string | null
}

export function consentVerdict(parts: Pick<ConsentKeyParts, 'capability' | 'action' | 'resource'>): ConsentVerdict {
  const danger = dangerCategoryOf(parts)
  return {
    danger,
    reason: danger ? `属于危险类别「${danger}」，每次都要询问` : '调用方声明这是危险操作，每次都要询问'
  }
}
