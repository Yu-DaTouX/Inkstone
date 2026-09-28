/**
 * 活动档案（实施-25 P01）的单测：契约纯逻辑 + 存储/快照。
 *
 * 为什么值得单测：
 *   · 角色文本决定「日常里的 agent 是不是代码助手」—— 这部分只有一处真源，
 *     搞错不会报错，只会让日常变得没用；
 *   · 「禁哪些工具」写错会表现为「模型说我没有工具」，最容易被当成模型问题；
 *   · 存储的 CAS 与会话键决定「切会话串不串」——串了在界面上看不出来。
 */

const base = { profile: 'daily', activity: 'research' }

export function runAgentProfileTests(ok, mod) {
  const {
    DEFAULT_AGENT_PROFILE,
    DEFAULT_AGENT_ACTIVITY,
    normalizeAgentProfileKind,
    normalizeAgentActivity,
    validateAgentProfile,
    agentRoleSection,
    filterToolsForActivity,
    activityDeniedTools,
    ROLE_SECTION_NAME
  } = mod

  ok(DEFAULT_AGENT_PROFILE === 'auto', '默认档案是 auto（由 agent 按请求自行判断）')
  ok(DEFAULT_AGENT_ACTIVITY === 'answer', '默认活动是 answer')

  /* ---- 枚举归一 ---- */
  ok(normalizeAgentProfileKind('daily') === 'daily', '合法 profile 原样返回')
  ok(normalizeAgentProfileKind('bad') === 'auto', '非法 profile 归一到 auto')
  ok(normalizeAgentActivity('learn') === 'learn', '合法 activity 原样返回')
  ok(normalizeAgentActivity('x') === 'answer', '非法 activity 归一到 answer')

  /* ---- 校验：显式报错，不静默修好 ---- */
  {
    const okProfile = validateAgentProfile({ profile: 'daily', activity: 'learn', spaceId: ' sp1 ' })
    ok(okProfile.ok === true, '合法档案通过校验')
    ok(okProfile.ok === true && okProfile.profile.spaceId === 'sp1', 'id 字段去掉首尾空白')

    const badKind = validateAgentProfile({ profile: 'Daily', activity: 'learn' })
    ok(badKind.ok === false, 'profile 大小写写错就报错（不静默纠正）')

    const badActivity = validateAgentProfile({ profile: 'daily', activity: 'teach' })
    ok(badActivity.ok === false && /activity/.test(badActivity.reason), 'activity 非法时给出可诊断原因')

    const badId = validateAgentProfile({ profile: 'daily', activity: 'answer', spaceId: 'a\u0000b' })
    ok(badId.ok === false, 'id 含控制字符时拒绝')

    ok(validateAgentProfile(null).ok === false, '非对象档案被拒')
  }

  /* ---- 角色分区：coding 不注入，auto / daily 注入 ---- */
  {
    ok(agentRoleSection('coding', 'research') === null, 'coding 档案不注入角色分区（保持 pi 原生）')
    const auto = agentRoleSection('auto', 'answer')
    ok(auto?.name === ROLE_SECTION_NAME, 'auto 档注入角色分区')
    ok(
      /判断/.test(String(auto?.content)) && /代码/.test(String(auto?.content)),
      'auto 档给的是「先判断、再按对应方式做」的准则'
    )
    const research = agentRoleSection('daily', 'research')
    ok(research?.name === ROLE_SECTION_NAME, `角色分区名是 ${ROLE_SECTION_NAME}`, String(research?.name))
    ok(
      /^[a-z][a-z0-9_-]*$/.test(String(research?.name)),
      '分区名符合 pi 的命名约束（否则 buildSystemPromptSections 会抛错）'
    )

    const learn = agentRoleSection('daily', 'learn')
    const compose = agentRoleSection('daily', 'compose')
    ok(!!learn && !!compose && learn.content !== compose.content, '不同活动的角色文本不同')

    const all = ['answer', 'research', 'compose', 'organize', 'learn'].map(
      (a) => agentRoleSection('daily', a)?.content ?? ''
    )
    ok(new Set(all).size === 5, '五个活动各有各的角色文本（不重复）')
    ok(
      all.every((c) => c.includes('日常') || c.includes('学习者')),
      '每条角色文本都点明了所处场景'
    )
    ok(learn?.content.includes('不要直接给答案'), '导师角色明确「先提示、不直接给答案」')
    ok(learn?.content.includes('独立完成'), '导师角色明确「独立完成之前不算掌握」')
  }

  /* ---- 工具策略：只禁必要的，永不禁 bash ---- */
  {
    const all = ['read', 'grep', 'find', 'ls', 'bash', 'write', 'edit']
    const research = filterToolsForActivity('research', all)
    ok(
      !research.includes('write') && !research.includes('edit'),
      '研究活动禁写文件（结论走成果对象）',
      research.join(',')
    )
    ok(research.includes('bash'), '研究活动保留 bash（yan 能力入口不能断）')

    const learn = filterToolsForActivity('learn', all)
    ok(!learn.includes('write') && !learn.includes('edit'), '学习活动禁写文件')
    ok(learn.includes('read') && learn.includes('bash'), '学习活动保留读与 bash')

    const answer = filterToolsForActivity('answer', all)
    ok(answer.length === all.length, '问答不禁任何工具（用户可能就是要它改文件）')

    ok(filterToolsForActivity('answer', all).join(',') === all.join(','), '过滤保持原顺序')
    ok(
      activityDeniedTools('answer').length === 0 && activityDeniedTools('research').length === 2,
      '禁表对外可查（宿主写快照要用）'
    )
  }
}

/** 存储与快照：真临时目录、真原子写。 */export async function runAgentProfileStoreTests(ok, mod, helpers) {
  const { AgentProfileStore, writeAgentProfileSnapshot, sanitizeAgentProfileDocument, normalizeProfileSessionKey, agentProfileSnapshotPath } = mod
  const { mkdtemp, readFile, rm } = helpers
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const root = await mkdtemp(join(tmpdir(), 'yan-profile-'))
  try {
    const store = new AgentProfileStore({ root })

    /* ---- 默认：auto/answer，revision 0（未落盘） ---- */
    {
      const s = store.state('sess-a')
      ok(s.profile === 'auto' && s.activity === 'answer' && s.revision === 0, '没有条目时给默认档案')
    }

    /* ---- 提交 ---- */
    {
      const r = await store.set('sess-a', { profile: 'daily', activity: 'learn' })
      ok(r.ok === true && r.state.activity === 'learn' && r.state.revision === 1, '提交后 revision=1')

      const again = await store.set('sess-a', { activity: 'research' }, 1)
      ok(again.ok === true && again.state.activity === 'research', 'CAS 命中时提交成功')

      const stale = await store.set('sess-a', { activity: 'compose' }, 1)
      ok(
        stale.ok === false && stale.error === 'version-mismatch' && stale.state.activity === 'research',
        'revision 过期时拒绝并返回当前状态（不静默覆盖）'
      )

      const bad = await store.set('sess-a', { profile: 'daily', activity: 'teach' })
      ok(bad.ok === false && bad.error === 'invalid-profile', '非法活动被挡在落盘之前')

      ok((await store.set('', { activity: 'answer' })).error === 'bad-key', '空键被拒')
    }

    /* ---- 会话隔离：B 会话不受 A 影响 ---- */
    {
      const a = store.state('sess-a')
      const b = store.state('sess-b')
      ok(a.activity === 'research' && b.activity === 'answer', '档案按会话隔离，切会话不串')
    }

    /* ---- adopt：迁移不算提交 ---- */
    {
      await store.set('pending:r1', { profile: 'daily', activity: 'compose' })
      const before = store.state('pending:r1').revision
      const adopted = await store.adopt('pending:r1', 'C:/proj/x.jsonl')
      ok(adopted.activity === 'compose', 'pending 档案迁移到稳定键')
      ok(adopted.revision === before, '迁移不算一次用户提交（revision 不变）')
      ok(store.state('pending:r1').revision === 0, '迁移后 pending 键不再持有档案')
    }

    /* ---- 落盘 + 读回 ---- */
    {
      const raw = JSON.parse(await readFile(join(root, 'agent-profiles.json'), 'utf8'))
      ok(raw.version === 1, '文档带 schema 版本')
      ok(!!raw.entries['sess-a'], '会话条目已落盘')

      const reloaded = new AgentProfileStore({ root })
      await reloaded.load()
      ok(reloaded.state('sess-a').activity === 'research', '重启后档案仍在')
    }

    /* ---- 快照：角色文本与工具策略由宿主渲染 ---- */
    {
      const snapPath = agentProfileSnapshotPath('sess-a', root)
      await writeAgentProfileSnapshot('sess-a', store.state('sess-a'), root)
      const snap = JSON.parse(await readFile(snapPath, 'utf8'))
      ok(snap.profile === 'daily' && snap.activity === 'research', '快照带上档案')
      ok(snap.roleSection?.name === 'yan_role' && /研究/.test(snap.roleSection.content), '快照带上渲染好的角色分区')
      ok(Array.isArray(snap.deniedTools) && snap.deniedTools.includes('write'), '快照带上本活动禁用的工具')

      // coding 档案：没有角色分区（扩展据此不注入）
      const coding = { profile: 'coding', activity: 'answer', revision: 1 }
      await writeAgentProfileSnapshot('coding-sess', coding, root)
      const codingSnap = JSON.parse(await readFile(agentProfileSnapshotPath('coding-sess', root), 'utf8'))
      ok(codingSnap.roleSection === null, 'coding 快照的 roleSection 为 null（扩展不注入）')
      ok(Array.isArray(codingSnap.deniedTools) && codingSnap.deniedTools.length === 0, 'coding 不禁用工具')

      /*
       * auto 档：注入自主判断的角色文本，但**不给工具限制** ——
       * 活动是模型当场判断的，拿旧 activity 去禁 write/edit 会让代码会话写不了文件。
       */
      const auto = { profile: 'auto', activity: 'research', revision: 1 }
      await writeAgentProfileSnapshot('auto-sess', auto, root)
      const autoSnap = JSON.parse(await readFile(agentProfileSnapshotPath('auto-sess', root), 'utf8'))
      ok(autoSnap.roleSection?.name === 'yan_role', 'auto 快照带角色分区（模型据此自行判断）')
      ok(Array.isArray(autoSnap.deniedTools) && autoSnap.deniedTools.length === 0, 'auto 不禁用工具（即使上次活动是研究）')
    }

    /* ---- 坏文档：丢掉坏条目，不整体失败 ---- */
    {
      const doc = sanitizeAgentProfileDocument({
        version: 1,
        entries: {
          good: { profile: 'daily', activity: 'learn', revision: 2, updatedAt: 5 },
          badEnum: { profile: 'daily', activity: 'teach', revision: 1, updatedAt: 1 },
          noObject: 'x'
        }
      })
      ok(Object.keys(doc.entries).length === 1 && !!doc.entries.good, '坏条目被丢弃，好条目保留')
      ok(sanitizeAgentProfileDocument(null).entries && Object.keys(sanitizeAgentProfileDocument(null).entries).length === 0, '空文档不报错')
    }

    /* ---- 会话键与 work-mode 同口径 ---- */
    {
      ok(
        normalizeProfileSessionKey('C:\\proj\\a.jsonl\\') === 'C:/proj/a.jsonl',
        '会话键归一化与 work-mode 一致（分隔符/尾斜杠）',
        String(normalizeProfileSessionKey('C:\\proj\\a.jsonl\\'))
      )
      ok(normalizeProfileSessionKey('') === null, '空键返回 null')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/**
 * 薄层扩展的**真实注入行为**（T01-2 / T01-3 / T01-4）。
 *
 * 直接加载 `resources/pi-extensions/profile.js` 并调用它的 `before_agent_start`，
 * 不启动 pi：扩展只读快照文件 + 改 `systemPromptOptions`，这两件事都能在这里钉住。
 */
export async function runAgentProfileExtensionTests(ok, extension, helpers, shared) {
  const { mkdtemp, writeFile, mkdir, rm } = helpers
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const root = await mkdtemp(join(tmpdir(), 'yan-profile-ext-'))
  const prevData = process.env.YAN_DATA_DIR
  const prevSession = process.env.YAN_SESSION_ID
  process.env.YAN_DATA_DIR = root
  process.env.YAN_SESSION_ID = 'runner-1'

  const writeSnapshot = async (record) => {
    await mkdir(join(root, 'agent-profile'), { recursive: true })
    await writeFile(join(root, 'agent-profile', 'runner-1.json'), typeof record === 'string' ? record : JSON.stringify(record), 'utf8')
  }
  const clearSnapshot = async () => {
    await rm(join(root, 'agent-profile'), { recursive: true, force: true })
  }

  const fakePi = (tools) => {
    const handlers = []
    return {
      on: (name, fn) => handlers.push({ name, fn }),
      getActiveTools: () => tools,
      /* pi 对 handler 的同步抛出也会当成失败（它每个 handler 单独 try/catch）；
         这里包一层 Promise，让同步 throw 也能被 allSettled 看到 */
      fire: (event) =>
        handlers
          .filter((h) => h.name === 'before_agent_start')
          .map((h) => Promise.resolve().then(() => h.fn(event)))
    }
  }

  /*
   * 枚举一致性：薄层为了「接口不符预期就显式报错」自己写了一份白名单，
   * 而真源在 `src/shared/agent-profile.ts`。两份曾经漂移（薄层漏了 `auto`），
   * 症状不是「角色没注入」，而是每轮都弹
   * 「扩展出错：档案 profile 取值非法：auto」。所以这里直接断言两份相等，
   * 顺带覆盖顺序 —— 顺序不影响本扩展的行为，但影响「一致」这个词的含义。
   */
  ok(
    extension.PROFILES.join(',') === shared.AGENT_PROFILES.join(','),
    '薄层 PROFILES 与 shared AGENT_PROFILES 一致（防枚举漂移）',
    `${extension.PROFILES} vs ${shared.AGENT_PROFILES}`
  )
  ok(
    extension.ACTIVITIES.join(',') === shared.AGENT_ACTIVITIES.join(','),
    '薄层 ACTIVITIES 与 shared AGENT_ACTIVITIES 一致（防枚举漂移）',
    `${extension.ACTIVITIES} vs ${shared.AGENT_ACTIVITIES}`
  )

  try {
    /* ---- 没有快照：不注入（旧会话保持 pi 原生） ---- */
    {
      await clearSnapshot()
      const pi = fakePi(['read', 'write', 'edit', 'bash'])
      extension.default(pi)
      const options = { sections: {} }
      await Promise.all(pi.fire({ systemPromptOptions: options }))
      ok(Object.keys(options.sections).length === 0, '没有档案快照时不注入角色')
      ok(options.selectedTools === undefined, '没有档案快照时不动工具表')
    }

    /* ---- coding：roleSection 为 null，不注入、不禁工具 ---- */
    {
      await writeSnapshot({ version: 1, profile: 'coding', activity: 'answer', roleSection: null, deniedTools: [] })
      const pi = fakePi(['read', 'write', 'edit', 'bash'])
      extension.default(pi)
      const options = { sections: {} }
      await Promise.all(pi.fire({ systemPromptOptions: options }))
      ok(Object.keys(options.sections).length === 0, 'coding 档案不注入角色分区')
      ok(options.selectedTools === undefined, 'coding 档案不禁用任何工具')
    }

    /* ---- auto（默认档）：注入判断准则，且**不能**被薄层判成非法 ---- */
    {
      await writeSnapshot({
        version: 1,
        profile: 'auto',
        activity: 'answer',
        roleSection: { name: 'yan_role', content: '你先判断这次请求是哪一类，再按那一类的方式做。' },
        deniedTools: []
      })
      const pi = fakePi(['read', 'write', 'edit', 'bash'])
      extension.default(pi)
      const options = { sections: {} }
      const results = await Promise.allSettled(pi.fire({ systemPromptOptions: options }))
      ok(
        results.every((r) => r.status === 'fulfilled'),
        'auto 档案不再被薄层判为非法（回归：界面上的「扩展出错」提示）',
        results.map((r) => (r.status === 'rejected' ? String(r.reason?.message ?? r.reason) : 'ok')).join(' | ')
      )
      ok(options.sections.yan_role?.includes('判断') === true, 'auto 档案注入判断准则分区')
      ok(options.selectedTools === undefined, 'auto 档案不禁用任何工具')
    }

    /* ---- daily + research：注入角色 + 收窄工具（保留 bash） ---- */
    {
      await writeSnapshot({
        version: 1,
        profile: 'daily',
        activity: 'research',
        roleSection: { name: 'yan_role', content: '你正在「日常」模式里做研究。' },
        deniedTools: ['write', 'edit']
      })
      const pi = fakePi(['read', 'write', 'edit', 'bash'])
      extension.default(pi)
      const options = { sections: {}, selectedTools: ['read', 'write', 'edit', 'bash'] }
      await Promise.all(pi.fire({ systemPromptOptions: options }))
      ok(options.sections.yan_role === '你正在「日常」模式里做研究。', 'daily 档案注入角色分区')
      ok(
        Array.isArray(options.selectedTools) && options.selectedTools.join(',') === 'read,bash',
        '研究活动收窄工具但保留 bash（yan 能力入口不能断）',
        JSON.stringify(options.selectedTools)
      )
    }

    /* ---- 本轮上下文（实施-25 P05）：与角色一起注入，但失败口径不同 ---- */
    {
      const writeContext = async (record) => {
        await mkdir(join(root, 'agent-context'), { recursive: true })
        await writeFile(
          join(root, 'agent-context', 'runner-1.json'),
          typeof record === 'string' ? record : JSON.stringify(record),
          'utf8'
        )
      }
      await writeSnapshot({ version: 1, profile: 'daily', activity: 'research', roleSection: { name: 'yan_role', content: '角色' }, deniedTools: [] })
      await writeContext({
        version: 1,
        runtimeKey: 'runner-1',
        activity: 'research',
        section: '### 来源片段\n正文 ⟦s1@1#0-4⟧',
        citations: [],
        budget: {},
        at: ''
      })
      const pi = fakePi(['read'])
      extension.default(pi)
      const options = { sections: {} }
      await Promise.all(pi.fire({ systemPromptOptions: options }))
      ok(
        options.sections.yan_context?.includes('来源片段') === true,
        '有上下文快照时注入 yan_context',
        String(options.sections.yan_context)
      )

      /* 坏 JSON：上下文是增强，不注入、也**不报错**（与档案的显式失败相反） */
      await writeContext('{ 不是 JSON')
      const pi2 = fakePi(['read'])
      extension.default(pi2)
      const options2 = { sections: {} }
      const settled = await Promise.allSettled(pi2.fire({ systemPromptOptions: options2 }))
      ok(settled.every((r) => r.status === 'fulfilled'), '上下文快照坏掉时不报错')
      ok(options2.sections.yan_context === undefined, '坏快照不注入上下文')

      await writeContext({ version: 1, section: '   ' })
      const pi3 = fakePi(['read'])
      extension.default(pi3)
      const options3 = { sections: {} }
      await Promise.all(pi3.fire({ systemPromptOptions: options3 }))
      ok(options3.sections.yan_context === undefined, 'section 为空时不注入空分区')

      await rm(join(root, 'agent-context'), { recursive: true, force: true })
    }

    /* ---- 工具名对象形态（pi 旧版 getActiveTools 返回值）也要兼容 ---- */
    {
      await writeSnapshot({
        version: 1,
        profile: 'daily',
        activity: 'learn',
        roleSection: { name: 'yan_role', content: '导师' },
        deniedTools: ['write', 'edit']
      })
      const pi = fakePi([{ name: 'read' }, { name: 'write' }, { name: 'bash' }])
      extension.default(pi)
      const options = { sections: {}, selectedTools: ['read', 'write', 'bash'] }
      await Promise.all(pi.fire({ systemPromptOptions: options }))
      ok(options.selectedTools.join(',') === 'read,bash', '工具名对象形态同样被过滤', JSON.stringify(options.selectedTools))
    }

    /* ---- 失败显式：结构不符 / 快照坏 / 枚举非法一律报错 ---- */
    {
      await writeSnapshot({ version: 1, profile: 'daily', activity: 'research', roleSection: null, deniedTools: [] })
      const pi = fakePi(['read'])
      extension.default(pi)
      const fired = pi.fire({ prompt: 'x' })
      const results = await Promise.allSettled(fired)
      ok(results.some((r) => r.status === 'rejected'), '没有 systemPromptOptions 时显式报错（不静默退回 coding）')

      await writeSnapshot('{ 不是 JSON')
      const pi2 = fakePi(['read'])
      extension.default(pi2)
      const r2 = await Promise.allSettled(pi2.fire({ systemPromptOptions: { sections: {} } }))
      ok(r2.some((r) => r.status === 'rejected'), '快照不是合法 JSON 时显式报错')

      await writeSnapshot({ version: 1, profile: 'daily', activity: 'teach', roleSection: null, deniedTools: [] })
      const pi3 = fakePi(['read'])
      extension.default(pi3)
      const r3 = await Promise.allSettled(pi3.fire({ systemPromptOptions: { sections: {} } }))
      ok(r3.some((r) => r.status === 'rejected'), 'activity 非法时显式报错')
    }
  } finally {
    if (prevData === undefined) delete process.env.YAN_DATA_DIR
    else process.env.YAN_DATA_DIR = prevData
    if (prevSession === undefined) delete process.env.YAN_SESSION_ID
    else process.env.YAN_SESSION_ID = prevSession
    await rm(root, { recursive: true, force: true })
  }
}
