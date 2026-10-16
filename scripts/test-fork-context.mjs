export function runForkContextTests(ok, mod) {
  const { FORK_CONTEXT_TAG, forkContextMarker, buildForkContext, hasForkContextEvidence } = mod

  const base = {
    forkId: 'fk-abc123',
    worktree: 'C:/work/pi-desktop-worktrees/git-review',
    repoName: 'pi-desktop',
    env: { branch: 'feat/git-review', detached: false, head: 'a1b2c3d4', ahead: 2, behind: 1, changedCount: 3 },
    source: { sessionId: 'sess-src', cwd: 'C:/work/pi-desktop' },
    refs: null,
    attachments: null
  }

  const text = buildForkContext(base)
  const first = text.split('\n')[0]
  ok(first === forkContextMarker('fk-abc123'), '标记行在正文第一行（能被 grep 到）', first)
  ok(forkContextMarker('x') === `[${FORK_CONTEXT_TAG}:x]`, '标记的形状与交接续接同一套')
  ok(hasForkContextEvidence(text, 'fk-abc123') === true, '证据检测认得自己写出来的正文')
  ok(hasForkContextEvidence(text, 'fk-other') === false, '别的 id 不算数')
  ok(hasForkContextEvidence(text, '') === false, '空 id 一律 false（参数漏了不能说“注过”）')
  ok(hasForkContextEvidence(null, 'fk-abc123') === false, '空文本不算证据')
  ok(
    hasForkContextEvidence(`prefix\n${forkContextMarker('fk-abc123')}\nsuffix`, 'fk-abc123') === true,
    '标记行被别的内容包着也算（内容是整文件包含判断）'
  )

  ok(text.includes('feat/git-review'), '分支名用的是传入的目标工作树分支')
  ok(text.includes('a1b2c3d4'), 'HEAD 用的是传入的短 sha')
  ok(text.includes('3 个未提交变更'), '变更数用的是传入值')
  ok(text.includes('+2/-1'), '领先落后按传入值渲染')
  ok(text.includes('C:/work/pi-desktop-worktrees/git-review'), '写明目标目录（新会话自己的目录）')
  ok(text.includes('sess-src'), '写明来源会话（可追溯，但不带它的历史）')
  ok(/历史没有带过来|没有带过来/.test(text), '如实说明源会话历史没带过来（否则模型会假装记得）')

  const detached = buildForkContext({
    ...base,
    env: { branch: null, detached: true, head: 'deadbee', ahead: 0, behind: 0, changedCount: 0 }
  })
  ok(detached.includes('detached @ deadbee'), 'detached 时不假装有分支名', 'detached @ deadbee')
  ok(!/\+0\/-0/.test(detached), '没有 ahead/behind 时不写 +0/-0（噪音）')

  const noUpstream = buildForkContext({ ...base, env: { ...base.env, ahead: 0, behind: 0 } })
  ok(!noUpstream.includes('相对 upstream'), '没有跟踪差异时不说 upstream')

  ok(!text.includes('交接包'), '交接已退役，正文不再提交接包')

  ok(!text.includes('文件在这个工作树里的对照'), '没有引用时不写对照段')
  const withRefs = buildForkContext({
    ...base,
    refs: {
      total: 3,
      resolved: 2,
      problems: [
        { ref: 'src/main/x.ts', state: 'missing' },
        { ref: 'C:/other/y.ts', state: 'outside' },
        { ref: 'docs/', state: 'type-mismatch' }
      ]
    }
  })
  ok(withRefs.includes('共 3 个，2 个能对上'), '对照段的计数来自传入的 summary')
  ok(withRefs.includes('src/main/x.ts（这个工作树里没有）'), 'missing 说人话')
  ok(withRefs.includes('按设计不迁移'), 'outside 与 missing **分开说**（处置完全不同）')
  ok(withRefs.includes('类型变了'), 'type-mismatch 说清发生了什么')

  const allOk = buildForkContext({ ...base, refs: { total: 2, resolved: 2, problems: [] } })
  ok(allOk.includes('2 个能对上。'), '全部对上时用句号收尾（不列出空的问题项）')
  ok(!allOk.includes('对不上的'), '全部对上时不出现“对不上的”字样')

  ok(!text.includes('附件'), '没有附件信息时不写附件段落（不编造）')
  ok(
    !buildForkContext({ ...base, attachments: { total: 0 } }).includes('附件'),
    '附件数为 0 时也不写这一段（本来就没东西可说）'
  )
  const withAttach = buildForkContext({ ...base, attachments: { total: 3 } })
  ok(withAttach.includes('3 个图片附件'), '有附件时写出个数', '3 个图片附件')
  ok(withAttach.includes('没有带过来'), '附件一律说「没有带过来」（不说会带）')
  ok(!/已带入|已经带过|一并带过/.test(withAttach), '正文里不得出现任何“附件已带过来”的说法')
  ok(withAttach.includes('重新添加'), '给出出口（重新添加），而不是让模型去猜图片内容')

  const noSource = buildForkContext({ ...base, source: null })
  ok(!noSource.includes('来源会话：'), '拿不到来源会话时不写这一行（不填 (未知)）')
  ok(noSource.split('\n')[0] === forkContextMarker('fk-abc123'), '没有来源时标记行照旧在第一行')
}
