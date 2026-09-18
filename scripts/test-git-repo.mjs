/**
 * Git 审查数据层的**真实仓库**验证（真 git、临时目录、不碰用户数据）。
 *
 * 为什么在纯解析单测之外还要这一层：`src/shared/git.ts` 的单测喂的是
 * 我**以为** git 会输出的字符串。真 git 的输出有版本差异与一堆边角
 * （`-z` 下 rename 的段排列、`--numstat` 对二进制给 `-`、删除文件的
 * `+++ /dev/null`、`core.autocrlf` 影响行数），只有真跑一遍才算数。
 *
 * 顺带钉住两条**只读保证**（方案 §13.1 的硬要求）：
 *   · 打开/刷新审查前后，工作区内容与 index 必须逐字节一致
 *   · 不能调用 subagent-isolation 的 collectDiff（它会 `git add -A`）
 *
 * 用法：npm run test:unit（由 test-unit.mjs 调起；每个仓库 < 100ms）
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'yan-test',
  GIT_AUTHOR_EMAIL: 'yan-test@example.com',
  GIT_COMMITTER_NAME: 'yan-test',
  GIT_COMMITTER_EMAIL: 'yan-test@example.com',
  /* 屏蔽用户的全局 / 系统 gitconfig：init.defaultBranch、core.autocrlf、
     diff.external 这些会让测试结果随机器而变。NUL 是 Windows 的空设备。 */
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
  const { reviewSnapshot, filePatch, fileContent } = await import('../out/test/git-diff.mjs')
  const { resolveRepo, clearRepoCache } = await import('../out/test/git-service.mjs')

  const root = await mkdtemp(join(tmpdir(), 'yan-git-'))
  const repo = join(root, 'demo')
  await mkdir(repo, { recursive: true })

  /* ── 建一个普通仓库 ───────────────────────────────────── */

  git(repo, ['init', '-q', '-b', 'main'])
  /* 关掉 autocrlf：它会让「行数」在不同平台不一致，而我们要断言行数 */
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

  /* ── 造出各种工作区状态 ───────────────────────────────── */

  await writeFile(join(repo, 'a.txt'), 'one\nTWO\nthree\nfour\n') // 未暂存修改
  await rm(join(repo, 'gone.txt')) // 未暂存删除
  await writeFile(join(repo, '中文 及空格.txt'), '第一行\n改过的第二行\n') // 中文+空格路径
  git(repo, ['add', '中文 及空格.txt']) // → 已暂存修改
  await writeFile(join(repo, 'staged-new.txt'), 'brand new\n')
  git(repo, ['add', 'staged-new.txt']) // → 已暂存新增
  git(repo, ['mv', 'old-name.txt', 'new-name.txt']) // → 已暂存重命名
  await writeFile(join(repo, 'untracked.txt'), 'u1\nu2\nu3\n') // 未跟踪
  await mkdir(join(repo, 'assets'), { recursive: true })
  /* 一个真的含 NUL 字节的二进制文件（PNG 头 + 0x00） */
  await writeFile(join(repo, 'assets', 'blob.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00]))

  /* ── 1. 仓库身份 ─────────────────────────────────────── */

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
  }

  /* ── 2. 工作区全部改动 ───────────────────────────────── */

  console.log('\n--- G2. 工作区全部改动 ---')
  {
    clearRepoCache()
    const snap = await reviewSnapshot({ cwd: repo, scope: { kind: 'working' }, requestId: 'r1' })
    ok(snap.ok === true, '快照成功', snap.error)
    ok(snap.repo?.branch === 'main', '读到当前分支 main', String(snap.repo?.branch))
    ok(snap.repo?.unborn === false, '有首提交')

    const paths = snap.files.map((f) => f.path).sort()
    const expect = ['a.txt', '中文 及空格.txt', 'gone.txt', 'staged-new.txt', 'new-name.txt', 'untracked.txt'].sort()
    for (const p of expect) ok(paths.includes(p), `工作区范围含 ${p}`, paths.join(','))

    const byPath = Object.fromEntries(snap.files.map((f) => [f.path, f]))

    ok(byPath['a.txt'].unstaged === 'modified' && byPath['a.txt'].staged === null, 'a.txt：只有未暂存修改')
    ok(byPath['a.txt'].additions === 2 && byPath['a.txt'].deletions === 1, 'a.txt 行数 +2 -1', `+${byPath['a.txt'].additions} -${byPath['a.txt'].deletions}`)

    ok(byPath['gone.txt'].status === 'deleted', 'gone.txt 判为删除', byPath['gone.txt'].status)
    ok(byPath['gone.txt'].deletions === 1, '删除文件计 1 行删', String(byPath['gone.txt'].deletions))

    ok(byPath['staged-new.txt'].staged === 'added', 'staged-new.txt 判为已暂存新增')
    ok(byPath['staged-new.txt'].additions === 1, '新增文件计 1 行增', String(byPath['staged-new.txt'].additions))

    ok(byPath['new-name.txt'].status === 'renamed', 'git mv 判为重命名', byPath['new-name.txt'].status)
    ok(byPath['new-name.txt'].oldPath === 'old-name.txt', '重命名带出旧路径', String(byPath['new-name.txt'].oldPath))

    ok(byPath['中文 及空格.txt'].staged === 'modified', '中文与空格路径的已暂存修改')
    ok(byPath['中文 及空格.txt'].additions === 1 && byPath['中文 及空格.txt'].deletions === 1, '中文路径文件的行数正确')

    ok(byPath['untracked.txt'].untracked === true, '未跟踪文件在清单里')
    ok(byPath['untracked.txt'].additions === 3, '未跟踪文件的行数由主进程数出来（3 行）', String(byPath['untracked.txt'].additions))
    ok(byPath['untracked.txt'].kind === 'text', '未跟踪文本文件判为 text')

    /* 二进制文件没有被 diff 出来（工作区里它是未跟踪的二进制） */
    ok(byPath['assets/blob.bin'] !== undefined, '未跟踪的二进制也在清单里')
    ok(byPath['assets/blob.bin'].kind === 'binary', '含 NUL 的文件判为二进制', byPath['assets/blob.bin'].kind)

    ok(snap.stats.files === snap.files.length, '统计的文件数与清单一致')
    ok(snap.stats.additions > 0 && snap.stats.deletions > 0, '总增删都有值')
    ok(snap.truncated === false, '未截断')

    /* 未跟踪文件的指纹来自 size+mtime，不是空串 */
    ok(byPath['untracked.txt'].newFingerprint.startsWith('u:'), '未跟踪文件有指纹', byPath['untracked.txt'].newFingerprint)
    /* 已跟踪文件的指纹来自 blob sha */
    ok(/^[0-9a-f]{4,}$/.test(byPath['a.txt'].oldFingerprint), '已跟踪文件的旧侧指纹是 blob sha', byPath['a.txt'].oldFingerprint)
  }

  /* ── 3. 未暂存 / 已暂存 ──────────────────────────────── */

  console.log('\n--- G3. 未暂存与已暂存分开 ---')
  {
    clearRepoCache()
    const unstaged = await reviewSnapshot({ cwd: repo, scope: { kind: 'unstaged' }, requestId: 'r2' })
    const uPaths = unstaged.files.map((f) => f.path)
    ok(uPaths.includes('a.txt'), '未暂存含 a.txt')
    ok(uPaths.includes('gone.txt'), '未暂存含删除的 gone.txt')
    ok(!uPaths.includes('staged-new.txt'), '未暂存**不含**只暂存过的文件', uPaths.join(','))
    ok(uPaths.includes('untracked.txt'), '未暂存含未跟踪文件（它们不属于 index）')

    const staged = await reviewSnapshot({ cwd: repo, scope: { kind: 'staged' }, requestId: 'r3' })
    const sPaths = staged.files.map((f) => f.path)
    ok(sPaths.includes('staged-new.txt'), '已暂存含新增文件')
    ok(sPaths.includes('new-name.txt'), '已暂存含重命名')
    ok(sPaths.includes('中文 及空格.txt'), '已暂存含中文路径文件')
    ok(!sPaths.includes('a.txt'), '已暂存**不含**工作区里的未暂存修改', sPaths.join(','))
    ok(!sPaths.includes('untracked.txt'), '已暂存不含未跟踪文件')

    /* 重新暂存 a.txt 后，它应当**同时**出现在两侧（双状态） */
    git(repo, ['add', 'a.txt'])
    await writeFile(join(repo, 'a.txt'), 'one\nTWO\nthree\nfour\nfive\n')
    clearRepoCache()
    const both = await reviewSnapshot({ cwd: repo, scope: { kind: 'working' }, requestId: 'r4' })
    const a = both.files.find((f) => f.path === 'a.txt')
    ok(a.staged === 'modified' && a.unstaged === 'modified', '同一文件同时有已暂存与未暂存（两个状态都保留）', `${a.staged}/${a.unstaged}`)
    ok(both.notes.some((n) => n.includes('不重复相加')), '这种情况下给出「行数不重复相加」的说明', both.notes.join(' | '))

    /* 取消暂存，恢复现场（后续测试的假设是 a.txt 只有未暂存改动） */
    git(repo, ['restore', '--staged', 'a.txt'])
    await writeFile(join(repo, 'a.txt'), 'one\nTWO\nthree\nfour\n')
  }

  /* ── 4. 单文件 diff ──────────────────────────────────── */

  console.log('\n--- G4. 单文件 diff（结构化 hunk） ---')
  {
    clearRepoCache()
    const p = await filePatch({
      cwd: repo,
      scope: { kind: 'working' },
      requestId: 'p1',
      path: 'a.txt'
    })
    ok(p.ok === true, 'patch 成功', p.error)
    ok(p.hunks.length === 1, '一个 hunk', String(p.hunks.length))
    const lines = p.hunks[0].lines
    ok(lines.some((l) => l.type === 'add' && l.text === 'four'), '新增行内容正确')
    ok(lines.some((l) => l.type === 'del' && l.text === 'two'), '删除行内容正确')
    ok(lines.find((l) => l.text === 'four')?.newLine === 4, '新增行的新行号是 4', String(lines.find((l) => l.text === 'four')?.newLine))
    ok(lines.find((l) => l.text === 'two')?.oldLine === 2, '删除行的旧行号是 2', String(lines.find((l) => l.text === 'two')?.oldLine))
    ok(p.additions === 2 && p.deletions === 1, 'patch 自带的增删统计与清单一致', `+${p.additions} -${p.deletions}`)

    /* 未跟踪文件：git diff 里没有它，内容要自己合成 */
    const u = await filePatch({
      cwd: repo,
      scope: { kind: 'working' },
      requestId: 'p2',
      path: 'untracked.txt',
      untracked: true
    })
    ok(u.ok === true && u.synthesized === true, '未跟踪文件走「合成全新增」路径', String(u.synthesized))
    ok(u.hunks.length === 1 && u.hunks[0].lines.length === 3, '合成 3 行新增', String(u.hunks[0]?.lines.length))
    ok(u.hunks[0].lines[0].type === 'add' && u.hunks[0].lines[0].newLine === 1, '合成行的类型与行号', JSON.stringify(u.hunks[0].lines[0]))

    /* 二进制：明确说「没有文本差异」，不伪造 +0 -0 */
    const b = await filePatch({
      cwd: repo,
      scope: { kind: 'working' },
      requestId: 'p3',
      path: 'assets/blob.bin',
      untracked: true
    })
    ok(b.ok === true && b.binary === true, '二进制文件标记为 binary（不是「没有改动」）', b.kind)
    ok(b.hunks.length === 0, '二进制没有 hunk')

    /* 中文路径 */
    const cn = await filePatch({
      cwd: repo,
      scope: { kind: 'working' },
      requestId: 'p4',
      path: '中文 及空格.txt'
    })
    ok(cn.ok === true && cn.hunks.length === 1, '中文+空格路径能取到 patch', String(cn.hunks.length))
    ok(cn.hunks[0].lines.some((l) => l.type === 'add' && l.text.includes('改过的第二行')), '中文内容没有被转义破坏')

    /* 路径校验：拒绝越界与选项注入 */
    const bad1 = await filePatch({ cwd: repo, scope: { kind: 'working' }, requestId: 'p5', path: '../escape.txt' })
    ok(bad1.ok === false, '含 .. 的路径被拒', bad1.error)
    const bad2 = await filePatch({ cwd: repo, scope: { kind: 'working' }, requestId: 'p6', path: '--upload-pack=x' })
    ok(bad2.ok === false, '以 - 开头的路径被拒（防选项注入）', bad2.error)
    const bad3 = await filePatch({ cwd: repo, scope: { kind: 'working' }, requestId: 'p7', path: '/etc/passwd' })
    ok(bad3.ok === true || bad3.ok === false, '绝对路径要么被相对化要么被拒，不抛异常')
  }

  /* ── 5. 两侧内容（含图片通道） ───────────────────────── */

  console.log('\n--- G5. 两侧内容 ---')
  {
    clearRepoCache()
    const oldSide = await fileContent({
      cwd: repo,
      scope: { kind: 'working' },
      requestId: 'c1',
      path: 'a.txt',
      side: 'old'
    })
    ok(oldSide.ok === true && oldSide.kind === 'text', '旧侧是文本', oldSide.kind)
    ok(oldSide.text === 'one\ntwo\nthree\n', '旧侧内容来自 HEAD（不是磁盘上的未暂存版本）', JSON.stringify(oldSide.text))
    ok(oldSide.bytes === 14, '旧侧字节数', String(oldSide.bytes))

    const newSide = await fileContent({
      cwd: repo,
      scope: { kind: 'working' },
      requestId: 'c2',
      path: 'a.txt',
      side: 'new'
    })
    ok(newSide.text === 'one\nTWO\nthree\nfour\n', '新侧内容来自工作区（磁盘现状）', JSON.stringify(newSide.text))

    /* index 侧：staged 范围的 new 应当是**已暂存**的版本，而不是磁盘上的 */
    const idx = await fileContent({
      cwd: repo,
      scope: { kind: 'staged' },
      requestId: 'c3',
      path: 'staged-new.txt',
      side: 'new'
    })
    ok(idx.text === 'brand new\n', 'index 侧内容从 git 对象读（不是磁盘）', JSON.stringify(idx.text))

    /* 新增文件的旧侧「缺失」而不是报错 */
    const missing = await fileContent({
      cwd: repo,
      scope: { kind: 'working' },
      requestId: 'c4',
      path: 'staged-new.txt',
      side: 'old'
    })
    ok(missing.ok === true && missing.missing === true, '新增文件的旧侧标记为缺失（不是错误）', String(missing.missing))

    /* 二进制：不返回乱码文本，而是明确 binary */
    const bin = await fileContent({
      cwd: repo,
      scope: { kind: 'working' },
      requestId: 'c5',
      path: 'assets/blob.bin',
      side: 'new'
    })
    ok(bin.ok === true && bin.kind === 'binary', '二进制内容判为 binary（不吐 U+FFFD）', bin.kind)
    ok(bin.text === undefined, '二进制不返回 text')

    /* 图片：真写一个 PNG，走 buffer 通道 */
    const pngBytes = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001' +
        '0d0a2db40000000049454e44ae426082',
      'hex'
    )
    await writeFile(join(repo, 'pic.png'), pngBytes)
    const img = await fileContent({
      cwd: repo,
      scope: { kind: 'working' },
      requestId: 'c6',
      path: 'pic.png',
      side: 'new'
    })
    ok(img.ok === true && img.kind === 'image', 'PNG 判为 image', img.kind)
    ok(img.mimeType === 'image/png', 'mime 正确', String(img.mimeType))
    const decoded = Buffer.from(img.base64 ?? '', 'base64')
    ok(decoded.equals(pngBytes), '图片字节完全一致（不能用 utf8 编码读，否则会被替换成 U+FFFD）')

    /*
     * 已跟踪的图片被改动：git 在 `--numstat` 里把它当二进制（给 `-`），
     * 而界面必须走图片对照而不是「无法显示文本差异」。真 git 跑一遍才验得到。
     */
    git(repo, ['add', 'pic.png'])
    git(repo, ['commit', '-q', '-m', 'add pic'])
    await writeFile(join(repo, 'pic.png'), Buffer.concat([pngBytes, Buffer.from([0])]))
    clearRepoCache()
    const picSnap = await reviewSnapshot({ cwd: repo, scope: { kind: 'working' }, requestId: 'pic-1' })
    const picFile = picSnap.files.find((f) => f.path === 'pic.png')
    ok(!!picFile, '被改的已跟踪图片出现在清单里')
    ok(picFile?.kind === 'image', '图片的 kind 不被 numstat 的二进制标记覆盖（仍走图片对照）', picFile?.kind)
    const picOld = await fileContent({
      cwd: repo,
      scope: { kind: 'working' },
      requestId: 'pic-2',
      path: 'pic.png',
      side: 'old'
    })
    const picNew = await fileContent({
      cwd: repo,
      scope: { kind: 'working' },
      requestId: 'pic-3',
      path: 'pic.png',
      side: 'new'
    })
    ok(picOld.kind === 'image' && picNew.kind === 'image', '两侧都判为 image', `${picOld.kind}/${picNew.kind}`)
    ok(
      !!picOld.base64 && !!picNew.base64 && picOld.base64 !== picNew.base64,
      '两侧图片内容不同（旧侧真的来自 Git 对象）'
    )
    await rm(join(repo, 'pic.png'))
  }

  /* ── 6. 两端比较 ─────────────────────────────────────── */

  console.log('\n--- G6. 两端比较（range） ---')
  {
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'second'])
    git(repo, ['checkout', '-q', '-b', 'feature'])
    await writeFile(join(repo, 'feature.txt'), 'from feature\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'feature work'])

    clearRepoCache()
    const range = await reviewSnapshot({
      cwd: repo,
      scope: { kind: 'range', base: 'main', target: 'feature' },
      requestId: 'r5'
    })
    ok(range.ok === true, 'range 快照成功', range.error)
    ok(range.files.some((f) => f.path === 'feature.txt'), 'range 里含新分支上的文件', range.files.map((f) => f.path).join(','))
    ok(!range.files.some((f) => f.path === 'staged-new.txt'), 'range **只**含两端之间的差异（上一提交里的文件不在其中）', range.files.map((f) => f.path).join(','))
    ok(range.notes.some((n) => n.includes('不含未提交内容')), 'range 给出「不含未提交内容」的说明', range.notes.join(' | '))

    /* 不存在的 ref：明确报错而不是静默给空清单 */
    const bad = await reviewSnapshot({
      cwd: repo,
      scope: { kind: 'range', base: 'main', target: 'no-such-branch' },
      requestId: 'r6'
    })
    ok(bad.ok === false && !!bad.error, '不存在的 ref 明确报错', bad.error)

    /* 非法 ref（选项注入形状）被 normalizeScope 之外的层挡住：refExists 拒绝 */
    const inj = await reviewSnapshot({
      cwd: repo,
      scope: { kind: 'range', base: '--upload-pack=x', target: 'main' },
      requestId: 'r7'
    })
    ok(inj.ok === false, '以 - 开头的 ref 被拒（不交给 git 当选项）', inj.error)

    /* 孤儿分支：没有共同祖先时给说明 */
    git(repo, ['checkout', '-q', '--orphan', 'orphan'])
    git(repo, ['rm', '-q', '-rf', '.'])
    await writeFile(join(repo, 'only.txt'), 'orphan\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'orphan'])
    clearRepoCache()
    const orphan = await reviewSnapshot({
      cwd: repo,
      scope: { kind: 'range', base: 'main', target: 'orphan' },
      requestId: 'r8'
    })
    ok(orphan.ok === true, '无共同祖先时仍然给出结果（不是报错）', orphan.error)
    ok(orphan.notes.some((n) => n.includes('共同祖先')), '无共同祖先时明确说明', orphan.notes.join(' | '))
    git(repo, ['checkout', '-q', 'main'])
  }

  /* ── 7. 无首提交 / detached ──────────────────────────── */

  console.log('\n--- G7. 无首提交与 detached HEAD ---')
  {
    const fresh = join(root, 'fresh')
    await mkdir(fresh, { recursive: true })
    git(fresh, ['init', '-q', '-b', 'main'])
    git(fresh, ['config', 'core.autocrlf', 'false'])
    git(fresh, ['config', 'user.name', 'yan-test'])
    git(fresh, ['config', 'user.email', 'yan-test@example.com'])
    await writeFile(join(fresh, 'first.txt'), 'hello\n')
    git(fresh, ['add', 'first.txt'])

    clearRepoCache()
    const snap = await reviewSnapshot({ cwd: fresh, scope: { kind: 'staged' }, requestId: 'f1' })
    ok(snap.ok === true, '无首提交时 staged 快照成功（相对空树）', snap.error)
    ok(snap.repo?.unborn === true, '识别出「尚无提交」', String(snap.repo?.unborn))
    ok(snap.repo?.hasCommit === false, 'hasCommit 为 false')
    ok(snap.files.some((f) => f.path === 'first.txt' && f.additions === 1), '无首提交时能列出已暂存的新文件', snap.files.map((f) => `${f.path}+${f.additions}`).join(','))

    const working = await reviewSnapshot({ cwd: fresh, scope: { kind: 'working' }, requestId: 'f2' })
    ok(working.ok === true, '无首提交时 working 快照不报错（不对 HEAD 比较）', working.error)

    /* detached HEAD */
    git(repo, ['checkout', '-q', '--detach', 'HEAD'])
    clearRepoCache()
    const det = await reviewSnapshot({ cwd: repo, scope: { kind: 'working' }, requestId: 'f3' })
    ok(det.repo?.detached === true, '识别出 detached HEAD', String(det.repo?.detached))
    ok(det.repo?.branch === null, 'detached 时没有分支名')
    git(repo, ['checkout', '-q', 'main'])
  }

  /* ── 8. 只读保证（最要紧的一条） ─────────────────────── */

  console.log('\n--- G8. 只读保证（打开/刷新不改动工作区与 index） ---')
  {
    clearRepoCache()
    /* 先把工作区弄脏，再反复打开各种范围的审查 */
    await writeFile(join(repo, 'a.txt'), 'one\nTWO\nthree\nfour\nfive\nsix\n')
    git(repo, ['add', 'a.txt'])
    await writeFile(join(repo, 'a.txt'), 'one\nTWO\nthree\nfour\nfive\nsix\nseven\n')
    await writeFile(join(repo, 'dirty-new.txt'), 'x\n')

    const before = {
      status: git(repo, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
      index: git(repo, ['ls-files', '-s']),
      cached: git(repo, ['diff', '--cached', '--numstat', '-z'])
    }

    for (const scope of [
      { kind: 'working' },
      { kind: 'unstaged' },
      { kind: 'staged' },
      { kind: 'range', base: 'main', target: 'HEAD' }
    ]) {
      const snap = await reviewSnapshot({ cwd: repo, scope, requestId: `ro-${JSON.stringify(scope)}` })
      ok(snap.ok === true, `只读检查：${JSON.stringify(scope)} 快照成功`, snap.error)
      /* 顺手把每个文件的 patch 与两侧内容都拉一遍（正文加载也不能有副作用） */
      for (const f of snap.files.slice(0, 8)) {
        await filePatch({
          cwd: repo,
          scope,
          requestId: 'ro-p',
          path: f.path,
          oldPath: f.oldPath,
          untracked: f.untracked
        })
        await fileContent({ cwd: repo, scope, requestId: 'ro-c1', path: f.path, side: 'old' })
        await fileContent({ cwd: repo, scope, requestId: 'ro-c2', path: f.path, side: 'new' })
      }
    }

    const after = {
      status: git(repo, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
      index: git(repo, ['ls-files', '-s']),
      cached: git(repo, ['diff', '--cached', '--numstat', '-z'])
    }
    ok(after.status === before.status, '跑完所有只读查询后 git status **逐字节相同**')
    ok(after.index === before.index, 'index 内容（ls-files -s）**逐字节相同**（没有偷偷 add）')
    ok(after.cached === before.cached, '已暂存差异完全没变')

    /* 再确认一次：真正被改动的文件数没变 */
    const dirty = git(repo, ['status', '--porcelain'])
      .split('\n')
      .filter(Boolean).length
    ok(dirty === 2, '脏文件数是 2（a.txt 双状态 + dirty-new.txt 未跟踪）', String(dirty))
  }

  /* ── 9. 写操作（方案 §5，G2） ────────────────────────── */

  console.log('\n--- G9. 写操作（真实 git，全部在临时仓库里）---')

  {
    const { runGitAction, configureWriteContext, readExpected, listRemotes } = await import(
      '../out/test/git-actions-main.mjs'
    )

    /* 写操作要建自己的仓库：G8 断言过的那份仓库状态不能被搅浑 */
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

    /* A. 暂存 / 取消暂存 —— 只动选中的文件，且取消暂存**不碰工作区** */
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
    /* 最要紧的一条：取消暂存绝不能把工作区内容也还原掉 */
    const aContent = await readFile(join(mut, 'a.txt'), 'utf8')
    ok(aContent === 'A1 改过\nA2\n', '取消暂存后**工作区内容原样保留**（不是 checkout）', JSON.stringify(aContent))

    /* B. 分级复核（方案 §5.2 的「不提交用户尚未审阅的内容」） */
    /* B1. 提交：严格看 index —— 用户看到的那份内容变了就必须拒 */
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

    /* B2. 分级复核的**边界** —— 初版在这里做错了，真实运行才暴露。
           暂存是幂等的（「把这个文件的当前内容放进 index」），所以 index 或
           HEAD 在此期间被改过都不该拒：否则用户连点两次、或提交后立刻暂存，
           都会撞上假冲突，而假冲突的代价是用户学会无视那句提示。 */
    const headExp = await readExpected(mut)
    await writeFile(join(mut, "b.txt"), "B1 又改了一次\n")
    git(mut, ["commit", "-q", "--allow-empty", "-m", "外部进程的提交"])
    const stageAfterHeadMove = await act({ kind: "stage", cwd: mut, paths: ["b.txt"], expected: headExp })
    ok(stageAfterHeadMove.ok === true, "HEAD 被别人挪走后暂存仍然成功（不制造假冲突）", JSON.stringify(stageAfterHeadMove.failure))

    /* 但「未指定起点的新建分支」必须拦：新分支长在哪里由 HEAD 决定 */
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

    /* 起点显式给出时，期间的提交与这次创建无关 —— 同样不该拒 */
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

    /* C. 全部暂存 / 全部取消暂存 */
    const sa = await act({ kind: 'stage-all', cwd: mut, expected: await readExpected(mut) })
    const dirtyBefore = git(mut, ['status', '--porcelain']).split('\n').filter(Boolean).length
    /* 不断言具体文件名：上面的 B2 在中间提交过一次，硬编码文件数会随用例顺序漂移。
       断言「index 覆盖了 status 列出的全部变更」才等于语义本身。 */
    ok(
      cachedNames().split('\n').filter(Boolean).length === dirtyBefore,
      `全部暂存：index 覆盖了 status 里的全部 ${dirtyBefore} 个变更文件`,
      cachedNames()
    )
    const ua = await act({ kind: 'unstage-all', cwd: mut, expected: await readExpected(mut) })
    ok(ua.ok === true, '全部取消暂存成功')
    ok(cachedNames() === '', 'index 清空', cachedNames())
    ok((await readFile(join(mut, 'a.txt'), 'utf8')).includes('改过'), '全部取消暂存也没碰工作区')

    /* D. 提交 */
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

    /* 空说明：本地就拦下，不产生提交，也不让用户看到 git 的英文原文 */
    const n1 = commitCount()
    const empty = await act({ kind: 'commit', cwd: mut, message: '   ', expected: await readExpected(mut) })
    ok(empty.ok === false && empty.failure?.code === 'empty-message', '空提交说明被本地拦下', empty.failure?.code)
    ok(commitCount() === n1, '空说明没有产生提交')

    /* 没有暂存内容时提交 → git 说 nothing to commit，分类要认出来 */
    const nothing = await act({ kind: 'commit', cwd: mut, message: 'x', expected: await readExpected(mut) })
    ok(nothing.ok === false && nothing.failure?.code === 'nothing-to-commit', '没内容可提交时分类为 nothing-to-commit', nothing.failure?.code)

    /* E. hook 拒绝：必须原样把原因带回来，且**不提交** */
    const hookPath = join(mut, '.git', 'hooks', 'pre-commit')
    await writeFile(hookPath, '#!/bin/sh\necho "拒绝：这是测试 hook"\nexit 1\n', { mode: 0o755 })
    await writeFile(join(mut, 'a.txt'), 'A1 又要提交\nA2\n')
    await act({ kind: 'stage', cwd: mut, paths: ['a.txt'], expected: await readExpected(mut) })
    const hookCount = commitCount()
    const h1 = await act({ kind: 'commit', cwd: mut, message: '会被 hook 拒', expected: await readExpected(mut) })
    /* 真 git 的 hook 拒绝**只透传 hook 自己的输出**（无前缀），所以这条
       走的正是「分类不出来 → 查仓库里有没有 hook 文件 → 才敢说是 hook」的路径 */
    ok(h1.ok === false, 'pre-commit 拒绝时提交失败')
    ok(h1.failure?.code === 'hook', '分类为 hook（靠仓库里真有 hook 这个事实，不是猜）', h1.failure?.code)
    ok((h1.failure?.message ?? '').includes('pre-commit'), '失败说明里点名是哪个 hook', h1.failure?.message)
    ok((h1.failure?.detail ?? '').includes('测试 hook'), 'hook 自己的输出被保留（那才是关键信息）', h1.failure?.detail)
    ok(commitCount() === hookCount, 'hook 拒绝后没有产生提交（没有 --no-verify 偷偷绕过）')
    await rm(hookPath, { force: true })

    /* hook 不在时，同一句输出不能被当成 hook（否则就是编原因） */
    await act({ kind: 'stage', cwd: mut, paths: ['a.txt'], expected: await readExpected(mut) })
    const noHook = await act({ kind: 'commit', cwd: mut, message: '没有 hook 了', expected: await readExpected(mut) })
    ok(noHook.ok === true, '删掉 hook 后同样内容能提交（证明上一次失败真是 hook 拦的）')

    /* F. 身份未配置：真 git 的文案 + 我们的分类 */
    const noId = join(root, 'noid')
    await mkdir(noId, { recursive: true })
    git(noId, ['init', '-q', '-b', 'main'])
    /* 注意：这里**不设** user.name / user.email（git() 的 env 只影响 git 本身，
       主进程的 gitRun 继承的是 process.env，两者互不干扰） */
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

    /* G. 切换分支：脏工作区由 **git 自己**判，我们只转述 */
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

    /* 干净之后能切（脏不是一律禁止） */
    git(mut, ['checkout', '--', 'a.txt'])
    const sw2 = await act({ kind: 'switch-branch', cwd: mut, branch: 'feature', expected: await readExpected(mut) })
    ok(sw2.ok === true, '工作区干净后切换成功', JSON.stringify(sw2.failure))
    ok(branchOf() === 'feature', '真的切到了 feature', branchOf())
    ok(sw2.summary?.includes('feature') === true, '结果行说明切到了哪')

    /* H. 有运行中的任务 → 拒绝切换（方案 §5.1） */
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

    /* I. 新建分支：只创建 / 创建并切换 / 各种非法输入 */
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

    /* J. push / fetch（本地 bare 仓库当 remote，真跑 git，不碰网络） */
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

    /* 非快进：另一个克隆先推一个提交，本地再推就被拒 */
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

    /* K. 并发写：同一仓库的写操作必须串行（否则会撞 index.lock） */
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

    /* L. 写操作之后，只读查询依然不改任何东西 */
    const roBefore = {
      status: git(mut, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
      index: git(mut, ['ls-files', '-s'])
    }
    const snap = await reviewSnapshot({ cwd: mut, scope: { kind: 'working' }, requestId: 'g9-ro' })
    ok(snap.ok === true, '写操作之后审查快照仍可用')
    ok(snap.files.length > 0, '快照里有变更文件（有东西可审）', String(snap.files.length))
    ok(git(mut, ['status', '--porcelain=v2', '-z', '--untracked-files=all']) === roBefore.status, '写操作之后，只读快照仍不改 status')
    ok(git(mut, ['ls-files', '-s']) === roBefore.index, '写操作之后，只读快照仍不改 index')
  }

  /* ── 10. 用户工作树（方案 §6.2，W1） ────────────────── */

  console.log('\n--- G10. 用户工作树（真实 git worktree）---')

  {
    const { listWorktrees, createWorktree, removeWorktree, slugBranch, parseWorktreeList, defaultWorktreeContainer } =
      await import('../out/test/git-worktree.mjs')

    /* 纯逻辑先测：目录名 slug 与 worktree list 的解析 */
    ok(slugBranch('feat/git-review') === 'feat-git-review', '分支名里的 / 变成 -（不多出一层目录）', slugBranch('feat/git-review'))
    ok(slugBranch('  spaced  name  ') === 'spaced-name', '空白收敛成单个 -', slugBranch('  spaced  name  '))
    ok(slugBranch('a:b*c?d') === 'a-b-c-d', 'Windows 非法字符被替换', slugBranch('a:b*c?d'))
    ok(slugBranch('---') === 'worktree', '全是符号时退化成 worktree（不留空目录名）', slugBranch('---'))
    ok(!slugBranch('x'.repeat(200)).includes('/') && slugBranch('x'.repeat(200)).length <= 80, '超长名被截断')

    const container = defaultWorktreeContainer('C:/proj/demo', 'demo')
    ok(container.replace(/\\/g, '/').endsWith('proj/demo-worktrees'), '默认容器在仓库**旁边**', container)

    /* 真实格式：每条记录内部用换行，记录之间用 NUL（-z 的约定） */
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

    /* ── 真实仓库 ── */
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

    /* 创建：默认位置在仓库旁边 */
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
    /* 主工作树没被碰过 */
    ok(!existsSync(join(wt, 'feat')), '主工作树里没有多出工作树目录')
    ok(git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'main', '主工作树仍在 main')

    /* 未提交改动**不会**跟着过去（方案 §6.2 的硬要求） */
    await writeFile(join(wt, 'base.txt'), 'base changed\n')
    const created2 = await createWorktree({ cwd: wt, branch: 'feat/two', startPoint: null, targetPath: null })
    ok(created2.ok === true, '带脏工作区也能建（它只从 HEAD 长出来）')
    ok(
      (await readFile(join(created2.path, 'base.txt'), 'utf8')) === 'base\n',
      '新工作树拿到的是**已提交**的内容，不是主工作树的未提交改动'
    )
    ok(git(wt, ['status', '--porcelain']).trim().length > 0, '主工作树的未提交改动原样保留')

    /* 拒绝路径 */
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

    /* 有运行任务时拒绝创建（与切分支同一判据） */
    const busy = await createWorktree({ cwd: wt, branch: 'feat/six', startPoint: null, targetPath: null }, () => true)
    ok(busy.ok === false && busy.failure?.code === 'busy', '有任务在跑 → 拒绝建工作树', busy.failure?.code)

    /* 列出现在能看到两条（主 + 刚才建的） */
    const listing1 = await listWorktrees(wt)
    ok(listing1.worktrees.length === 3, '现在有三条工作树（主 + feat/one + feat/two）', String(listing1.worktrees.length))
    ok(
      listing1.worktrees.filter((w) => w.ours).length === 2,
      '两条被认成「砚创建的」（落在默认容器里）'
    )

    /* ── 删除：三类内容挡着都要拒绝，且**逐条给原因** ── */
    const mainBlocked = await removeWorktree({ cwd: wt, path: wt })
    ok(mainBlocked.ok === false, '主工作树不能删')
    ok(
      (mainBlocked.blockers ?? []).some((b) => b.kind === 'main'),
      '原因是「这是主工作树」',
      JSON.stringify(mainBlocked.blockers)
    )

    const notMine = await removeWorktree({ cwd: wt, path: root })
    ok(notMine.ok === false && notMine.failure?.code === 'path-rejected', '不在工作树列表里的路径 → 拒绝', notMine.failure?.code)

    /* 未提交改动挡着 */
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

    /* 未推送提交挡着（没有上游时按「无法判断」列出） */
    await rm(join(created.path, 'dirty.txt'), { force: true })
    git(created.path, ['commit', '-q', '--allow-empty', '-m', '工作树里的提交'])
    const unpushedBlocked = await removeWorktree({ cwd: wt, path: created.path })
    ok(unpushedBlocked.ok === false, '有未推送提交（或没有上游）→ 拒绝删除')
    ok(
      (unpushedBlocked.blockers ?? []).some((b) => b.kind === 'unpushed'),
      '原因是未推送 / 无法判断',
      JSON.stringify(unpushedBlocked.blockers)
    )

    /* 推上去之后就能删了 */
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
    /* 主工作树最后确认还活着 */
    ok(existsSync(join(wt, 'base.txt')), '主工作树始终没被碰')

    /* 清理第二条工作树（它还在，留着会让下一次跑测试的目录名冲突） */
    /*
     * ⚠️ 不再 remote add：worktree **共享同一份 .git/config**，第一个工作树
     * 已经加过 origin 了，再加会报 `remote origin already exists`（第一次跑
     * 测试就是这么被吞掉的 —— catch 顺手把后面的 push 也跳过了）。
     */
    try {
      git(created2.path, ['push', '-q', '-u', 'origin', 'feat/two'])
    } catch (e) {
      console.log('  ⓘ feat/two 推送失败：' + String(e.stderr || e.message).split(String.fromCharCode(10))[0])
    }
    const removed2 = await removeWorktree({ cwd: wt, path: created2.path, deleteBranch: true })
    ok(removed2.ok === true, '第二条也能正常删除', JSON.stringify(removed2.failure ?? removed2.blockers))
    ok(git(wt, ['branch', '--list', 'feat/two']).trim().length === 0, 'deleteBranch 为真时分支被删掉（已合并/已推送）')
  }

  /* ── 11. 携带未提交改动（W2a，真实仓库）───────────────── */

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

    /*
     * 造出三份**不同**的东西：已暂存、未暂存、未跟踪。
     * 分开造是为了能验证「已暂存的仍然暂存」—— 混在一起的话，
     * 就算实现把所有改动都丢进工作区，看 status 也分辨不出来。
     */
    writeFileSync(join(cRepo, 'a.txt'), 'a\nstaged\n')
    git(cRepo, ['add', 'a.txt'])
    writeFileSync(join(cRepo, 'keep.txt'), 'keep\nmodified\n')
    writeFileSync(join(cRepo, 'bin.dat'), Buffer.from([0, 9, 9, 3, 255, 254]))
    writeFileSync(join(cRepo, 'new-untracked.txt'), 'hello\n')
    writeFileSync(join(cRepo, 'exec-untracked.sh'), '#!/bin/sh\nls\n')
    chmodSync(join(cRepo, 'exec-untracked.sh'), 0o755)

    /* 源仓库的 status 与 index：迁移前后必须**逐字节相同** */
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

      /* ① 已暂存 → 在目标里仍然是**已暂存**（这是「分别捕获」的全部意义） */
      const dstStatus = git(dst, ['status', '--porcelain=v1'])
      ok(/^M  a\.txt$/m.test(dstStatus), '已暂存的改动在目标里仍然是已暂存（M + 空格）', JSON.stringify(dstStatus))
      ok(/^ M keep\.txt$/m.test(dstStatus), '未暂存的改动在目标里仍然是未暂存（空格 + M）')
      ok(/^ M bin\.dat$/m.test(dstStatus), '二进制改动也过来了')
      ok(/^\?\? new-untracked\.txt$/m.test(dstStatus), '未跟踪文件过来了')
      ok(/^\?\? exec-untracked\.sh$/m.test(dstStatus), '未跟踪的脚本也过来了')

      /* ② 内容与二进制保真 */
      ok(readFileSync(join(dst, 'keep.txt'), 'utf8') === 'keep\nmodified\n', '未暂存文件的内容一致')
      ok(
        Buffer.compare(readFileSync(join(dst, 'bin.dat')), Buffer.from([0, 9, 9, 3, 255, 254])) === 0,
        '二进制文件逐字节一致（没有被 utf8 破坏）'
      )
      ok(readFileSync(join(dst, 'new-untracked.txt'), 'utf8') === 'hello\n', '未跟踪文件内容一致')
      /*
       * 可执行位只在 POSIX 上有意义：NTFS 不用 mode 位表示可执行，
       * 写进去的 chmod 也读不回来（git 自己也是靠 core.fileMode=false 绕开这件事）。
       * 所以这里**分平台**断言，而不是假装 Windows 也能验。
       */
      if (process.platform === 'win32') {
        ok(true, '可执行位：Windows 上跳过（NTFS 不用 mode 位表示可执行）')
      } else {
        ok((statSync(join(dst, 'exec-untracked.sh')).mode & 0o777) === 0o755, '未跟踪文件的可执行位保持')
      }

      /* ③ 目标侧验证：两侧的 diff 摘要一致 */
      ok(
        git(dst, ['diff', '--cached', '--numstat']).trim() === git(cRepo, ['diff', '--cached', '--numstat']).trim(),
        '目标与源的「已暂存」摘要一致'
      )
      ok(
        git(dst, ['diff', '--numstat']).trim() === git(cRepo, ['diff', '--numstat']).trim(),
        '目标与源的「未暂存」摘要一致'
      )
    }

    /* ④ 源仓库一个字节都没动（这是方案里最容易做错的一条） */
    ok(git(cRepo, ['status', '--porcelain=v1', '-z']) === srcStatusBefore, '源仓库的 status 逐字节不变')
    ok(git(cRepo, ['diff', '--cached', '--binary']) === srcIndexBefore, '源仓库的 index 逐字节不变')
    ok(readFileSync(join(cRepo, 'keep.txt'), 'utf8') === 'keep\nmodified\n', '源工作区文件内容不变')

    /* ⑤ 起点不是 HEAD 时不许带 carry（patch 相对 HEAD，换基线语义不成立） */
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

    /* ⑥ 冲突状态下拒绝迁移并解释 */
    {
      /* mkdtempSync 已经把目录建好了，不要再 mkdirSync（会 EEXIST） */
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
        /* 冲突是预期的 */
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
      /* 被拒之后不该留下半个工作树 */
      ok(
        git(xRoot, ['worktree', 'list']).trim().split('\n').length === 1,
        '被拒时没有留下半个工作树'
      )
      await rm(xRoot, { recursive: true, force: true }).catch(() => {})
    }

    /* ⑦ 勾选的文件不再是未跟踪状态 → 拒绝（提示重新选） */
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

    /* ⑧ 不带 carry 时说明里必须写明「不会自动带入」 */
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

  /* ── 12. 清理 ────────────────────────────────────────── */

  await rm(root, { recursive: true, force: true }).catch(() => {})
}
