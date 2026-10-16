import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

export async function runHandoffRequestTests(ok, shared, service) {
  console.log('\n--- 实施-05 S5b-2 交接包生成（请求 / 结果 / 解析） ---')

  const keys = ['r1', 'r-1_2.3', 'a b/c\\d', 'x'.repeat(200), '', '中文会话']
  for (const key of keys) {
    const mine = shared.handoffFileKey(key)
    const theirs = String(key ?? '')
      .trim()
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(0, 120)
    ok(mine === theirs, `文件名清洗两侧一致（${JSON.stringify(key).slice(0, 20)} → ${JSON.stringify(mine)}）`)
  }

  ok(shared.handoffFileKey('中文会话') === '____', '非 ASCII 一律替换（不允许路径分隔符逃逸）')
  ok(shared.handoffFileKey(123) === '', '非字符串 → 空（调用方据此放弃，不写坏文件）')

  const request = service.buildHandoffRequest({
    handoffId: 'h-1',
    operationId: 'op-1',
    sessionKey: 'C:/sessions/a.jsonl',
    prompt: '写一份交接包',
    sourceHead: 'msg-9',
    mode: 'autonomous',
    model: 'deepseek/deepseek-v4.1-flash',
    now: 1000
  })
  ok(request.handoffId === 'h-1' && request.operationId === 'op-1', '请求带两个身份（交接 / 本次生成）')
  ok(request.systemPrompt === shared.HANDOFF_SYSTEM_PROMPT, '请求带稳定 system prompt（缓存友好）')
  ok(request.maxTokens === shared.HANDOFF_PACKAGE_MAX_TOKENS, '请求带输出上限')
  ok(
    request.escalatedMaxTokens === shared.HANDOFF_PACKAGE_MAX_TOKENS_ESCALATED,
    `请求带第二跳预算（${shared.HANDOFF_PACKAGE_MAX_TOKENS_ESCALATED}）`
  )
  ok(
    request.escalatedMaxTokens > request.maxTokens,
    '第二跳预算真的比第一跳大（否则“抬起”是假的）'
  )
  ok(
    typeof request.retryPromptTruncated === 'string' && request.retryPromptTruncated.length > 10,
    '请求带截断专用提示'
  )
  ok(/长度限制|切断/.test(request.retryPromptTruncated), '截断提示说清是“被长度切断”而不是“格式不合格”')
  ok(
    !/必须包含全部列表/.test(request.retryPromptTruncated),
    '截断提示不再要求“写更多”（那是与预算直接冲突的那句）'
  )
  ok(request.sourceHead === 'msg-9' && request.mode === 'autonomous', '来源字段由宿主填进请求')

  const clean = shared.sanitizeHandoffRequest(request)
  ok(!!clean && clean.prompt === '写一份交接包' && clean.createdAt === 1000, '请求可被清洗读回（形状稳定）')
  ok(shared.sanitizeHandoffRequest({ ...request, prompt: '' }) === null, '缺提示词 → 整份作废（不猜）')
  ok(shared.sanitizeHandoffRequest({ ...request, handoffId: '  ' }) === null, '缺交接 id → 作废')
  ok(shared.sanitizeHandoffRequest({ ...request, operationId: '' }) === null, '缺生成 id → 作废')
  ok(shared.sanitizeHandoffRequest(null) === null, '非对象 → 作废')
  ok(shared.sanitizeHandoffRequest({ ...request, maxTokens: 99 }).maxTokens === 99, '输出上限可覆盖')
  ok(
    shared.sanitizeHandoffRequest({ ...request, maxTokens: 99999 }).maxTokens === shared.HANDOFF_PACKAGE_MAX_TOKENS_CEILING,
    '输出上限封顶（防手滑）；上限抬到能容下第二跳预算'
  )
  ok(shared.sanitizeHandoffRequest({ ...request, maxTokens: NaN }).maxTokens === shared.HANDOFF_PACKAGE_MAX_TOKENS, '非法上限 → 默认值')
  ok(
    shared.sanitizeHandoffRequest({ ...request, escalatedMaxTokens: 12000 }).escalatedMaxTokens === 12000,
    '第二跳预算可读回'
  )
  ok(
    shared.sanitizeHandoffRequest({ ...request, escalatedMaxTokens: 99999 }).escalatedMaxTokens ===
      shared.HANDOFF_PACKAGE_MAX_TOKENS_CEILING,
    '第二跳预算同样封顶'
  )
  ok(
    shared.sanitizeHandoffRequest({ ...request, escalatedMaxTokens: 100 }).escalatedMaxTokens === undefined,
    '第二跳预算不比第一跳大 → 当作没填（不搞假抬起）'
  )
  ok(
    shared.sanitizeHandoffRequest({ ...request, retryPromptTruncated: '  被切断  ' }).retryPromptTruncated === '被切断',
    '截断提示可读回（并做空白清洗）'
  )
  ok(shared.sanitizeHandoffRequest({ ...request, systemPrompt: '' }).systemPrompt === shared.HANDOFF_SYSTEM_PROMPT, '空 system → 默认文本')
  ok(shared.sanitizeHandoffRequest({ ...request, mode: '' }).mode === 'unknown', '空模式 → unknown（不编造）')

  const result = service.buildHandoffResult({ handoffId: 'h-1', operationId: 'op-1', text: '{}', ms: 1200, now: 2000 })
  ok(result.ms === 1200 && result.at === 2000, '结果带耗时与时间戳')
  ok(shared.sanitizeHandoffResult(result)?.text === '{}', '结果可被清洗读回')
  ok(shared.sanitizeHandoffResult({ ...result, truncated: true })?.truncated === true, '结果可标记截断')
  ok(
    shared.sanitizeHandoffResult({ ...result, stopReason: 'length' })?.truncated === true,
    'stopReason=length 也能推断出截断（旧扩展不写 truncated 时）'
  )
  ok(shared.sanitizeHandoffResult({ ...result, stopReason: 'stop' })?.truncated === false, '正常停止不算截断')
  ok(shared.sanitizeHandoffResult({ ...result, handoffId: '' }) === null, '缺交接 id 的结果 → 作废')
  const empty = shared.sanitizeHandoffResult(service.buildHandoffResult({ handoffId: 'h-1', operationId: 'op-1' }))
  ok(!!empty && empty.text === '' && empty.error === null, '「跑了但什么都没回」也是合法结果（宿主据此区分「没跑」）')

  const cases = [
    ['{"goal":"a","deliverable":"b"}', true],
    ['```json\n{"goal":"a"}\n```', true],
    ['好的，这是交接包：\n{"goal":"a","deliverable":"b"}\n希望有用。', true],
    ['{"goal":"a","deliverable":"b","notes":["x"]}\n```', true],
    ['', false],
    ['什么都没有', false],
    ['[1,2,3]', false],
    ['{"goal":', false]
  ]
  for (const [text, good] of cases) {
    const parsed = shared.parseHandoffOutput(text)
    ok(parsed.ok === good, `解析「${text.slice(0, 26).replace(/\n/g, '\\n') || '(空)'}」→ ${good ? '成功' : '失败'}`)
  }
  ok(shared.parseHandoffOutput('[]').reason === 'no-json-object', '数组不是对象（reason 可读）')
  ok(shared.parseHandoffOutput('{}{}').ok === true, '多个对象时取第一个完整对象（宽容但不猜语义）')

  const tally = { segmentId: 'initial', count: 0, keys: [], updatedAt: 0 }
  const goal = { revision: 1, phase: 'executing', goalId: 'g', steps: [], evidence: [], updatedAt: 0 }
  const base = { tally, goal, mode: 'autonomous', busy: false }
  ok(shared.handoffEligibility(base).eligible === false, '默认阈值：0 次 → 不够数')
  ok(shared.handoffEligibility(base).threshold === shared.HANDOFF_AUTO_COMPACT_THRESHOLD, '默认阈值来自常量')
  ok(shared.handoffEligibility({ ...base, threshold: 0 }).eligible === true, '阈值压到 0 → 立刻够格（测试通道）')
  ok(shared.handoffEligibility({ ...base, threshold: 0 }).threshold === 0, '覆盖后的阈值回传给调用方（界面要对得上）')
  ok(
    shared.handoffEligibility({ ...base, tally: { ...tally, count: 2 }, threshold: 3 }).reason === 'below-threshold',
    '阈值提到 3 → 2 次仍不够'
  )
  ok(shared.handoffEligibility({ ...base, mode: 'standard', threshold: 0 }).reason === 'not-autonomous', '标准档不交接（与阈值无关）')
  ok(shared.handoffEligibility({ ...base, busy: true, threshold: 0 }).reason === 'busy', '忙时不交接（不遗弃后台工作）')
  ok(
    shared.handoffEligibility({ ...base, goal: { ...goal, phase: 'completed' }, threshold: 0 }).reason === 'goal-not-active',
    '目标已完 → 不交接'
  )

  const root = await mkdtemp(join(tmpdir(), 'yan-handoff-req-'))
  try {
    const store = new service.HandoffRequestStore({ root })
    ok(store.requestPath('r1') === service.handoffRequestPath('r1', root), '请求路径按 root 拼（可注入）')
    ok(store.resultPath('r1') === service.handoffResultPath('r1', root), '结果路径按 root 拼')

    ok((await store.readRequest('r1')) === null, '没有请求文件 → null（不是报错）')
    ok((await store.writeRequest('r1', request)) === true, '写请求成功')
    const back = await store.readRequest('r1')
    ok(!!back && back.handoffId === 'h-1' && back.prompt === '写一份交接包', '读回的请求与写入一致')
    ok((await store.writeRequest('', request)) === false, '键不可用 → 返回 false（调用方据此放弃）')

    ok((await store.readResult('r1')) === null, '没有结果文件 → null')
    ok((await store.writeResult('r1', result)) === true, '写结果成功')
    ok((await store.readResult('r1'))?.operationId === 'op-1', '读回的结果对得上 operationId')

    const badPath = store.resultPath('r2')
    await mkdir(dirname(badPath), { recursive: true })
    await writeFile(badPath, '{"handoffId":"h-2",', 'utf8')
    ok((await store.readResult('r2')) === null, '坏 JSON → 当没有（不让一次坏写打断整条链）')

    await store.clearRequest('r1')
    await store.clearResult('r1')
    ok((await store.readRequest('r1')) === null && (await store.readResult('r1')) === null, '清掉之后两侧都读不到')

    const other = new service.HandoffRequestStore({ root })
    await store.writeRequest('r3', request)
    ok((await other.readRequest('r3'))?.handoffId === 'h-1', '无内存态：换一个实例照样读得到（写方是另一个进程）')

    const handoffs = new service.HandoffStore({ root })
    await handoffs.load()
    await store.writeRequest('r4', request)
    const got = await store.readRequest('r4')
    ok(!!got, '链路第 1 步：宿主写下请求')
    await store.writeResult(
      'r4',
      service.buildHandoffResult({
        handoffId: got.handoffId,
        operationId: got.operationId,
        text: '```json\n{"goal":"把导入做快","deliverable":"一个可用的导入","done":["跑通了基准"],"nextActions":"加上批量","acceptance":"10 万行 < 5s"}\n```',
        ms: 800
      })
    )
    const produced = await store.readResult('r4')
    const parsed = shared.parseHandoffOutput(produced.text)
    ok(parsed.ok, '链路第 2 步：模型原文能解析（含围栏）')
    const pkg = shared.sanitizeHandoffPackage(parsed.value, {
      sourceSession: got.sessionKey,
      sourceHead: got.sourceHead,
      mode: got.mode,
      model: got.model
    })
    ok(!!pkg && pkg.goal === '把导入做快' && pkg.deliverable === '一个可用的导入', '链路第 3 步：清洗出完整交接包')
    ok(pkg.done.length === 1 && pkg.acceptance.length === 1, '列表字段宽容读法：裸字符串也收（单元素）')
    ok(pkg.sourceSession === 'C:/sessions/a.jsonl' && pkg.mode === 'autonomous', '来源字段来自宿主，不来自模型')
    ok(pkg.generator === 'model' && pkg.sourceHead === 'msg-9', 'generator 与水位都记对')
    await handoffs.setPackage(got.sessionKey, pkg)
    const onDisk = JSON.parse(await readFile(service.handoffDocumentPath(root), 'utf8'))
    const saved = Object.values(onDisk.entries)[0]
    ok(saved?.package?.goal === '把导入做快', '链路第 4 步：交接包真的落盘（重启后能读）')

    const reopened = new service.HandoffStore({ root })
    await reopened.load()
    ok(reopened.state(got.sessionKey).package?.deliverable === '一个可用的导入', '重启后交接包还在')

    ok(shared.sanitizeHandoffPackage({ goal: '只有目标' }, { sourceSession: 's', sourceHead: null, mode: 'm', model: null }) === null, '缺交付物 → 作废')
    ok(
      shared.sanitizeHandoffPackage({ goal: '  ', deliverable: 'x' }, { sourceSession: 's', sourceHead: null, mode: 'm', model: null }) === null,
      '空白目标 → 作废'
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
