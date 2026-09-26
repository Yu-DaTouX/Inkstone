/**
 * 资料库（实施-25 P03）—— 真实窗口里走一遍 IPC 链路。
 *
 * 覆盖：导入真实文件 → 解析 → 两个会话 + 一门课引用同一份 → 按引用读正文 →
 * 归档到空间 → 软移除后旧引用仍能打开 → 恢复 → 旧会话引用提升 → 不存在的版本。
 *
 * **不在这里做的**：「更新文件后旧引用仍按旧版本打开」需要改文件内容，
 * 而渲染进程写不了文件。那一条由 `scripts/test-library-parse.mjs` 用真实
 * 文件系统钉住（写第一版 → 导入 → 写第二版 → 再导入 → 旧引用仍读旧正文）。
 * 两边合起来才是完整证据：这里是**通道**，那边是**语义**。
 */
;(async () => {
  const out = []
  const ok = (c, s, extra) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? `  ${extra}` : ''))
    return !!c
  }
  const log = (s) => out.push(s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const click = (el) => el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  const S = () => store.getState()

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const card = q('.ob-card')
    if (!card) break
    const b = [...card.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
    if (b) {
      click(b)
      await sleep(250)
    } else await sleep(120)
  }
  await sleep(400)
  S().closeSettings?.()
  await sleep(150)

  for (let i = 0; i < 24; i++) {
    if (S().conn === 'ready') break
    await sleep(500)
  }
  if (S().conn !== 'ready') return `  ⤺ 跳过：pi 未就绪（conn=${S().conn}）`

  const lib = window.yan.library
  if (!lib) return '✗ preload 里没有 library 桥（四处清单缺一处）'

  log('=== 1. 列表可用 ===')
  const before = await lib.list()
  ok(before.ok === true && Array.isArray(before.sources), 'library.list 通')

  log('=== 2. 导入真实文件并解析 ===')
  const cwd = String(S().settings?.cwd ?? '').replace(/[\/]+$/, '')
  const target = `${cwd}/README.md`
  const imported = await lib.import({
    kind: 'file',
    ref: target,
    title: 'README（探针）',
    owner: { kind: 'session', id: 'probe-sess-a' }
  })
  ok(imported.ok === true && !!imported.sourceId, '导入成功', imported.error)
  if (!imported.ok || !imported.sourceId) return out.join('\n')
  const sourceId = imported.sourceId
  const version = imported.version ?? 1
  ok(imported.parse?.status === 'ok', 'Markdown 提取到正文', JSON.stringify(imported.parse))
  ok((imported.parse?.chars ?? 0) > 0, '正文长度记录在案', String(imported.parse?.chars))

  const ref = { sourceId, version }
  const repeat = await lib.import({ kind: 'file', ref: target, title: 'README（探针）' })
  ok(repeat.decision === 'unchanged' && repeat.version === version, '重复导入幂等（同内容同指纹）')

  log('=== 3. 同一份资料被两个会话 + 一门课引用 ===')
  await lib.addRef({ kind: 'session', id: 'probe-sess-b' }, ref)
  await lib.addRef({ kind: 'course', id: 'probe-course-1' }, ref)
  const listed = await lib.list()
  const mine = listed.refs.filter((r) => r.ref.sourceId === sourceId)
  ok(mine.length === 3, '引用登记到三个引用方', mine.map((r) => r.owner.kind + ':' + r.owner.id).join(','))
  ok(mine.every((r) => r.outcome === 'ok'), '三条引用的判定都是 ok', mine.map((r) => r.outcome).join(','))

  log('=== 4. 按引用读正文（只按 id + version） ===')
  const opened = await lib.open(ref, { maxChars: 400 })
  ok(opened.ok === true && opened.outcome === 'ok', '打开引用', opened.outcome)
  ok(typeof opened.text === 'string' && opened.text.length > 0, '读到正文', String(opened.text?.length))
  ok(opened.source?.title === 'README（探针）', '带出资料标题')

  const missing = await lib.open({ sourceId, version: 999 })
  ok(missing.ok === true && missing.outcome === 'missing', '不存在的版本 → missing，不抛错', missing.outcome)

  log('=== 5. 归档到空间 ===')
  const space = await S().createSpace('探针空间（资料）')
  if (space) {
    const moved = await lib.attach(sourceId, space.id)
    ok(moved.ok === true, '资料归档到空间')
    const inSpace = await lib.list({ spaceId: space.id })
    ok(inSpace.sources.some((s) => s.id === sourceId), '按空间筛得到这份资料', String(inSpace.sources.length))
    await S().updateSpace(space.id, { archived: true })
  } else {
    ok(false, '建空间失败（后续归档检查跳过）')
  }

  log('=== 6. 软移除：旧引用仍能打开 ===')
  const removed = await lib.remove(sourceId)
  ok(removed.ok === true, '从空间移除')
  const afterRemove = await lib.open(ref)
  ok(afterRemove.outcome === 'removed', '判定为已移除', afterRemove.outcome)
  ok(typeof afterRemove.text === 'string' && afterRemove.text.length > 0, '**移除后旧引用仍能读到旧版本正文**')
  const active = await lib.list()
  ok(!active.sources.some((s) => s.id === sourceId), '移除后不在活动列表里')
  ok((await lib.restore(sourceId)).ok === true, '可以恢复')

  log('=== 7. 旧会话级 SourceRef 提升（T03-3） ===')
  const promoted = await lib.promoteLegacy({
    sessionId: 'probe-legacy-session',
    legacyId: 'probe-old-source-1',
    kind: 'file',
    ref: target,
    title: '旧引用（探针）'
  })
  ok(promoted.ok === true && promoted.mapped === true, '首次提升建映射')
  ok(promoted.decision === 'unchanged' && promoted.sourceId === sourceId, '同一个文件 → 命中已有资料（不重复建档）', promoted.decision)
  const again = await lib.promoteLegacy({
    sessionId: 'probe-legacy-session',
    legacyId: 'probe-old-source-1',
    kind: 'file',
    ref: target,
    title: '旧引用（探针）'
  })
  ok(again.sourceId === sourceId, '第二次提升仍指向同一版', String(again.sourceId))

  log('=== 8. 原件复核 ===')
  const verified = await lib.verify([ref])
  ok(verified.ok === true && verified.checked === 1 && verified.unavailable === 0, '复核原件仍在', JSON.stringify(verified))

  return out.join('\n')
})()
