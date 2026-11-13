import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const GIT_ENV = {
  ...process.env,
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

function gitOut(cwd, args) {
  try {
    return git(cwd, args).trim()
  } catch {
    return ''
  }
}

function gitc(cwd, args) {
  return git(cwd, ['-c', 'user.name=yan-test', '-c', 'user.email=yan-test@example.com', ...args])
}

export async function runSessionIsolationTests(ok) {
  const {
    autoIsolationBranch,
    sanitizeAutoIsolationDocument,
    AutoIsolationStore,
    isolateCwdForConflict,
    pendingIsolationChanges,
    isolationCwdKey,
    isolatedSessionCwd
  } = await import('../out/test/session-isolation.mjs')

  const stamp = new Date(2026, 8, 25, 14, 30, 12, 7)
  const branch = autoIsolationBranch(stamp)
  ok(branch === 'Inkstone/20260925-143012007', '分支名按时间戳生成且带毫秒', branch)
  ok(autoIsolationBranch(new Date(2026, 8, 25, 14, 30, 12, 8)) !== branch, '同秒不同毫秒不会撞名')

  const sanitized = sanitizeAutoIsolationDocument({
    version: 1,
    records: [
      { worktree: '/w1', mainCwd: '/m1', branch: 'yan/auto-1', repoRoot: '/r', baseBranch: 'main', sessionId: 's1', createdAt: 5 },
      { worktree: '', mainCwd: '/m2', branch: 'b' },
      { worktree: '/w3', mainCwd: '', branch: 'b' },
      { worktree: '/w4', mainCwd: '/m4', branch: '' },
      { worktree: '/w5', mainCwd: '/m5', branch: 'b', syncedAt: 9 }
    ]
  })
  ok(sanitized.records.length === 2, '清洗：缺身份字段的记录被丢弃', String(sanitized.records.length))
  ok(sanitized.records[0].sessionId === 's1' && sanitized.records[1].syncedAt === 9, '清洗：有效字段逐个保留')
  ok(isolationCwdKey('C:\\Repo\\Wt\\') === isolationCwdKey('c:/repo/wt'), 'cwd 比较口径与并发防线一致（斜杠/大小写/尾分隔符）')

  const root = mkdtempSync(join(tmpdir(), 'yan-auto-iso-'))
  const repo = join(root, 'demo')
  mkdirSync(repo, { recursive: true })

  const realProcessEnv = {}
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_TERMINAL_PROMPT']) {
    realProcessEnv[key] = process.env[key]
    if (GIT_ENV[key] === undefined) delete process.env[key]
    else process.env[key] = GIT_ENV[key]
  }
  delete process.env.GIT_AUTHOR_NAME
  delete process.env.GIT_AUTHOR_EMAIL
  delete process.env.GIT_COMMITTER_NAME
  delete process.env.GIT_COMMITTER_EMAIL

  try {
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'core.autocrlf', 'false'])
    await writeFile(join(repo, 'a.txt'), 'alpha\nbeta\ngamma\n')
    await writeFile(join(repo, 'keep.txt'), 'keep\n')
    git(repo, ['add', '-A'])
    gitc(repo, ['commit', '-q', '-m', 'init', '--no-verify'])

    const plain = join(root, 'plain')
    mkdirSync(plain, { recursive: true })
    const refused = await isolateCwdForConflict(plain)
    ok(refused.ok === false && refused.reason.includes('不是 Git 仓库'), '非 Git 目录拒绝自动隔离', JSON.stringify(refused))
    ok(existsSync(join(root, 'plain-worktrees')) === false, '拒绝时不会留下半截目录')

    const isolated = await isolateCwdForConflict(repo, { sessionId: 's-iso-1' })
    ok(isolated.ok === true, 'Git 仓库可以隔离', JSON.stringify(isolated))
    if (!isolated.ok) return
    const record = isolated.record
    ok(existsSync(join(record.worktree, 'a.txt')), '隔离工作树里有 HEAD 的内容', record.worktree)
    ok(record.baseBranch === 'main', '记下主干分支', record.baseBranch)
    ok(record.mainCwd === repo && record.branch.startsWith('Inkstone/'), '记录含主干目录与自动分支名', record.branch)
    ok(isolatedSessionCwd(record) === record.worktree, '在仓库根目录起的会话，隔离后就在工作树根')
    const subdir = join(repo, 'docs', 'notes')
    mkdirSync(subdir, { recursive: true })
    const nested = await isolateCwdForConflict(subdir, { sessionId: 's-iso-sub' })
    ok(nested.ok === true, '仓库子目录也能隔离', JSON.stringify(nested))
    if (nested.ok) {
      const nestedCwd = isolatedSessionCwd(nested.record)
      ok(nestedCwd === join(nested.record.worktree, 'docs', 'notes'), '子目录会话映射到工作树里同一个子目录', nestedCwd)
      ok(existsSync(nestedCwd), '工作树里没有的子目录会先建出来')
      ok(nested.record.mainCwd === subdir, '记录仍指向原来的子目录', nested.record.mainCwd)
      git(repo, ['worktree', 'remove', '--force', nested.record.worktree])
      git(repo, ['branch', '-D', nested.record.branch])
    }
    ok(isolatedSessionCwd({ worktree: '/w', repoRoot: '', mainCwd: '/m' }) === '/w', '旧记录没有仓库根时退回工作树根')
    ok(isolatedSessionCwd({ worktree: join(root, 'w'), repoRoot: repo, mainCwd: root }) === join(root, 'w'), '主目录不在仓库内时退回工作树根')
    const listed = gitOut(repo, ['worktree', 'list', '--porcelain'])
    ok(listed.includes(record.worktree.replace(/\\/g, '/')), 'git 认这个工作树', listed.split('\n')[0])

    await writeFile(join(repo, 'a.txt'), 'alpha\nLOCAL\nbeta\ngamma\n')
    const wtContent = readFileSync(join(record.worktree, 'a.txt'), 'utf8')
    ok(!wtContent.includes('LOCAL'), '隔离树从 HEAD 建，不带主目录的未提交改动')
    git(repo, ['checkout', '--', 'a.txt'])

    const storeRoot = join(root, 'yan-data')
    await mkdir(storeRoot, { recursive: true })
    const store = new AutoIsolationStore({ root: storeRoot })
    await store.add(record)
    const reloaded = new AutoIsolationStore({ root: storeRoot })
    ok((await reloaded.all()).length === 1, '登记表落盘后能读回')
    ok((await reloaded.byWorktree(record.worktree))?.branch === record.branch, '按工作树路径能找回登记')
    ok((await reloaded.bySession('s-iso-1'))?.worktree === record.worktree, '按会话 id 能找回登记')
    await reloaded.bindSession(record.worktree, 's-iso-2')
    ok((await reloaded.bySession('s-iso-2'))?.sessionId === 's-iso-2', 'bindSession 把新会话 id 补上')
    await reloaded.bindSession(record.worktree, 'pending:r7')
    ok((await reloaded.bySession('pending:r7')) === null && (await reloaded.bySession('s-iso-2')) !== null, 'pending 占位 id 不写进登记（不是稳定身份）')

    const clean = await pendingIsolationChanges(record)
    ok(clean.ok === true && clean.files === 0 && clean.commits === 0, '\u6ca1\u6539\u52a8\u65f6\u5f85\u5408\u5165\u4e3a 0', JSON.stringify(clean))
    await writeFile(join(record.worktree, 'b.txt'), 'from isolated\n')
    git(record.worktree, ['add', 'b.txt'])
    gitc(record.worktree, ['commit', '-q', '-m', 'agent step 1', '--no-verify'])
    await writeFile(join(record.worktree, 'b2.txt'), 'step 2\n')
    gitc(record.worktree, ['add', 'b2.txt'])
    gitc(record.worktree, ['commit', '-q', '-m', 'agent step 2', '--no-verify'])
    await writeFile(join(record.worktree, 'b3.txt'), 'uncommitted\n')
    const pending = await pendingIsolationChanges(record)
    ok(pending.ok === true && pending.files === 1 && pending.commits === 2, '\u5f85\u5408\u5165\u7edf\u8ba1\u672a\u63d0\u4ea4\u6587\u4ef6\u4e0e\u9886\u5148\u63d0\u4ea4', JSON.stringify(pending))
    ok(readFileSync(join(repo, 'a.txt'), 'utf8') && !existsSync(join(repo, 'b.txt')), '\u7edf\u8ba1\u5f85\u5408\u5165\u4e0d\u4f1a\u628a\u6539\u52a8\u5e26\u8fdb\u4e3b\u5e72')

    const doomed = await isolateCwdForConflict(repo)
    ok(doomed.ok === true, '再建一个用于验证修剪', JSON.stringify(doomed))
    if (doomed.ok) {
      const store2 = new AutoIsolationStore({ root: storeRoot })
      await store2.add(doomed.record)
      git(repo, ['worktree', 'remove', '--force', doomed.record.worktree])
      const store3 = new AutoIsolationStore({ root: storeRoot })
      const after = await store3.all()
      ok(
        !after.some((r) => r.worktree === doomed.record.worktree),
        '工作树消失后登记在加载时被清掉',
        after.map((r) => r.worktree).join(',')
      )
    }
    ok(existsSync(record.worktree), '上面的修剪没有误删活着的隔离工作树')
  } finally {
    for (const key of Object.keys(realProcessEnv)) {
      if (realProcessEnv[key] === undefined) delete process.env[key]
      else process.env[key] = realProcessEnv[key]
    }
    try {
      git(repo, ['worktree', 'prune'])
    } catch {
    }
    rmSync(root, { recursive: true, force: true })  }
}
