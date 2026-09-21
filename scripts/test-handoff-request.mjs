/**
 * 交接包**生成链路**的契约与文件交换（实施-05 S5b-2）。
 *
 * 这一片把「谁写什么」钉死：
 *   · 宿主写**请求**（提示词已渲染好、两个 id、来源字段）；
 *   · 薄层写**结果**（模型原文 + 失败原因）；
 *   · 宿主读结果 → 解析 → 清洗 → 落盘。
 *
 * 判错的代价都很大：请求写错位置 = 薄层永远看不见（而界面看起来一切正常）；
 * 清洗放宽 = 半份包进事务（新会话接手时缺交付物）；文件不清 = 下一次交接拿到上次的遗物。
 *
 * 用法：npm run test:unit
 */
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

export async function runHandoffRequestTests(ok, shared, service, goalResume) {
  console.log('\n--- 实施-05 S5b-2 交接包生成（请求 / 结果 / 解析） ---')

  /* --------------------------------------------------- 文件名清洗（两侧交叉校验） */

  const keys = ['r1', 'r-1_2.3', 'a b/c\\d', 'x'.repeat(200), '', '中文会话']
  for (const key of keys) {
    const mine = shared.handoffFileKey(key)
    /*
     * 薄层用 `YAN_SESSION_ID`、宿主用 runnerId，两边必须落到**同一个文件名**。
     * 这里直接拿扩展里的 `safeKey()` 对拍（它不是可选项：不一致就是「请求写了没人看见」）。
     */
    const theirs = String(key ?? '')
      .trim()
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(0, 120)
    ok(mine === theirs, `文件名清洗两侧一致（${JSON.stringify(key).slice(0, 20)} → ${JSON.stringify(mine)}）`)
  }
  ok(typeof goalResume?.safeKey === 'function', '薄层 `safeKey()` 可导入（否则交叉校验是假的）')
  if (typeof goalResume?.safeKey === 'function') {
    /* 薄层的 safeKey 读的是它自己的环境变量，所以对拍时把那个变量设成同一个 runnerId */
    const before = process.env.YAN_SESSION_ID
    process.env.YAN_SESSION_ID = 'r-1_2.3'
    try {
      ok(
        shared.handoffFileKey('r-1_2.3') === goalResume.safeKey(),
        '真·交叉校验：宿主与 goal-resume.js 的清洗实现一致'
      )
      process.env.YAN_SESSION_ID = 'a b/c\\d'
      ok(shared.handoffFileKey('a b/c\\d') === goalResume.safeKey(), '真·交叉校验：含分隔符 / 空格的键也一致')
    } finally {
      if (before === undefined) delete process.env.YAN_SESSION_ID
      else process.env.YAN_SESSION_ID = before
    }
  }

  /* --------------------------------------------------- 重载后的目标续接唤醒 */

  {
    const rootResume = await mkdtemp(join(tmpdir(), 'yan-goal-resume-start-'))
    const oldDataDir = process.env.YAN_DATA_DIR
    const oldSessionId = process.env.YAN_SESSION_ID
    const originalSetTimeout = globalThis.setTimeout
    const timers = []
    try {
      process.env.YAN_DATA_DIR = rootResume
      process.env.YAN_SESSION_ID = 'resume-runner'
      await mkdir(join(rootResume, 'goal-resume'), { recursive: true })
      await writeFile(
        join(rootResume, 'goal-resume', 'resume-runner.json'),
        JSON.stringify({ operationId: 'acq-continue-1', summary: '继续原目标', kind: 'continue' }),
        'utf8'
      )
      globalThis.setTimeout = (callback) => {
        const timer = { callback, unref() {} }
        timers.push(timer)
        return timer
      }
      const handlers = {}
      const sent = []
      const pi = {
        on(name, handler) { handlers[name] = handler },
        appendEntry() {},
        async sendMessage(message, options) { sent.push({ message, options }) }
      }
      goalResume.default(pi)
      ok(typeof handlers.session_start === 'function', 'goal resume 注册 session_start（runner 重载入口）')
      handlers.session_start({ reason: 'reload' })
      ok(timers.length === 1, 'session_start 延迟执行一次安全空闲检查')
      timers[0].callback()
      await Promise.resolve()
      await Promise.resolve()
      ok(
        sent.length === 1 && sent[0].message.customType === 'yan-goal-continue' && sent[0].options.triggerTurn === true,
        '重载后消费同一条 continue 快照并触发原目标续接'
      )
      const consumed = JSON.parse(await readFile(join(rootResume, 'goal-resume', 'resume-runner.consumed.json'), 'utf8'))
      ok(consumed.operationId === 'acq-continue-1', '重载唤醒先写 continueId 消费证据')
    } finally {
      globalThis.setTimeout = originalSetTimeout
      if (oldDataDir === undefined) delete process.env.YAN_DATA_DIR
      else process.env.YAN_DATA_DIR = oldDataDir
      if (oldSessionId === undefined) delete process.env.YAN_SESSION_ID
      else process.env.YAN_SESSION_ID = oldSessionId
      await rm(rootResume, { recursive: true, force: true })
    }
  }

  ok(shared.handoffFileKey('中文会话') === '____', '非 ASCII 一律替换（不允许路径分隔符逃逸）')
  ok(shared.handoffFileKey(123) === '', '非字符串 → 空（调用方据此放弃，不写坏文件）')

  /* --------------------------------------------------- 请求契约 */

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
  ok(request.sourceHead === 'msg-9' && request.mode === 'autonomous', '来源字段由宿主填进请求')

  const clean = shared.sanitizeHandoffRequest(request)
  ok(!!clean && clean.prompt === '写一份交接包' && clean.createdAt === 1000, '请求可被清洗读回（形状稳定）')
  ok(shared.sanitizeHandoffRequest({ ...request, prompt: '' }) === null, '缺提示词 → 整份作废（不猜）')
  ok(shared.sanitizeHandoffRequest({ ...request, handoffId: '  ' }) === null, '缺交接 id → 作废')
  ok(shared.sanitizeHandoffRequest({ ...request, operationId: '' }) === null, '缺生成 id → 作废')
  ok(shared.sanitizeHandoffRequest(null) === null, '非对象 → 作废')
  ok(shared.sanitizeHandoffRequest({ ...request, maxTokens: 99 }).maxTokens === 99, '输出上限可覆盖')
  ok(shared.sanitizeHandoffRequest({ ...request, maxTokens: 99999 }).maxTokens === 8000, '输出上限封顶（防手滑）')
  ok(shared.sanitizeHandoffRequest({ ...request, maxTokens: NaN }).maxTokens === shared.HANDOFF_PACKAGE_MAX_TOKENS, '非法上限 → 默认值')
  ok(shared.sanitizeHandoffRequest({ ...request, systemPrompt: '' }).systemPrompt === shared.HANDOFF_SYSTEM_PROMPT, '空 system → 默认文本')
  ok(shared.sanitizeHandoffRequest({ ...request, mode: '' }).mode === 'unknown', '空模式 → unknown（不编造）')

  /* --------------------------------------------------- 结果契约 */

  const result = service.buildHandoffResult({ handoffId: 'h-1', operationId: 'op-1', text: '{}', ms: 1200, now: 2000 })
  ok(result.ms === 1200 && result.at === 2000, '结果带耗时与时间戳')
  ok(shared.sanitizeHandoffResult(result)?.text === '{}', '结果可被清洗读回')
  ok(shared.sanitizeHandoffResult({ ...result, handoffId: '' }) === null, '缺交接 id 的结果 → 作废')
  const empty = shared.sanitizeHandoffResult(service.buildHandoffResult({ handoffId: 'h-1', operationId: 'op-1' }))
  ok(!!empty && empty.text === '' && empty.error === null, '「跑了但什么都没回」也是合法结果（宿主据此区分「没跑」）')

  /* --------------------------------------------------- 模型输出解析 */

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

  /* --------------------------------------------------- 阈值覆盖与资格 */

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

  /* --------------------------------------------------- 文件交换（真目录） */

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

    /* 半截文件（进程被杀时会留下）：一律当「没有」，不许抛 */
    const badPath = store.resultPath('r2')
    await mkdir(dirname(badPath), { recursive: true })
    await writeFile(badPath, '{"handoffId":"h-2",', 'utf8')
    ok((await store.readResult('r2')) === null, '坏 JSON → 当没有（不让一次坏写打断整条链）')

    /* 清理：宿主消费后必须把两边都删掉，否则下一次交接会拿到遗物 */
    await store.clearRequest('r1')
    await store.clearResult('r1')
    ok((await store.readRequest('r1')) === null && (await store.readResult('r1')) === null, '清掉之后两侧都读不到')

    /* 无内存态：另一个实例（模拟另一个进程）立刻能看到 */
    const other = new service.HandoffRequestStore({ root })
    await store.writeRequest('r3', request)
    ok((await other.readRequest('r3'))?.handoffId === 'h-1', '无内存态：换一个实例照样读得到（写方是另一个进程）')

    /* --------------------------------------------------- 全链路（无模型）：请求 → 结果 → 解析 → 清洗 → 落盘 */

    const handoffs = new service.HandoffStore({ root })
    await handoffs.load()
    await store.writeRequest('r4', request)
    const got = await store.readRequest('r4')
    ok(!!got, '链路第 1 步：宿主写下请求')
    /* 模拟薄层：拿到请求后回一份模型输出 */
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

    /* 重启读回：来源字段要能从盘上恢复（缺来源的包一律当没有） */
    const reopened = new service.HandoffStore({ root })
    await reopened.load()
    ok(reopened.state(got.sessionKey).package?.deliverable === '一个可用的导入', '重启后交接包还在')

    /* 缺必填栏 → 整份作废（半份包不许进事务） */
    ok(shared.sanitizeHandoffPackage({ goal: '只有目标' }, { sourceSession: 's', sourceHead: null, mode: 'm', model: null }) === null, '缺交付物 → 作废')
    ok(
      shared.sanitizeHandoffPackage({ goal: '  ', deliverable: 'x' }, { sourceSession: 's', sourceHead: null, mode: 'm', model: null }) === null,
      '空白目标 → 作废'
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
