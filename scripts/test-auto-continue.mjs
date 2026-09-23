/**
 * 模型出错后的自动继续（实施-05 S5c）—— 分类 / 计划 / 幂等 / 存储。
 *
 * 这一片全是「判定」：什么错误该重试、隔多久、什么时候必须停手。
 * 判错的两个方向都很贵 ——
 *   · 该停时不停：上游一直挂，没人看着，额度被烧光；
 *   · 不该停时停：明明只是网络抖一下，用户回来发现还是那句「模型返回错误」。
 *
 * 用法：npm run test:unit
 */
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runAutoContinueTests(ok) {
  const shared = await import('../out/test/auto-continue.mjs')
  const service = await import('../out/test/auto-continue-service.mjs')

  console.log('\n--- 实施-05 S5c 模型出错后的自动继续 ---')

  /* --------------------------------------------------- 错误分类 */

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
    ['Internal Server Error (500)', 'retryable'],
    ['socket hang up', 'retryable'],
    ['fetch failed', 'retryable'],
    ['', 'retryable']
  ]
  for (const [text, kind] of cases) {
    const info = shared.classifyModelError(text)
    ok(info.kind === kind, `分类「${text.slice(0, 34) || '(空)'}」→ ${kind}（实际 ${info.kind}）`)
  }
  ok(shared.classifyModelError(null).kind === 'retryable', '非字符串也当可重试（有上限兜着）')
  ok(/429/.test(shared.classifyModelError('429 Too Many Requests').text), '保留原始错误文本（排障要看）')
  ok(shared.classifyModelError('429 too many requests').kind === 'quota', '大小写不敏感')

  /* --------------------------------------------------- 自动继续计划 */

  const errRetryable = shared.classifyModelError('Internal Server Error')
  const errQuota = shared.classifyModelError('429 Too Many Requests')
  const state = (attempts) => ({ attempts, lastError: null, lastAt: 0 })
  const plan = (patch = {}) =>
    shared.planAutoContinue({ state: state(0), error: errRetryable, ...patch })

  ok(shared.AUTO_CONTINUE_LIMIT === 5, '默认上限 5 次（供应商抽风时多给几次机会）')
  ok(shared.AUTO_CONTINUE_DELAYS_MS[0] === 10_000, '第一次退避 10 秒')
  ok(
    shared.AUTO_CONTINUE_DELAYS_MS.length === shared.AUTO_CONTINUE_LIMIT,
    '退避表与上限一一对应（每次尝试都有确定的等待）'
  )
  ok(
    shared.AUTO_CONTINUE_DELAYS_MS.every((ms, i, all) => i === 0 || ms > all[i - 1]),
    '退避单调递增（越往后等得越久）'
  )

  const p1 = plan()
  ok(
    p1.action === 'retry' && p1.attempt === 1 && p1.delayMs === shared.AUTO_CONTINUE_DELAYS_MS[0],
    '第一次：retry(1) / 10 秒'
  )
  ok(/第 1\/5 次/.test(p1.note) && /10 秒后自动继续/.test(p1.note), `提示写清第几次与多久（${p1.note}）`)
  const p2 = plan({ state: state(1) })
  ok(
    p2.action === 'retry' && p2.attempt === 2 && p2.delayMs === shared.AUTO_CONTINUE_DELAYS_MS[1],
    '第二次：retry(2) / 30 秒'
  )
  const p5 = plan({ state: state(4) })
  ok(
    p5.action === 'retry' && p5.attempt === 5 && p5.delayMs === shared.AUTO_CONTINUE_DELAYS_MS[4],
    '第五次用最后一段退避（4 分钟）'
  )
  const pOver = plan({ state: state(5) })
  ok(pOver.action === 'stop' && pOver.reason === 'limit', '到上限 → 停（不再自动继续）')
  ok(/连续 5 次/.test(pOver.note), `到上限的提示要说清连续几次（${pOver.note}）`)

  for (const [text, why] of [
    ['429 Too Many Requests', 'quota'],
    ['401 Unauthorized', 'auth'],
    ['maximum context length', 'context'],
    ['Request aborted', 'aborted']
  ]) {
    const stop = shared.planAutoContinue({ state: state(0), error: shared.classifyModelError(text) })
    ok(stop.action === 'stop' && stop.reason === 'not-retryable', `${why} 类错误不重试`)
    ok(/没有意义/.test(stop.note), `${why} 的提示说明「重试没有意义」`)
  }

  const stopped = plan({ userStopped: true })
  ok(stopped.action === 'stop' && stopped.reason === 'user-stopped', '用户停止优先于一切（即使还没试过）')

  const custom = shared.planAutoContinue({
    state: state(0),
    error: errRetryable,
    limit: 1,
    delays: [10]
  })
  ok(custom.action === 'retry' && custom.delayMs === 10, '上限 / 退避可覆盖（测试通道）')
  ok(
    shared.planAutoContinue({ state: state(1), error: errRetryable, limit: 1 }).reason === 'limit',
    '覆盖后的上限同样生效'
  )
  ok(shared.planAutoContinue({ state: state(0), error: errQuota }).reason === 'not-retryable', '额度类不因覆盖而重试')

  /* --------------------------------------------------- 续行正文 */

  const body = shared.retryResumeSummary({ error: errRetryable, attempt: 2, limit: 3 })
  ok(/第 2\/3 次/.test(body), '正文写明第几次自动继续')
  ok(/不是用户说的话/.test(body), '正文声明「不是用户说的话」（不许伪造用户消息）')
  ok(/先检查再动手/.test(body), '正文提醒先检查再动手（防重复副作用）')
  ok(/不要问用户/.test(body), '正文要求不要回头问用户')

  /* --------------------------------------------------- 重复上报去重 */

  const dupState = { attempts: 1, lastError: 'boom', lastAt: 1000 }
  ok(shared.isDuplicateError(dupState, 'boom', 1500) === true, '同一错误 2 秒内 → 判重复（auto_retry_end 与 stopReason 会同时报）')
  ok(shared.isDuplicateError(dupState, 'boom', 5000) === false, '超过窗口 → 不算重复')
  ok(shared.isDuplicateError(dupState, 'other', 1500) === false, '不同错误 → 不算重复')
  ok(shared.isDuplicateError({ attempts: 0, lastError: null, lastAt: 0 }, 'boom', 10) === false, '没记录过 → 不算重复')

  /* --------------------------------------------------- env 覆盖解析 */

  ok(shared.sanitizeAutoContinueOptions({ limit: 2, delays: [100, 200] }).limit === 2, 'env 覆盖 limit')
  ok(shared.sanitizeAutoContinueOptions({ delays: [100] }).delays.join(',') === '100', 'env 覆盖 delays')
  ok(shared.sanitizeAutoContinueOptions({ limit: -1 }).limit === undefined, '负上限被忽略')
  ok(shared.sanitizeAutoContinueOptions({ limit: 'x' }).limit === undefined, '非数字上限被忽略')
  ok(shared.sanitizeAutoContinueOptions({ delays: [] }).delays === undefined, '空数组被忽略')
  ok(shared.sanitizeAutoContinueOptions({ delays: [1, -5, 'x'] }).delays.join(',') === '1', 'delays 只留合法数字')
  ok(shared.sanitizeAutoContinueOptions({ limit: 999 }).limit === 20, '上限封顶（防手滑写 999）')
  ok(Object.keys(shared.sanitizeAutoContinueOptions(null)).length === 0, '非对象 → 空')

  /* --------------------------------------------------- 存储层 */

  const root = await mkdtemp(join(tmpdir(), 'yan-autocontinue-'))
  try {
    let clock = 10_000
    const store = new service.AutoContinueStore({ root, now: () => clock })
    await store.load()
    const key = 'C:/tmp/sessions/a.jsonl'
    const other = 'C:/tmp/sessions/b.jsonl'

    const first = await store.noteFailure(key, 'Internal Server Error')
    ok(first.plan?.action === 'retry' && first.plan.attempt === 1, '第一次失败 → 安排第 1 次续')
    ok(store.state(key).attempts === 1, '计数落成 1')

    const same = await store.noteFailure(key, 'Internal Server Error')
    ok(same.duplicate === true && same.plan === null, '同一错误立刻再报 → 判重复、不给计划')
    ok(store.state(key).attempts === 1, '重复上报不推进计数')

    clock += 5_000
    for (let i = 2; i <= 5; i++) {
      const next = await store.noteFailure(key, 'Internal Server Error')
      ok(next.plan?.action === 'retry' && next.plan.attempt === i, i === 2 ? '过了窗口的同一错误 → 第 2 次续' : `第 ${i} 次续`)
      ok(store.state(key).attempts === i, `计数落成 ${i}`)
      clock += 5_000
    }
    const over = await store.noteFailure(key, 'Internal Server Error')
    ok(over.plan?.action === 'stop' && over.plan.reason === 'limit', '第 6 次 → 停（到上限）')
    ok(store.state(key).attempts === 5, '到上限后计数保持（不会自己归零再试）')

    /* 文件真的落盘 + 重启不忘记 */
    const file = join(root, service.AUTO_CONTINUE_FILE_NAME)
    const onDisk = JSON.parse(await readFile(file, 'utf8'))
    ok(Object.values(onDisk.entries)[0]?.attempts === 5, '计数真的落盘')
    const reopened = new service.AutoContinueStore({ root })
    await reopened.load()
    ok(reopened.state(key).attempts === 5, '重启后计数还在（重启不重新给满额度）')

    /* 用户发言 / 用户停止 → 归零 */
    await store.reset(key)
    ok(store.state(key).attempts === 0, '归零（用户接手了）')

    /* 不该重试的错误：不计数（额度恢复后不该被上次的失败挡着） */
    clock += 10_000
    const quota = await store.noteFailure(key, '429 Too Many Requests')
    ok(quota.plan?.action === 'stop' && quota.plan.reason === 'not-retryable', '额度类 → 不重试')
    ok(store.state(key).attempts === 0, '不该重试的错误不占计数')

    /* 用户已停止 */
    clock += 10_000
    const userStop = await store.noteFailure(key, 'Internal Server Error', { userStopped: true })
    ok(userStop.plan?.action === 'stop' && userStop.plan.reason === 'user-stopped', '用户停止 → 不重试')

    /* 多会话隔离 */
    clock += 10_000
    await store.noteFailure(other, 'socket hang up')
    ok(store.state(other).attempts === 1 && store.state(key).attempts === 0, 'A/B 计数互不影响')

    /* 覆盖上限（env 通道） */
    const smallRoot = await mkdtemp(join(tmpdir(), 'yan-autocontinue-small-'))
    try {
      /*
       * 时钟要往前走：同一条错误落在 2 秒窗口内会被判「重复上报」（那是另一条断言），
       * 这里要验的是「上限覆盖成 1 次」——两个时钟值就够了。
       */
      let smallClock = 1_000
      const small = new service.AutoContinueStore({
        root: smallRoot,
        now: () => (smallClock += 5_000),
        limit: 1,
        delays: [10]
      })
      await small.load()
      const a = await small.noteFailure(key, 'boom')
      const b = await small.noteFailure(key, 'boom')
      ok(a.plan?.action === 'retry' && a.plan.delayMs === 10, '覆盖后的上限/退避生效')
      ok(b.plan?.action === 'stop' && b.plan.reason === 'limit', '覆盖成 1 次后第二次就停')
    } finally {
      await rm(smallRoot, { recursive: true, force: true })
    }

    /* 脏 JSON / 旧文件 */
    await writeFile(file, '{ 坏 JSON', 'utf8')
    const bad = new service.AutoContinueStore({ root })
    await bad.load()
    ok(bad.state(key).attempts === 0, '坏 JSON → 空（宁可多试一次，也不要永远不重试）')

    await writeFile(file, JSON.stringify({ version: 1, entries: { [key]: { attempts: 'x', lastError: 7 } } }), 'utf8')
    const old = new service.AutoContinueStore({ root })
    await old.load()
    ok(old.state(key).attempts === 0 && old.state(key).lastError === null, '脏字段降级成「没失败过」')

    /* 落盘失败必须抛 */
    const badRoot = await mkdtemp(join(tmpdir(), 'yan-autocontinue-bad-'))
    try {
      const failing = new service.AutoContinueStore({ root: badRoot })
      await failing.load()
      await mkdir(service.autoContinueDocumentPath(badRoot), { recursive: true })
      let threw = false
      try {
        await failing.noteFailure(key, 'boom')
      } catch {
        threw = true
      }
      ok(threw, '落盘失败时抛错（不假装记住了）')
    } finally {
      await rm(badRoot, { recursive: true, force: true })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
