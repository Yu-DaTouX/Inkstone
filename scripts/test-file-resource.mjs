/**
 * 文件资源身份（实施-11 H-4）的纯逻辑测试。
 *
 * 盯的是**标签会不会互相顶掉**这件事，所以断言都是「两个不同文件必须得到
 * 两个不同的键」以及「同一个文件从不同写法进来必须得到同一个键」。
 *
 * 用法：npm run test:unit
 */
export async function runFileResourceTests(ok) {
  const fr = await import('../out/test/file-resource.mjs')
  const key = fr.fileResourceKey
  const parse = fr.parseFileResourceKey
  const label = fr.fileResourceLabel

  /* ------------------------------------------------ 键的往返 */

  const id = {
    projectId: 'p-1',
    workspaceRoot: 'C:/work/app',
    canonicalPath: 'C:/work/app/src/index.ts'
  }
  const k = key(id)
  const back = parse(k)
  ok(back !== null, '合法的三元组能解析回来')
  ok(back?.projectId === 'p-1', 'projectId 原样还原')
  ok(back?.workspaceRoot === 'C:/work/app', 'workspaceRoot 原样还原（含盘符与斜杠）')
  ok(back?.canonicalPath === 'C:/work/app/src/index.ts', 'canonicalPath 原样还原')
  ok(key(id) === k, '同一个身份重复构造出同一个键（标签不会重复建）')

  /* 路径里带空格 / 中文 / `|` 都不能把键拆坏 */
  const tricky = key({
    projectId: '项目 A',
    workspaceRoot: 'C:/我的 工作/app',
    canonicalPath: 'C:/我的 工作/app/src/奇|怪.ts'
  })
  const trickyBack = parse(tricky)
  ok(
    trickyBack?.canonicalPath === 'C:/我的 工作/app/src/奇|怪.ts',
    '含中文/空格/竖线的路径也能准确还原（不把键拆错）'
  )
  ok(
    trickyBack?.projectId === '项目 A' && trickyBack?.workspaceRoot === 'C:/我的 工作/app',
    '含中文的项目与工作树也能还原'
  )

  /* ------------------------------------------------ 不同文件不撞键 */

  const base = { projectId: 'p-1', workspaceRoot: 'C:/work/app', canonicalPath: 'C:/work/app/a.ts' }
  ok(
    key(base) !== key({ ...base, canonicalPath: 'C:/work/app/b.ts' }),
    '同目录两个文件 → 两个键（一个文件一个标签）'
  )
  ok(
    key(base) !== key({ ...base, workspaceRoot: 'C:/work/other' }),
    '不同工作树的同名文件 → 两个键（不被并成一个标签）'
  )
  ok(
    key(base) !== key({ ...base, projectId: 'p-2' }),
    '同工作树不同项目 → 两个键（项目归属进身份）'
  )

  /* 空的项目 / 工作树：用占位符，位置不丢 */
  const bare = key({ canonicalPath: 'C:/x.ts' })
  ok(parse(bare)?.canonicalPath === 'C:/x.ts', '只有路径时也能解析')
  ok(parse(bare)?.projectId === null && parse(bare)?.workspaceRoot === null, '空项目/工作树解析回 null')

  /* ------------------------------------------------ 脏输入不造身份 */

  ok(parse('') === null, '空键 → null')
  ok(parse('a|b') === null, '段数不够 → null')
  ok(parse('a|b|c|d') === null, '段数过多 → null')
  ok(parse('a|b|-') === null, 'canonicalPath 为空占位 → null（没有路径就没有文件身份）')

  /* ------------------------------------------------ 显示名与同路径判断 */

  ok(label('C:/work/app/src/index.ts') === 'index.ts', 'Windows 路径取文件名')
  ok(label('/home/me/app/main.ts') === 'main.ts', 'POSIX 路径取文件名')
  ok(label('C:/work/app/src/') === 'src', '目录（尾斜杠）取最后一段')
  ok(label('') === '', '空路径 → 空标签（界面自己回落）')

  ok(
    fr.sameResourcePath('C:/work/app/a.ts', 'C:\\work\\app\\a.ts'),
    '反斜杠与正斜杠视为同一路径'
  )
  ok(
    !fr.sameResourcePath('C:/work/app/a.ts', 'C:/work/app/A.ts'),
    '大小写不同不擅自当作同一路径（canonicalPath 已由 realpath 归一）'
  )

  /* ------------------------------------------------ 文档内相对链接（H-4 出口 3） */

  const rr = fr.resolveRelativePath
  ok(rr('C:/work/app/docs', '../README.md') === 'C:/work/app/README.md', '../ 相对文档目录解析')
  ok(rr('C:/work/app/docs', './guide/x.md') === 'C:/work/app/docs/guide/x.md', './ 与子目录正常拼接')
  ok(rr('C:/work/app/docs', 'x.md') === 'C:/work/app/docs/x.md', '同目录相对链接')
  ok(
    rr('C:/work/app/docs', '../../../etc/passwd') === 'C:/etc/passwd',
    '上溯到盘符根就停（不造出越界的 `..` 前缀）'
  )
  ok(rr('C:/work/app/docs', 'a\\b\\..\\c.md') === 'C:/work/app/docs/a/c.md', '反斜杠与 . 都归一')
  ok(rr('/home/me/docs', '../x.md') === '/home/me/x.md', 'POSIX 路径同样处理')
  ok(rr('C:/work/app/docs', '../docs2/./y.md') === 'C:/work/app/docs2/y.md', '多个相对段一起算')
}
