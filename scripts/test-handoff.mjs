/**
 * 交接计数与交接包契约（实施-05 S5a）的纯逻辑 + 存储单测。
 *
 * 分两层：
 *   · `src/shared/handoff.ts` —— 计入规则 / 去重键 / 资格判定 / 交接包清洗；
 *   · `src/main/handoff-service.ts` —— 真文件、真幂等、真「重启不归零」。
 *
 * 为什么存储层要单独测：它的失败模式都在磁盘边上 —— 一次压缩被 `state` 推送
 * 重放成几十次（去重失效）、重启后计数归零（阈值永远达不到）、交接成功后
 * 新片段没从零开始（一次交接后每次压缩都触发交接）。只看返回值一样验不出来。
 *
 * 用法：npm run test:unit
 */
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runHandoffTests(ok) {
  const shared = await import('../out/test/handoff.mjs')
  const service = await import('../out/test/handoff-service.mjs')

  console.log('\n--- 实施-05 S5a 交接计数与资格 ---')

  ok(shared.HANDOFF_AUTO_COMPACT_THRESHOLD === 2, '阈值是 2（§7：成功自动完整压缩累计两次）')
  ok(shared.HANDOFF_TALLY_KEY_LIMIT > 0 && shared.HANDOFF_TALLY_KEY_LIMIT <= 200, '去重键有上限（防无界）')

  /* --------------------------------------------------- 计入规则 */

  const run = (patch = {}) => ({ status: 'completed', reason: 'threshold', startedAt: 100, endedAt: 200, ...patch })
  ok(shared.isCountableCompaction(run()), 'pi 原生自动压缩（threshold）计入')
  ok(shared.isCountableCompaction(run({ reason: 'overflow' })), 'overflow 也计入')
  ok(
    shared.isCountableCompaction(run({ reason: 'manual', triggeredBy: 'policy' })),
    '砚自己发起的工作集压缩计入（pi 报 manual，但 triggeredBy=policy）'
  )
  ok(!shared.isCountableCompaction(run({ reason: 'manual' })), '用户手点的那次不计')
  for (const status of ['failed', 'cancelled', 'declined', 'running']) {
    ok(!shared.isCountableCompaction(run({ status })), `${status} 不计`)
  }
  ok(!shared.isCountableCompaction(null), '没有记录不计')

  ok(shared.compactionKeyOf(run({ entryId: 'e-1' })) === 'entry:e-1', '有摘要条目 id 时用它当去重键')
  ok(
    shared.compactionKeyOf(run()) === 't:100-200:threshold',
    `没有条目 id 时用「起止 + 原因」合成（${shared.compactionKeyOf(run())}）`
  )
  ok(shared.compactionKeyOf({ status: 'completed', reason: 'threshold' }) === null, '连时间都没有 → 没有稳定键')
  ok(shared.compactionKeyOf(null) === null, '空记录没有键')

  /* --------------------------------------------------- 计数（幂等） */

  const tally0 = shared.emptyTally(0)
  ok(tally0.count === 0 && tally0.segmentId === 'initial', '空计数从 0 开始')

  const first = shared.applyCompactionTally(tally0, run(), 1000)
  ok(first.counted === true && first.tally.count === 1, '第一次计入')
  const replay = shared.applyCompactionTally(first.tally, run(), 2000)
  ok(
    replay.counted === false && replay.reason === 'duplicate' && replay.tally.count === 1,
    '同一份记录重放（state 推送会重放）不重复计'
  )
  const manual = shared.applyCompactionTally(first.tally, run({ reason: 'manual' }), 3000)
  ok(manual.counted === false && manual.reason === 'manual-or-unknown' && manual.tally.count === 1, '手动压缩不计')

  const second = shared.applyCompactionTally(first.tally, run({ entryId: 'e-2' }), 4000)
  ok(second.counted === true && second.tally.count === 2, '第二次自动压缩计入（到阈值）')
  const third = shared.applyCompactionTally(second.tally, run({ entryId: 'e-3' }), 5000)
  ok(third.tally.count === 3, '到阈值后继续累加（界面要看到「压了几次」，不封顶）')

  /* 键上限：丢最旧的，计数不丢 */
  let many = shared.emptyTally(0)
  for (let i = 0; i < shared.HANDOFF_TALLY_KEY_LIMIT + 10; i++) {
    many = shared.applyCompactionTally(many, run({ entryId: `e-${i}` }), i).tally
  }
  ok(many.count === shared.HANDOFF_TALLY_KEY_LIMIT + 10, `计数持续累加（${many.count}）`)
  ok(many.keys.length === shared.HANDOFF_TALLY_KEY_LIMIT, `去重键压在上限内（${many.keys.length}）`)
  ok(!many.keys.includes('entry:e-0'), '丢的是最旧的键（新键还在）')

  const reset = shared.resetTallyForNewSegment('seg-2', 9000)
  ok(reset.count === 0 && reset.segmentId === 'seg-2' && reset.keys.length === 0, '新片段从零开始')

  /* --------------------------------------------------- 资格判定 */

  const goal = (patch = {}) => ({ goalId: 'g', phase: 'executing', revision: 3, steps: [], evidence: [], blocker: null, failure: null, updatedAt: 0, ...patch })
  const eligible = (patch = {}) =>
    shared.handoffEligibility({ tally: second.tally, goal: goal(), mode: 'autonomous', busy: false, ...patch })

  ok(eligible().eligible === true, '够数 + 在推进 + 自主档 + 不忙 → 可以交接')
  ok(
    shared.handoffEligibility({ tally: first.tally, goal: goal(), mode: 'autonomous', busy: false }).reason ===
      'below-threshold',
    '没够数 → below-threshold'
  )
  ok(eligible({ goal: goal({ revision: 0 }) }).reason === 'no-goal', '没有报告过目标 → no-goal')
  ok(eligible({ goal: goal({ phase: 'completed' }) }).reason === 'goal-not-active', '目标已完成 → 不交代')
  ok(eligible({ goal: goal({ phase: 'blocked' }) }).reason === 'goal-not-active', '目标阻塞 → 不交接（要先解决阻塞）')
  ok(eligible({ mode: 'standard' }).reason === 'not-autonomous', '标准档 → 不自动交接')
  ok(eligible({ mode: 'clarify' }).reason === 'not-autonomous', '澄清档 → 不自动交接')
  ok(eligible({ busy: true }).reason === 'busy', '有后台工作（子代理 / 长命令）→ 先等，不遗弃')

  /* --------------------------------------------------- 交接包清洗 */

  const source = { sourceSession: 'C:/tmp/s.jsonl', sourceHead: 'e-9', mode: 'autonomous', model: 'm', now: 111 }
  ok(shared.sanitizeHandoffPackage(null, source) === null, '非对象 → 不可用')
  ok(shared.sanitizeHandoffPackage({ deliverable: 'x' }, source) === null, '缺目标 → 不可用')
  ok(shared.sanitizeHandoffPackage({ goal: '  ' , deliverable: 'x' }, source) === null, '空白目标 → 不可用')
  const pkg = shared.sanitizeHandoffPackage(
    {
      goal: '把导出做完',
      deliverable: 'CSV 导出',
      constraints: ['不引入新依赖', '', 42],
      acceptance: '点一下能下载',
      done: ['解析器写完'],
      remaining: ['界面没接'],
      nextActions: ['接界面'],
      blockers: [],
      files: ['src/a.ts'],
      notes: ['长命令还在跑'],
      /* 模型不能自报来源：下面这些必须被覆盖 */
      sourceSession: 'evil',
      mode: 'standard',
      generator: 'user'
    },
    source
  )
  ok(!!pkg && pkg.goal === '把导出做完' && pkg.deliverable === 'CSV 导出', '两栏必填通过')
  ok(pkg?.constraints.length === 1 && pkg.constraints[0] === '不引入新依赖', '列表过滤空值与非字符串')
  ok(pkg?.acceptance.length === 1, '单字符串字段也接受（模型常这么写）')
  ok(pkg?.sourceSession === source.sourceSession && pkg?.mode === 'autonomous', '来源字段由宿主覆盖（模型给的丢掉）')
  ok(pkg?.generator === 'model' && pkg?.generatedAt === 111, '生成者与时间由宿主填')

  const prompt = shared.renderHandoffPrompt({
    goal: goal({ steps: [{ title: '解析器', status: 'done' }, { title: '界面', status: 'pending' }] }),
    cwd: 'C:/work',
    recentUser: ['把导出做完', '别引入依赖']
  })
  ok(/跨会话交接/.test(prompt) && /JSON/.test(prompt), '提示里写明这是交接包且只要 JSON')
  ok(prompt.includes('C:/work') && prompt.includes('解析器') && prompt.includes('别引入依赖'), '提示里带上了 cwd / 步骤 / 最近用户消息')
  ok(/不要复制密钥/.test(prompt), '提示里明确不许复制凭证')

  ok(shared.handoffSummary(null) === '没有交接包', '没有包时摘要可读')
  ok(shared.handoffSummary(pkg).includes('未完成 1 项'), '摘要把未完成计数带出来')

  /* --------------------------------------------------- 存储层 */

  const root = await mkdtemp(join(tmpdir(), 'yan-handoff-'))
  try {
    const store = new service.HandoffStore({ root, now: () => 5000 })
    await store.load()
    const keyA = 'C:/tmp/sessions/a.jsonl'
    const keyB = 'C:/tmp/sessions/b.jsonl'

    const c1 = await store.recordCompaction(keyA, run({ entryId: 'e-1' }))
    ok(c1.counted === true && c1.tally.count === 1, '存储层计入第一次')
    const c1b = await store.recordCompaction(keyA, run({ entryId: 'e-1' }))
    ok(c1b.counted === false && c1b.tally.count === 1, '同一份记录再写一次不增加（幂等真在磁盘语义上）')

    const file = join(root, service.HANDOFF_FILE_NAME)
    const onDisk = JSON.parse(await readFile(file, 'utf8'))
    const keys = Object.keys(onDisk.entries)
    ok(keys.length === 1, '只写了这一个会话')
    ok(onDisk.entries[keys[0]].tally.count === 1 && onDisk.entries[keys[0]].tally.keys.includes('entry:e-1'), '磁盘上有计数与去重键')

    ok(store.state(keyB).tally.count === 0, 'B 会话不受影响')

    /* 重启不归零：换一个 store 实例重新读 */
    const reopened = new service.HandoffStore({ root })
    await reopened.load()
    ok(reopened.state(keyA).tally.count === 1, '重新读盘后计数还在（重启不归零）')

    await store.setPackage(keyA, pkg)
    const withPkg = JSON.parse(await readFile(file, 'utf8'))
    const entryA = Object.values(withPkg.entries)[0]
    ok(entryA?.package?.goal === '把导出做完', '交接包真的落盘了')

    const reopened2 = new service.HandoffStore({ root })
    await reopened2.load()
    ok(reopened2.state(keyA).package?.goal === '把导出做完', '重新读盘后交接包还在')
    ok(reopened2.state(keyA).package?.sourceSession === keyA, '读盘时来源被重新绑到这条记录自己的键')

    const after = await store.startNewSegment(keyA, 'seg-2')
    ok(after.count === 0 && after.segmentId === 'seg-2', '交接成功后新片段从零开始')

    /* 脏 JSON / 旧文件兼容 */
    await writeFile(file, '{ 这不是 JSON', 'utf8')
    const bad = new service.HandoffStore({ root })
    await bad.load()
    ok(bad.state(keyA).tally.count === 0, '坏 JSON → 空文档（不抛）')

    await writeFile(
      file,
      JSON.stringify({ version: 1, entries: { [keyA]: { tally: { count: 7, keys: ['x'] }, updatedAt: 1 } } }),
      'utf8'
    )
    const old = new service.HandoffStore({ root })
    await old.load()
    ok(old.state(keyA).tally.count === 7, '旧文件（没有 package 字段）兼容')
    ok(old.state(keyA).package === null, '旧文件里没有包 → null（不造半份包）')
    ok(old.state(keyA).tally.segmentId === 'initial', '缺 segmentId 时回落 initial')

    /* 落盘失败必须抛（与目标状态同因） */
    const rootBad = await mkdtemp(join(tmpdir(), 'yan-handoff-bad-'))
    try {
      const badStore = new service.HandoffStore({ root: rootBad })
      await badStore.load()
      await mkdir(service.handoffDocumentPath(rootBad), { recursive: true })
      let threw = false
      try {
        await badStore.recordCompaction(keyA, run({ entryId: 'e-x' }))
      } catch {
        threw = true
      }
      ok(threw, '落盘失败时抛错（不报成功）')
      ok(badStore.state(keyA).tally.count === 0, '落盘失败后内存态回退，不留假计数')
    } finally {
      await rm(rootBad, { recursive: true, force: true })
    }

    /*
     * 自动交接开关（实施-05 S6）：用户 2026-09-19 拍板**默认开**。
     * 这一条很容易被“顺手改成默认关”而不被任何东西拦住，所以钉在这里。
     */
    ok(shared.handoffCommitEnabled({}) === true, '未设 YAN_HANDOFF_COMMIT → 默认开（用户拍板）')
    ok(shared.handoffCommitEnabled(undefined) === true, 'env 缺失也默认开')
    ok(shared.handoffCommitEnabled({ YAN_HANDOFF_COMMIT: '1' }) === true, '显式 1 → 开')
    for (const off of ['0', 'false', 'off', 'no', ' OFF ']) {
      ok(shared.handoffCommitEnabled({ YAN_HANDOFF_COMMIT: off }) === false, `显式关闭：${JSON.stringify(off)}`)
    }
    ok(shared.handoffCommitEnabled({ YAN_HANDOFF_COMMIT: 'yes' }) === true, '其它值不关（只有明确的关才算关）')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
