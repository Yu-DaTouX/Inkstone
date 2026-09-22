/**
 * 交接 / 目标续接阶段诊断（实施-14 F0）的测试。
 *
 * 两层各自负责一半：
 *   · `shared/handoff-diagnostics.ts` —— **脱敏与形状**：它是唯一能保证
 *     「提示词全文 / 凭证不进日志」的地方，判错就是静默泄漏；
 *   · `main/handoff-diagnostics.ts` —— **落盘与有界**：JSONL 追加、坏行跳过、
 *     超限重写、跨实例读回。
 *
 * 用法：npm run test:unit
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runHandoffDiagnosticsTests(ok, shared, main) {
  /* ---------------------------------------------- 脱敏（shared） */

  ok(
    shared.HANDOFF_EVENT_STAGES.includes('eligibility') && shared.HANDOFF_EVENT_STAGES.includes('commit'),
    '阶段清单包含资格判定与提交（F0 要区分的两类）'
  )

  const sk = shared.redactDiagnosticText('provider key is sk-abcdef1234567890 ok')
  ok(!String(sk).includes('sk-abcdef1234567890') && String(sk).includes('[redacted]'), 'API key 形状被替换', String(sk))
  const bearer = shared.redactDiagnosticText('Authorization: Bearer eyJhbGciOi.payload.sig')
  ok(!String(bearer).includes('eyJhbGciOiJ') && String(bearer).includes('[redacted]'), 'Bearer 令牌被替换', String(bearer))
  ok(
    !String(shared.redactDiagnosticText('token=abc123456 login')).includes('abc123456'),
    'token= 赋值被替换'
  )

  /* 长提示词：截断并标注原长，而不是原样留下 */
  const long = '交接包提示词'.repeat(200)
  const trimmed = shared.redactDiagnosticText(long)
  ok(String(trimmed).length < 200 && String(trimmed).endsWith(`…(共${long.length}字)`), '长文本截断并标注原长')

  ok(shared.redactDiagnosticText('') === null && shared.redactDiagnosticText(123) === null, '空 / 非字符串返回 null')

  const detail = shared.sanitizeHandoffDetail({
    count: 2.3456,
    busy: false,
    note: null,
    nested: { a: 1 },
    array: [1, 2, 3],
    prompt: long
  })
  ok(detail.count === 2.346 && detail.busy === false && detail.note === null, '数字 / 布尔 / null 原样保留（数字截到千分位）')
  ok(typeof detail.nested === 'string' && typeof detail.array === 'string', '未知类型降级成字符串（诊断不能崩主链路）')
  ok(String(detail.prompt).length < 200, 'detail 里的长文本同样被截断')
  ok(Object.keys(shared.sanitizeHandoffDetail(null)).length === 0, '非对象 detail 清洗成空字典')

  const event = shared.normalizeHandoffEvent({
    at: 5,
    stage: 'eligibility',
    outcome: 'rejected',
    op: 'op/1 with space',
    sessionKey: 'C:\\sessions\\a.jsonl',
    reason: 'busy',
    detail: { prompt: long }
  })
  ok(event.stage === 'eligibility' && event.at === 5, '事件阶段与时间保留')
  ok(event.op === 'op/1_with_space', 'id 只清洗不安全字符（路径分隔符保留）', String(event.op))
  ok(String(event.sessionKey ?? '').length > 0 && String(event.sessionKey).includes(':'), '会话键保留（斜杠 / 冒号是路径的一部分）')

  const bad = shared.normalizeHandoffEvent({ stage: 'nope', outcome: '' })
  ok(bad.stage === 'generate' && bad.outcome === 'unknown', '未知阶段 / 空结论降级成可读默认值')

  ok(shared.sanitizeHandoffEventLine(null) === null, '脏行（null）读回为 null')
  ok(shared.sanitizeHandoffEventLine({ at: 1, stage: 'wat' }) === null, '未知阶段的行读回为 null')
  ok(shared.sanitizeHandoffEventLine({ at: 0, stage: 'commit' }) === null, '没有时间的行读回为 null')

  /* ---------------------------------------------- 落盘（main） */

  const root = await mkdtemp(join(tmpdir(), 'yan-handoff-diag-'))
  try {
    const file = main.handoffEventPath(root)
    ok(file.endsWith(join('handoff', 'events.jsonl')), '事件落在 <YAN_DIR>/handoff/events.jsonl', file)

    const diag = new main.HandoffDiagnostics({ root, now: () => 1000, limit: 3 })
    await diag.load()
    diag.record({ stage: 'eligibility', outcome: 'rejected', reason: 'below-threshold', detail: { count: 1, threshold: 2 } })
    diag.record({ stage: 'generate', outcome: 'request-written', op: 'op-1' })
    diag.record({ stage: 'resume', outcome: 'unconfirmed', handoffId: 'h-1', reason: 'no-evidence' })
    await diag.flush()

    ok(diag.recent().length === 3, '内存里记了 3 条')
    ok(diag.recent()[0].stage === 'eligibility' && diag.recent()[2].stage === 'resume', 'recent 由旧到新')

    const text = await readFile(file, 'utf8')
    const lines = text.trim().split('\n')
    ok(lines.length === 3, 'JSONL 一行一条', String(lines.length))
    const first = JSON.parse(lines[0])
    ok(first.reason === 'below-threshold' && first.detail.count === 1, '落盘内容与内存一致')
    ok(!text.includes('\n\n'), '没有多写空行')

    /* 跨实例读回：现场排障就是「重启后看上次发生了什么」 */
    const reread = new main.HandoffDiagnostics({ root, limit: 10 })
    await reread.load()
    ok(reread.recent().length === 3, '新实例能读回磁盘上的事件')
    ok(reread.recent()[2].outcome === 'unconfirmed', '读回的事件字段完整')

    /* 有界：超过 limit 只留最新 */
    const small = new main.HandoffDiagnostics({ root, limit: 2 })
    await small.load()
    small.record({ stage: 'commit', outcome: 'stage', reason: 'committed' })
    await small.flush()
    ok(small.recent().length === 2, '内存有界（只留最新 limit 条）')

    /* 坏行跳过：半行 / 非法 JSON 不能让整个历史读不出来 */
    const broken = join(root, 'broken')
    const brokenFile = main.handoffEventPath(broken)
    await rm(broken, { recursive: true, force: true })
    await import('node:fs/promises').then(({ mkdir }) => mkdir(join(broken, 'handoff'), { recursive: true }))
    await writeFile(
      brokenFile,
      `${JSON.stringify({ at: 1, stage: 'generate', outcome: 'ok' })}\nnot-json\n${JSON.stringify({ at: 2, stage: 'wat' })}\n`,
      'utf8'
    )
    const tolerant = new main.HandoffDiagnostics({ root: broken, limit: 10 })
    await tolerant.load()
    ok(tolerant.recent().length === 1 && tolerant.recent()[0].outcome === 'ok', '坏行跳过，好行保留')

    /* 落盘永远等于内存：写很多条之后文件不会增长 */
    const rot = new main.HandoffDiagnostics({ root: join(root, 'rot'), limit: 3 })
    await rot.load()
    for (let i = 0; i < 15; i++) rot.record({ stage: 'generate', outcome: `e${i}` })
    await rot.flush()
    const rotated = await readFile(rot.path(), 'utf8')
    const kept = rotated.trim() ? rotated.trim().split('\n').length : 0
    ok(kept === 3, '落盘行数与内存上限一致（有界，不随调用次数漂）', String(kept))
    ok(rot.recent().length === 3 && rot.recent()[2].outcome === 'e14', '重写后内存仍是最新 3 条')

    /* 写失败不能抛：root 指向一个文件（不是目录）时照样安静 */
    const bogus = new main.HandoffDiagnostics({ root: join(root, 'not-a-dir') })
    await writeFile(join(root, 'not-a-dir'), 'x', 'utf8')
    let threw = false
    try {
      bogus.record({ stage: 'commit', outcome: 'failed', reason: 'disk' })
      await bogus.flush()
    } catch {
      threw = true
    }
    ok(!threw, '诊断落盘失败不抛（不拖垮交接链路）')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
