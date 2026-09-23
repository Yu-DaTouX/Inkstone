/**
 * 三类整理动作账本（实施-11 C-2b）的测试。
 *
 * 分两层：
 *   ① `shared/context-actions.ts` —— 解析容错与**分开**累计（这是本片的核心诉求）；
 *   ② `main/context-actions.ts` —— 真文件读写 + 路径穿越判据（读不到返回空统计）。
 *
 * 真实链路（扩展写账本 → 宿主读 → 界面分行）由 `test:live -- contextactions` 覆盖。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runContextActionTests(ok) {
  const shared = await import('../out/test/context-actions.mjs')
  const host = await import('../out/test/context-actions-host.mjs')
  const view = await import('../out/test/context-actions-view.mjs')

  /* ------------------------------------------------ 解析：坏行不毁整份统计 */

  const lines = [
    JSON.stringify({ at: 100, kind: 'tool-sweep', status: 'applied', reclaimed: 3, savedTokens: 1200 }),
    '{ 半截 json',
    '',
    JSON.stringify({ at: 200, kind: 'episode-fold', status: 'injected', freshness: 'fresh', tokens: 400 }),
    JSON.stringify({ at: 300, kind: 'unknown-kind', status: 'applied' }),
    JSON.stringify({ at: 400, kind: 'tool-sweep', status: 'skipped', reason: 'below-min-reclaim' })
  ].join('\n')
  const parsed = shared.parseActionLines(lines)
  ok(parsed.length === 3, '坏行与不认识的 kind 被丢掉，而不是让整份统计失效')
  ok(parsed[0].kind === 'tool-sweep' && parsed[0].reclaimed === 3, '认得出的动作字段完整保留')
  ok(parsed[1].freshness === 'fresh', 'episode-fold 的档位被读出来')
  ok(parsed[2].reason === 'below-min-reclaim', '跳过原因被读出来')

  const many = Array.from({ length: 10 }, (_, i) =>
    JSON.stringify({ at: i + 1, kind: 'tool-sweep', status: 'applied', reclaimed: 1 })
  ).join('\n')
  const limited = shared.parseActionLines(many, 3)
  ok(limited.length === 3, '超过上限只留最后几条（账本不是无限历史）')
  ok(limited[2].at === 10, '留下的是**最后**几条，不是头几条')

  /* ------------------------------------------------ 累计：三类必须分开 */

  const summary = shared.summarizeActions(
    shared.parseActionLines(lines)
  )
  ok(summary.kinds.length === 2, '账本只统计扩展能记的两类（压缩走 pi 事件，不重抄一份）')
  const sweep = summary.kinds.find((item) => item.kind === 'tool-sweep')
  const fold = summary.kinds.find((item) => item.kind === 'episode-fold')
  ok(sweep.count === 2, '清扫的次数单独累计')
  ok(fold.count === 1, '状态刷新的次数单独累计')
  ok(summary.total === 3, '总数等于两类之和（没有把压缩算进来）')
  ok(sweep.applied === 1 && sweep.skipped === 1, 'applied 与 skipped 分开计数')
  ok(sweep.reclaimed === 3 && sweep.savedTokens === 1200, '回收条数与省下的估算 token 累计')
  ok(sweep.lastReason === 'below-min-reclaim', '最近一次的原因用**最新那条带原因的**记录')
  const laterNoReason = shared.summarizeActions(
    shared.parseActionLines(
      [
        JSON.stringify({ at: 1, kind: 'tool-sweep', status: 'skipped', reason: 'no-candidates' }),
        JSON.stringify({ at: 2, kind: 'tool-sweep', status: 'applied', reclaimed: 2 })
      ].join('\n')
    )
  ).kinds.find((item) => item.kind === 'tool-sweep')
  ok(
    laterNoReason.lastReason === 'no-candidates',
    '最近一条是“做了”时，仍能说清上一次为什么没做（不显示“未记原因”）'
  )
  ok(laterNoReason.lastStatus === 'applied', '但“最近状态”仍然是最近那条（两个问题分开回答）')
  ok(fold.applied === 1, 'injected 也算作“真的做了”')
  ok(summary.lastAt === 400, '最近时间取所有记录的最大值')
  ok(shared.summarizeActions([]).kinds.every((item) => item.count === 0), '空账本不报错')

  /* ------------------------------------------------ 宿主读数：文件 + 判据 */

  const dir = mkdtempSync(join(tmpdir(), 'yan-ctx-actions-'))
  try {
    mkdirSync(join(dir, 'context-actions'), { recursive: true })
    writeFileSync(join(dir, 'context-actions', 'sess-1.jsonl'), lines + '\n', 'utf8')
    const read = await host.readContextActions('sess-1', { dataDir: dir })
    ok(read.total === 3, '宿主读到账本并按同一套规则聚合')
    ok(
      read.kinds.find((item) => item.kind === 'tool-sweep').count === 2,
      '宿主侧聚合同样把两类分开'
    )

    const missing = await host.readContextActions('sess-none', { dataDir: dir })
    ok(missing.total === 0, '没有账本 → 空统计（不是错误）')
    const bad = await host.readContextActions('../escape', { dataDir: dir })
    ok(bad.total === 0, '非法 sessionId 直接拒绝，不拼路径')
    const empty = await host.readContextActions(undefined, { dataDir: dir })
    ok(empty.total === 0, '没有活动会话时返回空统计')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  /* ------------------------------------------------ 界面三行：必须分开、不编造 */

  /* 只用 key 与变量的假 t：文案本身由 i18n 文件管，这里只钉结构 */
  const t = (key, vars) =>
    vars ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')})` : key

  const rows = view.contextActionRows(t, summary, null)
  ok(rows.length === 3, '三类整理在界面上占三行（不合并成一句）')
  ok(
    rows[0].kind === 'tool-sweep' && rows[1].kind === 'episode-fold' && rows[2].kind === 'compaction',
    '行的顺序固定：清扫 / 状态刷新 / 整轮压缩'
  )
  ok(rows[0].fromLedger === true && rows[2].fromLedger === false, '两类来自账本、压缩来自 pi 事件，来源标在行上')
  ok(rows[0].countText.includes('n=2'), '清扫次数来自账本（不是从压缩次数推的）')
  ok(rows[0].detail.includes('n=3'), '回收条数出现在细节里')
  ok(rows[0].detail.includes('tokens=1.2k'), '估算省下的 token 用粗粒度显示（不假装精确）')
  ok(rows[1].countText.includes('n=1'), '状态刷新单独计数')
  ok(rows[2].countText === null, '没有 pi 压缩记录时压缩行不编造次数')

  const blank = view.contextActionRows(t, null, null)
  ok(
    blank.every((row) => row.countText === null),
    '账本为空时三行都没有次数（界面写“未发生”，不是空白）'
  )
  ok(blank.length === 3, '未发生时三行仍然都在 —— 否则看不出“哪一类没跑”')
}
