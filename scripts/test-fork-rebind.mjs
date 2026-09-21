/**
 * 工作树 Fork 的路径重绑定（`src/shared/fork-rebind.ts`，实施-07 S2b-3）单测。
 *
 * 为什么值得钉这么细：这一层的错误在界面上**看不出来** ——
 * 「文件对不上」与「文件本来就不该带过来」都只显示一行字，
 * 而把 `outside` 算成 `missing` 会让用户以为工作树缺文件（然后去查 git）。
 * 纯函数，文件系统用假的 `stat` 注入，不碰真实磁盘。
 */

export function runForkRebindTests(ok, mod) {
  const {
    normalizeSlashes,
    isAbsolutePath,
    hasDotDot,
    toRepoRelative,
    resolveForkRefs,
    summarizeForkRefs,
    extractRefsFromTexts
  } = mod

  /* ---------------------------------------------------------- 1. 基础归一化 */

  ok(normalizeSlashes('C:\\repo\\src\\a.ts') === 'C:/repo/src/a.ts', '反斜杠归一成正斜杠')
  ok(normalizeSlashes('C:\\repo\\src\\') === 'C:/repo/src', '去掉尾部分隔符')
  ok(normalizeSlashes('a\\\\b') === 'a/b', '连续分隔符压成一个')

  ok(isAbsolutePath('C:/x') === true, '盘符路径算绝对路径')
  ok(isAbsolutePath('C:\\x') === true, '反斜杠盘符也一样')
  ok(isAbsolutePath('/usr/x') === true, 'POSIX 绝对路径算绝对')
  ok(isAbsolutePath('src/a.ts') === false, '相对路径不算绝对')
  ok(isAbsolutePath('../a.ts') === false, '`..` 开头不算绝对（后面单独拒）')

  ok(hasDotDot('a/../b') === true, '夹在中间的 `..` 也算逃逸（不做归一化越界）')
  ok(hasDotDot('a/..') === true, '结尾 `..` 算逃逸')
  ok(hasDotDot('a..b/c') === false, '名字里带点点不是逃逸（只有整段 `..` 才算）')

  /* ---------------------------------------------------------- 2. 绝对 → 相对 */

  ok(toRepoRelative('C:/repo', 'C:/repo/src/a.ts') === 'src/a.ts', '仓库内的绝对路径转成相对')
  ok(toRepoRelative('C:\\Repo', 'c:/repo/SRC/A.ts') === 'SRC/A.ts', '比较大小写不敏感、返回原拼写')
  ok(toRepoRelative('C:/repo', 'C:/repo') === null, '就是仓库根 → 没有相对路径（返回 null）')
  ok(toRepoRelative('C:/repo', 'C:/repo-other/a.ts') === null, '同前缀的兄弟目录不算在仓库内')
  ok(toRepoRelative('C:/repo', 'D:/x/a.ts') === null, '别的盘不算在仓库内')

  /* ---------------------------------------------------------- 3. 解析三态 */

  /* 一个假仓库：src/a.ts 是文件、src/ 是目录、空目录 empty/ 什么也没有 */
  const files = new Set(['c:/repo/src/a.ts', 'c:/repo/readme.md'])
  const dirs = new Set(['c:/repo/src', 'c:/repo/empty'])
  const stat = (abs) => {
    const key = abs.toLowerCase()
    if (files.has(key)) return 'file'
    if (dirs.has(key)) return 'dir'
    return null
  }

  const base = resolveForkRefs('C:/repo', ['src/a.ts'], stat)
  ok(base.length === 1 && base[0].state === 'resolved' && base[0].kind === 'file', '存在的文件 → resolved')
  ok(base[0].abs === 'C:/repo/src/a.ts', '返回拼好的绝对路径（供界面显示）', String(base[0].abs))

  const miss = resolveForkRefs('C:/repo', ['vendor/x.ts'], stat)
  ok(miss[0].state === 'missing', '仓库里没有 → missing')
  ok(miss[0].abs === 'C:/repo/vendor/x.ts', 'missing 也给绝对路径（用户能自己去看）')
  ok(miss[0].kind === null, 'missing 的 kind 是 null（不能猜它是文件还是目录）')

  const mismatch = resolveForkRefs('C:/repo', ['src/a.ts/'], stat)
  ok(mismatch[0].state === 'type-mismatch', '以 `/` 结尾要目录、实际是文件 → type-mismatch')
  const dirOk = resolveForkRefs('C:/repo', ['src/'], stat)
  ok(dirOk[0].state === 'resolved' && dirOk[0].kind === 'dir', '以 `/` 结尾且真是目录 → resolved')

  const outside = resolveForkRefs('C:/repo', ['../secret.txt', 'C:/other/x.ts'], stat)
  ok(outside.length === 2, '两条都保留（不静默丢）')
  ok(outside.every((x) => x.state === 'outside'), '`..` 与仓库外绝对路径都算 outside')
  ok(outside.every((x) => x.abs === null), 'outside 不给绝对路径（带不过去就不假装能带）')

  /* 绝对路径但**在仓库内** → 先转相对再解析（这正是不做前缀替换的正确姿势） */
  const absInRepo = resolveForkRefs('C:/repo', ['C:/repo/src/a.ts'], stat)
  ok(absInRepo[0].state === 'resolved' && absInRepo[0].ref === 'src/a.ts', '仓库内的绝对路径先转相对再解析')

  /* 归一化细节：前导 `./`、空串、大小写重复 */
  const norm = resolveForkRefs('C:/repo', ['./src/a.ts', '  ', 'SRC/A.TS'], stat)
  ok(norm.length === 1, '前导 `./` 与空白跳过、大小写不同的同一条去重', String(norm.length))

  /* ---------------------------------------------------------- 4. 汇总 */

  const s = summarizeForkRefs([
    { ref: 'src/a.ts', state: 'resolved', abs: 'C:/repo/src/a.ts', kind: 'file' },
    { ref: 'x.ts', state: 'missing', abs: 'C:/repo/x.ts', kind: null },
    { ref: 'y/', state: 'type-mismatch', abs: 'C:/repo/y', kind: 'file' },
    { ref: '../z', state: 'outside', abs: null, kind: null }
  ])
  ok(s.total === 4 && s.resolved === 1 && s.missing === 1 && s.mismatch === 1 && s.outside === 1, '四类各计一条')
  ok(s.problems.length === 3, 'problems 只放需要用户看的（missing / mismatch / outside）')
  ok(
    s.problems.map((p) => p.state).join(',') === 'missing,type-mismatch,outside',
    'problems 保持输入顺序（界面按顺序列，不重排）'
  )

  /* ---------------------------------------------------------- 5. `@` 引用提取 */

  const isRepoFile = (rel) => ['src/a.ts', 'docs/b.md'].includes(rel)
  const texts = [
    '看下 @src/a.ts 这段',
    '我的邮箱 foo@bar.com 与此无关',
    '（@docs/b.md）。',
    'npm 包 @scope/pkg 也不是文件',
    '再来一次 @src/a.ts',
    '    @src/a.ts。',
    'https://x.test/@src/a.ts'
  ]
  const refs = extractRefsFromTexts(texts, isRepoFile)
  ok(refs.join(',') === 'src/a.ts,docs/b.md', '只留仓库内真实存在的引用、去重、保持首次出现顺序', refs.join(','))
  ok(
    extractRefsFromTexts(['@missing.ts'], isRepoFile).length === 0,
    '仓库里不存在的引用不进来（`@某人` 这类噪音靠这个过滤）'
  )
  ok(
    extractRefsFromTexts(['@src/a.ts'], () => true)[0] === 'src/a.ts',
    '空格开头的 `@` 也能提（行首缩进不影响）'
  )
  ok(extractRefsFromTexts(['（@src/a.ts）'], isRepoFile)[0] === 'src/a.ts', '中文全角括号里的引用能提')
  ok(extractRefsFromTexts(['@../x.ts'], () => true).length === 0, '提取阶段就拒 `..`（不让它进解析）')
  ok(extractRefsFromTexts(['@C:/repo/src/a.ts'], () => true).length === 0, '提取阶段拒绝对路径（引用应是相对的）')
}
