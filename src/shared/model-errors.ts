/** Shared model error extraction, redaction and display; no execution or retry policy. */

export type ModelErrorKind =
  /** 值得再试一次：网络 / 上游瞬态 / 认不出的错误 */
  | 'retryable'
  /** 额度 / 限流：重试只会立刻再失败 */
  | 'quota'
  /** 认证 / 权限：不换凭证永远不行 */
  | 'auth'
  /** 上下文超限：由原生 Agent 处理压缩与恢复 */
  | 'context'
  /** 用户取消：不重试 */
  | 'aborted'
  /** 服务商安全审核拦截：同一段上下文重发多半照样被拦 */
  | 'refused'
  /** 模型或请求参数不受支持，需调整配置后再试。 */
  | 'request'

/**
 * 额度类错误的细分：窗口/套餐用量用尽与短时频率限流出路不同，不能混成一句。
 * · usage：这条会话/窗口的额度已用完（例如 Claude 的 5 小时窗口），等恢复才是正解；
 * · rate：短时间内发得太密，稍等或降并发即可，额度本身还在。
 */
export type ModelErrorQuotaScope = 'usage' | 'rate'

export interface ModelErrorInfo {
  kind: ModelErrorKind
  /** 归一化后的原始文本（可能为空） */
  text: string
  /** 给界面/日志看的中文短句 */
  label: string
  /** 仅 kind=quota 时有值 */
  quotaScope?: ModelErrorQuotaScope
}

/** 关键词表（中英都认；大小写不敏感）。顺序即优先级：越具体的越靠前。 */
const PATTERNS: { kind: ModelErrorKind; label: string; re: RegExp }[] = [
  {
    kind: 'aborted',
    label: '本轮被取消',
    re: /\b(abort(ed)?|cancel(led|ed)?)\b|取消|已中止/i
  },
  {
    kind: 'refused',
    label: '服务商安全审核拦截',
    /*
     * 各家措辞：OpenAI / Codex「flagged … cybersecurity risk」「usage policy」，
     * Azure「content management policy」/ content_filter，Gemini「blocked … SAFETY」，
     * DeepSeek「Content Exists Risk」，Moonshot「considered high risk」，
     * 通义「inappropriate content」/ data_inspection_failed，智谱「不安全或敏感内容」。
     * 排在额度 / 认证之前：这类拒绝有时带 400 / 403，但换凭证没用，要换模型或换说法。
     */
    re: /\bflagged\b|content[ _-]?(policy|filter|management)|usage polic(y|ies)|(blocked|filtered).{0,40}\bsafety\b|\bsafety (filter|system|polic)|prohibited[ _]content|content exists risk|considered (a )?high risk|inappropriate content|data_inspection_failed|内容安全|(不安全|敏感)(或敏感)?内容|违反.{0,8}(政策|规定|策略|规范)/i
  },
  {
    kind: 'quota',
    label: '额度或限流',
    /*
     * 为什么还要认 `used all` / `free requests` / `requests for today`：
     * 供应商的原文常常不带 429，而是 “You've used all 100 free requests for today”
     * （实测踩过：只写 429/quota 会让这类错误被当成可重试，白烧 3 次额度）。
     */
    re: /\b(?:402|429)\b|rate[ _-]?limit|too many requests|quota|resource_exhausted|insufficient[ _](?:balance|funds|credit)|balance|credit|usage limit|used all|free requests?|requests for today|额度|配额|余额|限流/i
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
  }
]

/**
 * 额度细分用的两条关键词表，「用量用尽」优先。
 *
 * 为什么先判用量：供应商把窗口额度用尽也写成 rate limit ——
 * 实测原文 “Claude rate limit (five_hour) — resets 10:30:00 pm: You've hit your session limit”，
 * 只按 rate limit 判会提示「降低并发」，但实际上并发再低也得等窗口恢复。
 */
const QUOTA_USAGE_RE = /usage limit|session limit|used all|free requests?|requests for today|weekly limit|hourly limit|5[ _-]?hour|five[ _-]?hour|resets?\s+(?:at|in)\b|额度|配额|余额|balance|credit|funds|套餐|用量上限/i
const QUOTA_RATE_RE = /rate[ _-]?limit|too many requests|resource_exhausted|requests?\s+per\s+(?:minute|second|hour)|concurren|限流|频率|并发/i
/** 余额不足与窗口用尽都是「不充值/不等待就不行」，但话不一样。 */
const QUOTA_BALANCE_RE = /insufficient[ _](?:balance|funds|credit)|balance|credit|funds|余额|充值/i

function quotaScopeOf(text: string): ModelErrorQuotaScope {
  if (QUOTA_USAGE_RE.test(text)) return 'usage'
  if (QUOTA_RATE_RE.test(text)) return 'rate'
  /* 只认到 402/quota 这类笼统措辞时按额度用尽说，比说「降低并发」更接近事实。 */
  return 'usage'
}

/**
 * 供应商常把恢复时间写在同一句里。抓不到就不写，不猜时间。
 * 例：`resets 10:30pm (Australia/Sydney)`、`Try again in ~76 min`。
 */
function quotaResetHint(text: string): string {
  /* 同一句里可能出现多个 resets（带时区的那个更有用），优先取带括号时区的。 */
  const hits = [...text.matchAll(/resets?\s+(?:at\s+)?([\d:.]+\s*[ap]\.?m\.?(?:\s*\([^)]+\))?)/gi)].map((m) => m[1].trim())
  const best = hits.find((h) => h.includes('(')) ?? hits[0]
  if (best) return `恢复时间：${best}`
  const after = text.match(/try again in\s*~?\s*([0-9]+(?:\.[0-9]+)?\s*(?:min(?:ute)?s?|hours?|hrs?|seconds?|秒|分钟|小时))/i)
  if (after) return `${after[1].trim()}后恢复`
  return ''
}

/** 只提取错误字段，避免把请求正文、密钥或完整响应对象投到界面。 */
export function modelErrorText(value: unknown, depth = 0): string {
  if (depth > 4) return ''
  if (typeof value === 'string') {
    const raw = value.trim()
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw)
        const extracted = modelErrorText(parsed, depth + 1)
        if (extracted) return extracted
      } catch { /* 非 JSON 错误保留原文。 */ }
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

/** 分类只用于错误展示；未知错误保留原文，不触发宿主自动重试。 */
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

/**
 * 消息流里错误行的文案（实时与历史共用）。
 *
 * 说明已知原因和下一步，保留脱敏原文；未知原因不推断成额度或鉴权失败。
 */
export function modelErrorNotice(errorText: unknown): string {
  const info = classifyModelError(errorText)
  if (!info.text) return '模型请求失败：服务商未返回具体原因，无法判断是网络、额度还是请求问题。请查看运行日志，或稍后重试。'
  let explanation: string
  switch (info.kind) {
    case 'refused': explanation = '服务商安全审核拦截了这轮请求。请检查请求内容与服务商政策；可换个模型继续，直接重发相同内容可能仍被拦截。'; break
    case 'quota': {
      if (info.quotaScope === 'rate') {
        explanation = '服务商限制了请求频率。请稍候片刻重试，或降低并发；额度本身未用尽。'
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
      if (/\bterminated\b|websocket|socket hang up|econnreset|stream.{0,20}(closed|ended)|connection.{0,20}(closed|reset)/i.test(info.text)) {
        explanation = /\b1012\b/.test(info.text)
          ? '模型连接被关闭（WebSocket 1012：服务重启）。可稍后重试，继续前先核对已执行的工具。'
          : '模型连接或响应流意外中断。现有信息无法确认中断源，可检查网络后重试；继续前先核对已执行的工具。'
      } else if (/timeout|timed out|etimedout|超时/i.test(info.text)) {
        explanation = '等待模型响应超时。请检查网络、代理与服务商状态后重试。'
      } else if (/\b5\d\d\b|overloaded|overload|server error|service unavailable/i.test(info.text)) {
        explanation = '模型服务暂时故障或过载。可稍后重试，或选择其他可用模型。'
      } else if (/fetch failed|connect|network|enotfound|econnrefused|dns|tls|certificate/i.test(info.text)) {
        explanation = '无法连接模型服务。请检查网络、代理、接口地址及证书。'
      } else explanation = '模型请求失败，服务商返回了以下原因。请根据原文检查配置或服务状态。'
  }
  return `${explanation} 原因：${info.text}`
}

