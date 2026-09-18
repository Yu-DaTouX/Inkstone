/**
 * Git 审查的纯逻辑单测（不启动 Electron、不建仓库、不花 token）。
 *
 * 为什么这批测试值得写：Git 的输出格式有一堆反直觉之处，而它们全都会
 * 变成**用户看得见的错**：
 *   · `--numstat` 对二进制给的是 `-` 而不是 0（当成 0 → 显示「+0 -0」，
 *     用户以为没改动）
 *   · `-z` 下 rename 条目多占一段（少读一段 → 路径与状态错位）
 *   · 未跟踪文件不在任何 diff 输出里（只能从 `status` 补，且行数要自己数）
 *   · 已暂存 / 未暂存同名的双状态（只显示一个 → 用户不知道 index 里还有一份）
 * 这些都是真跑仓库才能发现的，但真跑仓库又慢又不稳定 —— 用合成的
 * git 输出钉住它们最划算。
 *
 * 用法：npm run test:unit（由 test-unit.mjs 调起）
 */

export async function runGitReviewTests(ok) {
  const {
    scopeToArgs,
    scopeHasUntracked,
    scopeIdentity,
    parseStatusV2,
    parseDiffRaw,
    parseNumstat,
    buildChangedFiles,
    summarize,
    parseUnifiedDiff,
    countDiffLines,
    classifyKind,
    letterToStatus,
    imageExtOf,
    mimeOfExt,
    unquoteGitPath,
    stripAbPrefix,
    viewedKey,
    gapRanges,
    EMPTY_TREE
  } = await import('../out/test/git.mjs')
  const { remoteWebUrl, compareWebUrl } = await import('../out/test/git.mjs')

  const NUL = '\0'
  const j = (...parts) => JSON.stringify(parts)

  /* ══════════════════════════ 1. 范围 → git 参数 ══════════════════════════ */

  console.log('\n--- 1. 范围到 git 参数的映射 ---')

  {
    const w = scopeToArgs({ kind: 'working' }, true)
    ok(w?.refs.join(' ') === 'HEAD', '工作区全部改动：对 HEAD 比较', j(w))
    ok(w?.needStatus === true, '工作区全部改动：需要未跟踪文件（status）')

    const w2 = scopeToArgs({ kind: 'working' }, false)
    ok(w2?.refs.length === 0, '无首提交时工作区不对 HEAD 比较（HEAD 不存在会报错）', j(w2))

    const u = scopeToArgs({ kind: 'unstaged' }, true)
    ok(u?.refs.length === 0, '未暂存：不带 ref（即工作区 vs index）', j(u))

    const s = scopeToArgs({ kind: 'staged' }, true)
    ok(s?.refs.join(' ') === '--cached', '已暂存：相对 index（--cached）', j(s))
    ok(s?.emptyTree === false, '有首提交时不需要空树')

    const s2 = scopeToArgs({ kind: 'staged' }, false)
    ok(s2?.emptyTree === true, '无首提交时已暂存要相对空树', j(s2))
    ok(EMPTY_TREE.length === 40, '空树 sha 是 40 位')

    const r = scopeToArgs({ kind: 'range', base: 'main', target: 'feature' }, true)
    ok(r?.refs.join(' ') === 'main feature', '两端比较：按 base → target 传参', j(r))
    ok(r?.needStatus === false, '两端比较不需要工作区状态（纯已提交内容）')

    ok(scopeToArgs({ kind: 'range', base: 'main' }, true) === null, '两端比较缺 target 时判为非法')
    ok(scopeToArgs({ kind: 'range', base: '  ', target: 'x' }, true) === null, '空白 ref 视为非法')

    ok(scopeHasUntracked({ kind: 'working' }) === true, '工作区范围含未跟踪文件')
    ok(scopeHasUntracked({ kind: 'unstaged' }) === true, '未暂存范围含未跟踪文件')
    ok(scopeHasUntracked({ kind: 'staged' }) === false, '已暂存范围不含未跟踪文件（它们不在 index 里）')
    ok(scopeHasUntracked({ kind: 'range', base: 'a', target: 'b' }) === false, '两端比较不含未跟踪文件')

    ok(scopeIdentity({ kind: 'range', base: 'a', target: 'b' }) === 'range:a..b', '范围身份串含两端 ref')
    ok(scopeIdentity({ kind: 'working' }) === 'working', '非 range 直接用品名')
  }

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

  /* ═══════════════════════ 3. diff --raw -z 解析 ═══════════════════════ */

  console.log('\n--- 3. git diff --raw -z ---')

  {
    const out = [
      ':100644 100644 aaa bbb M',
      'src/a.ts',
      ':000000 100644 000 ccc A',
      'docs/new.md',
      ':100644 100644 ddd eee R100',
      'src/old.ts',
      'src/new.ts',
      ':160000 160000 fff ggg M',
      'vendor/sub'
    ].join(NUL)

    const raw = parseDiffRaw(out)
    ok(raw.length === 4, '四个条目', `实际 ${raw.length}`)

    ok(raw[0].code === 'M' && raw[0].path === 'src/a.ts', '普通修改条目解析', j(raw[0]))
    ok(raw[0].oldSha === 'aaa' && raw[0].newSha === 'bbb', '两侧 blob sha 都读到了（指纹的来源）')

    ok(raw[1].code === 'A' && raw[1].path === 'docs/new.md', '新增条目：oldSha 是全零', raw[1].oldSha)

    ok(raw[2].code === 'R100', 'rename 的 code 带相似度')
    ok(raw[2].oldPath === 'src/old.ts' && raw[2].path === 'src/new.ts', 'rename 的旧新路径各就各位', j(raw[2]))

    ok(raw[3].newMode === '160000' && raw[3].path === 'vendor/sub', '子模块条目：mode 160000 保留', raw[3].newMode)
    void j
  }

  /* ═══════════════════════ 4. numstat -z 解析 ═══════════════════════ */

  console.log('\n--- 4. git diff --numstat -z ---')

  {
    const out = [
      `12\t3\tsrc/a.ts`,
      `0\t0\tdocs/空文件.md`,
      `-\t-\tbuild/logo.png`,
      `5\t1\t`,
      `src/old.ts`,
      `src/new.ts`
    ].join(NUL)

    const n = parseNumstat(out)
    ok(n.length === 4, '四个条目', `实际 ${n.length}`)

    ok(n[0].additions === 12 && n[0].deletions === 3, '普通条目行数解析', j(n[0]))
    ok(n[1].additions === 0 && n[1].deletions === 0, '零改动条目不是二进制', j(n[1]))
    ok(n[2].binary === true, '前两列是 `-` → 判为二进制', j(n[2]))
    ok(n[2].additions === 0 && n[2].deletions === 0, '二进制条目的增删是 0（而不是 NaN）')

    ok(n[3].oldPath === 'src/old.ts' && n[3].path === 'src/new.ts', 'rename：空第三列 + 旧新各占一段', j(n[3]))
  }

  /* ═════════════════ 5. 合成清单（双状态 / 未跟踪 / kind） ═════════════════ */

  console.log('\n--- 5. 合成文件清单 ---')

  {
    const status = parseStatusV2(
      [
        '# branch.oid abc',
        '# branch.head main',
        '1 MM N... 100644 100644 100644 aaa bbb src/both.ts',
        '1 .M N... 100644 100644 100644 aaa ccc src/work.ts',
        '1 M. N... 100644 100644 100644 aaa ddd src/index-only.ts',
        '2 R. N... 100644 100644 100644 eee fff R100 src/renamed.ts',
        'src/was.ts',
        '? notes/新建.txt',
        '? assets/图标.png'
      ].join(NUL)
    )

    const raw = parseDiffRaw(
      [
        ':100644 100644 aaa bbb M',
        'src/both.ts',
        ':100644 100644 aaa ccc M',
        'src/work.ts',
        ':100644 100644 aaa ddd M',
        'src/index-only.ts',
        ':100644 100644 eee fff R100',
        'src/was.ts',
        'src/renamed.ts'
      ].join(NUL)
    )

    const numstat = parseNumstat(
      [`1\t1\tsrc/both.ts`, `2\t0\tsrc/work.ts`, `0\t3\tsrc/index-only.ts`, `1\t1\t`, `src/was.ts`, `src/renamed.ts`].join(
        NUL
      )
    )

    const files = buildChangedFiles({
      raw,
      numstat,
      status,
      untrackedLines: { 'notes/新建.txt': 7 },
      untrackedMeta: {
        'notes/新建.txt': { size: 120, mtimeMs: 1700000000000 },
        'assets/图标.png': { size: 4096, mtimeMs: 1700000000001 }
      }
    })

    const byPath = Object.fromEntries(files.map((f) => [f.path, f]))
    ok(files.length === 6, '六个文件（未跟踪的两个也在）', `实际 ${files.length}: ${files.map((f) => f.path).join(',')}`)

    ok(byPath['src/both.ts'].staged === 'modified' && byPath['src/both.ts'].unstaged === 'modified', '同名文件的双状态都保留')
    ok(byPath['src/both.ts'].additions === 1 && byPath['src/both.ts'].deletions === 1, '行数来自 numstat')
    ok(byPath['src/both.ts'].oldFingerprint === 'aaa' && byPath['src/both.ts'].newFingerprint === 'bbb', '指纹用两侧 blob sha')

    ok(byPath['src/work.ts'].staged === null && byPath['src/work.ts'].unstaged === 'modified', '只有工作区改动时 staged 为 null')
    ok(byPath['src/index-only.ts'].staged === 'modified' && byPath['src/index-only.ts'].unstaged === null, '只有暂存改动时 unstaged 为 null')

    const rn = byPath['src/renamed.ts']
    ok(rn.status === 'renamed', 'rename 的状态是 renamed', rn.status)
    ok(rn.oldPath === 'src/was.ts', 'rename 的旧路径带过来了', String(rn.oldPath))

    const nt = byPath['notes/新建.txt']
    ok(nt.untracked === true && nt.status === 'untracked', '未跟踪文件状态正确')
    ok(nt.additions === 7, '未跟踪文件的行数来自主进程统计（不是 0）', String(nt.additions))
    ok(nt.newFingerprint.startsWith('u:'), '未跟踪文件用 size:mtime 作指纹', nt.newFingerprint)
    ok(nt.kind === 'text', '文本文件判为 text')

    ok(byPath['assets/图标.png'].kind === 'image', '按扩展名把图片判为 image', byPath['assets/图标.png'].kind)

    const stats = summarize(files, false)
    ok(stats.files === 6, '统计的文件数', String(stats.files))
    ok(stats.additions === 1 + 2 + 0 + 1 + 7 && stats.deletions === 1 + 0 + 3 + 1, '总增删是把各文件相加', `${stats.additions}/${stats.deletions}`)
    ok(stats.truncated === false, '未截断')

    /* 未跟踪的二进制：元数据里带 LFS 判据 */
    const lfsFiles = buildChangedFiles({
      raw: [],
      numstat: [],
      status: parseStatusV2(['? data/big.psd'].join(NUL)),
      untrackedLines: {},
      untrackedMeta: { 'data/big.psd': { size: 10, mtimeMs: 1 } },
      lfsPaths: ['data/big.psd']
    })
    ok(lfsFiles[0].kind === 'lfs', 'LFS 指针优先于二进制判定', lfsFiles[0].kind)
  }

  /* ══════════════════════ 6. unified diff 解析 ══════════════════════ */

  console.log('\n--- 6. unified diff 解析 ---')

  {
    const text = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,4 @@ export function a() {',
      ' const x = 1',
      '-const y = 2',
      '+const y = 3',
      '+const z = 4',
      ' return x',
      '@@ -10,2 +11,2 @@',
      '-old',
      '+new',
      'diff --git a/docs/new.md b/docs/new.md',
      'new file mode 100644',
      'index 000..333',
      '--- /dev/null',
      '+++ b/docs/new.md',
      '@@ -0,0 +1,2 @@',
      '+line one',
      '+line two',
      'diff --git a/build/logo.png b/build/logo.png',
      'index 444..555 100644',
      'Binary files a/build/logo.png and b/build/logo.png differ'
    ].join('\n')

    const files = parseUnifiedDiff(text)
    ok(files.length === 3, '三个文件段', `实际 ${files.length}`)

    const a = files[0]
    ok(a.path === 'src/a.ts', '文件路径去掉 a/ 前缀', a.path)
    ok(a.hunks.length === 2, '两个 hunk', String(a.hunks.length))
    ok(a.hunks[0].section === 'export function a() {', 'hunk 的 section 文案保留', a.hunks[0].section)
    ok(a.hunks[0].oldStart === 1 && a.hunks[0].oldCount === 3 && a.hunks[0].newStart === 1 && a.hunks[0].newCount === 4, 'hunk 头部的四个数字', j(a.hunks[0]))

    const l0 = a.hunks[0].lines
    ok(l0[0].type === 'ctx' && l0[0].oldLine === 1 && l0[0].newLine === 1, '上下文行两侧行号都在', j(l0[0]))
    ok(l0[1].type === 'del' && l0[1].oldLine === 2 && l0[1].newLine === null, '删除行只有旧行号', j(l0[1]))
    ok(l0[2].type === 'add' && l0[2].oldLine === null && l0[2].newLine === 2, '新增行只有新行号', j(l0[2]))
    ok(l0[3].type === 'add' && l0[3].newLine === 3, '第二行新增的新行号连续')
    ok(l0[4].type === 'ctx' && l0[4].oldLine === 3 && l0[4].newLine === 4, '删除/新增交替后上下文行号正确（旧+1、新+2）', j(l0[4]))

    const b = files[1]
    ok(b.path === 'docs/new.md', '新增文件的新路径', b.path)
    ok(b.oldPath === undefined, '新增文件没有旧路径（不伪造缺失的一侧）', String(b.oldPath))
    ok(b.hunks[0].oldStart === 0, '新增文件的旧侧从 0 开始')
    ok(countDiffLines([b]).additions === 2, '新增文件数出 2 行增', String(countDiffLines([b]).additions))

    const c = files[2]
    ok(c.binary === true, 'Binary files 段落标记为二进制', String(c.binary))
    ok(c.hunks.length === 0, '二进制没有 hunk')

    const counts = countDiffLines(files)
    ok(counts.additions === 5 && counts.deletions === 2, '整份 diff 的增删统计（+5 -2）', j(counts))
  }

  {
    /* 边界：\ No newline、删除文件、含中文与空格的路径、git 加引号的路径 */
    const text = [
      'diff --git a/删掉的 文件.md b/删掉的 文件.md',
      'deleted file mode 100644',
      '--- a/删掉的 文件.md',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-第一行',
      '-第二行',
      '\\ No newline at end of file',
      'diff --git "a/中文\\344\\270\\255.ts" "b/中文\\344\\270\\255.ts"',
      '--- "a/中文\\344\\270\\255.ts"',
      '+++ "b/中文\\344\\270\\255.ts"',
      '@@ -1 +1 @@',
      '-a',
      '+b'
    ].join('\n')

    const files = parseUnifiedDiff(text)
    ok(files.length === 2, '两个文件段（含被引号包裹的）', String(files.length))

    const del = files[0]
    ok(del.path === '删掉的 文件.md', '删除文件的路径含中文与空格（+++ 是 /dev/null 时回退旧侧）', del.path)
    ok(del.oldPath === '删掉的 文件.md', '删除文件保留旧路径（内容从旧侧读）', String(del.oldPath))
    const contentLines = del.hunks[0].lines.filter((l) => l.type !== 'none')
    ok(contentLines.length === 2, '\\ No newline 不算内容行（否则之后所有行号偏移）', String(del.hunks[0].lines.length))
    const marker = del.hunks[0].lines.find((l) => l.type === 'none')
    ok(marker !== undefined && marker.oldLine === null, '\\ No newline 保留为提示行但**没有行号**（不会误标到某一行）', j(marker))
    ok(contentLines[1].type === 'del', '第二行仍是删除行')

    const cn = files[1]
    ok(cn.path === '中文中.ts', '八进制转义的 UTF-8 路径还原成中文', cn.path)
  }

  /* ═══════════════════ 6b. 未修改区的行号区间 ═══════════════════ */

  console.log('\n--- 6b. 未修改区的区间（“展开上下文”按它切行）---')

  {
    const hunksOf = (text) => parseUnifiedDiff(text)[0].hunks

    /* 首块之前有一段 9 行，两块之间一段 60 行 */
    const text = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -10,3 +10,4 @@',
      ' a',
      '-b',
      '+b2',
      '+b3',
      ' c',
      '@@ -73,3 +74,3 @@',
      ' d',
      '-e',
      '+e2'
    ].join('\n')
    const gaps = gapRanges(hunksOf(text))
    ok(gaps.length === 2, '两个未修改区（首块之前 + 两块之间）', String(gaps.length))
    ok(gaps[0].oldStart === 1 && gaps[0].newStart === 1, '首块之前的区间从第 1 行开始')
    ok(gaps[0].count === 9, '首块之前是 9 行（第 10 行之前）', String(gaps[0].count))
    ok(gaps[1].oldStart === 13 && gaps[1].newStart === 14, '两块之间的区间从上一块的**末尾之后**开始', j(gaps[1]))
    ok(gaps[1].count === 60, '两块之间是 60 行（73 - 13）', String(gaps[1].count))
    /* 两侧长度必须相等：未修改区在两侧内容一样，只是起点可能错开 */
    const nextOld = gaps[1].oldStart + gaps[1].count
    const nextNew = gaps[1].newStart + gaps[1].count
    ok(nextOld === 73 && nextNew === 74, '区间末尾正好接上下一个 hunk 的起点（两侧各自对齐）', `${nextOld}/${nextNew}`)

    /* 相邻 hunk（没有未修改区）时给 0，界面据此不渲染折叠条 */
    const tight = [
      'diff --git a/y.ts b/y.ts',
      '--- a/y.ts',
      '+++ b/y.ts',
      '@@ -1,2 +1,2 @@',
      '-a',
      '+b',
      '@@ -3,2 +3,2 @@',
      '-c',
      '+d'
    ].join('\n')
    const tightGaps = gapRanges(hunksOf(tight))
    ok(tightGaps.length === 2 && tightGaps[0].count === 0 && tightGaps[1].count === 0, '紧贴的两个 hunk 之间是 0 行（不画折叠条）', j(tightGaps))

    ok(gapRanges([]).length === 0, '没有 hunk 时没有区间')
  }

  /* ══════════════════════ 7. 内容形态判定 ══════════════════════ */

  console.log('\n--- 7. 内容形态（kind）判定 ---')

  {
    ok(classifyKind('src/a.ts') === 'text', '普通源码是文本')
    ok(classifyKind('vendor/sub', { mode: '160000' }) === 'submodule', 'mode 160000 → 子模块（不看扩展名）')
    ok(classifyKind('link.ts', { mode: '120000' }) === 'symlink', 'mode 120000 → 符号链接')
    ok(classifyKind('logo.PNG') === 'image', '扩展名大小写不敏感')
    ok(classifyKind('a.bin', { binary: true }) === 'binary', '二进制标志优先于扩展名')
    ok(classifyKind('a.pdf') === 'binary', 'PDF 按二进制处理（不假装能显示）')
    ok(classifyKind('big.log', { size: 5 * 1024 * 1024 }) === 'large', '超过上限 → large（明确限制而不是假装成功）')
    ok(classifyKind('big.mp4', { size: 5 * 1024 * 1024, largeAt: 1024 * 1024 }) === 'large', '上限可覆盖')
    ok(classifyKind('x.psd', { lfs: true }) === 'lfs', 'LFS 指针单独成一类')

    ok(imageExtOf('a.png') === 'png', '图片扩展名提取')
    ok(imageExtOf('a.svg') === null, 'SVG 不算位图（它按文本 diff 处理，不当可执行文档嵌入）')
    ok(imageExtOf('a') === null, '没有扩展名时为 null')
    ok(mimeOfExt('jpg') === 'image/jpeg' && mimeOfExt('png') === 'image/png', 'mime 映射')
    ok(mimeOfExt('bin') === 'application/octet-stream', '未知扩展名不给假 mime')

    ok(letterToStatus('M') === 'modified', 'M → modified')
    ok(letterToStatus('R') === 'renamed', 'R → renamed')
    ok(letterToStatus('?') === 'untracked', '? → untracked')
    ok(letterToStatus('.') === null, '`.` 表示无变化（不是 unknown）')
    ok(letterToStatus('') === null, '空字符表示无变化')

    ok(stripAbPrefix('a/x') === 'x' && stripAbPrefix('b/y') === 'y', '剥掉 a/ b/ 前缀')
    ok(stripAbPrefix('/dev/null') === '/dev/null', '/dev/null 保持原样（调用方据此判断缺一侧）')
    ok(unquoteGitPath('"a\\"b"') === 'a"b', '还原转义的双引号')
    ok(unquoteGitPath('plain') === 'plain', '没被引号包裹时原样返回')
  }

  /* ══════════════════════ 8. 已查看的键 ══════════════════════ */

  console.log('\n--- 8. 已查看标记的键 ---')

  {
    const base = {
      repoId: 'r1',
      worktreeId: 'w1',
      scope: 'working',
      path: 'src/a.ts',
      oldFingerprint: 'aaa',
      newFingerprint: 'bbb'
    }
    const k1 = viewedKey(base)
    ok(k1.includes('r1') && k1.includes('w1') && k1.includes('working') && k1.includes('src/a.ts'), '键含仓库/工作树/范围/路径', k1)

    ok(viewedKey(base) === k1, '同样输入 → 同样的键（可去重）')
    ok(viewedKey({ ...base, newFingerprint: 'ccc' }) !== k1, '新侧内容变了 → 键变（标记自动失效）')
    ok(viewedKey({ ...base, oldFingerprint: 'zzz' }) !== k1, '旧侧内容变了 → 键也变（分支切换后不会沿用旧标记）')
    ok(viewedKey({ ...base, scope: 'staged' }) !== k1, '范围不同 → 键不同')
    ok(viewedKey({ ...base, worktreeId: 'w2' }) !== k1, '另一个工作树 → 键不同（同一仓库两个 worktree 不串）')
    ok(viewedKey({ ...base, path: 'src/a.ts', oldPath: 'src/b.ts' }) !== k1, 'rename 的旧路径参与键（改名后旧的已查看不算数）')
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
