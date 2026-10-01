/** Historical usage parsing and current host title accounting. */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runContextBackgroundUsageTests(ok) {
  const shared = await import('../out/test/context-background-usage.mjs')
  const host = await import('../out/test/context-background-usage-host.mjs')

  /* ------------------------------------------------ 解析：坏行不毁整份统计 */

  const lines = [
    JSON.stringify({ at: 100, kind: 'summary', ok: true, input: 1000, output: 200, cacheRead: 9000, cacheWrite: 0, totalTokens: 10200, cost: 0.12 }),
    '{ 半截 json',
    '',
    JSON.stringify({ at: 200, kind: 'title', ok: true, input: 50, output: 8, totalTokens: 58 }),
    JSON.stringify({ at: 300, kind: 'not-a-kind', ok: true }),
    JSON.stringify({ at: 400, kind: 'handoff', ok: false, error: 'provider_error_stop' })
  ].join('\n')
  const parsed = shared.parseBackgroundUsageLines(lines)
  ok(parsed.length === 3, '坏行与不认识的 kind 被丢掉，而不是让整份统计失效')
  ok(parsed[0].cacheRead === 9000 && parsed[0].cost === 0.12, '认得出的用量字段完整保留')
  ok(parsed[1].kind === 'title' && parsed[1].usageReported === true, '没写 usageReported 的老行按“报过”处理')
  ok(parsed[2].ok === false && parsed[2].error === 'provider_error_stop', '失败与失败原因被读出来')

  const many = Array.from({ length: 10 }, (_, i) =>
    JSON.stringify({ at: i + 1, kind: 'deep', ok: true, input: 1 })
  ).join('\n')
  const limited = shared.parseBackgroundUsageLines(many, 3)
  ok(limited.length === 3, '超过上限只留最后几条（账本不是无限历史）')
  ok(limited[2].at === 10, '留下的是**最后**几条，不是头几条')

  /* ------------------------------------------------ 累计：每类分开、命中率口径 */

  const summary = shared.summarizeBackgroundUsage(parsed)
  ok(summary.kinds.length === 5, '五类（摘要 / 深度 / 状态 / 交接 / 标题）都占一行，缺的显示 0')
  const summaryKind = summary.kinds.find((item) => item.kind === 'summary')
  ok(summaryKind.calls === 1 && summaryKind.input === 1000, '整理摘要单独累计')
  ok(summary.calls === 3 && summary.failed === 1, '总数含失败，失败单独计数')
  ok(summary.input === 1050 && summary.cacheRead === 9000, '未缓存输入与缓存读取分别累计')
  ok(
    Math.abs(summary.cacheHitRate - (9000 / 10050) * 100) < 1e-9,
    '命中率分母是 未缓存输入 + 缓存读取（与 turns.ts 同一口径）'
  )
  ok(shared.emptyBackgroundUsage().cacheHitRate === null, '没有读数时命中率是 null，不是 0%')

  /* ------------------------------------------------ 缺报用量：不是“没花钱” */

  const missing = shared.summarizeBackgroundUsage(
    shared.parseBackgroundUsageLines(
      [
        JSON.stringify({ at: 1, kind: 'title', ok: false, error: 'title_timeout', usageReported: false }),
        JSON.stringify({ at: 2, kind: 'title', ok: true, input: 0, output: 0, cacheRead: 0, usageReported: true })
      ].join('\n')
    )
  )
  ok(missing.missingUsage === 1, '缺报用量的次数单独记（不能当成 0 花费）')
  ok(missing.calls === 2 && missing.failed === 1, '缺报与失败各自计数')
  ok(
    missing.kinds.find((item) => item.kind === 'title').missingUsage === 1,
    '每类的缺报次数也分开记'
  )

  /* ------------------------------------------------ 跨端格式：扩展写 → 宿主读 */

  const dir = mkdtempSync(join(tmpdir(), 'yan-background-usage-'))
  const previousDataDir = process.env.YAN_DATA_DIR
  process.env.YAN_DATA_DIR = dir
  try {
    // Read independently authored legacy rows after the producer has retired.
    mkdirSync(join(dir, 'context-background-usage'))
    writeFileSync(join(dir, 'context-background-usage', 'session-a.jsonl'), [
      JSON.stringify({ at: 1, kind: 'summary', ok: true, input: 500, output: 100, cacheRead: 4500, cacheWrite: 20, totalTokens: 5120, cost: 0.3, usageReported: true, estimatedInput: 520 }),
      JSON.stringify({ at: 2, kind: 'deep', ok: false, error: 'context_capacity_blocked', usageReported: false })
    ].join('\n') + '\n')

    const read = await host.readContextBackgroundUsage('session-a', { dataDir: dir })
    ok(read.calls === 2, '扩展写的两条都被宿主读回来（两端字段口径一致）')
    ok(read.input === 500 && read.cacheRead === 4500, '供应商口径的用量原样保留')
    ok(
      Math.abs(read.cacheHitRate - (4500 / 5000) * 100) < 1e-9,
      '跨端后的命中率与单价一致'
    )
    ok(read.kinds.find((item) => item.kind === 'deep').failed === 1, '主进程被挡下的后台调用也入账')
    ok(read.missingUsage === 1, '被挡下的那次没有 usage，记成缺报而不是 0')
    ok(read.estimatedInput === 520, '估算输入与真实输入一起留着，供对照')

    /* 宿主自己写（标题生成走这条）—— 与扩展同文件、同格式 */
    host.appendContextBackgroundUsage('session-a', {
      kind: 'title',
      ok: true,
      usage: { input: 40, output: 6, totalTokens: 46 },
      durationMs: 900
    }, { dataDir: dir })
    const afterTitle = await host.readContextBackgroundUsage('session-a', { dataDir: dir })
    ok(afterTitle.calls === 3, '主进程写的标题调用与扩展写的在同一份账本里')
    ok(afterTitle.kinds.find((item) => item.kind === 'title').calls === 1, '标题单独一类')

    /* 读不到 / 非法身份：空统计，不抛错 */
    const missingSession = await host.readContextBackgroundUsage('session-none', { dataDir: dir })
    ok(missingSession.calls === 0 && missingSession.cacheHitRate === null, '没有账本的会话返回空统计')
    const unsafe = await host.readContextBackgroundUsage('..', { dataDir: dir })
    ok(unsafe.calls === 0, '非法 sessionId 直接返回空统计（不拼路径）')
  } finally {
    if (previousDataDir === undefined) delete process.env.YAN_DATA_DIR
    else process.env.YAN_DATA_DIR = previousDataDir
    rmSync(dir, { recursive: true, force: true })
  }

}
