/**
 * 项目知识**注入链**的测试（实施-03 S3）。
 *
 * 两条都要验：
 *   · 宿主侧（`src/main/project-knowledge.ts`）：检索结果真的落成文件，
 *     且**关闭时也写**（`enabled:false` / 空块）—— 扩展据此不注入；
 *   · 薄层侧（`resources/pi-extensions/project-knowledge.js`）：只读文件 +
 *     在最后一条 user 消息前插一条独立消息，不做任何检索。
 *
 * 用隔离临时目录，不碰真实用户数据；扩展用假的 `pi`（只收 hook）驱动。
 */
export async function runProjectKnowledgeInjectionTests(ok, modules) {
  const { prepare, store, extension, memory } = modules
  const { mkdtemp, readFile, rm, readdir, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const root = await mkdtemp(join(tmpdir(), 'yan-knowledge-inject-'))
  const sessionId = 'sess-1'
  const identity = { projectId: 'proj-a', cwd: 'C:\\work\\a' }
  const opts = { root }

  const readRecord = async () =>
    JSON.parse(await readFile(prepare.knowledgeInjectPath(sessionId, root), 'utf8'))

  const previousEnv = {
    YAN_DATA_DIR: process.env.YAN_DATA_DIR,
    YAN_SESSION_ID: process.env.YAN_SESSION_ID,
    YAN_KNOWLEDGE_EXT_LOG: process.env.YAN_KNOWLEDGE_EXT_LOG
  }

  /* 取扩展注册进 pi 的那个 before_provider_request handler */
  const loadHandler = () => {
    let handler = null
    extension.default({ on: (name, fn) => { if (name === 'before_provider_request') handler = fn } })
    return handler
  }

  const payloadOf = (text) => ({
    payload: {
      model: 'x',
      messages: [
        { role: 'system', content: '你是砚' },
        { role: 'user', content: '第一句' },
        { role: 'assistant', content: '好的' },
        { role: 'user', content: text }
      ]
    }
  })

  try {
    process.env.YAN_DATA_DIR = root
    process.env.YAN_SESSION_ID = sessionId
    delete process.env.YAN_KNOWLEDGE_EXT_LOG

    /* ── 1. 开关读的是 desktop.json 本身（不经 electron 的 settings 模块） ── */
    await writeFile(join(root, 'desktop.json'), JSON.stringify({ projectKnowledge: { enabled: true } }))
    ok((await prepare.readProjectKnowledgeEnabled(root)) === true, '开关开启时读到 true')
    await writeFile(join(root, 'desktop.json'), JSON.stringify({ projectKnowledge: { enabled: 'yes' } }))
    ok((await prepare.readProjectKnowledgeEnabled(root)) === false, '脏值（字符串 yes）当成关')
    await writeFile(join(root, 'desktop.json'), JSON.stringify({ projectKnowledge: { enabled: false } }))
    ok((await prepare.readProjectKnowledgeEnabled(root)) === false, '明确关掉读到 false')
    await rm(join(root, 'desktop.json'))
    ok((await prepare.readProjectKnowledgeEnabled(root)) === false, '没有 desktop.json 时默认关')

    /* ── 2. 默认关：也要写文件（清掉上一轮） ─────────────────── */
    const disabled = await prepare.prepareProjectKnowledgeInjection({
      sessionId,
      identity,
      queryText: '发布流程怎么走',
      enabled: false,
      root
    })
    ok(disabled.reason === 'disabled' && disabled.block === '', '关闭时不检索、块为空')
    const disabledFile = await readRecord()
    ok(disabledFile.enabled === false, '关闭时文件里写明 enabled:false（扩展据此不注入）')
    ok(disabledFile.block === '', '关闭时文件里不留上一轮的块')

    /* ── 2. 写入一条知识 → 命中 → 落盘 ───────────────────────── */
    const committed = await store.commitKnowledge({
      identity,
      request: {
        expectedRevision: 0,
        kind: 'decision',
        text: '发布流程统一走 npm run dist，先跑完整门槛',
        tags: ['发布'],
        confidenceClass: 'user-confirmed',
        evidence: [{ sessionId: 's1' }]
      },
      hostCheck: { userConfirmed: { sessionId: 's1', quote: '记住：发布流程走 npm run dist' } },
      opts
    })
    ok(committed.ok === true, '前置：知识条目真的写进去了', committed.ok ? '' : committed.message)
    const entryId = committed.ok ? committed.entry.id : ''

    const hit = await prepare.prepareProjectKnowledgeInjection({
      sessionId,
      identity,
      queryText: '这次发布流程怎么走？',
      enabled: true,
      root
    })
    ok(hit.reason === 'ok' && hit.block.length > 0, '开启后命中条目并生成材料块', JSON.stringify(hit.hits))
    ok(hit.hits.some((h) => h.id === entryId), '命中记录里带真实条目 id', JSON.stringify(hit.hits))
    ok(hit.block.includes(entryId), '材料块里带来源 id（可追溯）')
    ok(/不是授权/.test(hit.block), '材料块写明不作为授权')
    const hitFile = await readRecord()
    ok(hitFile.enabled === true && hitFile.block.includes(entryId), '命中内容真的落到了扩展要读的文件里')
    ok(hitFile.tokens > 0, '记录里带 token 估算', String(hitFile.tokens))

    /* ── 3. 无关查询：文件被覆盖成空块（不是留着上一条） ───────── */
    const miss = await prepare.prepareProjectKnowledgeInjection({
      sessionId,
      identity,
      queryText: '数据库连接池要怎么调大',
      enabled: true,
      root
    })
    ok(miss.block === '' && miss.reason === 'no-match', '无关查询零注入', String(miss.reason))
    const missFile = await readRecord()
    ok(missFile.block === '', '无关查询把文件覆盖成空块（不会继续读旧块）')
    ok(!missFile.block.includes(entryId), '旧块的内容确实不在了')

    /* ── 4. 没有项目身份：不检索、不注入 ─────────────────────── */
    const noProject = await prepare.prepareProjectKnowledgeInjection({
      sessionId,
      queryText: '发布流程怎么走',
      enabled: true,
      root
    })
    ok(noProject.reason === 'no-project' && noProject.block === '', '没有项目身份时不检索也不注入')

    /* ── 5. 关闭立即失效：从开到关只需一次 prepare ───────────── */
    await prepare.prepareProjectKnowledgeInjection({
      sessionId,
      identity,
      queryText: '这次发布流程怎么走？',
      enabled: true,
      root
    })
    const beforeClose = await readRecord()
    ok(beforeClose.block.length > 0, '前置：关闭前文件里确实有块')
    await prepare.prepareProjectKnowledgeInjection({
      sessionId,
      identity,
      queryText: '这次发布流程怎么走？',
      enabled: false,
      root
    })
    const afterClose = await readRecord()
    ok(afterClose.block === '' && afterClose.enabled === false, '关闭后同一文件立刻变空（下一轮不注入）')

    /* ── 6. 文件名安全：会话键不能带路径 ─────────────────────── */
    const path = prepare.knowledgeInjectPath('../../etc/passwd', root)
    ok(path.startsWith(prepare.knowledgeInjectDir(root)), '会话键里的路径分隔符被替换（不能写到目录外）', path)
    ok(prepare.knowledgeInjectFileName('a/b\\c:d').indexOf('/') < 0, '文件名里没有分隔符')

    /* ── 7. 扩展：把块插到最后一条 user 消息之前 ─────────────── */
    await prepare.prepareProjectKnowledgeInjection({
      sessionId,
      identity,
      queryText: '这次发布流程怎么走？',
      enabled: true,
      root
    })
    const handler = loadHandler()
    const injected = handler(payloadOf('这次发布流程怎么走？'))
    ok(!!injected, '开启且有块时扩展会改 payload')
    const messages = injected?.messages ?? []
    ok(messages.length === 5, '插入了一条独立消息（不是改写原消息）', String(messages.length))
    const last = messages[messages.length - 1]
    ok(last.role === 'user' && last.content === '这次发布流程怎么走？', '最后一条仍是用户消息（插入位置在它前面）')
    ok(typeof messages[3].content === 'string' && messages[3].content.includes(entryId), '插入的那条就是材料块')
    ok(messages[3].role === 'system', '角色跟随已有系统角色（system / developer）')

    /* ── 8. 幂等：已经在消息里就不重复插 ─────────────────────── */
    const twice = handler(injected)
    ok(twice === undefined, '同一 payload 再跑一次不重复注入')

    /* ── 9. 空块 / 缺会话键：不动 payload ───────────────────── */
    await prepare.prepareProjectKnowledgeInjection({
      sessionId,
      identity,
      queryText: '数据库连接池要怎么调大',
      enabled: true,
      root
    })
    ok(handler(payloadOf('数据库连接池要怎么调大')) === undefined, '空块时扩展不改 payload')
    await prepare.prepareProjectKnowledgeInjection({
      sessionId,
      identity,
      queryText: '这次发布流程怎么走？',
      enabled: true,
      root
    })
    delete process.env.YAN_SESSION_ID
    ok(handler(payloadOf('这次发布流程怎么走？')) === undefined, '没有会话键时不注入（不猜一个会话）')
    process.env.YAN_SESSION_ID = sessionId

    /* ── 10. 诊断：trace 文件记录「注入了什么」 ─────────────── */
    const traceFile = join(root, 'trace.jsonl')
    process.env.YAN_KNOWLEDGE_EXT_LOG = traceFile
    await prepare.prepareProjectKnowledgeInjection({
      sessionId,
      identity,
      queryText: '这次发布流程怎么走？',
      enabled: true,
      root
    })
    handler(payloadOf('这次发布流程怎么走？'))
    const traceText = await readFile(traceFile, 'utf8').catch(() => '')
    const lines = traceText.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    ok(lines.some((line) => line.hook === 'payload' && line.injected === true), 'trace 记下「这一轮注入了」')
    ok(
      lines.some((line) => line.hook === 'inject' && Array.isArray(line.ids) && line.ids.includes(entryId)),
      'trace 记下注入的条目 id'
    )

    /* ── 11. 重新开启并重启（新会话）也要能读到同一份数据 ───── */
    await prepare.prepareProjectKnowledgeInjection({
      sessionId: 'sess-2',
      identity,
      queryText: '发布流程怎么走',
      enabled: true,
      root
    })
    const other = JSON.parse(await readFile(prepare.knowledgeInjectPath('sess-2', root), 'utf8'))
    ok(other.block.length > 0, '另一个会话有自己的一份注入文件（互不覆盖）')
    const files = await readdir(prepare.knowledgeInjectDir(root))
    ok(files.filter((name) => name.endsWith('.json')).length === 2, '两个会话各一档', files.join(','))
    ok(!files.some((name) => name.includes('.tmp')), '没有留下写了一半的临时文件', files.join(','))

    /* ── 12. 存储层不认识注入目录（`_inject` 不是合法 projectId） ─ */
    ok(memory.isSafeProjectId('_inject') === false, '`_inject` 不是合法 projectId（不会与项目数据撞目录）')

    /*
     * ── 13. 证据的路径边界（`yan knowledge propose` 用它拦越界来源）──
     * 只接受**项目内相对路径**：绝对路径 / `..` / 空值 / NUL 全拒。
     * 这里是纯函数层（§4「文本引用不授予读取权限」的第一道门）。
     */
    ok(memory.isSafeRelativeRef('src/main/agent.ts') === true, '项目内相对路径被接受')
    ok(memory.isSafeRelativeRef('docs\\plan\\x.md') === true, 'Windows 风格的相对路径也被接受')
    ok(memory.isSafeRelativeRef('C:/Users/x/y.txt') === false, '绝对路径（盘符）被拒')
    ok(memory.isSafeRelativeRef('/etc/passwd') === false, '绝对路径（POSIX）被拒')
    ok(memory.isSafeRelativeRef('..\\outside.txt') === false, '`..` 越界被拒')
    ok(memory.isSafeRelativeRef('a/../../b') === false, '夹在中间的 `..` 也被拒')
    ok(memory.isSafeRelativeRef('') === false, '空字符串被拒')
    ok(memory.isSafeRelativeRef('a\u0000b') === false, '含 NUL 的引用被拒')
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
}
