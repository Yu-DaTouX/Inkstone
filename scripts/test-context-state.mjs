/**
 * State / Archive 基础设施的单测（N21-4 / S1）。
 *
 * 为什么这些断言值得钉住：状态文件是**要喂给模型的派生物**，
 * 它坏了不会让应用崩，只会让模型拿着过期或半份的世界模型干活
 * （"它怎么把我刚说过不能改的东西改了"）。这类故障在真实窗口里
 * 几乎看不出来，所以判据必须落在纯逻辑层：
 *
 *   ① schema 校验：缺字段 / 类型错 / 未知版本 → 一律不能进上下文；
 *   ② provenance：只能指向**原始条目身份**，指向数组下标 / token / 归档引用一律非法；
 *   ③ 禁止递归摘要（§12.7）：`sourceRange` 指到 episode / ctx:// 上就是摘要的摘要；
 *   ④ 原子写：失败**不覆盖** last-known-good；
 *   ⑤ 损坏 / 版本不认识 → 安全丢弃（文件删掉、返回原因）；
 *   ⑥ 会话删除 → 派生状态一并清理；
 *   ⑦ 水位：从真实会话文件读 entry 身份，半截行不计入。
 *
 * 不进 `cost: 1`，不碰真实用户目录：store 的 `dir` 全部指向临时目录。
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* ---------------------------------------------------------------- 夹具 */

const RAW = ['e1', 'e2', 'e3']

function provenance(entryId, kind = 'user', confidence = 'observed') {
  return { kind, entryId, confidence }
}

function entry(text, entryId = 'e1', over = {}) {
  return { text, status: 'active', source: provenance(entryId), updatedAt: 1000, ...over }
}

function emptyTask(objective = '把 S1 做完') {
  return {
    task: { objective, currentPhase: '实现' },
    currentState: [],
    decisions: [],
    constraints: [],
    files: [],
    completed: [],
    failedAttempts: [],
    unresolved: [],
    nextActions: [],
    commandsRun: [],
    testsRun: [],
    symbolsTouched: [],
    assumptions: [],
    hypothesis: [],
    episodeRefs: [],
    archiveRefs: []
  }
}

function episode(over = {}) {
  return {
    id: 'ep1',
    objective: '实现存储层',
    outcome: '完成',
    decisions: [{ decision: '用纯函数', reason: '可单测' }],
    constraints: ['不改默认阈值'],
    filesChanged: [{ path: 'src/shared/context-state.ts' }],
    failedAttempts: ['先试了 JSON.parse 整文件'],
    unresolved: [],
    importantRefs: ['ctx://tool/8291'],
    sourceRange: { from: 'e1', to: 'e2' },
    watermark: { entryCount: 3, lastEntryId: 'e3' },
    tokensBefore: 1234,
    createdAt: 1500,
    ...over
  }
}

function archiveEntry(over = {}) {
  return {
    ref: 'ctx://tool/8291',
    kind: 'tool',
    label: 'read src/foo.ts',
    createdAt: 1000,
    tokens: 18421,
    recallable: 'agent',
    sourceRange: { from: 'e1', to: 'e2' },
    watermark: { entryCount: 3, lastEntryId: 'e3' },
    contentStored: false,
    ...over
  }
}

const codes = (issues) => issues.map((i) => i.code)
const has = (issues, code) => codes(issues).includes(code)

/* ---------------------------------------------------------------- 测试 */

export async function runContextStateTests(ok, mods) {
  const { state, store, watermark } = mods
  const {
    CONTEXT_STATE_SCHEMA_VERSION,
    CONTEXT_ARCHIVE_SCHEMA_VERSION,
    validateTaskState,
    validateEpisodeState,
    validateArchiveEntry,
    inspectContextStateFile,
    inspectArchiveFile,
    watermarkFromEntryIds,
    validateWatermark,
    watermarkRelation,
    watermarksEqual,
    checkSourceRange,
    deepContextUsable,
    emptyTaskState
  } = state

  const rawIndex = { knownEntryIds: RAW }

  /* ============ A. schema 校验 ============ */

  console.log('\n— A. schema 校验 —')

  const goodFile = {
    schemaVersion: CONTEXT_STATE_SCHEMA_VERSION,
    sessionId: 'abc12345',
    sourceWatermark: { entryCount: 3, lastEntryId: 'e3' },
    createdAt: 1000,
    updatedAt: 2000,
    task: emptyTask(),
    episodes: []
  }
  const good = inspectContextStateFile(goodFile, rawIndex)
  ok(good.status === 'ok', '合法状态文件通过校验', good.status === 'ok' ? '' : JSON.stringify(good.issues))

  ok(validateTaskState(emptyTask(), rawIndex).ok, '空 Task State 通过（字段齐全、没有结论是合法的）')
  ok(inspectContextStateFile({ ...goodFile, schemaVersion: 99 }).status === 'incompatible', '未知 schemaVersion → incompatible（不是 invalid）')
  ok(
    inspectContextStateFile({ ...goodFile, schemaVersion: undefined }).status === 'invalid',
    '缺 schemaVersion → invalid'
  )

  {
    const bad = inspectContextStateFile({ ...goodFile, sessionId: '' })
    ok(bad.status === 'invalid' && has(bad.issues, 'missing'), '缺 sessionId → invalid(missing)', JSON.stringify(bad.issues))
  }
  {
    const t = emptyTask()
    t.task.objective = ''
    const res = validateTaskState(t, rawIndex)
    ok(!res.ok && has(res.issues, 'missing'), 'objective 为空 → 拒绝', JSON.stringify(res.issues?.[0]?.path))
  }
  {
    const t = emptyTask()
    t.decisions = [entry('用 worktree', 'e1', { source: { kind: 'model', entryId: 'e1', confidence: 'observed' } })]
    const res = validateTaskState(t, rawIndex)
    ok(!res.ok && has(res.issues, 'model-confidence'), '模型来源不能自称 observed（只能 hypothesis）', JSON.stringify(codes(res.issues ?? [])))
  }
  {
    const t = emptyTask()
    t.decisions = [entry('用户要求不改阈值', 'e1', { source: { kind: 'user', confidence: 'observed' } })]
    const res = validateTaskState(t, rawIndex)
    ok(!res.ok && has(res.issues, 'missing'), 'user 来源缺 entryId → 拒绝', JSON.stringify(codes(res.issues ?? [])))
  }
  {
    const t = emptyTask()
    t.decisions = [entry('下标定位', 'e1', { source: { kind: 'tool', entryId: 12, confidence: 'observed' } })]
    const res = validateTaskState(t, rawIndex)
    ok(
      !res.ok && has(res.issues, 'missing'),
      '用数字（messages 下标）当 entryId → 拒绝',
      JSON.stringify(res.issues?.[0]?.message)
    )
  }
  {
    const t = emptyTask()
    t.decisions = [entry('不存在的条目', 'e1', { source: provenance('ghost') })]
    const res = validateTaskState(t, rawIndex)
    ok(!res.ok && has(res.issues, 'unknown-raw-entry'), 'entryId 不在原始会话里 → 拒绝', JSON.stringify(codes(res.issues ?? [])))
  }
  {
    const t = emptyTask()
    t.decisions = [entry('下标定位', 'e1', { source: { kind: 'tool', entryId: 'ctx://tool/9', confidence: 'observed' } })]
    const res = validateTaskState(t, rawIndex)
    ok(!res.ok, 'entryId 写成 ctx:// 引用 → 拒绝（那是归档，不是原始条目）', JSON.stringify(codes(res.issues ?? [])))
  }
  {
    const t = emptyTask()
    t.files = [{ path: 'src/a.ts', state: '已改', source: { kind: 'file', confidence: 'observed' } }]
    const res = validateTaskState(t, rawIndex)
    ok(!res.ok && has(res.issues, 'missing'), 'file 来源缺 path → 拒绝', JSON.stringify(codes(res.issues ?? [])))
  }
  {
    const t = emptyTask()
    t.decisions = [entry('旧决定', 'e1', { status: 'superseded' })]
    const res = validateTaskState(t, rawIndex)
    ok(!res.ok && has(res.issues, 'superseded-by'), 'superseded 必须写明被谁取代', JSON.stringify(codes(res.issues ?? [])))
  }
  {
    const t = emptyTask()
    t.decisions = [entry('现行决定', 'e1', { supersededBy: 'x' })]
    const res = validateTaskState(t, rawIndex)
    ok(!res.ok && has(res.issues, 'superseded-by'), '非 superseded 不能带 supersededBy')
  }
  ok(emptyTaskState('任务', '阶段').decisions.length === 0 && validateTaskState(emptyTaskState('任务', '阶段'), rawIndex).ok, 'emptyTaskState 造出来的起点本身合法')

  /* ============ B. Episode 与「禁止递归摘要」 ============ */

  console.log('\n— B. Episode / 禁止递归摘要（§12.7） —')

  const epOk = validateEpisodeState(episode(), rawIndex)
  ok(epOk.ok, '合法 EpisodeState 通过', epOk.ok ? '' : JSON.stringify(epOk.issues))

  {
    const res = validateEpisodeState(episode({ sourceRange: { from: 'ctx://tool/1', to: 'e2' } }), rawIndex)
    ok(!res.ok && has(res.issues, 'archive-ref'), 'sourceRange 指向 ctx:// → 拒绝（摘要的摘要）', JSON.stringify(codes(res.issues ?? [])))
  }
  {
    const opts = { knownEntryIds: RAW, knownEpisodeIds: ['ep1'] }
    const res = checkSourceRange({ from: 'ep1', to: 'ep1' }, opts)
    ok(!res.ok && res.code === 'episode-ref', 'sourceRange 指向另一份 EpisodeState → 拒绝（§12.7 判据）')
  }
  {
    const res = validateEpisodeState(episode({ sourceRange: { from: 'e3', to: 'e1' } }), rawIndex)
    ok(!res.ok && has(res.issues, 'range-order'), 'sourceRange 顺序反了 → 拒绝', JSON.stringify(codes(res.issues ?? [])))
  }
  {
    const res = validateEpisodeState(episode({ sourceRange: { from: 'e1', to: 'gone' } }), rawIndex)
    ok(!res.ok && has(res.issues, 'unknown-raw-entry'), 'sourceRange 指向不存在的原始条目 → 拒绝')
  }
  {
    const file = { ...goodFile, episodes: [episode()], task: { ...emptyTask(), episodeRefs: ['nope'] } }
    const res = inspectContextStateFile(file, rawIndex)
    ok(
      res.status === 'invalid' && has(res.issues, 'unknown-episode'),
      'task.episodeRefs 指向不存在的 Episode → 拒绝（引用要能对上）',
      JSON.stringify(codes(res.issues ?? []))
    )
  }
  {
    const file = { ...goodFile, episodes: [episode(), episode()] }
    const res = inspectContextStateFile(file, rawIndex)
    ok(res.status === 'invalid', 'Episode id 重复 → 拒绝')
  }
  {
    /*
     * 整份文件的递归摘要判定（S1 审查时修掉的缺口）：
     * 一份 EpisodeState 的 sourceRange 指向**另一份** EpisodeState 时，
     * 即使调用方没显式传 knownEpisodeIds，文件级校验也必须报 episode-ref。
     * 只把“前面已解析的 id”传进去会放过“指向后面那份”的情况。
     */
    const first = episode({ id: 'ep1' })
    const second = episode({ id: 'ep2', sourceRange: { from: 'ep1', to: 'e2' } })
    const res = inspectContextStateFile({ ...goodFile, episodes: [first, second] }, rawIndex)
    ok(
      res.status === 'invalid' && has(res.issues, 'episode-ref'),
      '文件级校验也拦“Episode 指向另一份 Episode”（§12.7 判据）',
      JSON.stringify(codes(res.issues ?? []))
    )
    const forward = episode({ id: 'ep2', sourceRange: { from: 'ep1', to: 'e2' } })
    const backward = inspectContextStateFile({ ...goodFile, episodes: [forward, first] }, rawIndex)
    ok(backward.status === 'invalid' && has(backward.issues, 'episode-ref'), '反向引用同样被拦（不依赖解析顺序）')
  }
  ok(validateEpisodeState(episode(), rawIndex).ok, '没有原始索引时只做形状校验（拿不到原始条目的场合）')

  /* ============ C. 水位 ============ */

  console.log('\n— C. sourceWatermark —')

  const wmEmpty = watermarkFromEntryIds([])
  ok(wmEmpty.entryCount === 0 && wmEmpty.lastEntryId === null, '空会话水位 = {0, null}')
  const wmFull = watermarkFromEntryIds(RAW)
  ok(wmFull.entryCount === 3 && wmFull.lastEntryId === 'e3', '水位取最后一条 entry id', JSON.stringify(wmFull))
  ok(watermarksEqual(wmFull, watermarkFromEntryIds(RAW)), '同一批条目算出的水位相等')
  ok(!watermarksEqual(wmFull, watermarkFromEntryIds(['e1', 'e2'])), '不同条目数水位不等')

  {
    const issues = { list: [], add(p, c, m) { this.list.push({ path: p, code: c, message: m }) } }
    const bad = validateWatermark({ entryCount: 0, lastEntryId: 'e1' }, 'wm', issues)
    ok(bad === null && has(issues.list, 'inconsistent-watermark'), 'entryCount=0 却给了 lastEntryId → 拒绝')
  }
  ok(watermarkRelation(wmFull, wmFull) === 'same', '水位相同 → same')
  ok(watermarkRelation(wmFull, watermarkFromEntryIds([...RAW, 'e4'])) === 'older', 'raw 继续变长 → older（有效但较早的快照）')
  ok(watermarkRelation(watermarkFromEntryIds([...RAW, 'e4']), wmFull) === 'diverged', '状态比 raw 还长 → diverged（raw 被裁剪）')
  ok(
    watermarkRelation(wmFull, { entryCount: 3, lastEntryId: 'eX' }) === 'diverged',
    '条数相同但尾巴不同 → diverged（不是同一份历史）'
  )
  ok(watermarkRelation({ entryCount: -1, lastEntryId: null }, wmFull) === 'unknown', '水位形状非法 → unknown')

  /* ============ D. Archive 元数据 ============ */

  console.log('\n— D. Archive 元数据 —')

  const archiveOk = inspectArchiveFile(
    { schemaVersion: CONTEXT_ARCHIVE_SCHEMA_VERSION, sessionId: 'abc12345', updatedAt: 1000, entries: [archiveEntry()] },
    rawIndex
  )
  ok(archiveOk.status === 'ok', '合法归档文件通过', archiveOk.status === 'ok' ? '' : JSON.stringify(archiveOk.issues))
  ok(
    inspectArchiveFile({ schemaVersion: 42, sessionId: 'x', updatedAt: 1, entries: [] }).status === 'incompatible',
    '归档未知版本 → incompatible'
  )
  {
    const res = validateArchiveEntry(archiveEntry({ kind: 'diff' }), rawIndex)
    ok(!res.ok && has(res.issues, 'bad-ref'), 'ref 类别与 kind 不一致 → 拒绝', JSON.stringify(codes(res.issues ?? [])))
  }
  {
    const res = validateArchiveEntry(archiveEntry({ ref: 'tool/8291' }), rawIndex)
    ok(!res.ok && has(res.issues, 'bad-ref'), '不是 ctx:// 形状 → 拒绝')
  }
  {
    const res = validateArchiveEntry(archiveEntry({ recallable: 'yes' }), rawIndex)
    ok(!res.ok && has(res.issues, 'type'), 'recallable 越出三态 → 拒绝')
  }
  for (const value of ['none', 'manual', 'agent']) {
    ok(validateArchiveEntry(archiveEntry({ recallable: value }), rawIndex).ok, `recallable='${value}' 合法`)
  }
  {
    const file = {
      schemaVersion: CONTEXT_ARCHIVE_SCHEMA_VERSION,
      sessionId: 'abc12345',
      updatedAt: 1,
      entries: [archiveEntry(), archiveEntry()]
    }
    ok(inspectArchiveFile(file, rawIndex).status === 'invalid', '归档 ref 重复 → 拒绝')
  }

  /* ============ E. Deep Context 只预留判据 ============ */

  console.log('\n— E. Deep Context（只预留接口，不发模型请求） —')

  const now = 2000
  const artifact = {
    sessionId: 'abc12345',
    sourceWatermark: wmFull,
    createdAt: 1000,
    expiresAt: 5000,
    content: 'trace…'
  }
  const usable = deepContextUsable(artifact, { sessionId: 'abc12345', watermark: wmFull, now })
  ok(usable.ok, '绑定完整、未过期、水位一致 → 可以注入', usable.ok ? '' : usable.reason)
  ok(
    deepContextUsable(artifact, { sessionId: 'other', watermark: wmFull, now }).reason === 'session-mismatch',
    'sessionId 不匹配 → 不能注入'
  )
  ok(
    deepContextUsable(artifact, { sessionId: 'abc12345', watermark: watermarkFromEntryIds([...RAW, 'e4']), now }).reason ===
      'watermark-mismatch',
    '水位不匹配（raw 已前进）→ 不能注入'
  )
  ok(
    deepContextUsable(artifact, { sessionId: 'abc12345', watermark: wmFull, now: 6000 }).reason === 'expired',
    '过期 → 不能注入'
  )
  ok(
    deepContextUsable({ ...artifact, createdAt: 9000, expiresAt: 10_000 }, { sessionId: 'abc12345', watermark: wmFull, now })
      .reason === 'not-created-yet',
    '创建时间还没到 → 不能注入（时间戳被改坏也拦得住）'
  )
  ok(
    deepContextUsable({ ...artifact, content: '   ' }, { sessionId: 'abc12345', watermark: wmFull, now }).reason ===
      'empty-content',
    '空内容 → 不能注入'
  )
  ok(deepContextUsable(null, { sessionId: 'abc12345', watermark: wmFull, now }).reason === 'not-object', '形状不对 → 不能注入')

  /* ============ F. 原子写与安全丢弃（真实文件系统） ============ */

  console.log('\n— F. 原子写 / 失败不覆盖 last-known-good / 安全丢弃 —')

  const dir = await mkdtemp(join(tmpdir(), 'yan-ctxstate-'))
  const sid = 'abc12345'
  const filePath = store.contextStatePath(sid, dir)

  await store.saveContextState({ ...goodFile, task: { ...emptyTask('第一版'), } }, { dir, raw: rawIndex })
  {
    const loaded = await store.loadContextState(sid, { dir, raw: rawIndex })
    ok(loaded.status === 'ok' && loaded.state.task.task.objective === '第一版', 'save → load 往返正常')
  }
  ok((await readFile(filePath, 'utf8')).includes('"schemaVersion": 1'), '落盘是格式化 JSON（人能读）')
  ok(
    (await readdir(dir)).every((n) => !n.endsWith('.tmp')),
    '写成功后没有残留临时文件',
    JSON.stringify(await readdir(dir))
  )

  /* 失败不覆盖 last-known-good：故意写一份 objective 为空的状态 */
  {
    let threw = null
    try {
      await store.saveContextState({ ...goodFile, task: emptyTask('') }, { dir, raw: rawIndex })
    } catch (error) {
      threw = error
    }
    ok(threw instanceof store.ContextStateError, '非法状态写入抛 ContextStateError（不是静默写坏）')
    const loaded = await store.loadContextState(sid, { dir, raw: rawIndex })
    ok(
      loaded.status === 'ok' && loaded.state.task.task.objective === '第一版',
      '写入失败后上一份好状态原样保留（last-known-good）',
      loaded.status === 'ok' ? loaded.state.task.task.objective : loaded.status
    )
    ok(
      (await readdir(dir)).every((n) => !n.endsWith('.tmp')),
      '失败写入没有留下临时文件',
      JSON.stringify(await readdir(dir))
    )
  }

  /* 损坏 JSON → 丢弃并删除 */
  {
    const sidBad = 'badjson1'
    const p = store.contextStatePath(sidBad, dir)
    await writeFile(p, '{ "schemaVersion": 1, "sessionId": "badjson1",', 'utf8')
    const loaded = await store.loadContextState(sidBad, { dir })
    ok(loaded.status === 'discarded' && loaded.reason === 'invalid', '损坏 JSON → discarded(invalid)')
    ok(!(await readdir(dir)).includes(`${sidBad}.json`), '损坏的状态文件被安全丢弃（不再留在盘上）')
  }

  /* 版本不认识 → 丢弃 */
  {
    const sidOld = 'oldschema'
    await writeFile(
      store.contextStatePath(sidOld, dir),
      JSON.stringify({ ...goodFile, sessionId: sidOld, schemaVersion: 0 }),
      'utf8'
    )
    const loaded = await store.loadContextState(sidOld, { dir })
    ok(loaded.status === 'discarded' && loaded.reason === 'incompatible', 'schema 不匹配 → discarded(incompatible)')
    ok(!(await readdir(dir)).includes(`${sidOld}.json`), '不兼容状态被丢弃')
  }

  /* 引用已消失的原始条目（原始会话被裁剪）→ 丢弃 */
  {
    const sidGone = 'goneentry'
    await store.saveContextState(
      {
        ...goodFile,
        sessionId: sidGone,
        task: { ...emptyTask(), decisions: [entry('引用旧条目', 'e1')] }
      },
      { dir, raw: rawIndex }
    )
    const loaded = await store.loadContextState(sidGone, { dir, raw: { knownEntryIds: ['e9'] } })
    ok(
      loaded.status === 'discarded' && loaded.reason === 'invalid',
      '状态引用的原始条目已不在会话里 → 丢弃（provenance 执法）',
      JSON.stringify(codes(loaded.issues ?? []))
    )
  }

  /* 文件名与内容不一致 → 丢弃（防串会话） */
  {
    const sidMismatch = 'mismatch1'
    await writeFile(store.contextStatePath(sidMismatch, dir), JSON.stringify(goodFile), 'utf8')
    const loaded = await store.loadContextState(sidMismatch, { dir })
    ok(loaded.status === 'discarded' && loaded.reason === 'invalid', '文件里的 sessionId 与文件名不一致 → 丢弃')
  }

  /* 路径穿越 */
  {
    let threw = false
    try {
      store.contextStatePath('../evil')
    } catch {
      threw = true
    }
    ok(threw, 'sessionId 带路径分隔符 → 直接抛错（不许写出目录）')
    ok((await store.deleteContextStates(['../evil'], { dir })) === 0, '清理非法 id 直接跳过（不误删别的文件）')
  }

  /* ============ G. 会话删除时清理派生状态 ============ */

  console.log('\n— G. 会话删除 → 清理派生状态 —')

  const dirClean = await mkdtemp(join(tmpdir(), 'yan-ctxclean-'))
  const keep = 'keep0001'
  const drop = 'drop0001'
  await store.saveContextState({ ...goodFile, sessionId: keep }, { dir: dirClean, raw: rawIndex })
  await store.saveContextState({ ...goodFile, sessionId: drop }, { dir: dirClean, raw: rawIndex })
  await store.saveArchive(
    { schemaVersion: CONTEXT_ARCHIVE_SCHEMA_VERSION, sessionId: keep, updatedAt: 1, entries: [archiveEntry()] },
    { dir: dirClean, raw: rawIndex }
  )
  await store.saveArchive(
    { schemaVersion: CONTEXT_ARCHIVE_SCHEMA_VERSION, sessionId: drop, updatedAt: 1, entries: [archiveEntry()] },
    { dir: dirClean, raw: rawIndex }
  )
  await writeFile(join(dirClean, `${drop}.json.999.1.tmp`), '{}', 'utf8')
  /* 召回账本 / 审计也是按 sessionId 命名的派生物，删会话时要一起清掉 */
  await writeFile(join(dirClean, `${drop}.recall.json`), '{"turn":1,"activeTokens":10}', 'utf8')
  await writeFile(join(dirClean, `${drop}.recall.jsonl`), '{"kind":"recall"}\n', 'utf8')
  await writeFile(join(dirClean, `${keep}.recall.json`), '{"turn":1,"activeTokens":10}', 'utf8')

  const removed = await store.deleteContextStates([drop], { dir: dirClean })
  const left = await readdir(dirClean)
  ok(removed === 5, '清理掉状态 + 归档 + 召回账本 + 审计 + 残留临时文件（5 个）', `removed=${removed} left=${JSON.stringify(left)}`)
  ok(left.includes(`${keep}.recall.json`), '别的会话的召回账本不受影响')
  ok(!left.some((n) => n.startsWith(drop)), '被删会话的派生文件一个不剩', JSON.stringify(left))
  ok(left.includes(`${keep}.json`) && left.includes(`${keep}.archive.json`), '其它会话的状态与归档不受影响（不误删）')
  {
    const ids = await store.listContextStateSessionIds({ dir: dirClean })
    ok(ids.length === 1 && ids[0] === keep, '列派生状态时同一会话的状态与归档算一个', JSON.stringify(ids))
  }
  await rm(dirClean, { recursive: true, force: true })

  /* ============ H. 从真实会话文件读原始条目身份 ============ */

  console.log('\n— H. 水位来自真实会话文件 —')

  const wmDir = await mkdtemp(join(tmpdir(), 'yan-ctxwm-'))
  const sessionPath = join(wmDir, 'session.jsonl')
  const lines = [
    { type: 'session', version: 3, id: 'sess0001', timestamp: 't', cwd: 'C:/x' },
    { type: 'model_change', id: 'mc0', parentId: null, timestamp: 't' },
    { type: 'message', id: 'm1', parentId: 'mc0', timestamp: 't', message: { role: 'user', content: [{ type: 'text', text: '嗨' }] } },
    { type: 'message', id: 'm2', parentId: 'm1', timestamp: 't', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(4000) }] } }
  ]
  await writeFile(sessionPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
  {
    const index = await watermark.readSessionEntryIndex(sessionPath)
    ok(!!index && index.sessionId === 'sess0001', '读到会话 id（文件头 type:"session"）')
    ok(
      !!index && index.entryIds.join(',') === 'mc0,m1,m2',
      '按文件顺序读出条目 id（含 model_change，不含文件头）',
      JSON.stringify(index?.entryIds)
    )
    ok(
      !!index && index.watermark.entryCount === 3 && index.watermark.lastEntryId === 'm2',
      '水位 = 条目数 + 最后一条 id',
      JSON.stringify(index?.watermark)
    )
    ok(!!index && !index.incompleteTail && index.unreadableEntries === 0, '完整文件不报截断')
  }

  /* 超长正文行仍然只读前缀（这条是性能约束：会话单行可达 4MB） */
  {
    const longPath = join(wmDir, 'long.jsonl')
    const longLine = JSON.stringify({
      type: 'message',
      id: 'big1',
      parentId: null,
      timestamp: 't',
      message: { role: 'toolResult', content: [{ type: 'text', text: 'y'.repeat(600_000) }] }
    })
    await writeFile(longPath, lines.slice(0, 2).map((l) => JSON.stringify(l)).join('\n') + '\n' + longLine + '\n', 'utf8')
    const index = await watermark.readSessionEntryIndex(longPath)
    ok(!!index && index.entryIds.join(',') === 'mc0,big1', '超长正文行照样只从开头取 id', JSON.stringify(index?.entryIds))
  }

  /* 半截最后一行：被进程杀在半路，不计数也不算坏文件 */
  {
    const partialPath = join(wmDir, 'partial.jsonl')
    const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
    await writeFile(partialPath, body + '{"type":"message","id":"m3","message":{"role":"user"', 'utf8')
    const index = await watermark.readSessionEntryIndex(partialPath)
    ok(!!index && index.entryIds.join(',') === 'mc0,m1,m2', '半截尾行不计入条目', JSON.stringify(index?.entryIds))
    ok(!!index && index.incompleteTail, '半截尾行会被标出来（水位停在上一条完整 entry）')
  }

  /* 中间坏行：整份索引不可信 */
  {
    const brokenPath = join(wmDir, 'broken.jsonl')
    await writeFile(brokenPath, `${JSON.stringify(lines[0])}\n{oops\n${JSON.stringify(lines[2])}\n`, 'utf8')
    const index = await watermark.readSessionEntryIndex(brokenPath)
    ok(index === null, '中间有坏行 → 整份索引作废（返回 null，不猜）')
  }

  ok((await watermark.readSessionEntryIndex(join(wmDir, 'nope.jsonl'))) === null, '读不到文件 → null（调用方退回形状校验）')

  await rm(wmDir, { recursive: true, force: true })
  await rm(dir, { recursive: true, force: true })
}
