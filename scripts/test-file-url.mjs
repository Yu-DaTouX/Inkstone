/**
 * 本地文件 → `file://` 地址（O10 回归）。
 *
 * 纯字符串函数，但断言用 `new URL()` 解析后的结果 —— `#` 没转义时
 * pathname 会被截断、hash 会多出一段，正是当初预览加载失败的形状：
 * 只看字符串相等很容易把 `图#1.png` 当成“看起来对”。
 */
export async function runFileUrlTests(ok) {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const temp = await mkdtemp(join(tmpdir(), 'yan-file-url-'))
  const { build } = await import('../node_modules/esbuild/lib/main.js')
  const outfile = join(temp, 'file-url.mjs')
  await build({
    entryPoints: ['src/shared/file-url.ts'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
  const { fileUrl } = await import(pathToFileURL(outfile).href)
  const parse = (p) => new URL(fileUrl(p))

  /* ---- Windows 盘符 ---- */
  {
    const url = parse('C:\\a\\b.png')
    ok(url.protocol === 'file:', '生成 file: 协议')
    ok(url.pathname === '/C:/a/b.png', 'Windows 盘符补第三个斜杠', url.pathname)
    ok(url.host === '', '没把盘符当成主机名', url.host)
  }

  /* ---- 回归本体：文件名里的 # ---- */
  {
    const url = parse('C:\\fixture\\图#1.png')
    ok(url.hash === '', '文件名里的 # 不产生 fragment', url.hash)
    ok(url.pathname.endsWith('%231.png'), '文件名里的 # 被转义成 %23', url.pathname)
    ok(decodeURIComponent(url.pathname) === '/C:/fixture/图#1.png', '路径可无损还原', decodeURIComponent(url.pathname))
    ok(url.pathname.startsWith('/C:/fixture/'), '目录部分仍然在（没被截断）', url.pathname)
  }

  /* ---- 空格 / ? / % / 中文 / UNIX 路径 ---- */
  {
    const url = parse('C:\\my files\\a b.png')
    ok(url.pathname === '/C:/my%20files/a%20b.png', '空格转义', url.pathname)
    ok(url.search === '' && url.hash === '', '空格不产生 query / hash')
  }
  {
    const url = parse('C:\\q\\a?b.png')
    ok(url.search === '', '文件名里的 ? 不产生 query', url.search)
    ok(decodeURIComponent(url.pathname) === '/C:/q/a?b.png', '? 被转义且可还原', decodeURIComponent(url.pathname))
  }
  {
    const url = parse('C:\\p\\50%.png')
    ok(url.pathname.includes('50%25.png'), '百分号被转义（否则 URL 解析会报无效转义）', url.pathname)
    ok(decodeURIComponent(url.pathname) === '/C:/p/50%.png', '百分号可还原', decodeURIComponent(url.pathname))
  }
  {
    const url = parse('/home/u/图 1.png')
    ok(decodeURIComponent(url.pathname) === '/home/u/图 1.png', 'UNIX 路径（无盘符段）保持正确', url.pathname)
  }
  {
    const url = parse('d:\\x\\y.txt')
    ok(url.pathname === '/d:/x/y.txt', '小写盘符同样处理', url.pathname)
  }
}
