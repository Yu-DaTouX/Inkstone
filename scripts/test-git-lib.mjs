import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runGitStateTests(ok) {
  const { parseStatusV2, remoteWebUrl, compareWebUrl } = await import('../out/test/git.mjs')
  const NUL = '\0'
  const j = (...parts) => JSON.stringify(parts)

  console.log('\n--- 2. git status --porcelain=v2 -z ---')

  {
    const out = [
      '# branch.oid abc123',
      '# branch.head feature/x',
      '# branch.upstream origin/feature/x',
      '# branch.ab +2 -3',
      '1 M. N... 100644 100644 100644 aaa bbb src/a.ts',
      '1 .M N... 100644 100644 100644 aaa bbb src/b.ts',
      '1 MM N... 100644 100644 100644 aaa bbb src/c.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 src/new name.ts',
      'src/old name.ts',
      '? docs/未跟踪 文件.md',
      '! build/'
    ].join(NUL)

    const p = parseStatusV2(out)
    ok(p.branch === 'feature/x', '读到当前分支', p.branch)
    ok(p.upstream === 'origin/feature/x', '读到 upstream', p.upstream)
    ok(p.ahead === 2 && p.behind === 3, '读到 ahead/behind', `${p.ahead}/${p.behind}`)
    ok(p.detached === false, '非 detached')
    ok(p.unborn === false, '有首提交')

    ok(p.entries.length === 6, '六条条目（含未跟踪与被忽略的那条）', `实际 ${p.entries.length}`)

    const a = p.entries[0]
    ok(a.path === 'src/a.ts' && a.x === 'M' && a.y === '.', '普通条目：index 位 M、工作区位空', j(a))

    const b = p.entries[1]
    ok(b.x === '.' && b.y === 'M', '只有工作区改动：index 位是空', j(b))

    const c = p.entries[2]
    ok(c.x === 'M' && c.y === 'M', '同一个文件同时有暂存与未暂存改动', j(c))

    const r = p.entries[3]
    ok(r.path === 'src/new name.ts', 'rename 的新路径（含空格）解析正确', r.path)
    ok(r.origPath === 'src/old name.ts', 'rename 的旧路径来自下一段', String(r.origPath))

    const q = p.entries[4]
    ok(q.untracked === true && q.path === 'docs/未跟踪 文件.md', '未跟踪文件：路径含中文与空格', q.path)

    const ig = p.entries[5]
    ok(ig.ignored === true, '被忽略的条目单独标记（界面不显示但能过滤）')

    const { entries } = p
    ok(entries.length === 6, 'rename 多占的那一段没有被当成独立条目')
  }

  {
    const p = parseStatusV2(['# branch.oid (initial)', '# branch.head main'].join(NUL))
    ok(p.unborn === true, 'branch.oid 为 (initial) → 尚无提交')
    ok(p.head === null, '尚无提交时没有 HEAD sha')
    ok(p.branch === 'main', '尚无提交时分支名仍然可读')

    const d = parseStatusV2(['# branch.oid deadbeef', '# branch.head (detached)'].join(NUL))
    ok(d.detached === true, 'branch.head 为 (detached) → detached HEAD')
    ok(d.branch === null, 'detached 时没有分支名')
    ok(d.head === 'deadbeef', 'detached 仍有 HEAD sha')
  }

  {
    const p = parseStatusV2(['u UU N... 100644 100644 100644 100644 aaa bbb ccc src/冲突 文件.ts'].join(NUL))
    const u = p.entries[0]
    ok(u.unmerged === true, 'u 条目标记为未合并')
    ok(u.path === 'src/冲突 文件.ts', '冲突条目的路径（含空格）正确', u.path)
  }

  {
    ok(remoteWebUrl('https://github.com/o/r.git') === 'https://github.com/o/r', 'https + .git 去掉后缀')
    ok(remoteWebUrl('git@github.com:o/r.git') === 'https://github.com/o/r', 'scp 写法（ssh 最常见）')
    ok(remoteWebUrl('ssh://git@github.com/o/r.git') === 'https://github.com/o/r', 'ssh:// 写法')
    ok(remoteWebUrl('ssh://git@github.com:2222/o/r') === 'https://github.com/o/r', '带端口的 ssh 写法')
    ok(remoteWebUrl('https://gitlab.com/g/s') === 'https://gitlab.com/g/s', 'gitlab')
    ok(remoteWebUrl('git@bitbucket.org:t/p.git') === 'https://bitbucket.org/t/p', 'bitbucket')
    ok(remoteWebUrl('C:\work\repo') === null, 'Windows 盘符不当成 scp 写法')
    ok(remoteWebUrl('/Users/x/repo') === null, '本地路径没有网页地址')
    ok(remoteWebUrl('https://git.example.com/o/r.git') === null, '自建服务不猜（认不出就 null）')
    ok(remoteWebUrl('') === null, '空字符串给 null')

    const gh = 'https://github.com/o/r'
    ok(compareWebUrl(gh, 'main', 'feat/x') === 'https://github.com/o/r/compare/main...feat%2Fx', 'GitHub 的 compare 路径')
    ok(
      compareWebUrl('https://gitlab.com/g/s', 'main', 'dev') === 'https://gitlab.com/g/s/-/compare/main...dev',
      'GitLab 用 /-/compare'
    )
    ok(
      compareWebUrl('https://bitbucket.org/t/p', 'main', 'dev') === 'https://bitbucket.org/t/p/branches/compare/dev..main',
      'Bitbucket 的顺序与我们相反（新..旧）'
    )
    ok(compareWebUrl(gh, 'main', 'main') === null, '两侧相同就不给链接（那是空比较）')
    ok(compareWebUrl(gh, '', 'main') === null, '缺一侧就不给链接')
  }

}

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

  console.log('\n--- 1. git 失败原因的分类（真 git 原文）---')

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

  const weird = classifyGitFailure('fatal: something nobody has seen before')
  ok(weird.code === 'unknown', '没见过的报错归为 unknown（不猜原因）', j(weird.code))
  ok(weird.retrySafe === false, 'unknown 不允许自动重试', j(weird.retrySafe))
  ok(weird.detail === 'fatal: something nobody has seen before', 'unknown 原样保留输出', j(weird.detail))

  ok(classifyGitFailure(cases[0][1]).retrySafe === true, '身份未配置：配好就能重试（安全）')
  ok(timeoutFailure('killed').retrySafe === false, '超时 → 不能无条件重试（提交可能已完成）')
  ok(timeoutFailure().code === 'timeout', 'timeoutFailure 的码')
  ok(staleFailure(['HEAD']).code === 'stale', 'staleFailure 的码')
  ok(staleFailure(['HEAD', '暂存区']).detail === 'HEAD、暂存区', 'stale 说清是哪个分量变了')

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

  console.log('\n--- 5. 结果行 ---')

  ok(summarizeFiles('已暂存', ['a.txt']) === '已暂存 a.txt', '单个文件带名字')
  ok(summarizeFiles('已暂存', ['a', 'b', 'c']) === '已暂存 3 个文件', '多个文件给数量')
  ok(summarizeFiles('已暂存全部变更', []) === '已暂存全部变更', '空列表用原样文案')
  ok(MAX_ACTION_PATHS === 800, '一次操作的文件数上限与审查清单一致')
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'yan-test',
  GIT_AUTHOR_EMAIL: 'yan-test@example.com',
  GIT_COMMITTER_NAME: 'yan-test',
  GIT_COMMITTER_EMAIL: 'yan-test@example.com',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_TERMINAL_PROMPT: '0'
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

export async function runGitRepoTests(ok) {
  const { resolveRepo, clearRepoCache } = await import('../out/test/git-service.mjs')

  const root = await mkdtemp(join(tmpdir(), 'yan-git-'))
  const repo = join(root, 'demo')
  await mkdir(repo, { recursive: true })

  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  git(repo, ['config', 'user.name', 'yan-test'])
  git(repo, ['config', 'user.email', 'yan-test@example.com'])

  await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
  await writeFile(join(repo, '中文 及空格.txt'), '第一行\n第二行\n')
  await writeFile(join(repo, 'gone.txt'), 'bye\n')
  await writeFile(join(repo, 'old-name.txt'), 'rename me\n')
  await mkdir(join(repo, 'docs'))
  await writeFile(join(repo, 'docs', 'keep.md'), '# keep\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'init'])

  await writeFile(join(repo, 'a.txt'), 'one\nTWO\nthree\nfour\n')
  await rm(join(repo, 'gone.txt'))
  await writeFile(join(repo, '中文 及空格.txt'), '第一行\n改过的第二行\n')
  git(repo, ['add', '中文 及空格.txt'])
  await writeFile(join(repo, 'staged-new.txt'), 'brand new\n')
  git(repo, ['add', 'staged-new.txt'])
  git(repo, ['mv', 'old-name.txt', 'new-name.txt'])
  await writeFile(join(repo, 'untracked.txt'), 'u1\nu2\nu3\n')
  await mkdir(join(repo, 'assets'), { recursive: true })
  await writeFile(join(repo, 'assets', 'blob.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00]))

  console.log('\n--- G1. 真实仓库：身份与状态 ---')
  {
    clearRepoCache()
    const id = await resolveRepo(repo)
    ok(!!id, '在真仓库里能解析出仓库身份', String(id))
    ok(id.root.endsWith('demo'), 'root 指向工作树根', id.root)
    ok(typeof id.repoId === 'string' && id.repoId.length > 0, 'repoId 非空')
    ok(id.worktreeId === id.repoId, '普通仓库里 worktreeId 与 repoId 相同（commonDir === gitDir）')

    const none = await resolveRepo(join(root, 'not-a-repo'))
    ok(none === null, '非 Git 目录返回 null（不是抛异常）')
    await mkdir(join(root, 'not-a-repo'), { recursive: true })
    clearRepoCache()
    ok((await resolveRepo(join(root, 'not-a-repo'))) === null, '空目录也返回 null')

    const { readRepoSnapshot, readRepoState, readExpected } = await import('../out/test/git-service.mjs')
    const [snapA, snapB] = await Promise.all([readRepoSnapshot(id), readRepoSnapshot(id)])
    ok(snapA === snapB, '同一仓库并发读取状态只跑一次')
    const separate = await readRepoState(repo, { withRefs: false })
    ok(JSON.stringify(snapA.repo) === JSON.stringify(separate), '合并读取的仓库状态与单独读取一致', JSON.stringify({ snap: snapA.repo, separate }))
    ok(JSON.stringify(snapA.expected) === JSON.stringify(await readExpected(id.root)), '合并读取的写前校验值与单独读取一致', JSON.stringify(snapA.expected))
    ok((await readRepoSnapshot(id)) !== snapA, '上一次读取结束后重新读取')
  }

  console.log('\n--- G9. 写操作（真实 git，全部在临时仓库里）---')

  {
    const { runGitAction, configureWriteContext, readExpected, listRemotes } = await import(
      '../out/test/git-actions-main.mjs'
    )

    const mut = join(root, 'mut')
    await mkdir(mut, { recursive: true })
    git(mut, ['init', '-q', '-b', 'main'])
    git(mut, ['config', 'core.autocrlf', 'false'])
    git(mut, ['config', 'user.name', 'yan-test'])
    git(mut, ['config', 'user.email', 'yan-test@example.com'])
    await writeFile(join(mut, 'a.txt'), 'A1\nA2\n')
    await writeFile(join(mut, 'b.txt'), 'B1\n')
    git(mut, ['add', '-A'])
    git(mut, ['commit', '-qm', '初始提交'])

    const act = (req) => runGitAction({ requestId: Math.random().toString(36).slice(2), ...req })
    const cachedNames = () => git(mut, ['diff', '--cached', '--name-only']).trim()
    const headOf = (dir = mut) => git(dir, ['rev-parse', 'HEAD']).trim()
    const commitCount = (dir = mut) => git(dir, ['rev-list', '--count', 'HEAD']).trim()
    const branchOf = (dir = mut) => git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()

    await writeFile(join(mut, 'a.txt'), 'A1 改过\nA2\n')
    await writeFile(join(mut, 'b.txt'), 'B1 改过\n')
    await writeFile(join(mut, 'c-new.txt'), '新文件\n')

    let exp = await readExpected(mut)
    const s1 = await act({ kind: 'stage', cwd: mut, paths: ['a.txt'], expected: exp })
    ok(s1.ok === true, '暂存 a.txt 成功', JSON.stringify(s1.failure))
    ok(s1.summary === '已暂存 a.txt', '结果行给出文件名', s1.summary)
    ok(cachedNames() === 'a.txt', '只有 a.txt 进了 index（b.txt 没被连带）', cachedNames())
    ok(s1.state?.stagedCount === 1, '返回的状态里已暂存数是 1', String(s1.state?.stagedCount))
    ok(s1.state?.untrackedCount === 1, '返回的状态里未跟踪数是 1')

    const s2 = await act({ kind: 'stage', cwd: mut, paths: ['b.txt', 'c-new.txt'], expected: await readExpected(mut) })
    ok(s2.ok === true, '暂存多个文件（含未跟踪新文件）成功')
    ok(
      cachedNames().split('\n').sort().join(',') === 'a.txt,b.txt,c-new.txt',
      '三个文件都在 index 里',
      cachedNames()
    )

    const u1 = await act({ kind: 'unstage', cwd: mut, paths: ['a.txt'], expected: await readExpected(mut) })
    ok(u1.ok === true, '取消暂存 a.txt 成功')
    ok(!cachedNames().split('\n').includes('a.txt'), 'a.txt 退出 index')
    ok(cachedNames().split('\n').includes('b.txt'), 'b.txt 仍在 index（没有连带取消）')
    const aContent = await readFile(join(mut, 'a.txt'), 'utf8')
    ok(aContent === 'A1 改过\nA2\n', '取消暂存后**工作区内容原样保留**（不是 checkout）', JSON.stringify(aContent))

    const staleExpect = await readExpected(mut)
    await act({ kind: 'unstage', cwd: mut, paths: ['b.txt'], expected: await readExpected(mut) })
    const indexNow = git(mut, ['ls-files', '-s'])
    const countBeforeStale = commitCount()
    const stale = await act({ kind: 'commit', cwd: mut, message: '拿过期状态提交', expected: staleExpect })
    ok(stale.ok === false, '拿着过期版本提交被拒绝')
    ok(stale.failure?.code === 'stale', '失败码是 stale', stale.failure?.code)
    ok(
      (stale.failure?.detail ?? '').includes('暂存区'),
      'stale 指出是「暂存区」变了（这才是能拦住「提交未审阅内容」的判据）',
      stale.failure?.detail
    )
    ok(commitCount() === countBeforeStale, '被拒时**没有产生提交**（未审阅的内容没被提交进去）', commitCount())
    ok(git(mut, ['ls-files', '-s']) === indexNow, '被拒时 index **逐字节未变**')

    const headExp = await readExpected(mut)
    await writeFile(join(mut, "b.txt"), "B1 又改了一次\n")
    git(mut, ["commit", "-q", "--allow-empty", "-m", "外部进程的提交"])
    const stageAfterHeadMove = await act({ kind: "stage", cwd: mut, paths: ["b.txt"], expected: headExp })
    ok(stageAfterHeadMove.ok === true, "HEAD 被别人挪走后暂存仍然成功（不制造假冲突）", JSON.stringify(stageAfterHeadMove.failure))

    const headExp2 = await readExpected(mut)
    git(mut, ["commit", "-q", "--allow-empty", "-m", "又一次外部提交"])
    const cbStale = await act({
      kind: "create-branch",
      cwd: mut,
      branch: "from-stale-head",
      startPoint: null,
      checkout: false,
      expected: headExp2
    })
    ok(cbStale.ok === false, "HEAD 被挪走后「用当前 HEAD 作起点」的新建分支被拒绝")
    ok(cbStale.failure?.code === "stale", "失败码是 stale", cbStale.failure?.code)
    ok((cbStale.failure?.detail ?? "").includes("HEAD"), "指出是 HEAD 变了", cbStale.failure?.detail)

    const headExp3 = await readExpected(mut)
    git(mut, ["commit", "-q", "--allow-empty", "-m", "第三次外部提交"])
    const cbPinned = await act({
      kind: "create-branch",
      cwd: mut,
      branch: "from-pinned-start",
      startPoint: "HEAD~1",
      checkout: false,
      expected: headExp3
    })
    ok(cbPinned.ok === true, "起点显式给出时不受 HEAD 变化影响", JSON.stringify(cbPinned.failure))

    const sa = await act({ kind: 'stage-all', cwd: mut, expected: await readExpected(mut) })
    const dirtyBefore = git(mut, ['status', '--porcelain']).split('\n').filter(Boolean).length
    ok(
      cachedNames().split('\n').filter(Boolean).length === dirtyBefore,
      `全部暂存：index 覆盖了 status 里的全部 ${dirtyBefore} 个变更文件`,
      cachedNames()
    )
    const ua = await act({ kind: 'unstage-all', cwd: mut, expected: await readExpected(mut) })
    ok(ua.ok === true, '全部取消暂存成功')
    ok(cachedNames() === '', 'index 清空', cachedNames())
    ok((await readFile(join(mut, 'a.txt'), 'utf8')).includes('改过'), '全部取消暂存也没碰工作区')

    await act({ kind: 'stage-all', cwd: mut, expected: await readExpected(mut) })
    const before = commitCount()
    const c1 = await act({ kind: 'commit', cwd: mut, message: 'feat: 第一次提交', expected: await readExpected(mut) })
    ok(c1.ok === true, '提交成功', JSON.stringify(c1.failure))
    ok(c1.committed === true, '结果里 committed 为 true')
    ok(commitCount() === String(Number(before) + 1), '提交数 +1', `${before} → ${commitCount()}`)
    ok(git(mut, ['log', '-1', '--pretty=%s']).trim() === 'feat: 第一次提交', '提交说明写进去了')
    ok(c1.commit?.length === 7, '结果里给出 short sha', c1.commit)
    ok(c1.headBefore !== c1.headAfter, 'HEAD 前后不同')
    ok(typeof c1.headBefore === 'string' && c1.headBefore.length === 40, '结果里带着提交前的完整 HEAD', c1.headBefore)

    const n1 = commitCount()
    const empty = await act({ kind: 'commit', cwd: mut, message: '   ', expected: await readExpected(mut) })
    ok(empty.ok === false && empty.failure?.code === 'empty-message', '空提交说明被本地拦下', empty.failure?.code)
    ok(commitCount() === n1, '空说明没有产生提交')

    const nothing = await act({ kind: 'commit', cwd: mut, message: 'x', expected: await readExpected(mut) })
    ok(nothing.ok === false && nothing.failure?.code === 'nothing-to-commit', '没内容可提交时分类为 nothing-to-commit', nothing.failure?.code)

    const hookPath = join(mut, '.git', 'hooks', 'pre-commit')
    await writeFile(hookPath, '#!/bin/sh\necho "拒绝：这是测试 hook"\nexit 1\n', { mode: 0o755 })
    await writeFile(join(mut, 'a.txt'), 'A1 又要提交\nA2\n')
    await act({ kind: 'stage', cwd: mut, paths: ['a.txt'], expected: await readExpected(mut) })
    const hookCount = commitCount()
    const h1 = await act({ kind: 'commit', cwd: mut, message: '会被 hook 拒', expected: await readExpected(mut) })
    ok(h1.ok === false, 'pre-commit 拒绝时提交失败')
    ok(h1.failure?.code === 'hook', '分类为 hook（靠仓库里真有 hook 这个事实，不是猜）', h1.failure?.code)
    ok((h1.failure?.message ?? '').includes('pre-commit'), '失败说明里点名是哪个 hook', h1.failure?.message)
    ok((h1.failure?.detail ?? '').includes('测试 hook'), 'hook 自己的输出被保留（那才是关键信息）', h1.failure?.detail)
    ok(commitCount() === hookCount, 'hook 拒绝后没有产生提交（没有 --no-verify 偷偷绕过）')
    await rm(hookPath, { force: true })

    await act({ kind: 'stage', cwd: mut, paths: ['a.txt'], expected: await readExpected(mut) })
    const noHook = await act({ kind: 'commit', cwd: mut, message: '没有 hook 了', expected: await readExpected(mut) })
    ok(noHook.ok === true, '删掉 hook 后同样内容能提交（证明上一次失败真是 hook 拦的）')

    const noId = join(root, 'noid')
    await mkdir(noId, { recursive: true })
    git(noId, ['init', '-q', '-b', 'main'])
    await writeFile(join(noId, 'x.txt'), 'x\n')
    git(noId, ['add', '-A'])
    const savedGlobal = process.env.GIT_CONFIG_GLOBAL
    const savedSystem = process.env.GIT_CONFIG_SYSTEM
    const savedIdent = {
      name: process.env.GIT_AUTHOR_NAME,
      email: process.env.GIT_AUTHOR_EMAIL,
      cname: process.env.GIT_COMMITTER_NAME,
      cemail: process.env.GIT_COMMITTER_EMAIL
    }
    process.env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
    process.env.GIT_CONFIG_SYSTEM = process.platform === 'win32' ? 'NUL' : '/dev/null'
    delete process.env.GIT_AUTHOR_NAME
    delete process.env.GIT_AUTHOR_EMAIL
    delete process.env.GIT_COMMITTER_NAME
    delete process.env.GIT_COMMITTER_EMAIL
    let idFail = null
    try {
      const r = await act({ kind: 'commit', cwd: noId, message: '没身份', expected: await readExpected(noId) })
      idFail = r.failure ?? null
      ok(r.ok === false, '没有身份时提交失败（而不是静默成功）')
    } finally {
      process.env.GIT_CONFIG_GLOBAL = savedGlobal ?? ''
      process.env.GIT_CONFIG_SYSTEM = savedSystem ?? ''
      for (const [k, v] of Object.entries({
        GIT_AUTHOR_NAME: savedIdent.name,
        GIT_AUTHOR_EMAIL: savedIdent.email,
        GIT_COMMITTER_NAME: savedIdent.cname,
        GIT_COMMITTER_EMAIL: savedIdent.cemail
      })) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
    if (idFail) {
      ok(idFail.code === 'identity', '真 git 的身份报错被分类为 identity', idFail.code)
      ok(/who you are|identity/i.test(idFail.detail ?? ''), '保留了 git 的原文', (idFail.detail ?? '').slice(0, 60))
      ok(!!idFail.hint, '给出可执行的下一步（去配 user.name/email）')
    }

    git(mut, ['switch', '-q', '-c', 'feature'])
    await writeFile(join(mut, 'a.txt'), 'feature 上的版本\n')
    git(mut, ['commit', '-qam', 'feature 改动 a.txt'])
    git(mut, ['switch', '-q', 'main'])
    await writeFile(join(mut, 'a.txt'), 'main 上未提交的改动\n')

    const sw1 = await act({ kind: 'switch-branch', cwd: mut, branch: 'feature', expected: await readExpected(mut) })
    ok(sw1.ok === false, '有冲突的本地改动时切换被拒')
    ok(sw1.failure?.code === 'dirty-blocks-switch', '分类为 dirty-blocks-switch', sw1.failure?.code)
    ok(branchOf() === 'main', '分支没有变')
    ok((await readFile(join(mut, 'a.txt'), 'utf8')) === 'main 上未提交的改动\n', '工作区内容原样保留（没被 stash/reset）')

    git(mut, ['checkout', '--', 'a.txt'])
    const sw2 = await act({ kind: 'switch-branch', cwd: mut, branch: 'feature', expected: await readExpected(mut) })
    ok(sw2.ok === true, '工作区干净后切换成功', JSON.stringify(sw2.failure))
    ok(branchOf() === 'feature', '真的切到了 feature', branchOf())
    ok(sw2.summary?.includes('feature') === true, '结果行说明切到了哪')

    configureWriteContext({ hasRunningTask: () => true })
    const busy = await act({ kind: 'switch-branch', cwd: mut, branch: 'main', expected: await readExpected(mut) })
    ok(busy.ok === false && busy.failure?.code === 'busy', '有运行任务时切换被拒', busy.failure?.code)
    ok(branchOf() === 'feature', '被拒后分支没变')
    ok(!!busy.failure?.hint, '说明了为什么（正在跑的任务会读到混乱的代码）')
    const busyCreate = await act({
      kind: 'create-branch',
      cwd: mut,
      branch: 'nope',
      startPoint: null,
      checkout: true,
      expected: await readExpected(mut)
    })
    ok(busyCreate.ok === false && busyCreate.failure?.code === 'busy', '有运行任务时「新建并切换」也被拒')
    configureWriteContext({})

    git(mut, ['switch', '-q', 'main'])
    const cb1 = await act({
      kind: 'create-branch',
      cwd: mut,
      branch: 'only-branch',
      startPoint: null,
      checkout: false,
      expected: await readExpected(mut)
    })
    ok(cb1.ok === true, '只创建分支成功', JSON.stringify(cb1.failure))
    ok(branchOf() === 'main', '只创建时**不**切换当前分支', branchOf())
    ok(git(mut, ['branch', '--list', 'only-branch']).trim().length > 0, '新分支真的存在')

    const cb2 = await act({
      kind: 'create-branch',
      cwd: mut,
      branch: 'switched',
      startPoint: 'main',
      checkout: true,
      expected: await readExpected(mut)
    })
    ok(cb2.ok === true, '创建并切换成功', JSON.stringify(cb2.failure))
    ok(branchOf() === 'switched', '当前分支变成新分支', branchOf())

    const cb3 = await act({
      kind: 'create-branch',
      cwd: mut,
      branch: '-bad',
      startPoint: null,
      checkout: false,
      expected: await readExpected(mut)
    })
    ok(cb3.ok === false && cb3.failure?.code === 'invalid-input', '以 - 开头的分支名被本地拦下', cb3.failure?.code)

    const cb4 = await act({
      kind: 'create-branch',
      cwd: mut,
      branch: 'only-branch',
      startPoint: null,
      checkout: false,
      expected: await readExpected(mut)
    })
    ok(cb4.ok === false && cb4.failure?.code === 'branch-exists', '重名 → 分类为 branch-exists', cb4.failure?.code)

    const cb5 = await act({
      kind: 'create-branch',
      cwd: mut,
      branch: 'from-nowhere',
      startPoint: 'no-such-ref',
      checkout: false,
      expected: await readExpected(mut)
    })
    ok(cb5.ok === false && cb5.failure?.code === 'branch-missing', '起点不存在 → branch-missing', cb5.failure?.code)

    const bare = join(root, 'bare.git')
    git(root, ['init', '-q', '--bare', bare])
    git(mut, ['switch', '-q', 'main'])
    git(mut, ['remote', 'add', 'origin', bare])
    ok((await listRemotes(mut)).includes('origin'), '能列出 remote')

    const p1 = await act({
      kind: 'push',
      cwd: mut,
      remote: 'origin',
      branch: 'main',
      setUpstream: true,
      expected: await readExpected(mut)
    })
    ok(p1.ok === true, '首次推送成功', JSON.stringify(p1.failure))
    ok(p1.pushed === true, '结果里 pushed 为 true')
    ok(git(mut, ['rev-parse', '--abbrev-ref', 'main@{upstream}']).trim() === 'origin/main', '上游设上了', git(mut, ['rev-parse', '--abbrev-ref', 'main@{upstream}']).trim())
    ok(git(mut, ['rev-parse', 'main']).trim() === git(bare, ['rev-parse', 'main']).trim(), 'bare 仓库收到了同一个提交')
    ok(p1.state?.unpushedCount === 0, '推送后待推送数为 0', String(p1.state?.unpushedCount))

    const f1 = await act({ kind: 'fetch', cwd: mut, requestId: 'f1' })
    ok(f1.ok === true, '拉取成功', JSON.stringify(f1.failure))

    const other = join(root, 'other')
    git(root, ['clone', '--quiet', '--branch', 'main', bare, other])
    git(other, ['config', 'user.name', 'yan-test'])
    git(other, ['config', 'user.email', 'yan-test@example.com'])
    await writeFile(join(other, 'a.txt'), '别的克隆改的\n')
    git(other, ['commit', '-qam', '别的克隆的提交'])
    git(other, ['push', '-q', 'origin', 'main'])

    await writeFile(join(mut, 'a.txt'), '本地自己的提交\n')
    await act({ kind: 'stage', cwd: mut, paths: ['a.txt'], expected: await readExpected(mut) })
    await act({ kind: 'commit', cwd: mut, message: '本地提交', expected: await readExpected(mut) })
    const localHead = headOf()
    const ff = await act({
      kind: 'push',
      cwd: mut,
      remote: 'origin',
      branch: 'main',
      setUpstream: false,
      expected: await readExpected(mut)
    })
    ok(ff.ok === false, '非快进推送被拒')
    ok(ff.failure?.code === 'non-fast-forward', '分类为 non-fast-forward', ff.failure?.code)
    ok(!!ff.failure?.hint, '给出下一步（先拉取并自己合并/变基，不会自动 rebase）')
    ok(headOf() === localHead, '推送失败**不影响本地提交**（提交被保留）')

    await writeFile(join(mut, 'k1.txt'), '1\n')
    await writeFile(join(mut, 'k2.txt'), '2\n')
    const expK = await readExpected(mut)
    const [r1, r2] = await Promise.all([
      act({ kind: 'stage', cwd: mut, paths: ['k1.txt'], expected: expK }),
      act({ kind: 'stage', cwd: mut, paths: ['k2.txt'], expected: expK })
    ])
    ok(
      r1.ok === true && r2.ok === true,
      '并发两个暂存请求都成功（串行队列 + 分级复核：第二个不该被自己造成的 index 变化误拒）',
      JSON.stringify([r1.failure, r2.failure])
    )
    const after = cachedNames().split('\n').filter(Boolean)
    ok(after.includes('k1.txt') && after.includes('k2.txt'), '两个文件都进了 index', after.join(','))
  }

  console.log('\n--- G10. 用户工作树（真实 git worktree）---')

  {
    const { listWorktrees, createWorktree, removeWorktree, slugBranch, parseWorktreeList, defaultWorktreeContainer } =
      await import('../out/test/git-worktree.mjs')

    ok(slugBranch('feat/git-review') === 'feat-git-review', '分支名里的 / 变成 -（不多出一层目录）', slugBranch('feat/git-review'))
    ok(slugBranch('  spaced  name  ') === 'spaced-name', '空白收敛成单个 -', slugBranch('  spaced  name  '))
    ok(slugBranch('a:b*c?d') === 'a-b-c-d', 'Windows 非法字符被替换', slugBranch('a:b*c?d'))
    ok(slugBranch('---') === 'worktree', '全是符号时退化成 worktree（不留空目录名）', slugBranch('---'))
    ok(!slugBranch('x'.repeat(200)).includes('/') && slugBranch('x'.repeat(200)).length <= 80, '超长名被截断')

    const container = defaultWorktreeContainer('C:/proj/demo', 'demo')
    ok(container.replace(/\\/g, '/').endsWith('proj/demo-worktrees'), '默认容器在仓库**旁边**', container)

    const rec = (...lines) => lines.join(String.fromCharCode(10)) + String.fromCharCode(0)
    const parsed = parseWorktreeList(
      rec('worktree C:/proj/demo', 'HEAD aaaa', 'branch refs/heads/main') +
        rec('worktree C:/proj/demo-worktrees/feat', 'HEAD bbbb', 'branch refs/heads/feat') +
        rec('worktree C:/tmp/detached', 'HEAD cccc', 'detached', 'locked'),
      container
    )
    ok(parsed.length === 3, '解析出三条工作树', String(parsed.length))
    ok(parsed[0].main === true, '第一条是主工作树（git 的约定）')
    ok(parsed[1].ours === true, '落在默认容器里 → ours 为真', parsed[1].path)
    ok(parsed[2].ours === false, '别处的路径不算 ours')
    ok(parsed[2].branch === null, 'detached 的 branch 是 null')
    ok(parsed[2].locked === true, 'locked 被认出来')

    const wt = join(root, 'wt')
    await mkdir(wt, { recursive: true })
    git(wt, ['init', '-q', '-b', 'main'])
    git(wt, ['config', 'core.autocrlf', 'false'])
    git(wt, ['config', 'user.name', 'yan-test'])
    git(wt, ['config', 'user.email', 'yan-test@example.com'])
    await writeFile(join(wt, 'base.txt'), 'base\n')
    git(wt, ['add', '-A'])
    git(wt, ['commit', '-qm', 'wt base'])

    const listing0 = await listWorktrees(wt)
    ok(listing0.ok === true, '能列出工作树')
    ok(listing0.worktrees.length === 1, '刚开始只有主工作树', String(listing0.worktrees.length))
    ok(listing0.worktrees[0].main === true, '那一条是主工作树')
    ok(listing0.repoRoot.endsWith('wt'), 'repoRoot 指向仓库根', listing0.repoRoot)

    const created = await createWorktree({ cwd: wt, branch: 'feat/one', startPoint: null, targetPath: null })
    ok(created.ok === true, '创建工作树成功', JSON.stringify(created.failure))
    ok(!!created.path && created.path.includes('wt-worktrees'), '默认落在 <仓库名>-worktrees 下', String(created.path))
    ok(!!created.path && existsSync(created.path), '目录真的存在')
    ok(!!created.notes && created.notes.some((n) => n.includes('未提交改动不会自动带入')), '明说未提交改动不会带过去')
    ok(
      git(created.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'feat/one',
      '新工作树检出的是新分支',
      git(created.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
    )
    ok(existsSync(join(created.path, 'base.txt')), '已提交的文件被带过去了')
    ok(!existsSync(join(wt, 'feat')), '主工作树里没有多出工作树目录')
    ok(git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'main', '主工作树仍在 main')

    await writeFile(join(wt, 'base.txt'), 'base changed\n')
    const created2 = await createWorktree({ cwd: wt, branch: 'feat/two', startPoint: null, targetPath: null })
    ok(created2.ok === true, '带脏工作区也能建（它只从 HEAD 长出来）')
    ok(
      (await readFile(join(created2.path, 'base.txt'), 'utf8')) === 'base\n',
      '新工作树拿到的是**已提交**的内容，不是主工作树的未提交改动'
    )
    ok(git(wt, ['status', '--porcelain']).trim().length > 0, '主工作树的未提交改动原样保留')

    const dup = await createWorktree({ cwd: wt, branch: 'feat/one', startPoint: null, targetPath: null })
    ok(dup.ok === false && dup.failure?.code === 'branch-exists', '分支已存在 → 拒绝', dup.failure?.code)
    const badStart = await createWorktree({ cwd: wt, branch: 'feat/three', startPoint: 'no-such-ref', targetPath: null })
    ok(badStart.ok === false && badStart.failure?.code === 'branch-missing', '起点不存在 → 拒绝', badStart.failure?.code)
    const badName = await createWorktree({ cwd: wt, branch: 'bad..name', startPoint: null, targetPath: null })
    ok(badName.ok === false && badName.failure?.code === 'invalid-input', '非法分支名 → 拒绝', badName.failure?.code)
    const inside = await createWorktree({
      cwd: wt,
      branch: 'feat/four',
      startPoint: null,
      targetPath: join(wt, 'inside')
    })
    ok(inside.ok === false && inside.failure?.code === 'path-rejected', '目标在仓库内部 → 拒绝', inside.failure?.code)
    const existing = await createWorktree({
      cwd: wt,
      branch: 'feat/five',
      startPoint: null,
      targetPath: wt
    })
    ok(existing.ok === false && existing.failure?.code === 'path-rejected', '目标目录已存在 → 拒绝', existing.failure?.code)

    const busy = await createWorktree({ cwd: wt, branch: 'feat/six', startPoint: null, targetPath: null }, () => true)
    ok(busy.ok === false && busy.failure?.code === 'busy', '有任务在跑 → 拒绝建工作树', busy.failure?.code)

    const listing1 = await listWorktrees(wt)
    ok(listing1.worktrees.length === 3, '现在有三条工作树（主 + feat/one + feat/two）', String(listing1.worktrees.length))
    ok(
      listing1.worktrees.filter((w) => w.ours).length === 2,
      '两条被认成「砚创建的」（落在默认容器里）'
    )

    const { runGitAction: actWt } = await import('../out/test/git-actions-main.mjs')
    const { readRepoState: stateWt, readExpected: expectedWt } = await import('../out/test/git-service.mjs')
    await writeFile(join(wt, 'base.txt'), 'base staged for busy check\n')
    const fullState = await stateWt(wt)
    ok(
      Array.isArray(fullState?.busyBranches) && fullState.busyBranches.length === 2,
      '别的分支被其他工作树检出（busyBranches 非空）',
      JSON.stringify(fullState?.busyBranches)
    )
    const stageBusy = await actWt({
      requestId: 'busy-stage',
      cwd: wt,
      kind: 'stage',
      paths: ['base.txt'],
      expected: await expectedWt(wt)
    })
    ok(stageBusy.ok === true, '暂存在有其他工作树时仍成功', JSON.stringify(stageBusy.failure))
    ok(
      Array.isArray(stageBusy.state?.busyBranches) && stageBusy.state.busyBranches.length === 0,
      '暂存结果不再读 refs（busyBranches 为空）',
      JSON.stringify(stageBusy.state?.busyBranches)
    )
    ok(stageBusy.state?.stagedCount === 1, '暂存结果仍带状态计数', String(stageBusy.state?.stagedCount))

    const mainBlocked = await removeWorktree({ cwd: wt, path: wt })
    ok(mainBlocked.ok === false, '主工作树不能删')
    ok(
      (mainBlocked.blockers ?? []).some((b) => b.kind === 'main'),
      '原因是「这是主工作树」',
      JSON.stringify(mainBlocked.blockers)
    )

    const notMine = await removeWorktree({ cwd: wt, path: root })
    ok(notMine.ok === false && notMine.failure?.code === 'path-rejected', '不在工作树列表里的路径 → 拒绝', notMine.failure?.code)

    await writeFile(join(created.path, 'dirty.txt'), 'x\n')
    const dirtyBlocked = await removeWorktree({ cwd: wt, path: created.path })
    ok(dirtyBlocked.ok === false, '有未提交改动 → 拒绝删除')
    ok(
      (dirtyBlocked.blockers ?? []).some((b) => b.kind === 'dirty' && (b.count ?? 0) >= 1),
      '原因里带未提交的文件数',
      JSON.stringify(dirtyBlocked.blockers)
    )
    ok(existsSync(created.path), '被拒之后目录还在（没有偷偷删）')
    ok((await readFile(join(created.path, 'dirty.txt'), 'utf8')) === 'x\n', '被拒之后未提交的内容也还在')

    await rm(join(created.path, 'dirty.txt'), { force: true })
    git(created.path, ['commit', '-q', '--allow-empty', '-m', '工作树里的提交'])
    const unpushedBlocked = await removeWorktree({ cwd: wt, path: created.path })
    ok(unpushedBlocked.ok === false, '有未推送提交（或没有上游）→ 拒绝删除')
    ok(
      (unpushedBlocked.blockers ?? []).some((b) => b.kind === 'unpushed'),
      '原因是未推送 / 无法判断',
      JSON.stringify(unpushedBlocked.blockers)
    )

    const bare2 = join(root, 'wt-remote.git')
    git(root, ['init', '-q', '--bare', bare2])
    git(created.path, ['remote', 'add', 'origin', bare2])
    git(created.path, ['push', '-q', '-u', 'origin', 'feat/one'])
    const removed = await removeWorktree({ cwd: wt, path: created.path, deleteBranch: false })
    ok(removed.ok === true, '干净且已推送之后可以删除', JSON.stringify(removed.failure ?? removed.blockers))
    ok(!existsSync(created.path), '目录真的没了')
    ok(
      (await listWorktrees(wt)).worktrees.length === 2,
      '工作树列表少了一条',
      String((await listWorktrees(wt)).worktrees.length)
    )
    ok(git(wt, ['branch', '--list', 'feat/one']).trim().length > 0, 'deleteBranch 为假时分支保留')
    ok(existsSync(join(wt, 'base.txt')), '主工作树始终没被碰')

    try {
      git(created2.path, ['push', '-q', '-u', 'origin', 'feat/two'])
    } catch (e) {
      console.log('  ⓘ feat/two 推送失败：' + String(e.stderr || e.message).split(String.fromCharCode(10))[0])
    }
    const removed2 = await removeWorktree({ cwd: wt, path: created2.path, deleteBranch: true })
    ok(removed2.ok === true, '第二条也能正常删除', JSON.stringify(removed2.failure ?? removed2.blockers))
    ok(git(wt, ['branch', '--list', 'feat/two']).trim().length === 0, 'deleteBranch 为真时分支被删掉（已合并/已推送）')
  }

  {
    const { createWorktree } = await import('../out/test/git-worktree.mjs')
    const cRoot = mkdtempSync(join(tmpdir(), 'yan-git-carry-'))
    const cRepo = join(cRoot, 'carry')
    mkdirSync(cRepo)
    git(cRepo, ['init', '-q', '-b', 'main'])
    git(cRepo, ['config', 'user.email', 't@example.com'])
    git(cRepo, ['config', 'user.name', 'T'])
    writeFileSync(join(cRepo, 'a.txt'), 'a\n')
    writeFileSync(join(cRepo, 'keep.txt'), 'keep\n')
    writeFileSync(join(cRepo, 'bin.dat'), Buffer.from([0, 1, 2, 3, 255, 254]))
    writeFileSync(join(cRepo, 'run.sh'), '#!/bin/sh\necho hi\n')
    git(cRepo, ['add', '-A'])
    git(cRepo, ['commit', '-q', '-m', 'init'])

    writeFileSync(join(cRepo, 'a.txt'), 'a\nstaged\n')
    git(cRepo, ['add', 'a.txt'])
    writeFileSync(join(cRepo, 'keep.txt'), 'keep\nmodified\n')
    writeFileSync(join(cRepo, 'bin.dat'), Buffer.from([0, 9, 9, 3, 255, 254]))
    writeFileSync(join(cRepo, 'new-untracked.txt'), 'hello\n')
    writeFileSync(join(cRepo, 'exec-untracked.sh'), '#!/bin/sh\nls\n')
    chmodSync(join(cRepo, 'exec-untracked.sh'), 0o755)

    const srcStatusBefore = git(cRepo, ['status', '--porcelain=v1', '-z'])
    const srcIndexBefore = git(cRepo, ['diff', '--cached', '--binary'])

    const carried = await createWorktree({
      cwd: cRepo,
      branch: 'carry-test',
      startPoint: null,
      targetPath: null,
      carry: { staged: true, unstaged: true, untracked: ['new-untracked.txt', 'exec-untracked.sh'] }
    })
    ok(carried.ok === true, '带 carry 的创建工作树成功', JSON.stringify(carried.failure))
    const dst = carried.path ?? ''

    if (carried.ok && dst) {
      ok(
        carried.notes?.some((n) => n.includes('已带入改动')) === true,
        '返回的说明里写明带入了改动',
        (carried.notes ?? []).join(' | ').slice(0, 90)
      )
      ok(
        (carried.notes ?? []).some((n) => n.includes('源工作区的改动原样保留')) === true,
        '说明里写明源工作区没被动过'
      )

      const dstStatus = git(dst, ['status', '--porcelain=v1'])
      ok(/^M  a\.txt$/m.test(dstStatus), '已暂存的改动在目标里仍然是已暂存（M + 空格）', JSON.stringify(dstStatus))
      ok(/^ M keep\.txt$/m.test(dstStatus), '未暂存的改动在目标里仍然是未暂存（空格 + M）')
      ok(/^ M bin\.dat$/m.test(dstStatus), '二进制改动也过来了')
      ok(/^\?\? new-untracked\.txt$/m.test(dstStatus), '未跟踪文件过来了')
      ok(/^\?\? exec-untracked\.sh$/m.test(dstStatus), '未跟踪的脚本也过来了')

      ok(readFileSync(join(dst, 'keep.txt'), 'utf8') === 'keep\nmodified\n', '未暂存文件的内容一致')
      ok(
        Buffer.compare(readFileSync(join(dst, 'bin.dat')), Buffer.from([0, 9, 9, 3, 255, 254])) === 0,
        '二进制文件逐字节一致（没有被 utf8 破坏）'
      )
      ok(readFileSync(join(dst, 'new-untracked.txt'), 'utf8') === 'hello\n', '未跟踪文件内容一致')
      if (process.platform === 'win32') {
        ok(true, '可执行位：Windows 上跳过（NTFS 不用 mode 位表示可执行）')
      } else {
        ok((statSync(join(dst, 'exec-untracked.sh')).mode & 0o777) === 0o755, '未跟踪文件的可执行位保持')
      }

      ok(
        git(dst, ['diff', '--cached', '--numstat']).trim() === git(cRepo, ['diff', '--cached', '--numstat']).trim(),
        '目标与源的「已暂存」摘要一致'
      )
      ok(
        git(dst, ['diff', '--numstat']).trim() === git(cRepo, ['diff', '--numstat']).trim(),
        '目标与源的「未暂存」摘要一致'
      )
    }

    ok(git(cRepo, ['status', '--porcelain=v1', '-z']) === srcStatusBefore, '源仓库的 status 逐字节不变')
    ok(git(cRepo, ['diff', '--cached', '--binary']) === srcIndexBefore, '源仓库的 index 逐字节不变')
    ok(readFileSync(join(cRepo, 'keep.txt'), 'utf8') === 'keep\nmodified\n', '源工作区文件内容不变')

    const badStart = await createWorktree({
      cwd: cRepo,
      branch: 'carry-bad-start',
      startPoint: 'main~0',
      targetPath: null,
      carry: { staged: false, unstaged: true, untracked: [] }
    })
    ok(
      badStart.ok === false && badStart.failure?.code === 'invalid-input',
      '指定了起点时拒绝携带（不然不知道该应用到哪）',
      JSON.stringify(badStart.failure?.code)
    )

    {
      const xRoot = mkdtempSync(join(tmpdir(), 'yan-git-conflict-'))
      git(xRoot, ['init', '-q', '-b', 'main'])
      git(xRoot, ['config', 'user.email', 't@example.com'])
      git(xRoot, ['config', 'user.name', 'T'])
      writeFileSync(join(xRoot, 'c.txt'), 'base\n')
      git(xRoot, ['add', '-A'])
      git(xRoot, ['commit', '-q', '-m', 'init'])
      git(xRoot, ['checkout', '-q', '-b', 'other'])
      writeFileSync(join(xRoot, 'c.txt'), 'other\n')
      git(xRoot, ['commit', '-q', '-am', 'other'])
      git(xRoot, ['checkout', '-q', 'main'])
      writeFileSync(join(xRoot, 'c.txt'), 'main\n')
      git(xRoot, ['commit', '-q', '-am', 'main'])
      try {
        git(xRoot, ['merge', 'other'])
      } catch {
      }
      const conflictCarry = await createWorktree({
        cwd: xRoot,
        branch: 'carry-conflict',
        startPoint: null,
        targetPath: null,
        carry: { staged: true, unstaged: true, untracked: [] }
      })
      ok(
        conflictCarry.ok === false && conflictCarry.failure?.code === 'carry-rejected',
        '有未解决冲突时拒绝迁移',
        JSON.stringify(conflictCarry.failure?.code)
      )
      ok(
        String(conflictCarry.failure?.message ?? '').includes('冲突'),
        '拒绝原因里说明是冲突',
        String(conflictCarry.failure?.message ?? '').slice(0, 50)
      )
      ok(
        git(xRoot, ['worktree', 'list']).trim().split('\n').length === 1,
        '被拒时没有留下半个工作树'
      )
      await rm(xRoot, { recursive: true, force: true }).catch(() => {})
    }

    {
      writeFileSync(join(cRepo, 'gone.txt'), 'x\n')
      git(cRepo, ['add', 'gone.txt'])
      const stale = await createWorktree({
        cwd: cRepo,
        branch: 'carry-stale',
        startPoint: null,
        targetPath: null,
        carry: { staged: false, unstaged: false, untracked: ['gone.txt'] }
      })
      ok(
        stale.ok === false && stale.failure?.code === 'carry-rejected',
        '勾选项与实际状态不符时拒绝',
        JSON.stringify(stale.failure?.code)
      )
      git(cRepo, ['reset', '-q', 'gone.txt'])
      await rm(join(cRepo, 'gone.txt'), { force: true }).catch(() => {})
    }

    const plain = await createWorktree({
      cwd: cRepo,
      branch: 'carry-plain',
      startPoint: null,
      targetPath: null
    })
    ok(
      plain.ok === true && (plain.notes ?? []).some((n) => n.includes('不会自动带入')),
      '不带时必须明说「未提交改动不会自动带入」',
      (plain.notes ?? [])[0] ?? ''
    )
    if (plain.ok && plain.path) {
      ok(
        !/keep\.txt/.test(git(plain.path, ['status', '--porcelain=v1'])),
        '不带时目标工作树确实是干净的'
      )
    }

    await rm(cRoot, { recursive: true, force: true }).catch(() => {})
  }

  await rm(root, { recursive: true, force: true }).catch(() => {})
}

