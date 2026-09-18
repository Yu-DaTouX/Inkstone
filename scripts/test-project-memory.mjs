/**
 * 项目知识存储层（`src/shared/project-memory.ts` + `src/main/project-memory-store.ts`，
 * 实施-03 S2）的测试。
 *
 * 这一片是**唯一真的写项目知识的地方**，所以每条断言都要对着**磁盘上的文件**验，
 * 不能只看返回值 —— 返回值说成功而文件没变（或反过来）正是最坏的失败模式。
 *
 * 覆盖 S2 出口的五条性质：CAS 冲突 / 磁盘写失败 / 崩溃恢复（半写 manifest 保留上一版）/
 * 删除后旧候选不复活 / 过期锁**核实进程**后再回收。
 * 全部用隔离临时目录，不碰真实用户数据。
 */
export async function runProjectMemoryTests(ok, modules) {
  const memory = modules.memory
  const store = modules.store
  const { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } = await import('node:fs/promises')
  const { tmpdir, hostname } = await import('node:os')
  const { join } = await import('node:path')
  const { spawnSync } = await import('node:child_process')

  const root = await mkdtemp(join(tmpdir(), 'yan-project-memory-'))
  const registry = [
    { id: 'proj-a', cwd: 'C:\\work\\a', name: 'A', archived: false, createdAt: 1, updatedAt: 1 },
    { id: 'proj-b', cwd: 'C:\\work\\b', name: 'B', archived: false, createdAt: 1, updatedAt: 1 },
    { id: 'proj-archived', cwd: 'C:\\work\\old', name: 'Old', archived: true, createdAt: 1, updatedAt: 1 }
  ]
  const A = { projectId: 'proj-a', cwd: 'C:\\work\\a' }
  const B = { projectId: 'proj-b', cwd: 'C:\\work\\b' }
  const opts = { root }

  const dirOf = (id) => store.projectMemoryDir(id, root)
  const entryPath = (id, entryId, revision) => store.revisionPath(dirOf(id), entryId, revision)
  const manifestBytes = (id) => readFile(store.manifestPath(dirOf(id)), 'utf8')
  const entryIds = async (id) => {
    const names = await readdir(join(dirOf(id), 'entries')).catch(() => [])
    return names.sort()
  }
  /** 提交一次（正常路径用；失败就抛，免得断言里漏判 ok） */
  const commit = async (identity, request, hostCheck) => {
    const res = await store.commitKnowledge({ identity, request, hostCheck, opts })
    if (!res.ok) throw new Error(`意外失败：${res.code} ${res.message}`)
    return res
  }
  /** 造一个「新建」请求（模型侧形状：只有内容，没有身份 / 置信权） */
  const draft = (extra = {}) => ({ expectedRevision: 0, kind: 'fact', text: '默认文字', ...extra })

  try {
    /* ══════════════════════════════════════════════════════════════
     * 一、纯逻辑：身份只认项目登记
     * ══════════════════════════════════════════════════════════════ */
    console.log('\n--- 1. 项目身份：只认登记，不认自报 / 不认 cwd 反推 ---')
    {
      const good = memory.resolveProjectIdentity('proj-a', registry)
      ok(good.ok && good.identity.projectId === 'proj-a', '登记里的 id 被接受')
      ok(good.ok && good.identity.cwd === 'C:\\work\\a', '身份带上登记里的 cwd（不是调用方给的）')
      const archived = memory.resolveProjectIdentity('proj-archived', registry)
      ok(archived.ok && archived.archived === true, '已归档项目仍可用，但标记 archived')

      const cases = [
        [undefined, 'bad_project_id', '缺 projectId 被拒'],
        ['', 'bad_project_id', '空 projectId 被拒'],
        ['proj-evil', 'unregistered_project', '未登记的 id 被拒（模型自报进不来）'],
        ['../proj-a', 'unregistered_project', '带路径分隔符的 id 被拒'],
        [{ cwd: 'C:\\work\\a' }, 'bad_project_id', '拿 cwd 冒充身份被拒']
      ]
      for (const [value, code, label] of cases) {
        const res = memory.resolveProjectIdentity(value, registry)
        ok(!res.ok && res.code === code, label, res.ok ? '' : res.code)
      }

      const badRegistry = [{ id: '../escape', cwd: 'C:\\work\\x', name: '', archived: false, createdAt: 1, updatedAt: 1 }]
      const badId = memory.resolveProjectIdentity('../escape', badRegistry)
      ok(!badId.ok && badId.code === 'bad_project_id', '登记里形状非法的 id 也不能当目录名')

      ok(memory.registeredProjectIdForCwd('C:\\work\\a', registry) === 'proj-a', '已登记 cwd → 对应 id')
      ok(memory.registeredProjectIdForCwd('C:\\work\\unknown', registry) === undefined, '未登记 cwd 不给 id（不现场派生）')
      ok(memory.registeredProjectIdForCwd(undefined, registry) === undefined, '没有 cwd 不给 id')

      let traversal = null
      try {
        store.projectMemoryDir('../escape', root)
      } catch (err) {
        traversal = err
      }
      ok(traversal?.code === 'bad_project_id', '存储层的目录函数也挡路径穿越')
    }

    /* ══════════════════════════════════════════════════════════════
     * 二、纯逻辑：指纹与校验
     * ══════════════════════════════════════════════════════════════ */
    console.log('\n--- 2. 文本指纹：空白 / 全角半角归一，原文不动 ---')
    {
      const d1 = memory.textDigest('  用 pnpm 而不是 npm  ')
      const d2 = memory.textDigest('用  pnpm\n而不是 npm')
      ok(d1 === d2, '空白差异归一后指纹相同')
      ok(
        memory.textDigest('规则：用 ＡＢＣ 命名') === memory.textDigest('规则:用 ABC 命名'),
        'NFKC 让全角与半角算同一段文字'
      )
      ok(memory.normalizeKnowledgeText('ＡＢＣ：') === 'ABC:', '归一化把全角折成半角（只影响指纹）')
      ok(memory.textDigest('用 pnpm') !== d1, '不同文字指纹不同')
      ok(/^[0-9a-f]{16}$/.test(d1), '指纹是 16 位十六进制', d1)
      ok(memory.normalizeKnowledgeText('a\n\tb') === 'a b', '归一化只影响指纹判定用的形式')
    }

    console.log('\n--- 3. 草稿校验：新写入严格 ---')
    {
      const bad = [
        [{ kind: 'note', text: 'x' }, 'bad_kind', 'kind 只能是四种之一'],
        [{ kind: 'fact', text: '   ' }, 'empty_text', '纯空白的正文被拒'],
        [{ kind: 'fact', text: 123 }, 'empty_text', '非字符串正文被拒'],
        [{ kind: 'fact', text: 'x'.repeat(4001) }, 'text_too_long', '超过 4000 code point 被拒'],
        [{ kind: 'fact', text: '👍'.repeat(4001) }, 'text_too_long', '按 code point 计数（emoji 不算 2）'],
        [{ kind: 'fact', text: 'x', tags: 'a' }, 'bad_tags', 'tags 必须是数组'],
        [{ kind: 'fact', text: 'x', tags: ['a', ''] }, 'bad_tags', '空标签被拒'],
        [{ kind: 'fact', text: 'x', tags: Array.from({ length: 17 }, (_, i) => `t${i}`) }, 'bad_tags', '标签数量超限'],
        [{ kind: 'fact', text: 'x', evidence: [{}] }, 'bad_evidence', '空来源被拒（来源必须可追溯）'],
        [{ kind: 'fact', text: 'x', evidence: [{ file: 'C:\\secret.txt' }] }, 'bad_evidence', '证据里的绝对路径被拒'],
        [{ kind: 'fact', text: 'x', evidence: [{ file: '../../etc/passwd' }] }, 'bad_evidence', '证据里的 .. 被拒'],
        [{ kind: 'fact', text: 'x', validFor: 'main' }, 'bad_valid_for', 'validFor 必须是对象'],
        [{ kind: 'fact', text: 'x', validFor: { paths: ['/abs'] } }, 'bad_valid_for', 'validFor.paths 拒绝绝对路径'],
        [{ kind: 'fact', text: 'x', supersedes: ['../x'] }, 'bad_supersedes', 'supersedes 里的非法 id 被拒'],
        [{ kind: 'fact', text: 'x', confidenceClass: 'probably' }, 'bad_confidence', '认不出的置信类被拒']
      ]
      for (const [raw, code, label] of bad) {
        const res = memory.validateKnowledgeDraft(raw)
        ok(!res.ok && res.code === code, label, res.ok ? '' : res.code)
      }
      const good = memory.validateKnowledgeDraft({
        kind: 'decision',
        text: '界面历史以会话 JSONL 为准',
        tags: ['界面', '会话', '界面'],
        evidence: [{ sessionId: 'abcdef12', excerpt: '以 JSONL 为准' }],
        validFor: { branch: 'main', paths: ['src/main/sessions.ts'] }
      })
      ok(good.ok, '合法草稿通过')
      ok(good.ok && good.value.tags.length === 2, '标签去重')
      ok(good.ok && good.value.evidence[0].sessionId === 'abcdef12', '证据字段保留')
      const emoji = memory.validateKnowledgeDraft({ kind: 'fact', text: '👍'.repeat(4000) })
      ok(emoji.ok, '正好 4000 个 emoji 允许（按 code point）')
    }

    /* ══════════════════════════════════════════════════════════════
     * 三、纯逻辑：状态迁移与 CAS
     * ══════════════════════════════════════════════════════════════ */
    console.log('\n--- 4. 状态迁移（纯 reducer）：CAS / 置信类 / 替代 ---')
    {
      const base = memory.emptyKnowledgeManifest('proj-a', '2026-09-19T00:00:00.000Z')
      /* 每次调用都换一个新 id：真实 store 每次提交都会生成新的 uuid */
      let newIdSeq = 0
      const ctxFor = (extra = {}) => ({
        newId: `k-new-${++newIdSeq}`,
        now: '2026-09-19T01:00:00.000Z',
        current: null,
        digests: new Map(),
        supersedesTargets: new Map(),
        ...extra
      })

      const created = memory.applyKnowledgeCommit(base, draft({ text: '第一条' }), ctxFor())
      ok(created.ok && created.entry.revision === 1, '新建 revision 从 1 开始')
      ok(created.ok && created.entry.status === 'candidate', '没有宿主核实 → 只能是候选')
      ok(created.ok && created.entry.confidenceClass === 'inferred', '默认置信类是 inferred')
      ok(created.ok && created.manifest.revision === 1, 'manifest 也 +1')

      const modelConfirmed = memory.applyKnowledgeCommit(
        base,
        draft({ text: '模型自称用户决定', confidenceClass: 'user-confirmed' }),
        ctxFor()
      )
      ok(
        !modelConfirmed.ok && modelConfirmed.code === 'unconfirmed_confidence',
        '模型自报 user-confirmed 被拒（硬规则）',
        modelConfirmed.ok ? '' : modelConfirmed.code
      )

      const hostConfirmed = memory.applyKnowledgeCommit(
        base,
        draft({ text: '用户明确要求', confidenceClass: 'user-confirmed' }),
        ctxFor({ hostCheck: { userConfirmed: { sessionId: 'abcdef12', quote: '记住这条' } } })
      )
      ok(hostConfirmed.ok && hostConfirmed.entry.status === 'active', '带原话的宿主确认 → 直接生效')

      const verifiedNoEvidence = memory.applyKnowledgeCommit(
        base,
        draft({ text: '声称已验证', confidenceClass: 'verified' }),
        ctxFor({ hostCheck: { evidenceVerified: true } })
      )
      ok(
        !verifiedNoEvidence.ok && verifiedNoEvidence.code === 'missing_evidence',
        'verified 没有证据被拒',
        verifiedNoEvidence.ok ? '' : verifiedNoEvidence.code
      )

      const verified = memory.applyKnowledgeCommit(
        base,
        draft({ text: '宿主核实过', confidenceClass: 'verified', evidence: [{ file: 'src/a.ts' }] }),
        ctxFor({ hostCheck: { evidenceVerified: true } })
      )
      ok(verified.ok && verified.entry.status === 'active', '证据经宿主核实 → 升为生效')

      const candidate = memory.applyKnowledgeCommit(base, draft({ text: '只是候选' }), ctxFor()).entry
      const pointer = {
        id: candidate.id,
        revision: candidate.revision,
        status: candidate.status,
        kind: candidate.kind,
        confidenceClass: candidate.confidenceClass,
        digest: candidate.textDigest,
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt
      }
      const manifest1 = {
        ...base,
        revision: 1,
        entries: [pointer],
        updatedAt: candidate.updatedAt
      }
      const digestMap = new Map([[candidate.textDigest, pointer]])

      const stale = memory.applyKnowledgeCommit(
        manifest1,
        draft({ id: candidate.id, text: '改一版', expectedRevision: 99 }),
        ctxFor({ current: candidate, digests: digestMap })
      )
      ok(stale.ok === false && stale.code === 'stale_revision', 'CAS 冲突报 stale_revision（不静默覆盖）')

      const exists = memory.applyKnowledgeCommit(
        manifest1,
        draft({ id: candidate.id, text: '再建一次' }),
        ctxFor({ current: candidate, digests: digestMap })
      )
      ok(exists.ok === false && exists.code === 'entry_exists', 'expectedRevision=0 但条目已存在 → entry_exists')

      const updated = memory.applyKnowledgeCommit(
        manifest1,
        draft({ id: candidate.id, text: '改一版', expectedRevision: 1 }),
        ctxFor({ current: candidate, digests: digestMap })
      )
      ok(updated.ok && updated.entry.revision === 2, 'CAS 对得上才真的写')
      ok(
        updated.ok && updated.entry.textDigest !== candidate.textDigest,
        '改了正文指纹也跟着变'
      )

      const duplicate = memory.applyKnowledgeCommit(
        manifest1,
        draft({ text: candidate.text }),
        ctxFor({ digests: digestMap })
      )
      ok(duplicate.ok === false && duplicate.code === 'duplicate', '同指纹不接受（不自动替换）')
      ok(duplicate.ok === false && duplicate.existingId === candidate.id, 'duplicate 指出是哪一条（供合并）')

      const deletedPointer = { ...pointer, status: 'deleted' }
      const revives = memory.applyKnowledgeCommit(
        manifest1,
        draft({ text: candidate.text }),
        ctxFor({ digests: new Map([[candidate.textDigest, deletedPointer]]) })
      )
      ok(revives.ok === false && revives.code === 'revives_deleted', '被删过的文字不能再作为新候选复活')

      const confirmedEntry = memory.applyKnowledgeCommit(
        base,
        draft({ text: '用户决定', confidenceClass: 'user-confirmed' }),
        ctxFor({ hostCheck: { userConfirmed: { quote: '记住' } } })
      ).entry
      const confirmedPointer = { ...pointer, id: confirmedEntry.id, digest: confirmedEntry.textDigest, confidenceClass: 'user-confirmed' }
      const downgrade = memory.applyKnowledgeCommit(
        { ...manifest1, entries: [confirmedPointer] },
        draft({ id: confirmedEntry.id, text: '改一下', expectedRevision: 1, confidenceClass: 'inferred' }),
        ctxFor({ current: confirmedEntry })
      )
      ok(
        downgrade.ok === false && downgrade.code === 'downgrade_confirmed',
        '不能让已确认条目悄悄降级',
        downgrade.ok ? '' : downgrade.code
      )

      const supersededThem = { ...candidate, status: 'active' }
      const supersedes = memory.applyKnowledgeCommit(
        { ...manifest1, entries: [{ ...pointer, status: 'active' }] },
        draft({ text: '取代旧决定', supersedes: [candidate.id] }),
        ctxFor({ digests: digestMap, supersedesTargets: new Map([[candidate.id, supersededThem]]) })
      )
      ok(supersedes.ok && supersedes.superseded.length === 1, '显式 supersedes 会替换掉目标')
      ok(
        supersedes.ok && supersedes.superseded[0].status === 'superseded' && supersedes.superseded[0].revision === 2,
        '被替代的条目也走一份新 revision（状态变化也是历史）'
      )
      ok(supersedes.ok && supersedes.entry.supersedes?.[0] === candidate.id, '新条目记下替代关系')

      const unknown = memory.applyKnowledgeCommit(
        manifest1,
        draft({ text: '取代谁？', supersedes: ['k-missing'] }),
        ctxFor({ digests: digestMap })
      )
      ok(unknown.ok === false && unknown.code === 'unknown_supersedes', 'supersedes 指向不存在的条目被拒')

      const selfSupersede = memory.applyKnowledgeCommit(
        manifest1,
        draft({ id: candidate.id, text: '取代自己', expectedRevision: 1, supersedes: [candidate.id] }),
        ctxFor({ current: candidate, digests: digestMap, supersedesTargets: new Map([[candidate.id, candidate]]) })
      )
      ok(selfSupersede.ok === false && selfSupersede.code === 'bad_supersedes', '不能替代自己')

      const full = { ...base, entries: Array.from({ length: 500 }, (_, i) => ({ ...pointer, id: `k-${i}`, digest: `d${i}` })) }
      const over = memory.applyKnowledgeCommit(full, draft({ text: '第 501 条' }), ctxFor())
      ok(over.ok === false && over.code === 'too_many_entries', '超过 500 条被拒（不静默丢）')
    }

    console.log('\n--- 5. 删除语义（纯 reducer） ---')
    {
      const entry = {
        schemaVersion: 1,
        id: 'k-1',
        projectId: 'proj-a',
        revision: 3,
        kind: 'decision',
        status: 'active',
        text: '这条会被删',
        textDigest: memory.textDigest('这条会被删'),
        tags: ['t'],
        evidence: [{ file: 'src/a.ts', excerpt: '摘录' }],
        confidenceClass: 'user-confirmed',
        createdAt: '2026-09-19T00:00:00.000Z',
        updatedAt: '2026-09-19T00:00:00.000Z'
      }
      const manifest = {
        schemaVersion: 1,
        projectId: 'proj-a',
        revision: 3,
        updatedAt: entry.updatedAt,
        entries: [
          {
            id: 'k-1',
            revision: 3,
            status: 'active',
            kind: 'decision',
            confidenceClass: 'user-confirmed',
            digest: entry.textDigest,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt
          }
        ]
      }
      const ctx = { now: '2026-09-19T02:00:00.000Z', current: entry }

      const logical = memory.applyKnowledgeDelete(manifest, { id: 'k-1', expectedRevision: 3, mode: 'logical' }, ctx)
      ok(logical.ok && logical.entry.status === 'deleted', '逻辑删除 → status deleted')
      ok(logical.ok && logical.entry.text === entry.text, '逻辑删除保留正文（可恢复）')
      ok(logical.ok && logical.purgePreviousRevisions === false, '逻辑删除不清正文')
      ok(logical.ok && logical.entry.tombstone?.digest === entry.textDigest, '墓碑记下指纹')

      const noUser = memory.applyKnowledgeDelete(manifest, { id: 'k-1', expectedRevision: 3, mode: 'permanent' }, ctx)
      ok(!noUser.ok && noUser.code === 'not_user_action', '永久删除必须由用户动作发起')

      const permanent = memory.applyKnowledgeDelete(
        manifest,
        { id: 'k-1', expectedRevision: 3, mode: 'permanent', userAction: { by: 'user' } },
        ctx
      )
      ok(permanent.ok && permanent.entry.text === '', '永久删除不留正文')
      ok(permanent.ok && permanent.entry.evidence.length === 0, '永久删除也不留摘录')
      ok(permanent.ok && permanent.purgePreviousRevisions === true, '永久删除要清旧 revision')
      ok(permanent.ok && permanent.entry.tombstone?.textLength === 5, '墓碑只留长度与指纹')
      ok(permanent.ok && permanent.manifest.entries[0].status === 'deleted', 'manifest 指针同步为 deleted')

      const stale = memory.applyKnowledgeDelete(manifest, { id: 'k-1', expectedRevision: 2, mode: 'logical' }, ctx)
      ok(!stale.ok && stale.code === 'stale_revision', '删除也要 CAS')
      const badMode = memory.applyKnowledgeDelete(manifest, { id: 'k-1', expectedRevision: 3, mode: 'hide' }, ctx)
      ok(!badMode.ok && badMode.code === 'bad_mode', '认不出的删除模式被拒')
    }

    console.log('\n--- 6. 读回宽容 + 需复核派生状态 ---')
    {
      const good = {
        schemaVersion: 1,
        id: 'k-1',
        projectId: 'proj-a',
        revision: 2,
        kind: 'fact',
        status: 'active',
        text: '读得回来',
        textDigest: memory.textDigest('读得回来'),
        tags: ['a', 42],
        evidence: [{ file: 'src/a.ts' }, null],
        confidenceClass: 'verified',
        createdAt: '2026-09-19T00:00:00.000Z',
        updatedAt: '2026-09-19T00:00:00.000Z'
      }
      const read = memory.readKnowledgeFile(good)
      ok(!!read && read.id === 'k-1', '正常条目读得回')
      ok(read?.tags.length === 1 && read?.evidence.length === 1, '坏项逐条丢掉，不丢整条')
      ok(memory.readKnowledgeFile({ ...good, schemaVersion: 2 }) === undefined, 'schema 版本对不上就当不认识')
      ok(memory.readKnowledgeFile({ ...good, revision: 0 }) === undefined, 'revision 不是正整数当不认识')
      ok(memory.readKnowledgeFile({ ...good, text: '' }) === undefined, '没有墓碑的空正文当坏文件')
      ok(
        !!memory.readKnowledgeFile({
          ...good,
          status: 'deleted',
          text: '',
          tombstone: { at: '2026-09-19T02:00:00.000Z', digest: good.textDigest, textLength: 4 }
        }),
        '带墓碑的空正文是合法的永久删除形态'
      )

      const entry = memory.readKnowledgeFile({ ...good, validFor: { branch: 'release', paths: ['src/a.ts'] } })
      ok(memory.knowledgeNeedsReview(entry, { branch: 'main' }) === true, '分支变了 → 需复核')
      ok(memory.knowledgeNeedsReview(entry, { branch: 'release', existingPaths: ['src/a.ts'] }) === false, '分支与文件都在 → 不用复核')
      ok(memory.knowledgeNeedsReview(entry, { branch: 'release', existingPaths: ['src/b.ts'] }) === true, '引用的文件没了 → 需复核')
      ok(memory.knowledgeNeedsReview(entry, { branch: 'release' }) === false, '拿不到文件清单时不乱报')
    }

    /* ══════════════════════════════════════════════════════════════
     * 七、存储层：真实文件
     * ══════════════════════════════════════════════════════════════ */
    console.log('\n--- 7. 落盘：不可变 revision + 原子 manifest ---')
    {
      const res = await commit(A, draft({ text: '第一条真正落盘的知识', tags: ['落盘'] }))
      const ids = await entryIds('proj-a')
      ok(ids.length === 1 && ids[0] === res.entry.id, '目录里按条目 id 建了子目录', ids.join(','))
      const raw = JSON.parse(await readFile(entryPath('proj-a', res.entry.id, 1), 'utf8'))
      ok(raw.text === '第一条真正落盘的知识' && raw.revision === 1, 'revision 文件里有正文（不可变）')
      const manifest = JSON.parse(await manifestBytes('proj-a'))
      ok(manifest.revision === 1 && manifest.entries.length === 1, 'manifest 记下指针与版本')
      ok(manifest.entries[0].digest === res.entry.textDigest, 'manifest 里只有指纹，没有正文')
      ok(!(await manifestBytes('proj-a')).includes('第一条真正落盘的知识'), 'manifest 里搜不到正文')
      ok(
        store.tempPathFor(store.manifestPath(dirOf('proj-a')), 9).startsWith(dirOf('proj-a')),
        '临时文件与目标同目录（同卷才可能原子 rename）',
        store.tempPathFor(store.manifestPath(dirOf('proj-a')), 9)
      )

      const listed = await store.listKnowledge(A, opts)
      ok(listed.length === 1 && listed[0].text === '第一条真正落盘的知识', 'listKnowledge 读回正文')

      const read = await store.readKnowledge(A, res.entry.id, opts)
      ok(read?.revision === 1, 'readKnowledge 读回同一版本')

      const second = await commit(A, draft({ text: '第二条', kind: 'constraint' }))
      ok((await store.listKnowledge(A, opts)).length === 2, '第二条也进列表')
      ok(second.manifest.revision === 2, 'manifest 版本递增')
      ok(await store.listKnowledge(B, opts).then((list) => list.length === 0), 'B 项目读不到 A 的知识（物理隔离）')

      /* 崩溃留下的半写文件：抢到锁之后应当被收掉（否则会惍惍攒垃圾） */
      const stale1 = `${store.manifestPath(dirOf('proj-a'))}.12345.1.tmp`
      const stale2 = `${entryPath('proj-a', res.entry.id, 7)}.12345.1.tmp`
      await writeFile(stale1, 'half', 'utf8')
      await writeFile(stale2, 'half', 'utf8')
      await commit(A, draft({ text: '顺手收掉垃圾临时文件' }))
      ok(await readFile(stale1, 'utf8').then(() => false).catch(() => true), '抢到锁后收掉 manifest 遗留的临时文件')
      ok(await readFile(stale2, 'utf8').then(() => false).catch(() => true), '条目目录里的临时文件也被收掉')
    }

    console.log('\n--- 8. CAS 冲突（对着真文件） ---')
    {
      const first = await commit(A, draft({ text: '会被并发改的那条', tags: ['cas'] }))
      const before = await manifestBytes('proj-a')
      const conflict = await store.commitKnowledge({
        identity: A,
        request: { id: first.entry.id, kind: 'fact', text: '改一版', expectedRevision: 99 },
        opts
      })
      ok(!conflict.ok && conflict.code === 'stale_revision', '陈旧 revision 被拒', conflict.ok ? '' : conflict.code)
      ok(!conflict.ok && conflict.latest?.revision === 1, '冲突时交回磁盘上的最新版本（供合并）')
      ok(
        !conflict.ok && conflict.latestManifest?.revision === first.manifest.revision,
        '冲突时也交回最新 manifest'
      )
      ok((await manifestBytes('proj-a')) === before, '冲突后 manifest 一个字节没变')
      ok(await readFile(entryPath('proj-a', first.entry.id, 2), 'utf8').then(() => false).catch(() => true), '冲突没有留下 r2')

      const good = await store.commitKnowledge({
        identity: A,
        request: { id: first.entry.id, kind: 'fact', text: '改一版', expectedRevision: 1 },
        opts
      })
      ok(good.ok && good.entry.revision === 2, '对得上 revision 的更新成功')
      const files = await readdir(join(dirOf('proj-a'), 'entries', first.entry.id))
      ok(files.sort().join(',') === 'r1.json,r2.json', '旧 revision 仍在（不可变历史）', files.join(','))
    }

    console.log('\n--- 9. 磁盘写失败：manifest 保持上一版 ---')
    {
      /* (a) 正文写不进去：先把 revision 的目标路径占成目录 */
      const blocked = 'k-blocked00000'
      const before = await manifestBytes('proj-a')
      const beforeList = await store.listKnowledge(A, opts)
      await mkdir(entryPath('proj-a', blocked, 1), { recursive: true })
      let caught = null
      try {
        await commit(A, { expectedRevision: 0, kind: 'fact', text: '写不进去的正文', id: blocked })
      } catch (err) {
        caught = err
      }
      ok(caught?.code === 'write_failed', '正文写不进去报 write_failed', caught?.code)
      ok((await manifestBytes('proj-a')) === before, '正文失败后 manifest 没变')
      ok((await store.listKnowledge(A, opts)).length === beforeList.length, '失败的条目没有被算进去')

      /* (b) manifest 提交阶段失败：把备份位置占成目录 */
      const beforeManifest = await manifestBytes('proj-a')
      await rm(store.manifestBackupPath(dirOf('proj-a')), { recursive: true, force: true })
      await mkdir(store.manifestBackupPath(dirOf('proj-a')), { recursive: true })
      caught = null
      try {
        await commit(A, draft({ text: '这一步会在提交索引时失败' }))
      } catch (err) {
        caught = err
      }
      ok(caught?.code === 'write_failed', 'manifest 阶段失败也报 write_failed', caught?.code)
      ok((await manifestBytes('proj-a')) === beforeManifest, 'manifest 仍是上一版（没有被半份替换）')
      const manifestNow = JSON.parse(await manifestBytes('proj-a'))
      ok(
        manifestNow.revision === JSON.parse(beforeManifest).revision,
        `manifest 版本没有涨（实际 ${manifestNow.revision}）`
      )
      ok(
        !(await store.listKnowledge(A, opts)).some((entry) => entry.text === '这一步会在提交索引时失败'),
        '没有提交成功的知识不会出现在列表里'
      )
      await rm(store.manifestBackupPath(dirOf('proj-a')), { recursive: true, force: true })
    }

    console.log('\n--- 10. 崩溃恢复：半写 manifest 保留上一版 ---')
    {
      const target = await commit(B, draft({ text: '崩溃恢复前的第一条' }))
      const second = await commit(B, { expectedRevision: 1, kind: 'fact', text: '崩溃恢复前的第二条', id: target.entry.id })
      const goodManifest = await manifestBytes('proj-b')
      const good = JSON.parse(goodManifest)
      ok(
        good.revision === second.manifest.revision && good.entries[0].revision === 2,
        `崩溃前的状态：manifest ${good.revision} / 条目 revision 2`
      )

      /* (a) 半写的 manifest（JSON 截断）→ 退回备份 */
      await writeFile(store.manifestPath(dirOf('proj-b')), goodManifest.slice(0, Math.floor(goodManifest.length / 2)), 'utf8')
      const recovered = await store.loadManifest('proj-b', opts)
      ok(recovered.status === 'recovered' && recovered.reason === 'backup', '半写 manifest → 从备份恢复', recovered.status)
      const restored = recovered.status === 'recovered' ? recovered.manifest : null
      ok(
        !!restored && restored.revision === second.manifest.revision - 1,
        `恢复的是**上一版**（实际 ${restored?.revision}）`
      )
      ok(!!restored && restored.entries[0].revision === 1, '上一版里条目还是 revision 1')
      const after = await store.loadManifest('proj-b', opts)
      ok(after.status === 'ok', '恢复后主文件被写回（下一次读就是正常的 ok）')
      ok((await store.listKnowledge(B, opts))[0].text === '崩溃恢复前的第一条', '列表回到上一版的正文')

      /* (b) 合法 JSON 但形状不对 → 同样走备份 */
      await writeFile(store.manifestPath(dirOf('proj-b')), '{}\n', 'utf8')
      const recovered2 = await store.loadManifest('proj-b', opts)
      ok(recovered2.status === 'recovered' && recovered2.reason === 'backup', '形状不对的 manifest 也走备份恢复')

      /* (c) 主文件与备份都没了 → 从 revision 文件重建索引 */
      await rm(store.manifestPath(dirOf('proj-b')), { force: true })
      await rm(store.manifestBackupPath(dirOf('proj-b')), { force: true })
      /* 再留一个「写了一半」的高 revision，重建必须跳过它 */
      await writeFile(entryPath('proj-b', target.entry.id, 99), '{"schemaVersion":1,"id":', 'utf8')
      const rebuilt = await store.loadManifest('proj-b', opts)
      ok(rebuilt.status === 'recovered' && rebuilt.reason === 'rebuild', 'manifest 全丢 → 从 revision 重建', rebuilt.status)
      const rebuiltManifest = rebuilt.status === 'recovered' ? rebuilt.manifest : null
      ok(!!rebuiltManifest && rebuiltManifest.entries.length === 1, '重建出一条指针')
      ok(
        !!rebuiltManifest && rebuiltManifest.entries[0].revision === 2,
        `重建取最高的**可解析** revision（实际 ${rebuiltManifest?.entries[0].revision}）`
      )
      ok((await store.listKnowledge(B, opts))[0].text === '崩溃恢复前的第二条', '重建后读到的是完整的最高一版')

      /* (d) manifest 与备份都坏、又没有可重建的正文 → unreadable，且拒绝写入 */
      const brokenProj = { projectId: 'proj-broken', cwd: 'C:\\work\\broken' }
      const brokenDir = dirOf('proj-broken')
      await mkdir(brokenDir, { recursive: true })
      await writeFile(store.manifestPath(brokenDir), 'not json', 'utf8')
      await writeFile(store.manifestBackupPath(brokenDir), 'also not json', 'utf8')
      const unreadable = await store.loadManifest('proj-broken', opts)
      ok(unreadable.status === 'unreadable', '两边都坏且无可重建 → unreadable（不当成空库）', unreadable.status)
      let refused = null
      try {
        await commit(brokenProj, draft({ text: '在状态不明时写入' }))
      } catch (err) {
        refused = err
      }
      ok(refused?.code === 'read_failed', '状态不明时拒绝写入（否则等于用空库覆盖）', refused?.code)
    }

    console.log('\n--- 11. 删除后旧候选不复活 ---')
    {
      const secret = '绝密的用户决定：只有 A 项目知道'
      const created = await commit(A, draft({ text: secret, kind: 'decision' }))
      await commit(A, draft({ text: secret.replace('只有', '只给'), kind: 'decision' }))
      const logical = await store.deleteKnowledge({
        identity: A,
        request: { id: created.entry.id, expectedRevision: 1, mode: 'logical' },
        opts
      })
      ok(logical.ok && logical.entry.status === 'deleted', '逻辑删除成功')
      ok(logical.ok && logical.purgedRevisions === 0, '逻辑删除不清正文')
      const listed = await store.listKnowledge(A, opts)
      ok(!listed.some((entry) => entry.id === created.entry.id), '逻辑删除后立刻不在可检索集里')
      const withDeleted = await store.listKnowledge(A, { ...opts, includeDeleted: true })
      ok(
        withDeleted.some((entry) => entry.id === created.entry.id && entry.text === secret),
        '带 includeDeleted 仍读得到正文（数据层可恢复）'
      )
      const revive = await store.commitKnowledge({ identity: A, request: draft({ text: secret }), opts })
      ok(!revive.ok && revive.code === 'revives_deleted', '同一段文字再提一次被拒（旧候选不复活）', revive.ok ? '' : revive.code)

      /* 永久删除：正文真的不再留在磁盘上 */
      const permanentTarget = await commit(A, draft({ text: '这条要永久删掉', kind: 'fact' }))
      const permanent = await store.deleteKnowledge({
        identity: A,
        request: { id: permanentTarget.entry.id, expectedRevision: 1, mode: 'permanent', userAction: { by: 'user' } },
        opts
      })
      ok(permanent.ok && permanent.purgedRevisions === 1, '永久删除清掉了旧的正文 revision', String(permanent.purgedRevisions))
      const files = await readdir(join(dirOf('proj-a'), 'entries', permanentTarget.entry.id))
      ok(files.join(',') === 'r2.json', '只剩墓碑那一份', files.join(','))
      const tombstone = await store.readKnowledge(A, permanentTarget.entry.id, opts)
      ok(tombstone?.text === '' && !!tombstone?.tombstone, '读回的是无正文墓碑')
      ok(tombstone?.tombstone?.digest === permanentTarget.entry.textDigest, '墓碑指纹与被删正文一致')

      const allText = await readAllText(dirOf('proj-a'))
      ok(!allText.includes('这条要永久删掉'), '项目目录里搜不到被永久删除的正文')
      const revivePermanent = await store.commitKnowledge({
        identity: A,
        request: draft({ text: '这条要永久删掉' }),
        opts
      })
      ok(
        !revivePermanent.ok && revivePermanent.code === 'revives_deleted',
        '永久删除后同一段文字不能复活',
        revivePermanent.ok ? '' : revivePermanent.code
      )

      const permanent2 = await store.deleteKnowledge({
        identity: A,
        request: { id: permanentTarget.entry.id, expectedRevision: 2, mode: 'permanent', userAction: { by: 'user' } },
        opts
      })
      ok(!permanent2.ok && permanent2.code === 'deleted_entry', '重复删除被拒')
    }

    console.log('\n--- 12. 排他锁：过期也要核实进程才回收 ---')
    {
      const dir = dirOf('proj-a')
      const lockFile = store.lockPath(dir)
      const beforeList = await store.listKnowledge(A, opts)
      /** 刚过期（1 秒前）的锁：主要用来观察「进程是否活着」这条判据 */
      const writeLock = (record) =>
        writeFile(
          lockFile,
          JSON.stringify({
            at: new Date(Date.now() - 2000).toISOString(),
            expiresAt: new Date(Date.now() - 1000).toISOString(),
            ...record
          }),
          'utf8'
        )

      /* 正常路径：提交完锁就没了 */
      await commit(A, draft({ text: '锁的正常路径' }))
      ok(await readFile(lockFile, 'utf8').then(() => false).catch(() => true), '正常提交后锁文件被释放')

      /* (a) 持有者进程**还活着**（就是本进程）+ 锁已过期 → 不能抢 */
      await writeLock({ pid: process.pid, host: hostname(), token: 'alive-holder' })
      const locked = await store
        .commitKnowledge({ identity: A, request: draft({ text: '别人还在写' }), opts: { ...opts, lockWaitMs: 150 } })
        .then(() => null)
        .catch((err) => err)
      ok(locked?.code === 'locked', '持有者进程还活着 → 抢不到锁（即使 TTL 过期）', locked?.code)
      ok(
        JSON.parse(await readFile(lockFile, 'utf8')).token === 'alive-holder',
        '抢不到锁时没有动别人的锁文件'
      )

      /* (b) 持有者进程**已经死了**（真起子进程再等它退出）→ 核实后回收 */
      const deadPid = findDeadPid(spawnSync, process.execPath)
      ok(deadPid !== null, '找到一个确实已退出的 pid', String(deadPid))
      ok(store.isProcessAlive(deadPid) === false, `真的死掉的 pid（${deadPid}）被判为不活着`)
      ok(store.isProcessAlive(process.pid) === true, '当前进程被判为活着')
      ok(store.isProcessAlive(0) === false && store.isProcessAlive('x') === false, '非法 pid 一律当不活着')
      await writeLock({ pid: deadPid, host: hostname(), token: 'dead-holder' })
      const reclaimed = await store.commitKnowledge({
        identity: A,
        request: draft({ text: '死进程留下的锁可以回收' }),
        opts: { ...opts, lockWaitMs: 2000 }
      })
      ok(reclaimed.ok, '过期锁的持有者已死 → 核实后回收并写入成功', reclaimed.ok ? '' : reclaimed.code)
      ok(await readFile(lockFile, 'utf8').then(() => false).catch(() => true), '回收后锁被释放')

      /* (c) 认不出的锁文件（写了一半）→ 等一小段宽限期才敢收 */
      await writeFile(lockFile, '{"pid":', 'utf8')
      const waitShort = await store
        .commitKnowledge({ identity: A, request: draft({ text: '宽限期内不抢' }), opts: { ...opts, lockWaitMs: 150 } })
        .then(() => null)
        .catch((err) => err)
      ok(waitShort?.code === 'locked', '刚出现的半写锁文件不会被抢（避免打断别人的创建）', waitShort?.code)
      const old = new Date(Date.now() - 60_000)
      await utimes(lockFile, old, old)
      const waitLong = await store.commitKnowledge({
        identity: A,
        request: draft({ text: '宽限期后收掉垃圾锁' }),
        opts: { ...opts, lockWaitMs: 2000 }
      })
      ok(waitLong.ok, '超过宽限期的半写锁文件被当作垃圾收掉')

      /* (d) 别的主机留下的锁：无法核实进程 → 宽限期内不抢 */
      await writeLock({ pid: 4242, host: 'another-machine', token: 'foreign' })
      const foreign = await store
        .commitKnowledge({ identity: A, request: draft({ text: '别的主机' }), opts: { ...opts, lockWaitMs: 200 } })
        .then(() => null)
        .catch((err) => err)
      ok(foreign?.code === 'locked', '别的主机的锁不能核实进程 → 宽限期内不抢', foreign?.code)
      await rm(lockFile, { force: true })
      ok((await store.listKnowledge(A, opts)).length >= beforeList.length, '锁的测试没有破坏既有数据')
    }

    /* ══════════════════════════════════════════════════════════════
     * 八、读路径的容错
     * ══════════════════════════════════════════════════════════════ */
    console.log('\n--- 13. 读路径容错 + 与旧存储无关 ---')
    {
      /* 指针在、正文缺失：展示路径退回更早的完好 revision，写入路径拒绝 */
      const res = await commit(A, { expectedRevision: 0, kind: 'fact', text: '第一版', id: 'k-fallback000' })
      await commit(A, { expectedRevision: 1, kind: 'fact', text: '第二版', id: res.entry.id })
      await rm(entryPath('proj-a', res.entry.id, 2))
      const fallback = await store.readKnowledge(A, res.entry.id, opts)
      ok(fallback?.text === '第一版', '正文缺失时退回上一份完好的 revision（展示路径）')
      const writeFail = await store
        .commitKnowledge({ identity: A, request: { id: res.entry.id, kind: 'fact', text: '第三版', expectedRevision: 2 }, opts })
        .then(() => null)
        .catch((err) => err)
      ok(writeFail?.code === 'read_failed', '写入路径读不到当前版本就拒绝（不拿旧版本做 CAS）', writeFail?.code)

      /* 旧记忆存储：不读、不转换、不碰（用真实文件证明） */
      const legacy = join(dirOf('proj-a'), 'memory.json')
      await writeFile(legacy, JSON.stringify([{ text: '旧记忆条目' }]), 'utf8')
      const list = await store.listKnowledge(A, opts)
      ok(!list.some((entry) => entry.text === '旧记忆条目'), '旧 memory.json 不会被读成项目知识')
      ok((await readFile(legacy, 'utf8')).includes('旧记忆条目'), '旧文件逐字节没被动过')
      await rm(legacy)

      const missing = await store.listKnowledge({ projectId: 'proj-empty', cwd: 'C:\\work\\empty' }, opts)
      ok(missing.length === 0, '从没用过的项目 → 空列表（不是错误）')
      const manifestMissing = await store.loadManifest('proj-empty', opts)
      ok(manifestMissing.status === 'missing', '没有数据时 loadManifest 报 missing')
    }

    console.log('\n--- 14. 分叉：两个工作树各自独立的知识 ---')
    {
      await commit(A, draft({ text: 'A 工作树的事实', tags: ['wt'] }))
      await commit(B, draft({ text: 'B 工作树的事实', tags: ['wt'] }))
      const a = await store.listKnowledge(A, opts)
      const b = await store.listKnowledge(B, opts)
      ok(a.some((entry) => entry.text === 'A 工作树的事实'), 'A 读得到自己的')
      ok(!a.some((entry) => entry.text === 'B 工作树的事实'), 'A 读不到 B 的')
      ok(b.some((entry) => entry.text === 'B 工作树的事实'), 'B 读得到自己的')
      ok(dirOf('proj-a') !== dirOf('proj-b'), '两个项目两个目录（隔离不靠查询条件）')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  /** 把一个目录下所有文件的内容拼起来（搜正文用） */
  async function readAllText(dir) {
    let text = ''
    for (const name of await readdir(dir).catch(() => [])) {
      const full = join(dir, name)
      if ((await stat(full).catch(() => null))?.isDirectory()) text += await readAllText(full)
      else text += await readFile(full, 'utf8').catch(() => '')
    }
    return text
  }
}

/**
 * 找一个**确实已经退出**的 pid。
 *
 * 不用 `999999` 这种「大概没人用」的号：那验的是「猜」而不是「核实」；
 * 也不用刚 spawn 完就扔掉的 pid —— Windows 上可能已经被复用。
 * 这里真起子进程、等它退出，再确认 `kill(pid, 0)` 报不在。
 */
function findDeadPid(spawnSync, execPath) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const child = spawnSync(execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8' })
    const pid = typeof child.pid === 'number' && child.pid > 0 ? child.pid : null
    if (pid !== null) {
      try {
        process.kill(pid, 0)
      } catch (err) {
        if (err?.code === 'ESRCH') return pid
      }
    }
  }
  return null
}
