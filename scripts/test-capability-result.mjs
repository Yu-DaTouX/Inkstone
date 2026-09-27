/**
 * 受管结果的落盘行为（capability-server）—— 重点是**超过大小上限**那一条。
 *
 * 为什么值得单独测：这条分支是所有 `yan` 命令共用的通用链路。写坏了以后
 * 模型拿到的是「`JSON.parse` 失败」，而不是一个能读的原因 —— 排查成本极高，
 * 但触发条件（超 4MB）平时碰不到，所以很容易悄悄退化。
 *
 * 这里用真的 `CapabilityServer` + 真 HTTP（不绕过它自己的鉴权与落盘路径），
 * 只把 handler 换成「吐一个大结果」。
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runCapabilityResultTests(ok, mod) {
  const { CapabilityServer, CAPABILITY_API_VERSION, CAPABILITY_RESULT_MAX_BYTES } = mod
  ok(typeof CAPABILITY_RESULT_MAX_BYTES === 'number' && CAPABILITY_RESULT_MAX_BYTES > 0, '结果上限常量可用')

  const opsDir = mkdtempSync(join(tmpdir(), 'yan-ops-'))
  const server = new CapabilityServer({
    opsDir,
    handlers: {
      async run() {
        /* 5MB 的 data：超过上限，必然走截断改写分支 */
        return { data: { big: 'x'.repeat(5 * 1024 * 1024), small: 1 }, summary: { kind: 'probe' } }
      }
    }
  })
  const { url, token } = await server.start({ sessionId: 's', projectId: 'p' })

  try {
    const res = await fetch(url + '/rpc', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({
        apiVersion: CAPABILITY_API_VERSION,
        sessionId: 's',
        projectId: 'p',
        command: 'capabilities.search',
        params: {}
      })
    })
    const body = await res.json()
    ok(body.ok === true && typeof body.resultFile === 'string', '大结果仍然回执（带 resultFile）')
    ok(body.resultBytes <= CAPABILITY_RESULT_MAX_BYTES, '落盘字节数不超过上限')

    const raw = readFileSync(body.resultFile, 'utf8')
    let parsed
    let parseError = ''
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      parseError = e instanceof Error ? e.message : String(e)
    }
    /* 这条就是回归线：改回 `slice` 的话，这里会报 Unterminated string */
    ok(!parseError, `超限后的结果文件仍是合法 JSON（实际：${parseError || 'ok'}）`)
    ok(parsed?.truncated === true, '写明被截断')
    ok(typeof parsed?.bytes === 'number' && parsed.bytes > CAPABILITY_RESULT_MAX_BYTES, '写明原始大小')
    ok(
      parsed?.shape?.keys?.big?.type === 'string' && parsed.shape.keys.big.length === 5 * 1024 * 1024,
      '形状轮廓说清 big 是个 5MB 的字符串'
    )
    ok(typeof parsed?.head === 'string' && parsed.head.length <= 2000, '开头片段被夹住（不是把原文搬一遍）')
  } finally {
    server.stop()
  }
}
