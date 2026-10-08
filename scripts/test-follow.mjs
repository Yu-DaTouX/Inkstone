/**
 * 持续关注与提醒（实施-25 P16）—— 节奏 / 到点 / 提醒规则 / 落盘 / 服务。
 *
 * 四条最值得钉住的：
 *   · **应用没开就不跟进**：状态里只有「上次看 / 下次该看」，没有「后台在跑」；
 *   · **用户没启用的关注不自行建立**：模型只能提议（`enabled: false`）；
 *   · **「没有变化」不打扰**：它只进运行记录（否则关注就成了噪音）；
 *   · **一次性关注做完就结束**：不把 `nextDueAt` 推到无穷，也不累积欠账。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DAY = 86400000
const MIN = 60_000

function watch(over = {}) {
  return {
    id: over.id ?? 'fw_1',
    title: over.title ?? '看看 README 有没有变',
    kind: over.kind ?? 'files',
    spaceId: over.spaceId ?? null,
    cadence: over.cadence ?? 'interval',
    ...(over.cadence === 'once' ? {} : { intervalMinutes: over.intervalMinutes ?? 1440 }),
    resultPlace: over.resultPlace ?? '写进成果：项目变更',
    notifyOn: over.notifyOn ?? 'change',
    enabled: over.enabled ?? true,
    createdAt: over.createdAt ?? 0,
    updatedAt: over.updatedAt ?? 0,
    ...(over.lastCheckedAt !== undefined ? { lastCheckedAt: over.lastCheckedAt } : {}),
    ...(over.nextDueAt !== undefined ? { nextDueAt: over.nextDueAt } : {}),
    ...(over.lastOutcome ? { lastOutcome: over.lastOutcome } : {}),
    origin: over.origin ?? 'user'
  }
}

function run(over = {}) {
  return {
    id: over.id ?? 'fn_1',
    watchId: over.watchId ?? 'fw_1',
    at: over.at ?? 0,
    outcome: over.outcome ?? 'no-change',
    summary: over.summary ?? '',
    changed: over.changed ?? [],
    decisions: over.decisions ?? [],
    ...over
  }
}

export function runFollowTests(ok, mod) {
  const {
    describeCadence,
    nextDueAfter,
    dueWatches,
    waitingFor,
    shouldNotify,
    runSummaryText,
    watchStatusText,
    followAppOnlyNote,
    followScopeText,
    FOLLOW_APP_ONLY_NOTE,
    proposedNote,
    validateWatchInput,
    createWatch,
    applyWatchPatch,
    applyRunToWatch,
    sanitizeWatch,
    sanitizeFollowDocument,
    pruneRuns,
    upsertWatchIn,
    removeWatchFrom,
    removeSpaceWatchesFrom,
    watchesForSpace,
    runsForWatch,
    watchBriefText,
    watchViews,
    emptyFollowDocument,
    FOLLOW_LIMITS,
    FOLLOW_OUTCOME_LABELS,
    formatWhen
  } = mod

  /* ---- 节奏 ---- */
  {
    ok(describeCadence({ cadence: 'once' }) === '看一次就好', '一次性关注的节奏文案')
    ok(describeCadence({ cadence: 'interval', intervalMinutes: 1440 }) === '每 1 天看一次', '按天说')
    ok(describeCadence({ cadence: 'interval', intervalMinutes: 180 }) === '每 3 小时看一次', '按小时说')
    ok(describeCadence({ cadence: 'interval', intervalMinutes: 90 }) === '每 90 分钟看一次', '不整小时就报分钟')

    ok(nextDueAfter({ cadence: 'interval', intervalMinutes: 1440 }, 1000) === 1000 + DAY, '间隔到期时间 = 基准 + 间隔')
    ok(nextDueAfter({ cadence: 'once' }, 1000) === undefined, '一次性关注没有下一次（不推到无穷）')
    ok(nextDueAfter({ cadence: 'interval', intervalMinutes: 5 }, 1000) === undefined, '低于最短间隔的节奏不给下一次')
  }

  /* ---- 到点（只数启用过的） ---- */
  {
    const now = 10 * DAY
    const due = dueWatches(
      [
        watch({ id: 'fw_due', nextDueAt: now - MIN }),
        watch({ id: 'fw_later', nextDueAt: now + MIN }),
        watch({ id: 'fw_disabled', nextDueAt: now - MIN, enabled: false }),
        watch({ id: 'fw_proposed', cadence: 'once', enabled: false, origin: 'agent' }),
        watch({ id: 'fw_once', cadence: 'once' })
      ],
      now
    )
    ok(
      [...due].map((w) => w.id).sort().join(',') === 'fw_due,fw_once',
      '到点 = 已到期 + 没看过的一次性；未启用的不算',
      due.map((w) => w.id).join(',')
    )
    ok(!dueWatches([watch({ id: 'fw_x', cadence: 'once', lastCheckedAt: 5 })], now).length, '看过的一次性关注不再出现')

    const ordered = dueWatches(
      [watch({ id: 'fw_b', nextDueAt: now - MIN }), watch({ id: 'fw_a', nextDueAt: now - 2 * MIN })],
      now
    )
    ok(ordered[0].id === 'fw_a', '最早到期的排前面')

    ok(waitingFor(watch({ nextDueAt: now + MIN }), now) && !waitingFor(watch({ nextDueAt: now - MIN }), now), '「还在等下次」的判据')
    ok(!waitingFor(watch({ nextDueAt: now - MIN, enabled: false }), now), '未启用不算在等')
    ok(waitingFor(watch({ cadence: 'once', lastCheckedAt: 1 }), now), '看过的一次性关注属于「结束」而不是「到点」')

    ok(/还没看过/.test(watchStatusText(watch({ cadence: 'once' }), now)), '一次性未看过的状态文案')
    ok(/看过了/.test(watchStatusText(watch({ cadence: 'once', lastCheckedAt: 1 }), now)), '一次性看过后的状态文案')
    ok(/到点了/.test(watchStatusText(watch({ nextDueAt: now - 1 }), now)), '到点的状态文案')
    ok(/还没启用/.test(watchStatusText(watch({ enabled: false }), now)), '未启用的状态文案说清「你点一下才会开始看」')
    ok(formatWhen(undefined) === '时间未知', '时间未知时不编一个时间')
  }

  /* ---- 提醒规则（T16-5） ---- */
  {
    ok(!shouldNotify('no-change', 'change'), '「没有变化」默认不打扰')
    ok(shouldNotify('changed', 'change'), '有变化要提醒')
    ok(shouldNotify('needs-decision', 'change'), '需要用户决定要提醒')
    ok(shouldNotify('failed', 'change'), '这次没看成要提醒（否则用户以为一直没问题）')
    ok(!shouldNotify('changed', 'decision') && shouldNotify('needs-decision', 'decision'), '「只在需要决定时提醒」按这个过滤')
    ok(shouldNotify('no-change', 'always'), 'always 时连没变化也提醒（用户自己选的）')

    const text = runSummaryText(run({ outcome: 'needs-decision', summary: '版本号对不上', decisions: ['要不要跟进上游'] }))
    ok(/需要你定/.test(text) && /版本号对不上/.test(text) && /等你定/.test(text), '运行摘要把结局、说明与待决定合在一句里', text)
    ok(runSummaryText(run({ outcome: 'no-change' })) === FOLLOW_OUTCOME_LABELS['no-change'], '没写说明时只给结局')
  }

  /* ---- 「应用没开就不跟进」的文案 ---- */
  {
    ok(/应用没开/.test(followAppOnlyNote()) && /不会补看/.test(FOLLOW_APP_ONLY_NOTE), '「应用没开不跟进」写进固定文案')
    ok(!/已跟进|正在后台/.test(followScopeText()), '说明里没有「已跟进 / 后台在跑」这种承诺', followScopeText())
    ok(/不会自动开始学习/.test(followScopeText()), '说明里写明复习类关注不自动代学')
    ok(/还没启用/.test(proposedNote()), '提议的提示写明「点了才生效」')
  }

  /* ---- 输入校验 ---- */
  {
    const good = validateWatchInput({
      title: '看看 README 有没有变',
      kind: 'files',
      cadence: 'interval',
      intervalMinutes: 1440,
      resultPlace: '写进成果：项目变更'
    })
    ok(good.ok && good.value.enabled === false, '默认**不启用**（提议语义），要启用必须显式给 true')
    ok(good.value.origin === 'user', '默认 origin 是 user')

    ok(!validateWatchInput({ title: '', resultPlace: 'x' }).ok, '没写关注什么：拒掉')
    ok(!validateWatchInput({ title: 'x', resultPlace: '' }).ok, '没写结果放哪：拒掉')
    const badKind = validateWatchInput({ title: 'x', kind: 'magic', resultPlace: 'y' })
    ok(!badKind.ok && badKind.code === 'bad_kind', '认不出的 kind：拒掉')
    const noInterval = validateWatchInput({ title: 'x', cadence: 'interval', resultPlace: 'y' })
    ok(!noInterval.ok && noInterval.code === 'bad_interval', '周期关注没写间隔：拒掉')
    const tooShort = validateWatchInput({ title: 'x', cadence: 'interval', intervalMinutes: 5, resultPlace: 'y' })
    ok(!tooShort.ok && /30 分钟/.test(tooShort.message), '间隔太短：给出可读错误', tooShort.message)
    const tooLong = validateWatchInput({ title: 'x', cadence: 'interval', intervalMinutes: 999999999, resultPlace: 'y' })
    ok(!tooLong.ok, '间隔太长：拒掉')
    const badNotify = validateWatchInput({ title: 'x', cadence: 'once', resultPlace: 'y', notifyOn: 'every-time' })
    ok(!badNotify.ok && badNotify.code === 'bad_notify', '认不出的提醒条件：拒掉')
    const tooLongTitle = validateWatchInput({ title: 'x'.repeat(FOLLOW_LIMITS.maxTitle + 1), resultPlace: 'y' })
    ok(!tooLongTitle.ok && tooLongTitle.code === 'title_too_long', '标题超长：如实报错')

    const created = createWatch(good.value, { id: 'fw_new', now: 1000 })
    ok(created.id === 'fw_new' && created.createdAt === 1000 && created.updatedAt === 1000, '创建填上 id 与时间')
    ok(created.nextDueAt === 1000 + DAY, '新建时下一次到期 = 现在 + 间隔')
    const onceWatch = createWatch({ ...good.value, cadence: 'once', intervalMinutes: undefined }, { id: 'fw_once', now: 1000 })
    ok(onceWatch.nextDueAt === undefined, '一次性关注没有 nextDueAt')
  }

  /* ---- 修改与运行 ---- */
  {
    const base = createWatch(
      validateWatchInput({ title: '看 README', cadence: 'interval', intervalMinutes: 1440, resultPlace: '概览' }).value,
      { id: 'fw_1', now: 1000 }
    )
    const renamed = applyWatchPatch(base, { title: '看 README（改过名）' }, 2000)
    ok(renamed.ok && renamed.watch.updatedAt === 2000, '改名推后 updatedAt')
    ok(renamed.watch.nextDueAt === base.nextDueAt, '只改名**不**动下一次到期（免得改个错别字就把提醒推后）')

    const slowed = applyWatchPatch(base, { intervalMinutes: 4320 }, 2000)
    ok(slowed.ok && slowed.watch.nextDueAt === 2000 + 3 * DAY, '改节奏会重算下一次到期')

    const enabled = applyWatchPatch(base, { enabled: true }, 2000)
    ok(enabled.ok && enabled.watch.enabled === true, '启用关注')
    const badPatch = applyWatchPatch(base, { intervalMinutes: 5 }, 2000)
    ok(!badPatch.ok && badPatch.code === 'bad_interval', '改节奏时同样挡住太短的间隔')

    const afterRun = applyRunToWatch(base, { outcome: 'changed', at: 5000 })
    ok(afterRun.lastCheckedAt === 5000 && afterRun.lastOutcome === 'changed', '运行后记下时间与结局')
    ok(afterRun.nextDueAt === 5000 + DAY, '下一次到期从这次看的时间起算（不是从上次到期起算）')
    const onceAfterRun = applyRunToWatch(
      { ...base, cadence: 'once', intervalMinutes: undefined },
      { outcome: 'no-change', at: 5000 }
    )
    ok(onceAfterRun.nextDueAt === undefined, '一次性关注跑完就没有下一次了')
  }

  /* ---- 容错读盘与集合 ---- */
  {
    const base = createWatch(
      validateWatchInput({ title: 'x', cadence: 'interval', intervalMinutes: 1440, resultPlace: 'y' }).value,
      { id: 'fw_1', now: 1 }
    )
    ok(!!sanitizeWatch(base), '合法关注读得回来')
    ok(sanitizeWatch({ ...base, title: '' }) === undefined, '读盘时丢掉读不通的关注')
    ok(sanitizeWatch({ ...base, intervalMinutes: 2 }) === undefined, '间隔不合法也整条丢掉（不让它一直挂在到点列表里）')
    ok(sanitizeWatch({ ...base, runs: [] }).origin === 'user', '认不出的 origin 退回 user')

    const doc = sanitizeFollowDocument({
      watches: [base, { ...base, id: 'fw_2' }, { id: 'bad' }, null],
      runs: [run({ id: 'fn_1' }), run({ id: 'fn_2', outcome: 'nonsense' }), { id: 'fn_3' }]
    })
    ok(doc.watches.length === 2, '读盘时丢掉坏关注与重复 id')
    ok(doc.runs.length === 1 && doc.runs[0].id === 'fn_1', '读盘时丢掉认不出的运行记录')

    const many = Array.from({ length: FOLLOW_LIMITS.maxRunsPerWatch + 5 }, (_, i) =>
      run({ id: `fn_${i}`, at: i, summary: `第 ${i} 次` })
    )
    const pruned = pruneRuns(many)
    ok(pruned.length === FOLLOW_LIMITS.maxRunsPerWatch, `每个关注只留 ${FOLLOW_LIMITS.maxRunsPerWatch} 条记录`)
    ok(pruned[0].at === FOLLOW_LIMITS.maxRunsPerWatch + 4, '留下的是最近的（按时间倒序）')

    let d = emptyFollowDocument()
    d = upsertWatchIn(d, base)
    d = upsertWatchIn(d, { ...base, title: '第二版' })
    ok(d.watches.length === 1 && d.watches[0].title === '第二版', '同 id 覆盖')
    d = { ...d, runs: [run({ id: 'fn_a', watchId: 'fw_1' }), run({ id: 'fn_b', watchId: 'fw_other' })] }
    const removed = removeWatchFrom(d, 'fw_1')
    ok(removed.watches.length === 0 && removed.runs.length === 1 && removed.runs[0].watchId === 'fw_other', '删关注带走它的运行记录')

    const withSpace = upsertWatchIn(d, { ...base, id: 'fw_sp', spaceId: 'sp_a' })
    ok(watchesForSpace(withSpace, 'sp_a').length === 2, '本空间能看到自己的 + 不挑空间的')
    ok(watchesForSpace(withSpace, 'sp_b').length === 1, '别的空间看不到它')
    const cleared = removeSpaceWatchesFrom(withSpace, 'sp_a')
    ok(cleared.removed === 1 && !cleared.doc.watches.some((w) => w.id === 'fw_sp'), '删空间带走属于它的关注')
    ok(cleared.doc.runs.every((r) => r.watchId !== 'fw_sp'), '也带走它的运行记录')

    ok(runsForWatch(d, 'fw_1', 1).length === 1, '按关注取运行记录并限量')
  }

  /* ---- 交给模型的说明与界面视图 ---- */
  {
    const base = createWatch(
      validateWatchInput({
        title: '看看 README 有没有变',
        kind: 'files',
        cadence: 'interval',
        intervalMinutes: 1440,
        resultPlace: '写进成果：项目变更',
        enabled: true
      }).value,
      { id: 'fw_1', now: 1 }
    )
    const withRun = { ...base, lastCheckedAt: 5000, lastOutcome: 'changed' }
    const brief = watchBriefText(withRun, [run({ outcome: 'changed', summary: '多了两行', at: 5000 })])
    ok(/按这个关注看一遍/.test(brief) && /结果记到：写进成果/.test(brief), '说明里写清看什么与记到哪')
    ok(/上次看：/.test(brief), '说明里带上上次看的时间')
    ok(/没有变化 \/ 有变化 \/ 需要我定 \/ 没看成/.test(brief), '要求回报四种结局之一')
    ok(/应用没开/.test(brief), '说明里同样有「应用没开不跟进」那句话')

    let d = emptyFollowDocument()
    d = upsertWatchIn(d, { ...base, id: 'fw_due', nextDueAt: 1 })
    d = upsertWatchIn(d, { ...base, id: 'fw_later', nextDueAt: 10 * DAY })
    d = upsertWatchIn(d, { ...base, id: 'fw_off', enabled: false, origin: 'agent' })
    const views = watchViews(d, null, 1000)
    ok(views[0].watch.id === 'fw_due', '到点的排最前')
    ok(views.find((v) => v.watch.id === 'fw_off').proposed === true, '未启用的 agent 提议被标成 proposed')
    ok(views.find((v) => v.watch.id === 'fw_due').status === '到点了', '视图带上状态文案')
  }
}

export function runFollowStoreTests(ok, mod, fs) {
  const { FollowStore } = mod
  return (async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'yan-follow-'))
    try {
      let tick = 1000
      let seq = 0
      const store = new FollowStore({ root: dir, now: () => (tick += 1000), idFactory: () => `fw_g${++seq}` })
      await store.load()

      /* 模型提议：默认未启用，不进「到点了」 */
      const proposed = await store.save({
        title: '看看 README 有没有变',
        kind: 'files',
        cadence: 'interval',
        intervalMinutes: 1440,
        resultPlace: '概览里记一笔',
        origin: 'agent',
        enabled: false
      })
      ok(proposed.ok && proposed.value.enabled === false && proposed.value.origin === 'agent', '提议存下来是未启用状态', JSON.stringify(proposed.ok ? proposed.value : proposed))
      ok(store.due().length === 0, '未启用的提议**不出现**在到点里（T16-3）')

      /* 用户启用之后才到点 */
      const enabled = await store.update(proposed.value.id, { enabled: true })
      ok(enabled.ok && enabled.value.enabled === true, '用户点过才启用')
      /* 启用不改 nextDueAt（新建时已经排好了） */
      ok(store.snapshot().watches[0].nextDueAt !== undefined, '启用后有一次到期时间')

      /* 把时间推过到期点：该到点了 */
      const far = 1000 + 2 * 86400000
      const later = new FollowStore({ root: dir, now: () => far, idFactory: () => 'fw_late' })
      await later.load()
      ok(later.due().length === 1, '时间过去之后进到点列表')

      /* 回报一次「没有变化」：record 落盘、下次到期往后推 */
      const reported = await store.report({
        watchId: proposed.value.id,
        outcome: 'no-change',
        summary: '和上次一样'
      })
      ok(reported.ok && reported.value.run.outcome === 'no-change', '回报结果落成一条运行记录')
      ok(reported.value.watch.lastCheckedAt > 0 && reported.value.watch.nextDueAt > reported.value.watch.lastCheckedAt, '记下上次看的时间并把下一次往后排')
      ok(store.runs(proposed.value.id).length === 1, '运行记录取得到')

      const badOutcome = await store.report({ watchId: proposed.value.id, outcome: 'maybe' })
      ok(!badOutcome.ok && badOutcome.code === 'bad_notify', '认不出的结局：拒掉（不写成一条假记录）')
      const badId = await store.report({ watchId: 'fw_nope', outcome: 'changed' })
      ok(!badId.ok && badId.code === 'not_found', '找不到关注：如实失败')

      /* 一次性关注：回报之后不再出现 */
      const once = await store.save({
        title: '看看发布说明',
        cadence: 'once',
        resultPlace: '概览里记一笔',
        enabled: true
      })
      ok(once.ok && store.due().some((w) => w.id === once.value.id), '新建的一次性关注在到点里')
      await store.report({ watchId: once.value.id, outcome: 'changed', summary: '发了新版本' })
      ok(!later.due().some((w) => w.id === once.value.id), '看过之后不再出现')

      /* 读盘重开：记录与状态都还在 */
      const reopened = new FollowStore({ root: dir, now: () => far })
      await reopened.load()
      ok(reopened.list().length === 2, '重开后关注还在')
      ok(reopened.runs(proposed.value.id).length === 1, '重开后运行记录还在')
      ok(reopened.find(proposed.value.id).lastOutcome === 'no-change', '重开后最近结局还在')

      /* 删空间带走关注与记录 */
      const inSpace = await store.save({
        title: '空间内的关注',
        cadence: 'interval',
        intervalMinutes: 1440,
        resultPlace: '概览',
        spaceId: 'sp_a',
        enabled: true
      })
      await store.report({ watchId: inSpace.value.id, outcome: 'changed', summary: '变了' })
      const removed = await store.removeSpace('sp_a')
      ok(removed === 1, '删空间带走一条关注')
      ok(store.runs(inSpace.value.id).length === 0, '也带走它的运行记录')

      /* 显式给过才启用：save 不带 enabled 时是未启用 */
      const silent = await store.save({ title: '没写 enabled 的关注', cadence: 'once', resultPlace: '概览' })
      ok(silent.ok && silent.value.enabled === false, '不带 enabled 的关注是未启用（不静默开始跟踪）')

      /*
       * 并发保存：8 个不同关注都要在（O02 回归）。
       * 旧实现把「构造新文档」放在写队列之外，8 个并发各自基于同一份旧文档构造，
       * 再依次覆盖写入 —— 8 次都返回成功，磁盘上只剩最后那一个。
       */
      {
        const before = store.list().length
        const concurrent = await Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            store.save({
              title: `并发关注 ${i}`,
              kind: 'files',
              cadence: 'interval',
              intervalMinutes: 1440,
              resultPlace: '概览',
              enabled: true
            })
          )
        )
        ok(concurrent.every((r) => r.ok), '并发保存 8 个关注都返回成功')
        ok(
          store.list().length === before + 8,
          '**并发保存的关注都在**（旧实现只剩一个）',
          `${before} → ${store.list().length}`
        )
        const { readFile } = await import('node:fs/promises')
        const onDisk = JSON.parse(await readFile(join(dir, 'follows.json'), 'utf8'))
        ok(onDisk.watches.length === before + 8, '磁盘上也都在', String(onDisk.watches.length))
      }

      /*
       * 只读入口依赖 load（O07）：宿主入口必须先 `await load()`，否则
       * 「重启后还没有任何写操作」时读到的是空文档（磁盘上的关注还在）。
       */
      {
        const expected = store.list().length
        const fresh = new FollowStore({ root: dir })
        ok(fresh.list().length === 0, '没 load 时只读入口是空的（所以宿主必须先 await load）')
        await fresh.load()
        ok(fresh.list().length === expected, 'load 之后记录都在，不需要任何写操作触发')
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })()
}
