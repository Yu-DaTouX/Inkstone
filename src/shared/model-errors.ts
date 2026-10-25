export type ModelErrorKind =
  | 'retryable'
  | 'quota'
  | 'auth'
  | 'context'
  | 'aborted'
  | 'refused'
  | 'request'

export type ModelErrorQuotaScope = 'usage' | 'rate'

export interface ModelErrorInfo {
  kind: ModelErrorKind
  text: string
  label: string
  quotaScope?: ModelErrorQuotaScope
}

const PATTERNS: { kind: ModelErrorKind; label: string; re: RegExp }[] = [
  {
    kind: 'refused',
    label: '服务商安全审核拦截',
    re: /\bflagged\b|content[ _-]?(policy|filter|management)|usage polic(y|ies)|(blocked|filtered).{0,40}\bsafety\b|\bsafety (filter|system|polic)|prohibited[ _]content|content exists risk|considered (a )?high risk|inappropriate content|data_inspection_failed|内容安全|(不安全|敏感)(或敏感)?内容|违反.{0,8}(政策|规定|策略|规范)/i
  },
  {
    kind: 'quota',
    label: '额度或限流',
    re: /\b(?:402|429)\b|rate[ _-]?limit|too many requests|quota|resource_exhausted|insufficient[ _](?:balance|funds|credit)|balance|credit|usage limit|extra usage|plan limits?|used all|free requests?|requests for today|额度|配额|余额|限流/i
  },
  {
    kind: 'auth',
    label: '认证或权限',
    re: /\b401\b|\b403\b|unauthorized|unauthenticated|forbidden|invalid[ _-]api[ _-]key|api[ _-]key[ _-]invalid|api key not valid|authentication|insufficient permissions|token.{0,12}expired|not logged in|登录|凭证|密钥/i
  },
  {
    kind: 'context',
    label: '上下文超限',
    re: /context[ _-](length|window|limit)|too many tokens|maximum context|token limit|prompt is too long|too long|上下文.{0,6}(超|过|长)/i
  },
  {
    kind: 'request',
    label: '模型或请求配置不受支持',
    re: /model.{0,50}(not found|does not exist|not available|unsupported)|unknown model|model_not_found|invalid_request_error|invalid (request|parameter|argument)|unsupported (parameter|value|model|tool)|tool.{0,40}(schema|invalid|mismatch)|\b(?:400|404|422)\b|模型.{0,8}(不存在|不支持)|参数.{0,8}(错误|无效)/i
  },
  {
    kind: 'aborted',
    label: '本轮被取消',
    re: /\b(aborted by user|(request|operation) (was )?aborted)\b|AbortError|用户取消|主动取消|已取消|已中止|本轮被取消/i
  }
]

const QUOTA_USAGE_RE = /usage limit|extra usage|plan limits?|session limit|used all|free requests?|requests for today|weekly limit|hourly limit|5[ _-]?hour|five[ _-]?hour|resets?\s+(?:at|in)\b|额度|配额|余额|balance|credit|funds|套餐|用量上限/i
const QUOTA_RATE_RE = /rate[ _-]?limit|too many requests|resource_exhausted|requests?\s+per\s+(?:minute|second|hour)|concurren|限流|频率|并发/i
const QUOTA_BALANCE_RE = /insufficient[ _](?:balance|funds|credit)|balance|credit|funds|extra usage|余额|充值/i

function quotaScopeOf(text: string): ModelErrorQuotaScope {
  if (QUOTA_USAGE_RE.test(text)) return 'usage'
  if (QUOTA_RATE_RE.test(text) || /\b429\b/.test(text)) return 'rate'
  return 'usage'
}

function quotaResetHint(text: string): string {
  const hits = [...text.matchAll(/resets?\s+(?:at\s+)?([\d:.]+\s*[ap]\.?m\.?(?:\s*\([^)]+\))?)/gi)].map((m) => m[1].trim())
  const best = hits.find((h) => h.includes('(')) ?? hits[0]
  if (best) return `恢复时间：${best}`
  const after = text.match(/try again in\s*~?\s*([0-9]+(?:\.[0-9]+)?\s*(?:min(?:ute)?s?|hours?|hrs?|seconds?|秒|分钟|小时))/i)
  if (after) return `${after[1].trim()}后恢复`
  return ''
}

export function modelErrorText(value: unknown, depth = 0): string {
  if (depth > 4) return ''
  if (typeof value === 'string') {
    const raw = value.trim()
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw)
        const extracted = modelErrorText(parsed, depth + 1)
        if (extracted) return extracted
      } catch { }
    }
    return raw
      .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [已隐藏]')
      .replace(/\bsk-[A-Za-z0-9_-]+/g, '[已隐藏]')
      .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password)\s*[=:]\s*["']?)[^\s"'&,;]+/gi, '$1[已隐藏]')
      .replace(/[\r\n\t]+/g, ' ')
      .slice(0, 900)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const box = value as Record<string, unknown>
  const parts = ['status', 'code', 'message', 'error', 'error_description', 'detail', 'cause']
    .map(key => typeof box[key] === 'number' ? String(box[key]) : modelErrorText(box[key], depth + 1))
    .filter(Boolean)
  return [...new Set(parts)].join('；').slice(0, 900)
}

export function classifyModelError(text: unknown): ModelErrorInfo {
  const raw = modelErrorText(text)
  for (const item of PATTERNS) {
    if (item.re.test(raw)) {
      return item.kind === 'quota'
        ? { kind: item.kind, text: raw, label: item.label, quotaScope: quotaScopeOf(raw) }
        : { kind: item.kind, text: raw, label: item.label }
    }
  }
  return { kind: 'retryable', text: raw, label: raw ? '模型侧错误' : '模型侧错误（没有错误文本）' }
}

const STREAM_BROKEN_RE = /\bterminated\b|websocket|socket hang up|econnreset|stream.{0,20}(closed|ended)|connection.{0,20}(closed|reset)/i
const TIMEOUT_RE = /timeout|timed out|etimedout|超时/i
const OVERLOAD_RE = /\b5\d\d\b|overloaded|overload|server error|service unavailable/i
const UNREACHABLE_RE = /fetch failed|connect|network|enotfound|econnrefused|dns|tls|certificate/i
const CERTIFICATE_RE = /tls|certificate/i

export function isTransientModelError(errorText: unknown): boolean {
  const info = classifyModelError(errorText)
  if (info.kind !== 'retryable' || !info.text) return false
  if (STREAM_BROKEN_RE.test(info.text) || TIMEOUT_RE.test(info.text) || OVERLOAD_RE.test(info.text)) return true
  return UNREACHABLE_RE.test(info.text) && !CERTIFICATE_RE.test(info.text)
}

export function modelErrorNotice(errorText: unknown): string {
  const info = classifyModelError(errorText)
  if (!info.text) return '模型请求失败：服务商未返回具体原因，无法判断是网络、额度还是请求问题。请查看运行日志，或稍后重试。'
  let explanation: string
  switch (info.kind) {
    case 'refused': explanation = '服务商安全审核拦截了这轮请求。请检查请求内容与服务商政策；可换个模型继续，直接重发相同内容可能仍被拦截。'; break
    case 'quota': {
      if (info.quotaScope === 'rate') {
        explanation = '服务商返回限流。可能是请求太快，也可能是订阅额度窗口已满（部分服务商额度用尽时同样返回 429）。砚会核对用量窗口；窗口已满时可等恢复后自动续跑，否则稍候重试。'
      } else if (QUOTA_BALANCE_RE.test(info.text)) {
        explanation = '模型账户余额或额度不足。请充值或选择其他可用模型。'
      } else {
        const reset = quotaResetHint(info.text)
        explanation = `模型额度已用尽（达到套餐用量上限或额度窗口用尽）${reset ? `，${reset}` : ''}。请等待额度恢复后重试，或选择其他可用模型。`
      }
      break
    }
    case 'auth': explanation = '模型认证或访问权限失败。请在设置中重新登录、检查凭证及模型访问权限。'; break
    case 'context': explanation = '请求超过模型的上下文或输入长度限制。请压缩会话、减少附件，或选择支持更长上下文的模型。'; break
    case 'aborted': explanation = '本轮请求已取消。已执行的工具操作可能保留，继续前请先核对进度。'; break
    case 'request': explanation = '服务商拒绝了模型或请求配置。请核对模型 ID、接口地址、工具格式及不受支持的参数。'; break
    default:
      if (STREAM_BROKEN_RE.test(info.text)) {
        explanation = /\b1012\b/.test(info.text)
          ? '模型连接被关闭（WebSocket 1012：服务重启）。可稍后重试，继续前先核对已执行的工具。'
          : '模型连接或响应流意外中断。现有信息无法确认中断源，可检查网络后重试；继续前先核对已执行的工具。'
      } else if (TIMEOUT_RE.test(info.text)) {
        explanation = '等待模型响应超时。请检查网络、代理与服务商状态后重试。'
      } else if (OVERLOAD_RE.test(info.text)) {
        explanation = '模型服务暂时故障或过载。可稍后重试，或选择其他可用模型。'
      } else if (UNREACHABLE_RE.test(info.text)) {
        explanation = '无法连接模型服务。请检查网络、代理、接口地址及证书。'
      } else explanation = '模型请求失败，服务商返回了以下原因。请根据原文检查配置或服务状态。'
  }
  return `${explanation} 原因：${info.text}`
}

