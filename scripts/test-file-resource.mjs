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
}
