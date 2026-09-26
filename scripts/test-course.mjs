/**
 * 课程与路线（实施-25 P07）的单测：契约 / 生成路线 / 单元编辑 / 存储 / 服务。
 *
 * 三条最值得钉住的：
 *   · **材料 vs 补充**：material 单元没有出处必须被拒（否则「书上说的」可以是编的）；
 *     model 单元没有说明也必须被拒。
 *   · **不编页码**：生成路线的定位只能是正文里真实存在的字符区间 ——
 *     用「切片回去等于原文」来证明，而不是相信生成器自己说的偏移。
 *   · **路线独立于会话**：单元顺序完全由课程数组决定（不读任何会话数据）。
 */

export function runCourseTests(ok, mod) {
  const {
    validateCourseInput,
    createCourse,
    updateCourse,
    validateUnit,
    addUnit,
    updateUnit,
    moveUnit,
    removeUnit,
    addConcept,
    removeConcept,
    paragraphSpans,
    draftRouteFromText,
    planTopicUnits,
    planBlockerUnits,
    totalMinutes,
    courseSourceRefs,
    sanitizeCourseDocument,
    MAX_ROUTE_UNITS
  } = mod

  const mkIds = () => {
    let n = 0
    return () => `u_${++n}`
  }

  const mkCourse = (extra = {}) => {
    const res = createCourse(
      { title: '英语精读', goal: '能读完 Unit 3 并复述', entry: 'source', minutesPerDay: 30, ...extra },
      1000,
      () => 'co_test1'
    )
    ok(res.ok === true, '建课成功', JSON.stringify(res))
    return res.course
  }

  const mkMaterialUnit = (id = 'u1', locator) => ({
    id,
    title: '第一段',
    estimateMinutes: 10,
    origin: 'material',
    sources: [{ sourceId: 'lib_a', version: 1, ...(locator ? { locator } : {}) }],
    concepts: []
  })

  /* ---- 建课与校验 ---- */
  {
    const course = mkCourse()
    ok(course.entry === 'source' && course.level === 'new' && course.minutesPerDay === 30, '默认基础与可用时间')
    ok(course.units.length === 0 && course.concepts.length === 0, '先开课、后加单元（先开始）')
    ok(validateCourseInput({ title: '', goal: 'x', entry: 'topic' }).ok === false, '缺课程名被拒')
    ok(validateCourseInput({ title: 'x', goal: '', entry: 'topic' }).ok === false, '缺目标被拒（没有目标的路线会退化成清单）')
    ok(validateCourseInput({ title: 'x', goal: 'y', entry: 'nope' }).ok === false, '未知入口被拒')
    ok(validateCourseInput({ title: 'x', goal: 'y', entry: 'topic', minutesPerDay: 1000 }).ok === false, '可用时间越界被拒')
    ok(validateCourseInput({ title: 'x', goal: 'y', entry: 'topic', minutesPerDay: 30 }).ok === true, '合法输入通过')

    const changed = updateCourse(course, { title: '英语精读（改）', minutesPerDay: 45 }, 2000)
    ok(changed.ok === true && changed.course.title === '英语精读（改）' && changed.course.minutesPerDay === 45, '改课程')
    ok(updateCourse(course, { title: '英语精读', goal: course.goal, level: 'new', minutesPerDay: 30 }, 3000).unchanged === true, '没改就没变')
  }

  /* ---- 材料 vs 补充（T07-3 的落点） ---- */
  {
    ok(validateUnit({ ...mkMaterialUnit(), sources: [] }).ok === false, '材料单元没有出处被拒')
    ok(validateUnit(mkMaterialUnit()).ok === true, '材料单元带出处通过')
    ok(
      validateUnit({ id: 'u2', title: '补充', estimateMinutes: 5, origin: 'model', sources: [], concepts: [] }).ok === false,
      '补充单元没有说明被拒'
    )
    ok(
      validateUnit({
        id: 'u3',
        title: '补充',
        estimateMinutes: 5,
        origin: 'model',
        sources: [],
        note: '宿主按骨架加的',
        concepts: []
      }).ok === true,
      '补充单元带说明通过'
    )
    ok(validateUnit(mkMaterialUnit('u4', { start: 10, end: 4 })).ok === false, '来源区间倒置被拒')
    ok(validateUnit(mkMaterialUnit('u5', { start: 0, end: 10 })).ok === true, '来源区间合法通过')
  }

  /* ---- 段落偏移：切片回去必须等于原文 ---- */
  {
    const text = '第一段。\n\n第二段。\n\n第三段。'
    const spans = paragraphSpans(text)
    ok(spans.length === 3, '切出 3 段', String(spans.length))
    ok(text.slice(spans[0].start, spans[0].end) === '第一段。', '第 1 段偏移正确')
    ok(text.slice(spans[1].start, spans[1].end) === '第二段。', '第 2 段偏移正确')
    ok(text.slice(spans[2].start, spans[2].end) === '第三段。', '第 3 段偏移正确')
    ok(paragraphSpans('a\r\n\r\nb').length === 2, 'CRLF 也能切段')
    ok(paragraphSpans('   \n\n  \n\n').length === 0, '空白段不产生段落')
  }

  /* ---- 从资料生成路线 ---- */
  {
    const paragraphs = Array.from({ length: 9 }, (_, i) => `第 ${i + 1} 段的正文内容，长度够一点。`)
    const text = paragraphs.join('\n\n')
    const draft = draftRouteFromText({ sourceId: 'lib_a', version: 3 }, text, { paragraphsPerUnit: 3 }, mkIds())
    ok(draft.units.length === 3, '每 3 段合成一节', String(draft.units.length))
    ok(draft.units.every((u) => u.origin === 'material'), '生成的单元都是材料单元')
    ok(
      draft.units.every((u) => u.sources.length === 1 && u.sources[0].sourceId === 'lib_a' && u.sources[0].version === 3),
      '每个单元都指回那一份资料的那一版'
    )
    ok(draft.units[0].sources[0].locator.start === 0, '第一节从正文开头开始')
    ok(
      draft.units.every((u) => text.slice(u.sources[0].locator.start, u.sources[0].locator.end).length > 0),
      '每个区间都能切回真实正文'
    )
    ok(
      text.slice(draft.units[1].sources[0].locator.start, draft.units[1].sources[0].locator.end).startsWith(paragraphs[3]),
      '第二节的区间正好从第 4 段开始'
    )
    /* 不编页码：定位只用字符区间 */
    ok(draft.units.every((u) => !('page' in u) && !('page' in u.sources[0])), '单元里没有编造出来的页码')
    ok(draft.units.every((u) => u.estimateMinutes > 0), '每节有建议学习量')
    ok(draft.truncated === false, '没超上限时不标截断')

    const big = Array.from({ length: MAX_ROUTE_UNITS + 5 }, (_, i) => `段 ${i}`).join('\n\n')
    const cut = draftRouteFromText({ sourceId: 'lib_a', version: 1 }, big, { paragraphsPerUnit: 1 }, mkIds())
    ok(cut.units.length === MAX_ROUTE_UNITS && cut.truncated === true, '超上限时截断并如实标注', String(cut.units.length))

    const empty = draftRouteFromText({ sourceId: 'lib_a', version: 1 }, '   ', {}, () => 'u_x')
    ok(empty.units.length === 0 && empty.paragraphCount === 0, '空正文切不出单元（不硬凑一节）')
  }

  /* ---- 主题与卡点骨架：全是补充，且都写了为什么 ---- */
  {
    const topic = planTopicUnits('虚拟语气', 30, mkIds())
    const blocker = planBlockerUnits('分不清 since 和 for', 20, mkIds())
    ok(topic.length > 0 && blocker.length > 0, '主题与卡点都能生成骨架')
    ok(topic.every((u) => u.origin === 'model' && !!u.note), '主题骨架都是补充单元且带说明')
    ok(blocker.every((u) => u.origin === 'model' && !!u.note), '卡点骨架都是补充单元且带说明')
    ok(topic.every((u) => validateUnit(u).ok), '骨架单元本身合法')
  }

  /* ---- 单元编辑 ---- */
  {
    let course = mkCourse()
    const added = addUnit(course, mkMaterialUnit('u1'), 2000)
    ok(added.ok === true && added.course.units.length === 1, '加单元')
    course = added.course
    ok(addUnit(course, mkMaterialUnit('u1'), 2100).ok === false, '重复 id 被拒')
    ok(addUnit(course, { ...mkMaterialUnit('u9'), origin: 'model' }, 2100).ok === false, '补充单元没说明仍被拒')

    const u2 = addUnit(course, { id: 'u2', title: '第二节', estimateMinutes: 8, origin: 'model', sources: [], note: '补充', concepts: [] }, 2200)
    course = u2.course
    ok(course.units.map((u) => u.id).join(',') === 'u1,u2', '插入顺序按数组位置')
    const moved = moveUnit(course, 'u2', -1, 2300)
    ok(moved.ok === true && moved.course.units.map((u) => u.id).join(',') === 'u2,u1', '上移')
    ok(moveUnit(moved.course, 'u2', -1, 2400).unchanged === true, '到顶了就如实说没动')
    ok(moveUnit(course, 'nope', 1, 2400).ok === false, '移动不存在的单元如实失败')

    const patched = updateUnit(course, 'u2', { title: '第二节（改）', target: '能解释一遍', estimateMinutes: 12 }, 2500)
    ok(patched.ok === true && patched.course.units[1].title === '第二节（改）' && patched.course.units[1].target === '能解释一遍', '改单元标题与目标')
    ok(updateUnit(course, 'u1', { note: '材料单元不给改说明' }, 2600).ok === false, '材料单元没有「为什么加」这个字段')
    ok(updateUnit(course, 'u2', { note: '' }, 2600).ok === false, '补充单元的说明不能清空')
    const cleared = updateUnit(course, 'u2', { target: null }, 2700)
    ok(cleared.ok === true && cleared.course.units[1].target === undefined, '目标可以清空')

    ok(removeUnit(course, 'u1', 2800).course.units.length === 1, '删单元')
    ok(removeUnit(course, 'nope', 2800).ok === false, '删不存在的单元如实失败')

    const capped = addUnit(course, mkMaterialUnit('u1'), 2900)
    ok(capped.ok === false, '同一门课里 id 不能重复')
    ok(updateUnit(course, 'u2', { estimateMinutes: 0 }, 3000).ok === false, '建议学习量必须为正')
  }

  /* ---- 概念与汇总 ---- */
  {
    let course = mkCourse()
    const c1 = addConcept(course, '虚拟语气', 2000, () => 'c1')
    ok(c1.ok === true && c1.course.concepts.length === 1, '加概念')
    course = c1.course
    ok(addConcept(course, '虚拟语气', 2100, () => 'c2').unchanged === true, '同名概念幂等')
    ok(addConcept(course, '  ', 2100, () => 'c3').ok === false, '空概念名被拒')
    ok(removeConcept(course, 'c1', 2200).course.concepts.length === 0, '删概念')

    const withUnits = addUnit(addUnit(course, mkMaterialUnit('u1'), 2300).course, {
      id: 'u2',
      title: '第二节',
      estimateMinutes: 5,
      origin: 'material',
      sources: [{ sourceId: 'lib_a', version: 1 }, { sourceId: 'lib_b', version: 2 }],
      concepts: []
    }, 2400).course
    ok(totalMinutes(withUnits) === 15, '总时长是各节之和', String(totalMinutes(withUnits)))
    ok(courseSourceRefs(withUnits).map((r) => r.sourceId).join(',') === 'lib_a,lib_b', '用到的资料去重')
  }

  /* ---- 容错读盘 ---- */
  {
    const doc = sanitizeCourseDocument({
      version: 1,
      courses: [
        { id: 'co_ok', title: '好的', goal: '目标', entry: 'topic', units: [], concepts: [], createdAt: 1, updatedAt: 1 },
        { id: 'co_nogoal', title: '缺目标' },
        { id: 'co_ok', title: '重复 id', goal: '目标', entry: 'topic', units: [], concepts: [] },
        {
          id: 'co_units',
          title: '带坏单元',
          goal: '目标',
          entry: 'source',
          units: [
            { id: 'u_bad', title: '没有出处', origin: 'material', estimateMinutes: 5, sources: [] },
            { id: 'u_good', title: '好的单元', origin: 'material', estimateMinutes: 5, sources: [{ sourceId: 'lib_a', version: 1 }] }
          ],
          concepts: []
        }
      ]
    })
    ok(doc.courses.length === 2, '坏课程与重复 id 被丢掉', String(doc.courses.length))
    ok(doc.courses[1].units.length === 1 && doc.courses[1].units[0].id === 'u_good', '坏单元被丢掉、好单元留下')
    ok(sanitizeCourseDocument(null).courses.length === 0, '空文档读成空列表')
  }
}

/** 存储：真临时目录、真原子写、落盘后重读。 */
export async function runCourseStoreTests(ok, mod, helpers) {
  const { CourseStore, coursePath } = mod
  const { mkdtemp, readFile, rm } = helpers
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const root = await mkdtemp(join(tmpdir(), 'yan-course-'))
  try {
    const store = new CourseStore({ root, now: () => 1000, random: () => 0.5 })
    const created = await store.create({
      title: '英语精读',
      goal: '读完 Unit 3',
      entry: 'source',
      minutesPerDay: 30,
      spaceId: 'sp1'
    })
    ok(created.ok === true, '建课并落盘')
    const id = created.course.id

    await store.create({ title: '别的空间', goal: 'x', entry: 'topic', spaceId: 'sp2' })
    ok(store.list('sp1').length === 1 && store.list('sp1')[0].id === id, '按空间筛课程')

    const withUnit = await store.addUnit(id, { title: '第一节', origin: 'model', note: '骨架' })
    ok(withUnit.ok === true && withUnit.course.units.length === 1, '加单元')
    const unitId = withUnit.course.units[0].id

    const bad = await store.addUnit(id, { title: '材料节', origin: 'material', sources: [] })
    ok(bad.ok === false, '材料单元没出处被拒（存储层同样把关）')

    await store.update(id, { title: '英语精读（改）', minutesPerDay: 45 })
    await store.addConcept(id, '虚拟语气')
    await store.moveUnit(id, unitId, 1)
    await store.addUnit(id, { title: '第二节', origin: 'model', note: '骨架二' })
    await store.removeUnit(id, unitId)

    /* 关闭重开：新 store 从磁盘读回 */
    const reopened = new CourseStore({ root })
    await reopened.load()
    const doc = reopened.find(id)
    ok(!!doc && doc.title === '英语精读（改）', '重开后标题仍在')
    ok(doc.minutesPerDay === 45, '重开后可用时间仍在')
    ok(doc.concepts.length === 1 && doc.concepts[0].name === '虚拟语气', '重开后概念仍在')
    ok(doc.units.length === 1 && doc.units[0].title === '第二节', '重开后单元仍在', JSON.stringify(doc.units.map((u) => u.title)))

    const archived = await store.archive(id, true)
    ok(archived.ok === true && archived.course.status === 'archived', '归档')
    ok((await store.archive(id, false)).course.status === 'active', '取消归档')
    ok((await store.remove(id)).ok === true, '删除课程')
    ok((await store.remove('不存在')).ok === false, '删不存在的课程如实失败')

    const raw = JSON.parse(await readFile(coursePath(root), 'utf8'))
    ok(Array.isArray(raw.courses), '磁盘上是 v1 文档结构')

    /* 坏文档不拦启动（放在最后：写坏之后就读不了结构化内容了） */
    await import('node:fs/promises').then((fs) => fs.writeFile(coursePath(root), '{ 不是 JSON', 'utf8'))
    const tolerant = new CourseStore({ root })
    await tolerant.load()
    ok(tolerant.list().length === 0, '坏文档读成空列表（不抛错）')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** 服务：三条入口 + 三个入口的失败方式必须分得清。 */
export async function runCourseServiceTests(ok, mod, helpers) {
  const { CourseService, CourseStore } = mod
  const { mkdtemp, rm } = helpers ?? {}
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  /* 用临时目录：服务的默认 store 就是真 YAN_DIR，不能拿用户数据做测试 */
  const root = await mkdtemp(join(tmpdir(), 'yan-course-svc-'))
  const text = '第一段正文。\n\n第二段正文。\n\n第三段正文。'
  const books = {
    lib_ok: { outcome: 'ok', text, source: { title: '精读材料' } },
    lib_empty: { outcome: 'ok', text: '   ' },
    lib_removed: { outcome: 'removed', text }
  }
  const service = new CourseService({
    store: new CourseStore({ root, random: () => 0.5 }),
    library: {
      openRef: async (ref) => books[ref.sourceId] ?? { outcome: 'missing' }
    },
    random: () => 0.5
  })

  const created = await service.createFromSource({
    sourceId: 'lib_ok',
    version: 2,
    input: { title: '英语精读', goal: '读完 Unit 3', entry: 'source', minutesPerDay: 30 }
  })
  ok(created.ok === true, '入口一：从资料生成路线', JSON.stringify(created))
  const course = created.course
  ok(course.units.length === 1 && course.units[0].origin === 'material', '三小段合成一节材料单元')
  ok(course.basedOn?.sourceId === 'lib_ok' && course.basedOn?.version === 2, '记下用的是哪一份哪一版')
  ok(course.entryInput === '精读材料', '入口输入回填资料标题')
  const ref = course.units[0].sources[0]
  ok(text.slice(ref.locator.start, ref.locator.end) === text, '单元区间切片回去正好是原文')
  ok(course.units.every((u) => validateOk(u)), '生成出来的单元都合法')

  const removed = await service.createFromSource({
    sourceId: 'lib_removed',
    version: 1,
    input: { title: '旧材料', goal: 'x', entry: 'source' }
  })
  ok(removed.ok === true, '软移除的资料仍能从旧版本生成路线（P03 不变量）')

  const empty = await service.createFromSource({
    sourceId: 'lib_empty',
    version: 1,
    input: { title: '没正文', goal: 'x', entry: 'source' }
  })
  ok(empty.ok === false, '没有正文的资料不生成路线')

  const missing = await service.createFromSource({
    sourceId: 'nope',
    version: 1,
    input: { title: '找不到', goal: 'x', entry: 'source' }
  })
  ok(missing.ok === false && /正文/.test(missing.reason), '找不到的资料如实说没有正文')

  const topic = await service.createFromTopic({ title: '虚拟语气', goal: '能解释', entry: 'topic', minutesPerDay: 30 })
  ok(topic.ok === true && topic.course.units.length > 0, '入口二：主题骨架')
  ok(topic.course.units.every((u) => u.origin === 'model' && !!u.note), '主题骨架是带说明的补充单元')
  ok(topic.course.basedOn === undefined, '主题路线没有资料来源（不能假装有）')

  const blocker = await service.createFromBlocker({
    title: '卡住了',
    goal: '搞清楚 since 和 for',
    entry: 'stuck',
    minutesPerDay: 20
  })
  ok(blocker.ok === true && blocker.course.units.length > 0, '入口三：卡点骨架')

  const id = topic.course.id
  const badAdd = await service.addUnit(id, { title: '材料节', origin: 'material', sources: [] })
  ok(badAdd.ok === false, '服务层同样拒绝没有出处的材料单元')
  const goodAdd = await service.addUnit(id, { title: '材料节', origin: 'material', sources: [{ sourceId: 'lib_ok', version: 1 }] })
  ok(goodAdd.ok === true && goodAdd.course.units.length === topic.course.units.length + 1, '带出处就能加')
  ok((await service.remove(topic.course.id)).ok === true, '删课程')

  /*
   * 入口四（T06b-4）：成果「用于学习」。
   *
   * 关键是**两步顺序**：先登记成一份资料库来源，再走入口一 —— 所以生成的
   * 单元照样指着真实字符区间；而不是把成果正文另存一份「材料」。
   */
  const imported = []
  const artifactService = new CourseService({
    store: new CourseStore({ root, random: () => 0.5 }),
    library: { openRef: async (ref) => books[ref.sourceId] ?? { outcome: 'missing' } },
    artifacts: {
      read: async (artifactId) =>
        artifactId === 'art_ok'
          ? { id: 'art_ok', title: '精读笔记', text, spaceId: 'sp_1' }
          : artifactId === 'art_empty'
            ? { id: 'art_empty', title: '空成果', text: '  ' }
            : null
    },
    importer: {
      importText: async (params) => {
        imported.push(params)
        /* 模拟资料库：登记成功后返回一个稳定 id —— 印证「成果 → 来源」这一步真的发生了 */
        return { ok: true, sourceId: 'lib_from_artifact', version: 1 }
      }
    },
    random: () => 0.5
  })
  books.lib_from_artifact = { outcome: 'ok', text, source: { title: '成果：精读笔记' } }

  const fromArtifact = await artifactService.createFromArtifact({
    artifactId: 'art_ok',
    input: { title: '精读笔记', goal: '读完能复述', entry: 'source', spaceId: 'sp_1' }
  })
  ok(fromArtifact.ok === true, '入口四：从成果生成路线', JSON.stringify(fromArtifact))
  ok(imported.length === 1, '先把它登记成一份资料库来源（不是另存一份材料）')
  ok(imported[0].identity === 'text:artifact:art_ok' && imported[0].ref === 'artifact:art_ok', '身份用成果 id：成果改了就是新版本')
  ok(imported[0].owner?.kind === 'artifact' && imported[0].owner?.id === 'art_ok', '来源登记时带上出处（成果 id）')
  ok(imported[0].spaceId === 'sp_1', '来源落在成果所在的空间')
  ok(imported[0].content === text, '材料正文就是成果那一份正文')
  const artCourse = fromArtifact.course
  const artRef = artCourse.units[0].sources[0]
  ok(text.slice(artRef.locator.start, artRef.locator.end) === text, '生成出来的单元指得回真实字符区间')
  ok(artCourse.entryInput === '精读笔记', '入口输入回填成果标题')
  ok(artCourse.entry === 'source', '路线来自资料（entry 为 source）')

  ok((await artifactService.createFromArtifact({ artifactId: 'nope', input: { title: 'x', goal: 'x', entry: 'source' } })).ok === false, '成果不存在就不建课')
  const emptyArt = await artifactService.createFromArtifact({
    artifactId: 'art_empty',
    input: { title: '空成果', goal: 'x', entry: 'source' }
  })
  ok(emptyArt.ok === false && /正文/.test(emptyArt.reason), '成果没正文就不建课')
  ok(imported.length === 1, '失败的两次都没去登记来源')

  /* 宿主没接成果时要不建课，而不是静默建一门空课 */
  const bare = new CourseService({ library: { openRef: async () => ({ outcome: 'ok', text }) } })
  const bareRes = await bare.createFromArtifact({ artifactId: 'art_ok', input: { title: 'x', goal: 'x', entry: 'source' } })
  ok(bareRes.ok === false, '宿主没接成果时如实拒绝')

  /* 临时目录直接删（断言失败时残留一个 tmp 目录无害，好过包一层 try 打乱缩进） */
  await rm(root, { recursive: true, force: true })

  function validateOk(unit) {
    return unit.sources.length > 0 || !!unit.note
  }
}
