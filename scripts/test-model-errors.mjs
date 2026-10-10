/** Model errors retain their cause, redact credentials and preserve history semantics. */
export async function runModelErrorTests(ok) {
  const shared = await import('../out/test/model-errors.mjs')
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
  for (const [raw, expected] of [
    ['terminated', /响应流意外中断/],
    ['WebSocket closed 1012', /服务重启/],
    ['You have hit your ChatGPT usage limit (plus plan). Try again in ~76 min.', /套餐用量上限/],
    ['429 Too Many Requests', /请求频率/],
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
  ok(/quota/.test(shared.modelErrorNotice({ error: { code: 'insufficient_quota', message: 'quota exhausted' } })), '嵌套服务商错误字段可读取')
  ok(!shared.modelErrorNotice('fetch failed Authorization=abc123 Bearer secret-token api_key=private-key sk-secret123').includes('secret-token'), '错误原文中的 Bearer 凭证脱敏')
  ok(!/abc123|private-key|sk-secret123/.test(shared.modelErrorNotice('fetch failed Authorization=abc123 api_key=private-key sk-secret123')), '常见密钥字段脱敏')

  const { normalizeMessage, normalizeHistory } = await import('../out/test/normalize.mjs')
  const notice = '<subagent-notification id="sub-test" status="done">\n后台结果\n</subagent-notification>'
  const history = normalizeHistory([
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

}
