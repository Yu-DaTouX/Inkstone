/**
 * Git **写操作**的纯逻辑单测（不建仓库、不启动 Electron、不花 token）。
 *
 * 这批测试盯的是三件「错了会很贵」的事：
 *   1. **失败分类**：用户点提交失败后看到的那句话是他唯一的线索。
 *      身份未配置、hook 拒绝、lock、非快进、认证失败 —— 每一种要找的东西
 *      都不同，混成「操作失败」等于把排查成本全推给用户。
 *      这里喂的是**真 git 的原文**（在 `test-git-repo.mjs` 里会再核对关键几条）。
 *   2. **版本摘要**：`digestOf` 用长度前缀拼接，不是分隔符 —— 用 `\n` 拼的话
 *      「一个叫 `a\nb` 的文件」与「两个文件 a、b」会算出同一个摘要，
 *      于是「内容变了但摘要没变」，乐观并发的检查直接失效。
 *   3. **命令构造**：`--` 终止符、unborn 仓库要绕开 `HEAD`、创建分支的
 *      两种走法。这些参数错了 git 要么报错要么**做错事**。
 *
 * 用法：npm run test:unit（由 test-unit.mjs 调起）
 */

export async function runGitActionTests(ok) {
  const {
    classifyGitFailure,
    validateCommitMessage,
    validateBranchName,
    digestOf,
    expectedMismatch,
    buildStageArgs,
    buildStageAllArgs,
    buildUnstageArgs,
    buildUnstageAllArgs,
    buildCommitArgs,
    buildSwitchArgs,
    buildCreateBranchArgs,
    buildPushArgs,
    buildFetchArgs,
    buildSetUpstreamAfterCreateArgs,
    summarizeFiles,
    timeoutFailure,
    staleFailure,
    MAX_COMMIT_MESSAGE,
    MAX_ACTION_PATHS
  } = await import('../out/test/git-actions.mjs')

  const j = (...parts) => JSON.stringify(parts)

  /* ══════════════════════════ 1. 失败分类 ══════════════════════════ */

  console.log('\n--- 1. git 失败原因的分类（真 git 原文）---')

  /* 这一组是**真实输出**，逐条对照过（见 test-git-repo.mjs 的对应用例） */
  const cases = [
    [
      'identity',
      'Author identity unknown\n\n*** Please tell me who you are.\n\nRun\n\n  git config --global user.email "you@example.com"\n  git config --global user.name "Your Name"\n\nto set your account\'s default identity.',
      '身份未配置'
    ],
    ['sign', 'error: gpg failed to sign the data\nfatal: failed to write commit object', '签名失败'],
    ['hook', 'husky - pre-commit hook exited with code 1 (error)', 'hook 拒绝（husky 写法）'],
    ['hook', 'pre-commit hook declined', 'hook 拒绝（declined 写法）'],
    ['lock', "fatal: Unable to create 'C:/x/.git/index.lock': File exists.", 'index.lock 冲突'],
    ['lock', 'fatal: Unable to create \'C:/x/.git/refs/heads/main.lock\': File exists.', 'refs 锁冲突'],
    [
      'conflict',
      'error: Committing is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use \'git add/rm <file>\'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.',
      '未解决的冲突'
    ],
    [
      'dirty-blocks-switch',
      'error: Your local changes to the following files would be overwritten by checkout:\n\tb.txt\nPlease commit your changes or stash them before you switch branches.\nAborting',
      '脏工作区阻止切换（git 自己的判据）'
    ],
    ['branch-in-use', "fatal: 'main' is already checked out at 'C:/other/worktree'", '分支被别的 worktree 占用'],
    ['branch-exists', "fatal: a branch named 'feat' already exists", '分支已存在'],
    ['auth', "fatal: could not read Username for 'https://github.com': terminal prompts disabled", '认证失败（无终端）'],
    ['auth', "fatal: Authentication failed for 'https://github.com/a/b.git/'", '认证失败（口令）'],
    [
      'no-upstream',
      'fatal: The current branch feat has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n    git push --set-upstream origin feat\n',
      '没有上游'
    ],
    [
      'non-fast-forward',
      "To github.com:a/b.git\n ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs to 'github.com:a/b.git'\nhint: Updates were rejected because the tip of your current branch is behind",
      '非快进被拒'
    ],
    ['no-remote', "fatal: 'origin' does not appear to be a git repository", '远程不存在'],
    ['unborn', "fatal: your current branch 'main' does not have any commits yet", '无首提交'],
    ['nothing-to-commit', 'nothing to commit, working tree clean', '无可提交内容'],
    [
      'path-rejected',
      "error: pathspec 'gone.txt' did not match any file(s) known to git",
      '路径不在仓库里'
    ]
  ]
  for (const [code, text, label] of cases) {
    const f = classifyGitFailure(text)
    ok(f.code === code, `分类为 ${code}：${label}`, j(f.code, code))
    ok(!!f.detail && f.detail.length > 0, `${code} 保留 git 原文（排查第一现场）`)
    ok(typeof f.message === 'string' && f.message.length > 0, `${code} 有一句人话说明`)
  }

  /* 未识别的一律 unknown，且**不许**编造原因 */
  const weird = classifyGitFailure('fatal: something nobody has seen before')
  ok(weird.code === 'unknown', '没见过的报错归为 unknown（不猜原因）', j(weird.code))
  ok(weird.retrySafe === false, 'unknown 不允许自动重试', j(weird.retrySafe))
  ok(weird.detail === 'fatal: something nobody has seen before', 'unknown 原样保留输出', j(weird.detail))

  /* 重试安全性：明确没做任何事的安全，可能已经做了的不安全 */
  ok(classifyGitFailure(cases[0][1]).retrySafe === true, '身份未配置：配好就能重试（安全）')
  ok(timeoutFailure('killed').retrySafe === false, '超时 → 不能无条件重试（提交可能已完成）')
  ok(timeoutFailure().code === 'timeout', 'timeoutFailure 的码')
  ok(staleFailure(['HEAD']).code === 'stale', 'staleFailure 的码')
  ok(staleFailure(['HEAD', '暂存区']).detail === 'HEAD、暂存区', 'stale 说清是哪个分量变了')

  /* ══════════════════════════ 2. 输入校验 ══════════════════════════ */

  console.log('\n--- 2. 提交说明与分支名 ---')

  ok(validateCommitMessage('fix: 修一个 bug') === null, '正常说明通过')
  ok(validateCommitMessage('标题\n\n正文第一段\n第二行') === null, '多行说明通过（-m 会保留换行）')
  ok(validateCommitMessage('')?.code === 'empty-message', '空说明被拦（不交给 git 报英文错）')
  ok(validateCommitMessage('   \n\t ')?.code === 'empty-message', '只有空白的说明被拦')
  ok(validateCommitMessage('x'.repeat(MAX_COMMIT_MESSAGE + 1))?.code === 'invalid-input', '超长说明被拦')

  ok(validateBranchName('feat/git-review') === null, '正常分支名通过')
  ok(validateBranchName('') !== null, '空分支名被拦')
  ok(validateBranchName('-x') !== null, '以 - 开头被拦（会在命令行里变成选项）')
  ok(validateBranchName('a..b') !== null, '含 .. 被拦')
  ok(validateBranchName('a b') !== null, '含空格被拦')
  ok(validateBranchName('a~b') !== null, '含 ~ 被拦')
  ok(validateBranchName('a:b') !== null, '含 : 被拦')
  ok(validateBranchName('a?b') !== null, '含 ? 被拦')
  ok(validateBranchName('a*b') !== null, '含 * 被拦')
  ok(validateBranchName('a[b') !== null, '含 [ 被拦')
  ok(validateBranchName('a\\b') !== null, '含 \\ 被拦')
  ok(validateBranchName('a.lock') !== null, '以 .lock 结尾被拦')
  ok(validateBranchName('a.') !== null, '以 . 结尾被拦')
  ok(validateBranchName('/a') !== null, '以 / 开头被拦')
  ok(validateBranchName('a/') !== null, '以 / 结尾被拦')
  ok(validateBranchName('a//b') !== null, '连续 / 被拦')
  ok(validateBranchName('a@{b') !== null, '含 @{ 被拦')
  ok(validateBranchName('a\u0001b') !== null, '含控制字符被拦')
  ok(validateBranchName('a'.repeat(201)) !== null, '超长被拦')

  /* ══════════════════════════ 3. 版本摘要 ══════════════════════════ */

  console.log('\n--- 3. 版本摘要（乐观并发的判据）---')

  ok(digestOf(['ab', 'c']) !== digestOf(['a', 'bc']), '长度前缀：拼接边界不可伪造', j(digestOf(['ab', 'c']), digestOf(['a', 'bc'])))
  ok(digestOf(['a\nb']) !== digestOf(['a', 'b']), '含换行的单段 ≠ 两段', j(digestOf(['a\nb']), digestOf(['a', 'b'])))
  ok(digestOf(['x']) === digestOf(['x']), '同样输入同样摘要')
  ok(digestOf(['x']) !== digestOf(['y']), '变一个字符摘要就变')
  ok(digestOf([]) === digestOf([]), '空输入稳定')
  ok(digestOf(['']).length === 16, '摘要长度固定 16')

  const expected = { head: 'a'.repeat(40), indexDigest: 'i1', statusDigest: 's1' }
  ok(expectedMismatch(expected, expected) === null, '完全一致 → 不需要刷新')
  ok(
    JSON.stringify(expectedMismatch(expected, { ...expected, head: 'b'.repeat(40) })) === '["HEAD"]',
    'HEAD 变了 → 指出 HEAD'
  )
  ok(
    JSON.stringify(expectedMismatch(expected, { ...expected, indexDigest: 'i2' })) === '["暂存区"]',
    'index 变了 → 指出暂存区（这才是「不提交未审阅内容」的判据）'
  )
  ok(
    expectedMismatch(expected, { ...expected, head: 'b'.repeat(40), indexDigest: 'i2', statusDigest: 's2' })?.length === 3,
    '三个分量都变了 → 都列出来'
  )

  /* ══════════════════════════ 4. 命令构造 ══════════════════════════ */

  console.log('\n--- 4. 命令参数 ---')

  const eq = (got, want, label) => ok(JSON.stringify(got) === JSON.stringify(want), label, j(got, want))

  eq(buildStageArgs(['a.txt', 'b c.txt']), ['add', '--', 'a.txt', 'b c.txt'], '暂存：带 -- 终止符（含空格的路径与选项注入）')
  eq(buildStageAllArgs(), ['add', '-A'], '全部暂存含未跟踪与删除')
  eq(buildUnstageArgs(['a.txt'], true), ['reset', '--quiet', 'HEAD', '--', 'a.txt'], '取消暂存（有 HEAD）')
  eq(buildUnstageArgs(['a.txt'], false), ['rm', '--cached', '--quiet', '--', 'a.txt'], '取消暂存（无首提交 → 不能用 reset）')
  eq(buildUnstageAllArgs(true), ['reset', '--quiet', 'HEAD'], '全部取消暂存（有 HEAD）')
  ok(buildUnstageAllArgs(false).includes('--ignore-unmatch'), '全部取消暂存（无首提交）：ignore-unmatch 防「没匹配到」报错')
  ok(!buildCommitArgs('x').includes('--no-verify'), '提交**不**跳过 hook（方案 §5.2 的硬要求）')
  eq(buildCommitArgs('msg'), ['commit', '-m', 'msg'], '提交说明走 -m 参数（不经 shell）')
  eq(buildSwitchArgs('main'), ['switch', '--', 'main'], '切换用 switch（不会顺手改文件）')

  const createOnly = buildCreateBranchArgs('feat', null, false)
  const createSwitch = buildCreateBranchArgs('feat', null, true)
  eq(createOnly, ['branch', '--', 'feat'], '只创建 → git branch -- 名字')
  eq(createSwitch, ['switch', '-c', 'feat'], '创建并切换 → switch -c（名字是 -c 的值，不能塞 --）')
  eq(buildCreateBranchArgs('feat', 'origin/main', true), ['switch', '-c', 'feat', 'origin/main'], '带起点的创建并切换')
  eq(buildCreateBranchArgs('feat', 'main', false), ['branch', '--', 'feat', 'main'], '带起点的只创建')

  eq(buildPushArgs('main', 'origin', true), ['push', '--set-upstream', '--', 'origin', 'main'], '推送并设置上游')
  eq(buildPushArgs('main', null, false), ['push', 'main'], '推送（无 remote）')
  ok(!buildPushArgs('main', 'origin', false).some((a) => /force|rebase/.test(a)), '推送**不**带 force / rebase')

  eq(buildFetchArgs('origin'), ['fetch', '--prune', '--', 'origin'], '拉取带 --prune（清掉远程已删的分支）')
  eq(buildFetchArgs(null), ['fetch', '--prune'], '拉取全部')

  eq(buildSetUpstreamAfterCreateArgs('feat', 'origin/main', true), ['branch', '--set-upstream-to=origin/main', 'feat'], '从远程跟踪分支新建 → 顺手设上游')
  eq(buildSetUpstreamAfterCreateArgs('feat', 'main', false), [], '从本地分支新建 → **不**乱设上游')
  eq(buildSetUpstreamAfterCreateArgs('feat', null, true), [], '无起点 → 不设上游')

  /* ══════════════════════════ 5. 结果文案 ══════════════════════════ */

  console.log('\n--- 5. 结果行 ---')

  ok(summarizeFiles('已暂存', ['a.txt']) === '已暂存 a.txt', '单个文件带名字')
  ok(summarizeFiles('已暂存', ['a', 'b', 'c']) === '已暂存 3 个文件', '多个文件给数量')
  ok(summarizeFiles('已暂存全部变更', []) === '已暂存全部变更', '空列表用原样文案')
  ok(MAX_ACTION_PATHS === 800, '一次操作的文件数上限与审查清单一致')
}
