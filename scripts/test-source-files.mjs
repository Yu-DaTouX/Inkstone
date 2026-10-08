/**
 * 文件来源登记（`src/renderer/src/state/source-files.ts`）的读写归属（O08 回归）。
 *
 * 纯 localStorage 逻辑：用内存替身，不开 Electron、不碰真实界面与用户数据。
 *
 * 钉住两件相反方向的事故：
 *   · 在 B 会话加一个文件，不能把 A 会话的登记整段覆盖掉；
 *   · 读侧（来源菜单 / 工作台首页）必须按会话过滤，不能把别的会话的文件列出来。
 */
export async function runSourceFilesTests(ok) {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const temp = await mkdtemp(join(tmpdir(), 'yan-source-files-'))
  const { build } = await import('../node_modules/esbuild/lib/main.js')
  const outfile = join(temp, 'source-files.mjs')
  await build({
    entryPoints: ['src/renderer/src/state/source-files.ts'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
  const mod = await import(pathToFileURL(outfile).href)
  const { addSourceFiles, listSourceFiles, removeSourceFile, readSourceFiles } = mod
  /* 记住原值：test-unit 是同一个进程，不能让棚渗到后面的测试里 */
  const savedLocalStorage = globalThis.localStorage
  const store = new Map()
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(String(key)) : null),
    setItem: (key, value) => store.set(String(key), String(value)),
    removeItem: (key) => store.delete(String(key)),
    clear: () => store.clear()
  }

  /* ---- 跨会话互不覆盖 ---- */
  addSourceFiles('sess-A', ['C:\\work\\a1.md', 'C:\\work\\a2.md'])
  addSourceFiles('sess-B', ['C:\\work\\b1.md'])
  ok(readSourceFiles().length === 3, '两次登记都在（B 的写入不清掉 A 的记录）', String(readSourceFiles().length))
  ok(listSourceFiles('sess-A').length === 2, 'A 会话仍登记着 2 个文件')
  ok(listSourceFiles('sess-B').length === 1, 'B 会话登记着 1 个文件')
  ok(
    listSourceFiles('sess-B').every((record) => record.path.includes('b1')),
    'B 会话只看到自己的文件（读侧按会话过滤）'
  )

  /* ---- 同一路径重复添加只留一条 ---- */
  addSourceFiles('sess-A', ['C:\\work\\a1.md', 'C:\\work\\a3.md'])
  const a = listSourceFiles('sess-A')
  ok(a.length === 3, '重复添加不产生重复记录', String(a.length))
  ok(a.filter((record) => record.path.endsWith('a1.md')).length === 1, '同一路径只有一条登记')
  ok(a.every((record) => record.sessionId === 'sess-A'), '每条记录都带会话 id（读侧才过滤得动）')

  /* ---- 删除只影响本会话 ---- */
  removeSourceFile('sess-A', 'C:\\work\\a1.md')
  ok(listSourceFiles('sess-A').length === 2, '删掉 A 的一条后剩 2 条')
  ok(!listSourceFiles('sess-A').some((record) => record.path.endsWith('a1.md')), '被删的那条不在了')
  ok(listSourceFiles('sess-B').length === 1, '删 A 的记录不影响 B')
  /* 同名文件在两个会话里都有：删 A 的不能带走 B 的 */
  addSourceFiles('sess-A', ['C:\\work\\b1.md'])
  removeSourceFile('sess-A', 'C:\\work\\b1.md')
  ok(listSourceFiles('sess-B').length === 1, '删除按 (会话, 路径) 而非只按路径')
  ok(listSourceFiles('sess-A').length === 2, 'A 里那条重名的也被删掉了')

  /* ---- 边界 ---- */
  ok(listSourceFiles('').length === 0, '空会话 id 不返回任何记录')
  ok(listSourceFiles('sess-none').length === 0, '没登记过的会话返回空')
  addSourceFiles('', ['C:\\work\\x.md'])
  ok(readSourceFiles().length === 3, '空会话 id 不写入（否则记录永远归不到任何会话）')

  /* ---- 坏数据容错 ---- */
  store.set('yan.source-files.v1', '{ 这不是 JSON')
  ok(readSourceFiles().length === 0, '坏 JSON 当空数组，不抛错')
  store.set('yan.source-files.v1', JSON.stringify([{ path: 'C:\\x' }, { path: 'C:\\y', sessionId: 's1' }, null]))
  ok(readSourceFiles().length === 1, '缺 sessionId 的记录被丢掉（旧格式不冒充某会话的登记）')

  if (savedLocalStorage === undefined) delete globalThis.localStorage
  else globalThis.localStorage = savedLocalStorage
}
