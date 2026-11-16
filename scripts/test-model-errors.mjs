import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  await runModelErrorTests(ok, {
    shared: await compile('src/shared/model-errors.ts', { platform: 'neutral' }),
    normalize: await compile('src/main/normalize.ts', { platform: 'neutral' }),
    projector: await compile('src/main/session-items/projector.ts', { platform: 'neutral' })
  })
})

export async function runModelErrorTests(ok, modules) {
  const { shared } = modules
  const cases = [
    ['429 Too Many Requests', 'quota'],
    ["You've used all 100 free requests for today", 'quota'],
    ['Rate limit exceeded', 'quota'],
    ['insufficient balance', 'quota'],
    ['429 配额已用尽', 'quota'],
    ['401 Unauthorized', 'auth'],
    ['403 Forbidden', 'auth'],
    ['invalid api key', 'auth'],
    ['Authentication failed: not logged in', 'auth'],
    ['请先登录', 'auth'],
    ['maximum context length is 128000 tokens', 'context'],
    ['prompt is too long', 'context'],
    ['上下文超过上限', 'context'],
    ['Request aborted', 'aborted'],
    ['已取消', 'aborted'],
    ['aborted by user', 'aborted'],
    ['RequestAbortedError: AbortError', 'aborted'],
    ['upstream request cancelled', 'retryable'],
    ['ECONNRESET', 'retryable'],
    ['insufficient credit balance', 'quota'],
    ['400 {"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going."}}', 'quota'],
    [
      'Codex error: This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. If you’re doing authorized security work that requires more cyber permissive safeguards, apply for Daybreak access via https://platform.openai.com/settings/organization/status-and-access before retrying.',
      'refused'
    ],
    ['400 Invalid prompt: your prompt was flagged as potentially violating our usage policy', 'refused'],
    ["The response was filtered due to the prompt triggering Azure OpenAI's content management policy", 'refused'],
    ['finish_reason: content_filter', 'refused'],
    ['Response was blocked due to SAFETY', 'refused'],
    ['Content Exists Risk', 'refused'],
    ['The request was rejected because it was considered high risk', 'refused'],
    ['data_inspection_failed: Input data may contain inappropriate content.', 'refused'],
    ['系统检测到输入或生成内容可能包含不安全或敏感内容', 'refused'],
    ['WebSocket error', 'retryable'],
    ['Internal Server Error (500)', 'retryable'],
    ['socket hang up', 'retryable'],
    ['fetch failed', 'retryable'],
    ['', 'retryable']
  ]
  for (const [text, kind] of cases) {
    const info = shared.classifyModelError(text)
    ok(info.kind === kind, `分类「${text.slice(0, 34) || '(空)'}」→ ${kind}（实际 ${info.kind}）`)
  }
  ok(shared.classifyModelError(null).kind === 'retryable', '缺失错误文本归入通用错误类别')
  ok(/429/.test(shared.classifyModelError('429 Too Many Requests').text), '保留原始错误文本（排障要看）')
  ok(shared.classifyModelError('429 too many requests').kind === 'quota', '大小写不敏感')

  const flagged = 'Codex error: This content was flagged for possible cybersecurity risk.'
  const refusedNotice = shared.modelErrorNotice(flagged)
  ok(/安全审核/.test(refusedNotice) && /换个模型/.test(refusedNotice), `安全审核拦截说清原因与出路（${refusedNotice}）`)
  ok(/连接或响应流意外中断/.test(shared.modelErrorNotice('WebSocket error')), '连接错误说明中断原因')
  ok(/未返回具体原因/.test(shared.modelErrorNotice(undefined)), '没有原文时明确未知，不编造原因')
  const windowLimit = "Claude rate limit (five_hour) — resets 10:30:00 pm: You've hit your session limit · resets 10:30pm (Australia/Sydney)"
  const windowNotice = shared.modelErrorNotice(windowLimit)
  ok(shared.classifyModelError(windowLimit).kind === 'quota', '会话窗口额度用尽归入额度类')
  ok(shared.classifyModelError(windowLimit).quotaScope === 'usage', '窗口额度用尽与请求频率限流分开')
  ok(/额度已用尽/.test(windowNotice) && /恢复时间：10:30pm/.test(windowNotice), `额度用尽说清原因与恢复时间（${windowNotice}）`)
  ok(!/降低并发/.test(windowNotice) && !/请求频率/.test(windowNotice), '额度用尽不误报成请求频率限流')
  ok(shared.classifyModelError('429 Too Many Requests').quotaScope === 'rate', '429 仍归入频率限流')

  const openaiQuotaMessage = 'You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.'
  for (const raw of [
    `429 ${openaiQuotaMessage}`,
    `429 {"error":{"message":"${openaiQuotaMessage}","type":"insufficient_quota","param":null,"code":"insufficient_quota"}}`,
    { status: 429, error: { code: 'insufficient_quota', message: openaiQuotaMessage } },
    '429 insufficient_quota',
    'Error code: 429 - insufficient_quota'
  ]) {
    const label = typeof raw === 'string' ? raw.slice(0, 48) : JSON.stringify(raw).slice(0, 48)
    const info = shared.classifyModelError(raw)
    ok(info.kind === 'quota' && info.quotaScope === 'usage', `OpenAI insufficient_quota 不归入频率限流：${label}`, [info.kind, info.quotaScope])
    ok(shared.modelErrorCause(raw) === 'quotaBalance', `OpenAI insufficient_quota → quotaBalance：${label}`, shared.modelErrorCause(raw))
    ok(/充值/.test(shared.modelErrorNotice(raw)), `OpenAI insufficient_quota 提示充值或换模型：${label}`)
  }
  for (const raw of [
    '429 {"error":{"message":"Rate limit reached for gpt-4o in organization org-x on requests per min (RPM): Limit 3, Used 3, Requested 1. Please try again in 20s.","type":"requests","param":null,"code":"rate_limit_exceeded"}}',
    '429 Rate limit reached for default-gpt-3.5-turbo in organization org-x on requests per min. Limit: 3 / min. Please try again in 20s. Please add a payment method to your account to increase your rate limit. Visit https://platform.openai.com/account/billing to add a payment method.',
    'rate_limit_exceeded',
    '429 Too Many Requests',
    'Too many requests per minute'
  ]) {
    ok(shared.modelErrorCause(raw) === 'quotaRate', `真正的限流仍是 quotaRate：${raw.slice(0, 48)}`, shared.modelErrorCause(raw))
  }
  for (const [raw, cause] of [
    ['400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}', 'quotaBalance'],
    ['402 Insufficient Balance', 'quotaBalance'],
    ['insufficient balance', 'quotaBalance'],
    ['402 This request requires more credits, or fewer max_tokens.', 'quotaBalance'],
    ['400 Third-party apps now draw from your extra usage, not your plan limits.', 'quotaBalance'],
    ['429 配额已用尽', 'quotaUsage'],
    ['You have hit your ChatGPT usage limit (plus plan). Try again in ~76 min.', 'quotaUsage']
  ]) {
    ok(shared.modelErrorCause(raw) === cause, `已有额度文案分类不变：${raw.slice(0, 48)} → ${cause}`, shared.modelErrorCause(raw))
  }

  for (const [raw, expected] of [
    ['terminated', /响应流意外中断/],
    ['insufficient balance', /余额/],
    ['WebSocket closed 1012', /服务重启/],
    ['You have hit your ChatGPT usage limit (plus plan). Try again in ~76 min.', /套餐用量上限/],
    ['429 Too Many Requests', /限流.*用量窗口/],
    ['Rate limit exceeded, please slow down', /限流.*用量窗口/],
    ['401 invalid api key', /重新登录/],
    ['context_length_exceeded: maximum context length', /压缩会话/],
    ['503 overloaded', /故障或过载/],
    ['ETIMEDOUT', /响应超时/],
    ['upstream connect error: Connection refused', /无法连接模型服务/],
    ['404 model_not_found', /模型 ID/],
    ['400 unsupported parameter temperature', /不受支持的参数/]
  ]) {
    const result = shared.modelErrorNotice(raw)
    ok(expected.test(result) && result.includes(raw), `错误保留原因与处理建议：${raw}`)
  }
  ok(shared.classifyModelError('You have hit your ChatGPT usage limit').kind === 'quota', 'ChatGPT 套餐上限识别为额度错误')
  ok(shared.classifyModelError('400 unsupported parameter').kind === 'request', '参数错误不当成网络错误反复重试')
  ok(shared.classifyModelError('403 insufficient permissions').kind === 'auth', '权限不足不误判成额度不足')
  ok(shared.isTransientModelError('ECONNRESET'), 'ECONNRESET 是可重试的临时错误')
  ok(!shared.isTransientModelError('upstream request cancelled'), '上游取消不当作临时错误自动重试')
  ok(shared.isAuthRejected('401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"},"request_id":"req_x"}'), 'Anthropic 401 认证拒绝识别为可续跑一次的认证闪断')
  ok(!shared.isAuthRejected('403 Forbidden: insufficient permissions'), '403 权限不足不当作认证闪断')
  ok(!shared.isAuthRejected('429 rate limit'), '限流不当作认证闪断')
  for (const text of ['OAuth refresh failed for anthropic', 'OAuth refresh failed for openai-codex: Error: 400 {"error":"invalid_grant","error_description":"Refresh token expired"}', 'invalid_grant', 'Kimi Code token refresh unauthorized (status 401)', 'refresh token has been revoked']) {
    ok(shared.classifyModelError(text).kind === 'auth', `OAuth 刷新失败认成认证错误：${text}`)
    ok(shared.isOAuthRefreshFailure(text) && shared.isAuthRejected(text), `OAuth 刷新失败可走 401 补救与换号：${text}`)
    ok(shared.modelErrorCause(text) === 'authExpired', `OAuth 刷新失败单独给出重新登录提示：${text}`)
  }
  const refreshNotice = shared.modelErrorNotice('OAuth refresh failed for anthropic')
  ok(/登录已失效/.test(refreshNotice) && /设置 → 模型/.test(refreshNotice) && refreshNotice.includes('anthropic') && refreshNotice.includes('原因：OAuth refresh failed for anthropic'), '提示到设置里重新登录对应服务商的账号，并保留原文', refreshNotice)
  ok(!/abc123/.test(shared.modelErrorNotice('OAuth refresh failed for anthropic: refresh_token=abc123')), '刷新失败原文里的刷新令牌被遮掉')
  ok(!shared.isOAuthRefreshFailure('401 Unauthorized') && shared.modelErrorCause('401 Unauthorized') === 'auth', '普通 401 仍是通用认证提示')
  ok(shared.classifyModelError('OAuth refresh failed for anthropic: 429 rate limit').kind === 'quota', '刷新接口被限流仍按限流处理')
  ok(shared.modelErrorNotice('upstream request cancelled').includes('upstream request cancelled'), '取消类原文仍保留在错误内容里')
  ok(/quota/.test(shared.modelErrorNotice({ error: { code: 'insufficient_quota', message: 'quota exhausted' } })), '嵌套服务商错误字段可读取')
  ok(!shared.modelErrorNotice('fetch failed Authorization=abc123 Bearer secret-token api_key=private-key sk-secret123').includes('secret-token'), '错误原文中的 Bearer 凭证脱敏')
  ok(!/abc123|private-key|sk-secret123/.test(shared.modelErrorNotice('fetch failed Authorization=abc123 api_key=private-key sk-secret123')), '常见密钥字段脱敏')

  const { normalizeMessage } = modules.normalize
  const { projectHistory } = modules.projector
  const notice = '<subagent-notification id="sub-test" status="done">\n后台结果\n</subagent-notification>'
  const history = projectHistory([
    { role: 'user', content: '原任务' },
    { role: 'user', content: notice },
    { role: 'assistant', content: [{ type: 'text', text: '继续处理' }] }
  ])
  ok(history[1].text === notice && history[2].id === 'm2', '历史通知保留完整标记和稳定消息编号，不修改持久记录')
  const failedAssistant = (errorMessage) =>
    normalizeMessage({ role: 'assistant', content: [], stopReason: 'error', ...(errorMessage ? { errorMessage } : {}) }, 0)
  ok(/安全审核/.test(failedAssistant(flagged).error ?? ''), '历史读回的拦截消息带同一句说明')
  ok(/未返回具体原因/.test(failedAssistant().error), '旧历史没有原文时明确缺失原因')
  ok(normalizeMessage({ role: 'assistant', content: [], stopReason: 'stop' }, 0).error === undefined, '正常结束没有错误行')

  const cut = normalizeMessage({ role: 'assistant', content: [{ type: 'text', text: '写到一半' }], stopReason: 'length' }, 0)
  ok(cut.error === shared.TRUNCATED_OUTPUT_NOTICE && cut.text === '写到一半', '输出被截断的消息保留正文并带截断说明', cut.error)
  ok(shared.classifyModelError(cut.error).kind === 'truncated' && shared.modelErrorCause(cut.error) === 'truncated', '截断说明归入截断类，不当成模型侧错误')
  ok(shared.modelErrorNotice(cut.error) === shared.TRUNCATED_OUTPUT_NOTICE, '截断说明再过一遍通知文案不变')
  ok(!shared.isTransientModelError(cut.error) && !shared.isAuthRejected(cut.error), '截断不触发临时错误续跑或认证闪断续跑')
  ok(shared.classifyModelError('finish_reason: length').kind !== 'truncated', '服务商原文里的 length 字样不误判成截断')

}
