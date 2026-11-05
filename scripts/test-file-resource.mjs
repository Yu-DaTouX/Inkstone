export async function runFileResourceTests(ok) {
  const fr = await import('../out/test/file-resource.mjs')
  const key = fr.fileResourceKey

  const id = {
    projectId: 'p-1',
    workspaceRoot: 'C:/work/app',
    canonicalPath: 'C:/work/app/src/index.ts'
  }
  const k = key(id)
  ok(k === 'p-1|C%3A%2Fwork%2Fapp|C%3A%2Fwork%2Fapp%2Fsrc%2Findex.ts', '三段各自编码后用竖线连接')
  ok(key(id) === k, '同一个身份重复构造出同一个键（标签不会重复建）')

  const tricky = key({
    projectId: '项目 A',
    workspaceRoot: 'C:/我的 工作/app',
    canonicalPath: 'C:/我的 工作/app/src/奇|怪.ts'
  })
  ok(tricky.split('|').length === 3, '路径里的竖线被编码，键始终是三段')
  ok(
    tricky.split('|').map(decodeURIComponent)[2] === 'C:/我的 工作/app/src/奇|怪.ts',
    '含中文/空格/竖线的路径编码后不丢信息'
  )

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

  ok(key({ canonicalPath: 'C:/x.ts' }) === '-|-|C%3A%2Fx.ts', '缺项目/工作树时用占位符')

  ok(
    fr.sameResourcePath('C:/work/app/a.ts', 'C:\\work\\app\\a.ts'),
    '反斜杠与正斜杠视为同一路径'
  )
  ok(
    !fr.sameResourcePath('C:/work/app/a.ts', 'C:/work/app/A.ts'),
    '大小写不同不擅自当作同一路径（canonicalPath 已由 realpath 归一）'
  )

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
