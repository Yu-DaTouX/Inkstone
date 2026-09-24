/**
 * 交接事务状态机与事务日志（实施-05 S5b-3a）。
 *
 * 这一片全是「顺序与恢复」：能不能跳步、重复推进会不会出事、
 * 崩在中间之后该重发还是该放弃。它们没有一个是「跑一次看看」能验的 ——
 * 必须在单测里把每个阶段的每个岔路都走一遍。
 *
 * 用法：npm run test:unit
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runHandoffTransactionTests(ok, tx, service, handoffShared) {
  console.log('\n--- 实施-05 S5b-3a 交接事务（状态机 / 恢复 / 日志） ---')

  const pkg = handoffShared.sanitizeHandoffPackage(
    { goal: '把导入做快', deliverable: '一个可用的导入', nextActions: ['加批量'] },
    { sourceSession: 'C:/s/a.jsonl', sourceHead: 'm-1', mode: 'autonomous', model: 'x', now: 5 }
  )
  ok(!!pkg, '夹具：交接包可构造')

  /* --------------------------------------------------- 阶段顺序 */

  ok(tx.handoffStages().join(',') === 'pending,snapshot,validated,destination-created,committed,resumed', '阶段顺序固定')
  ok(tx.isTerminalStage('resumed') && tx.isTerminalStage('failed'), 'resumed / failed 是终态')
  ok(!tx.isTerminalStage('committed'), 'committed 不是终态（还差消费证据）')

  const base = tx.createTransaction({ handoffId: 'h-1', sourceSession: 'C:/s/a.jsonl', resumeId: 'rs-1', at: 1000 })
  ok(base.stage === 'pending' && base.destinationSession === null && base.package === null, '新事务从 pending 开始')
  ok(base.steps.length === 0 && base.resumeId === 'rs-1', '新事务没有步骤、有 resumeId')

  const can = (t, to) => tx.canAdvance(t, to)
  ok(can(base, 'snapshot').ok, 'pending → snapshot 允许')
  ok(can(base, 'validated').reason === 'skipped', '不许跳步（pending → validated）')
  ok(can(base, 'destination-created').reason === 'skipped', '不许跳步（pending → destination-created）')
  ok(can(base, 'failed').ok, 'pending → failed 允许（放弃）')
  ok(can({ ...base, stage: 'pending' }, 'pending').reason === 'already-there', '同一阶段不算前进')
  ok(can({ ...base, stage: 'snapshot' }, 'pending').reason === 'backwards', '不许倒退')
  ok(can({ ...base, stage: 'resumed' }, 'committed').reason === 'terminal:resumed', '终态不再前进')
  ok(can({ ...base, stage: 'snapshot' }, 'validated').reason === 'no-package', '没有包 → 不能 validated')

  /* --------------------------------------------------- 推进与幂等 */

  const s1 = tx.advance(base, 'snapshot', { at: 1100 })
  ok(s1.advanced && s1.tx.stage === 'snapshot' && s1.tx.steps.length === 1, 'advance 前进一格并留日志')
  ok(s1.tx.steps[0].from === 'pending' && s1.tx.steps[0].to === 'snapshot', '日志记下了从哪到哪')
  const again = tx.advance(s1.tx, 'snapshot', { at: 1200 })
  ok(!again.advanced && again.tx === s1.tx && again.reason === 'already-there', '重复推进同一格 → 幂等（事务不变）')

  const withPkg = tx.attachPackage(s1.tx, pkg, 1300)
  ok(withPkg.ok && withPkg.tx.stage === 'validated' && withPkg.tx.package, 'snapshot + 包 → 自动前进到 validated')
  const locked = tx.attachPackage(withPkg.tx, pkg, 1400)
  ok(!locked.ok && locked.reason === 'package-locked', '包只挂一次（换包要重走校验，这里不做）')

  ok(tx.advance(withPkg.tx, 'destination-created').reason === 'no-destination', '没有目的会话 → 不能 destination-created')
  const attached = tx.attachDestination(withPkg.tx, 'C:/s/b.jsonl', 1500)
  ok(attached.ok && attached.tx.destinationSession === 'C:/s/b.jsonl', '挂上目的会话')
  const same = tx.attachDestination(attached.tx, 'C:/s/b.jsonl', 1600)
  ok(same.ok && same.reason === 'unchanged', '同一个目的会话重复挂 → unchanged')
  const different = tx.attachDestination(attached.tx, 'C:/s/c.jsonl', 1700)
  ok(!different.ok && different.reason === 'destination-locked', '换另一个目的会话 → 拒绝（锁定）')
  ok(tx.attachDestination(withPkg.tx, '  ').reason === 'empty-destination', '空路径 → 拒绝')

  const d1 = tx.advance(attached.tx, 'destination-created', { at: 1800 })
  ok(d1.advanced && d1.tx.stage === 'destination-created', 'destination-created 走通')
  const c1 = tx.advance(d1.tx, 'committed', { at: 1900 })
  ok(c1.advanced && c1.tx.stage === 'committed', 'committed 走通')
  ok(tx.attachDestination(c1.tx, 'C:/s/b.jsonl').reason === 'already-committed', '已提交之后改目的会话 → 拒绝（会把用户指错会话）')
  const r1 = tx.advance(c1.tx, 'resumed', { at: 2000 })
  ok(r1.advanced && r1.tx.stage === 'resumed', 'resumed 走通（只能由磁盘证据驱动，见接线）')
  ok(tx.advance(r1.tx, 'committed').reason === 'terminal:resumed', 'resumed 之后不能再改阶段')

  /* --------------------------------------------------- 崩溃恢复 */

  const rec = (stage, hasEvidence) =>
    tx.recoveryAction({ ...base, stage, destinationSession: 'C:/s/b.jsonl', package: pkg }, { destinationHasResume: hasEvidence })
  ok(rec('resumed', false).action === 'none', 'resumed → 什么都不做')
  ok(rec('failed', false).action === 'none', 'failed → 什么都不做')
  ok(rec('committed', true).action === 'complete', 'committed + 有消费证据 → 补记完成（不重发）')
  ok(rec('committed', false).action === 'resend', 'committed + 没证据 → 允许重发一次（消费去重挡住重复）')
  ok(rec('destination-created', true).action === 'abandon', 'destination-created → 回源（目的会话还是空壳）')
  ok(rec('pending', true).action === 'abandon', 'pending → 回源')
  ok(rec('snapshot', false).action === 'abandon', 'snapshot → 回源')
  ok(rec('validated', false).action === 'abandon', 'validated → 回源')
  ok(tx.recoveryAction(null, { destinationHasResume: false }).action === 'none', '没有事务 → 什么都不做')
  ok(/committed/.test(tx.transactionSummary(c1.tx)), '摘要里带阶段（排障要看）')

  /* --------------------------------------------------- 事务日志（真目录） */

  const root = await mkdtemp(join(tmpdir(), 'yan-handoff-tx-'))
  try {
    let clock = 10_000
    const store = new service.HandoffTransactionStore({ root, now: () => clock })
    await store.load()

    const started = await store.begin({ handoffId: 'h-9', sourceSession: 'C:/s/a.jsonl', resumeId: 'rs-9' })
    ok(started.created && started.tx.stage === 'pending', 'begin 建出 pending 事务')
    const againBegin = await store.begin({ handoffId: 'h-9', sourceSession: 'C:/s/a.jsonl', resumeId: 'rs-9' })
    ok(!againBegin.created && againBegin.tx.createdAt === started.tx.createdAt, '同一 handoffId 重复 begin → 幂等')

    clock += 100
    const st1 = await store.step('h-9', 'snapshot')
    ok(st1.advanced && store.get('h-9').stage === 'snapshot', 'step 前进并写进内存')
    const st1b = await store.step('h-9', 'snapshot')
    ok(!st1b.advanced && st1b.reason === 'already-there', '重复 step → 幂等')
    ok((await store.step('h-9', 'committed')).reason === 'skipped', '跳步被拒（且不落盘）')

    const sp = await store.setPackage('h-9', pkg)
    ok(sp.ok && store.get('h-9').stage === 'validated', 'setPackage 自动推进到 validated')
    const sd = await store.setDestination('h-9', 'C:/s/b.jsonl')
    ok(sd.ok && store.get('h-9').destinationSession === 'C:/s/b.jsonl', 'setDestination 落进事务')
    await store.step('h-9', 'destination-created')
    await store.step('h-9', 'committed')

    /* 落盘 + 重启读回 */
    const onDisk = JSON.parse(await readFile(service.handoffTransactionDocumentPath(root), 'utf8'))
    ok(onDisk.transactions['h-9']?.stage === 'committed', '每步都落盘（磁盘上是 committed）')
    ok(onDisk.transactions['h-9']?.package?.goal === '把导入做快', '交接包也留在事务日志里（崩溃恢复不必再调模型）')
    const reopened = new service.HandoffTransactionStore({ root })
    await reopened.load()
    ok(reopened.get('h-9')?.stage === 'committed', '重启后事务还在（可恢复）')
    ok(reopened.activeForSession('C:/s/b.jsonl')?.handoffId === 'h-9', '按目的会话能查到未终结事务')
    ok(reopened.activeForSession('C:/s/a.jsonl')?.handoffId === 'h-9', '按源会话也能查到')
    ok(reopened.openTransactions().length === 1, '未终结事务列表有它')

    /* 终态：不再算「未终结」，也不参与恢复 */
    await reopened.step('h-9', 'resumed')
    ok(reopened.activeForSession('C:/s/a.jsonl') === null, '已 resumed → 不再出现在 activeForSession')
    ok(reopened.openTransactions().length === 0, '已 resumed → 不在未终结列表里')

    /* 脏文档：缺身份字段的事务整条丢掉（留着只会让恢复乱猜） */
    await writeFile(
      service.handoffTransactionDocumentPath(root),
      JSON.stringify({
        version: 1,
        transactions: {
          bad1: { handoffId: 'bad1', stage: 'committed' },
          bad2: { sourceSession: 's', resumeId: 'r', stage: 'committed' },
          good: { handoffId: 'g', sourceSession: 'C:/s/d.jsonl', resumeId: 'r2', stage: 'pending', steps: [] }
        }
      }),
      'utf8'
    )
    const cleaned = new service.HandoffTransactionStore({ root })
    await cleaned.load()
    ok(cleaned.get('g')?.stage === 'pending', '合法事务保留（按 handoffId 重新索引）')
    ok(!cleaned.get('bad1') && !cleaned.get('bad2'), '缺身份字段的事务被丢掉')
    ok(cleaned.get('g').stage === 'pending', '脏 stage 降级成 pending')

    /* 坏 JSON → 空文档（不让一次坏写把应用卡住） */
    await writeFile(service.handoffTransactionDocumentPath(root), '{坏', 'utf8')
    const empty = new service.HandoffTransactionStore({ root })
    await empty.load()
    ok(Object.keys(empty.snapshot().transactions).length === 0, '坏 JSON → 空文档')

    /* 落盘失败必须抛（不假装记住了） */
    const badRoot = await mkdtemp(join(tmpdir(), 'yan-handoff-tx-bad-'))
    try {
      const failing = new service.HandoffTransactionStore({ root: badRoot })
      await failing.load()
      await mkdir(service.handoffTransactionDocumentPath(badRoot), { recursive: true })
      let threw = false
      try {
        await failing.begin({ handoffId: 'h-x', sourceSession: 's', resumeId: 'r' })
      } catch {
        threw = true
      }
      ok(threw, '落盘失败时抛错（交接宁可停下，也不能「内存里提交了、磁盘没有」）')
    } finally {
      await rm(badRoot, { recursive: true, force: true })
    }

    /* ------------------------------------------------ A-3 续接回执（三边界） */
    {
      /* ① 已投递但未运行：标记行在，还没有扩展启动回执 */
      const resumeId = 'r-receipt'
      /*
       * 现场编译一份：本测试在 test-unit 里的调用点比 handoff-resume 的编译步骤早，
       * 直接用 `out/test/handoff-resume.mjs` 会拿到上一次运行的旧产物。
       */
      await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
        build({
          entryPoints: ['src/shared/handoff-resume.ts'],
          outfile: 'out/test/handoff-resume.mjs',
          bundle: true,
          format: 'esm',
          platform: 'neutral',
          logLevel: 'silent'
        })
      )
      const hresume = await import('../out/test/handoff-resume.mjs')
      const marker = hresume.resumeMarker(resumeId)
      const persistedOnly = `{"role":"custom","text":"${marker}"}\n`
      ok(hresume.containsResumeEvidence(persistedOnly, resumeId), '标记行在 → 已投递')
      ok(
        !hresume.hasExplicitHandoffStartReceipt(persistedOnly, resumeId),
        '只有标记行时不算“已启动”（投递不等于 provider 请求启动）'
      )

      /* 助手输出可能是之后的普通回合，不能替这次交接补启动回执。 */
      const withAssistant =
        persistedOnly + `{"role":"assistant","content":[{"type":"text","text":"继续"}]}\n`
      ok(
        !hresume.hasExplicitHandoffStartReceipt(withAssistant, resumeId),
        '标记之后即使有助手输出也不算启动回执（避免后续普通回合误归属）'
      )
      ok(
        !hresume.hasExplicitHandoffStartReceipt(
          `{"type":"custom","customType":"yan-handoff-started","data":{"operationId":"${resumeId}","hook":"before_provider_request"}}\n`,
          resumeId
        ),
        '有启动条目但没有该续接标记，不算已启动'
      )
      const startedEntry =
        `{"type":"custom","customType":"yan-handoff-started","data":{"operationId":"${resumeId}","hook":"before_provider_request"}}\n`
      ok(
        hresume.hasExplicitHandoffStartReceipt(persistedOnly + startedEntry, resumeId),
        '同 operationId 的 before_provider_request 自定义条目 → 已启动'
      )
      ok(
        !hresume.hasExplicitHandoffStartReceipt(
          persistedOnly + startedEntry.replace(resumeId, 'another-operation'),
          resumeId
        ),
        '其它 operationId 的启动条目不算这次交接已启动'
      )
      ok(!hresume.hasExplicitHandoffStartReceipt('', resumeId), '空文本不报“已启动”')

      /* ③ 回执落盘与幂等：同一 kind 只记第一次；脏值丢掉 */
      const receiptRoot = await mkdtemp(join(tmpdir(), 'yan-handoff-receipt-'))
      try {
        const store = new service.HandoffTransactionStore({ root: receiptRoot, now: () => 1000 })
        await store.load()
        await store.begin({ handoffId: 'h-r', sourceSession: 'C:/s/a.jsonl', resumeId })
        await store.noteReceipt('h-r', 'sent')
        const again = await store.noteReceipt('h-r', 'sent')
        ok(again?.receipts.sentAt === 1000, 'sent 回执落盘')
        await store.noteReceipt('h-r', 'persisted')
        await store.noteReceipt('h-r', 'started')
        const tx = store.snapshot().transactions['h-r']
        ok(
          tx.receipts.sentAt === 1000 && tx.receipts.persistedAt === 1000 && tx.receipts.startedAt === 1000,
          '三条回执都在（sent / persisted / started 分开记）'
        )
        ok(tx.stage === 'pending', '回执不推进阶段（不是状态转移）')

        /* 重启读回：回执必须真的写进文件 */
        const reread = new service.HandoffTransactionStore({ root: receiptRoot, now: () => 2000 })
        await reread.load()
        const back = reread.snapshot().transactions['h-r']
        ok(back.receipts.startedAt === 1000, '重启后回执读得回来')

        /*
         * 人工确认（A-3）：先推到 committed、且确认「已发出」之后，才能靠用户确认了结。
         * 这条路径走的是与自动证据同一条 step（只换 source），
         * 所以不需要第二套状态机。
         */
        await store.step('h-r', 'snapshot', 'test')
        /* 硬前提：没包就不能 validated，没目的会话就不能 destination-created / committed */
        await store.setPackage(
          'h-r',
          handoffShared.sanitizeHandoffPackage(
            { goal: 'g', deliverable: 'd', nextActions: ['a'] },
            { sourceSession: 'C:/s/a.jsonl', sourceHead: 'm-1', mode: 'autonomous', model: 'x', now: 5 }
          )
        )
        await store.setDestination('h-r', 'C:/s/b.jsonl')
        await store.step('h-r', 'destination-created', 'test')
        await store.step('h-r', 'committed', 'test')
        const manual = await store.step('h-r', 'resumed', 'manual-confirmed')
        ok(manual.advanced && manual.tx?.stage === 'resumed', '人工确认能把事务推到已续接')
        ok(
          store.snapshot().transactions['h-r'].steps.some((s) => s.detail === 'manual-confirmed'),
          '转移日志里留下 manual-confirmed（区分“自动证据”与“人看的”）'
        )
      } finally {
        await rm(receiptRoot, { recursive: true, force: true })
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
