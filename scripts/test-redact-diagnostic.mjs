import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { redactSecretText, redactCredentialShapes } = await compile('src/shared/redact-diagnostic.ts')
  const { shownModelError } = await compile('src/main/workflows/model-lane.ts')

  const secrets = [
    ['OpenAI sk-', 'sk-proj-abcDEF123456'],
    ['Anthropic sk-ant-', 'sk-ant-api03-abcdefGHIJKL'],
    ['Google AIza', 'AIza' + 'SyD1x2Y3z4_-abcdefghijklmnopqrstu'],
    ['GitHub ghp_', 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'],
    ['GitHub gho_', 'gho_' + 'Z'.repeat(36)],
    ['GitHub ghs_', 'ghs_' + '9'.repeat(36)],
    ['GitHub github_pat_', 'github_pat_' + '11ABCDEFG0' + 'x'.repeat(70)],
    ['xAI xai-', 'xai-' + 'Ab3'.repeat(26)]
  ]
  for (const [label, secret] of secrets) {
    const text = `401 invalid key ${secret}, check settings`
    const out = redactSecretText(text)
    ok(!out.includes(secret) && out.includes('[redacted]') && out.startsWith('401 invalid key ') && out.endsWith(', check settings'), `${label} 被脱敏，前后文保留`, out)
  }

  const bearer = redactSecretText('Authorization failed: Bearer eyJhbGciOi.payload.sig rejected')
  ok(!bearer.includes('eyJhbGciOi') && bearer.includes('[redacted]'), 'Bearer 令牌被脱敏', bearer)

  const queries = [
    ['https://generativelanguage.googleapis.com/v1/models?key=SECRETVALUE1', 'SECRETVALUE1'],
    ['https://x.test/cb?code=1&client_secret=SECRETVALUE2&x=1', 'SECRETVALUE2'],
    ['https://x.test/v1?x-goog-api-key=SECRETVALUE3', 'SECRETVALUE3'],
    ['https://x.test/v1?a=1&access_token=SECRETVALUE4#frag', 'SECRETVALUE4'],
    ['https://x.test/blob?sv=1&sig=SECRETVALUE5', 'SECRETVALUE5'],
    ['https://x.test/v1?session.token=SECRETVALUE6', 'SECRETVALUE6']
  ]
  for (const [url, secret] of queries) {
    const out = redactSecretText(`GET ${url} -> 403`)
    ok(!out.includes(secret) && out.includes('[redacted]') && out.endsWith(' -> 403'), `查询参数里的密钥被脱敏：${url.slice(0, url.indexOf(secret))}`, out)
  }
  const keepQuery = redactSecretText('GET https://x.test/v1?model=gpt-5&page=2&monkey=banana -> 404')
  ok(keepQuery === 'GET https://x.test/v1?model=gpt-5&page=2&monkey=banana -> 404', '普通查询参数（含 monkey 这类只是包含 key 字样的名字）不动', keepQuery)

  const plain = [
    'task-abcdefghij failed on disk-0123456789',
    'pip install sk-learn scikit-learn',
    'model xai-grok-4-fast-reasoning not found',
    'see https://github.com/ghp_docs and AIzaShort',
    'flag ghp_short and github_pat_tooShort',
    'xai-models overloaded, retry later',
    'risk-assessment ask-question desk-top'
  ]
  for (const text of plain) ok(redactSecretText(text) === text, `普通词不误伤：${text}`, redactSecretText(text))

  const glued = redactSecretText('prefixAIza' + 'Q'.repeat(35) + ' xghp_' + 'a'.repeat(36))
  ok(glued.includes('prefixAIza') && glued.includes('xghp_'), '嵌在别的词里的形态不按密钥处理（保持词边界）', glued)

  const legacy = 'GET https://u:p@x.test/?api_key=abc token="zz" Bearer abcdefghij'
  ok(redactSecretText(legacy) === redactCredentialShapes(legacy), '原有凭据形态规则保持不变', redactSecretText(legacy))

  const shown = shownModelError(`401 for AIza${'Z'.repeat(35)} ` + '错'.repeat(3000))
  ok(!shown.includes('AIza') && [...shown].length <= 1001, 'shownModelError 走同一套规则并截断', shown.slice(0, 80))
})
