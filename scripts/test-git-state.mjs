/* Repository status parser and hosted URL regression checks. */
export async function runGitStateTests(ok) {
  const { parseStatusV2, remoteWebUrl, compareWebUrl } = await import('../out/test/git.mjs')
  const NUL = '\0'
  const j = (...parts) => JSON.stringify(parts)
  /* ══════════════════════ 2. porcelain=v2 -z 解析 ══════════════════════ */

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

    /* rename：新路径在行内、旧路径在**下一段** */
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
    /* 无首提交：branch.oid 是 (initial)；detached 另测 */
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
    /* 冲突：u 条目有 10 个固定字段，路径里可以有空格 */
    const p = parseStatusV2(['u UU N... 100644 100644 100644 100644 aaa bbb ccc src/冲突 文件.ts'].join(NUL))
    const u = p.entries[0]
    ok(u.unmerged === true, 'u 条目标记为未合并')
    ok(u.path === 'src/冲突 文件.ts', '冲突条目的路径（含空格）正确', u.path)
  }

  /* ── remote 地址 → 托管网页（G3 / H1 的纯解析）── */
  {
    /*
     * 这里的原则是**宁可不给链接，也不要给一个打不开的**：
     * 认不出的托管站一律 null（自建服务的网页路径各不相同，猜一个等于 404）。
     */
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
