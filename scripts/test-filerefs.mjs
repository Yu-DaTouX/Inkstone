/**
 * 文件引用（拖入的普通文件）的纯逻辑测试。
 *
 * 为什么要有：这里是**安全边界** —— 渲染端只能给路径，
 * 能不能读、读多少、是不是普通文件全部在主进程定。
 * 一旦这里松了，「消息里写一个绝对路径」就能读到任意文件。
 *
 * 用临时目录里的合成文件，不碰用户数据。
 */
export async function runFileRefTests(ok) {
  const { grantFile, grantFiles, isGranted, readGrantedText, readPreview, statPreview } = await import('../out/test/file-refs.mjs')
  const { mkdtemp, writeFile, mkdir, rm, symlink } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join, resolve } = await import('node:path')

  const dir = await mkdtemp(join(tmpdir(), 'yan-fileref-'))
  try {
    const txt = join(dir, 'hello.ts')
    await writeFile(txt, 'export const a = 1\n')
    const other = join(dir, 'other.txt')
    await writeFile(other, 'secret\n')
    const binary = join(dir, 'app.exe')
    await writeFile(binary, Buffer.from([0x4d, 0x5a, 0x00, 0x01, 0x02]))
    const img = join(dir, 'pic.png')
    await writeFile(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const sub = join(dir, 'sub')
    await mkdir(sub)
    const big = join(dir, 'big.log')
    await writeFile(big, 'y'.repeat(2 * 1024 * 1024 + 64))

    /* ---- 登记 ---- */
    const t = await grantFile(txt)
    ok(t.ok && t.kind === 'text' && t.name === 'hello.ts', '普通文本文件可引用')
    ok(resolve(t.path) === resolve(txt), '返回的是 realpath')
    ok(isGranted(t.path), '引用后进入授权表')
    ok(t.mimeType === 'text/typescript', `按扩展名给 MIME（实际 ${t.mimeType}）`)

    const i = await grantFile(img)
    ok(i.ok && i.kind === 'image', '图片识别为 image（后续走图片通道）')
    const b = await grantFile(binary)
    ok(b.ok && b.kind === 'binary', '.exe 归为 binary（可引用，但不能当文本预览）')

    const missing = await grantFile(join(dir, 'nope.ts'))
    ok(!missing.ok, '不存在的文件被拒绝')
    ok(typeof missing.error === 'string' && missing.error.length > 0, '失败时给出可显示的原因')
    const dirRef = await grantFile(sub)
    ok(!dirRef.ok, '目录被拒绝（不做递归引用）')
    const rel = await grantFile('hello.ts')
    ok(!rel.ok, '相对路径被拒绝（只接受绝对路径）')
    const nul = await grantFile(txt + '\0x')
    ok(!nul.ok, '含 NUL 的路径被拒绝')

    /* ---- 读取：只认已登记 ---- */
    const notGranted = await readGrantedText(other)
    ok(!notGranted.ok, '没登记过的绝对路径读不到（消息里的路径不获得权限）')
    const got = await readGrantedText(t.path)
    ok(got.ok && got.text.includes('export const a = 1'), '已登记文件可以读文本')
    const binRead = await readGrantedText(b.path)
    ok(!binRead.ok, '二进制文件拒绝文本读取')

    /* ---- 大文本：允许引用，读取时截断 ---- */
    const bigRef = await grantFile(big)
    ok(bigRef.ok, '超过 2MB 的文本仍可引用（大文件只是不整体进上下文）')
    const bigRead = await readGrantedText(bigRef.path)
    ok(bigRead.ok && bigRead.truncated === true, '读取时标记截断')
    ok(bigRead.text.length === 2 * 1024 * 1024, `只读前 2MB（实际 ${bigRead.text.length}）`)

    /* ---- 批量上限 ---- */
    const many = await grantFiles(Array.from({ length: 30 }, () => txt))
    ok(many.length === 20, `一次最多登记 20 个（实际 ${many.length}）`)

    /* ---- 只读预览（消息里的文件链接）：相对路径按 cwd 解析 ---- */
    const pvRel = await readPreview('hello.ts', dir)
    ok(pvRel.ok && pvRel.text.includes('export const a'), '相对路径按 cwd 解析后可预览')
    ok(pvRel.kind === 'text', '预览结果带上类型（界面据此决定怎么显示）')

    const pvLine = await readPreview('hello.ts', dir, 42)
    ok(pvLine.line === 42, '行号原样带出（界面滚到那一行）')

    /* 范围高亮（H-4）：末行也带出去，但只限真的有范围时 */
    const pvRange = await readPreview('hello.ts', dir, 2, 5)
    ok(pvRange.line === 2 && pvRange.lineEnd === 5, '范围末行透传到预览结果')
    ok((await readPreview('hello.ts', dir, 2, 2)).lineEnd === undefined, '末行等于首行不写范围')
    ok((await readPreview('hello.ts', dir, 5, 2)).lineEnd === undefined, '反向范围不写进结果')
    ok((await readPreview('hello.ts', dir, 2)).lineEnd === undefined, '不传末行时没有范围')

    /* 大文件窗口化（H-4）：超过阈值时只围绕目标行给一段真窗口 */
    const manyLines = join(dir, 'many.txt')
    await writeFile(
      manyLines,
      Array.from({ length: 3000 }, (_, i) => `row ${i + 1}`).join('\n') + '\n',
      'utf8'
    )
    const win = await readPreview('many.txt', dir, 2500)
    ok(win.windowStart === 2300, `窗口从目标行前 200 行开始（实际 ${win.windowStart ?? '-'}）`)
    ok((win.text ?? '').split('\n')[0] === 'row 2300', '窗口第一行是真实内容（不是估算）')
    ok((win.text ?? '').includes('row 2500'), '目标行就在窗口里')
    ok((win.totalLines ?? 0) >= 3000, '总行数如实给出')
    const nearTop = await readPreview('many.txt', dir, 10)
    ok(nearTop.windowStart === undefined, '目标靠前时不窗口化（不留白）')
    ok((nearTop.text ?? '').includes('row 3000'), '不窗口化时全文可见')

    const pvAbs = await readPreview(txt, dir)
    ok(pvAbs.ok, '绝对路径也能预览（但主进程仍做 realpath 校验）')

    const pvEsc = await readPreview('../outside.txt', dir)
    ok(!pvEsc.ok, '相对路径跳出 cwd 被拒绝（`../../etc/passwd` 挡在这里）')
    const pvMissing = await readPreview('nope.ts', dir)
    ok(!pvMissing.ok, '不存在的文件给出错误而不是抛异常')
    ok(
      typeof pvMissing.dir === 'string' &&
        pvMissing.dir.replace(/[\\/]+$/, '') === dir.replace(/[\\/]+$/, ''),
      'H-4：读不到时给出父目录（“定位父目录”出口）'
    )
    ok(pvEsc.dir === undefined, 'H-4：越界错误不泄露父目录（不把工作区外路径当导航目标）')
    const pvDir = await readPreview('sub', dir)
    ok(!pvDir.ok, '目录不能作为文件预览')

    const pvBig = await readPreview('big.log', dir)
    ok(pvBig.ok && pvBig.truncated === true, '大文本预览标记截断')
    const pvBin = await readPreview('app.exe', dir)
    ok(pvBin.ok && pvBin.kind === 'binary' && pvBin.text === undefined, '二进制不给内容，只给元信息')
    const pvImg = await readPreview('pic.png', dir)
    ok(pvImg.ok && pvImg.kind === 'image' && pvImg.text === undefined, '图片识别为 image（界面走图片展示）')

    /* ---- 变化提示（H-4）：只 stat，不读内容 ---- */
    ok(typeof pvRel.mtimeMs === 'number' && pvRel.mtimeMs > 0, '预览带上 mtime（变化提示的基准）')
    const st1 = await statPreview('hello.ts', dir)
    ok(st1.ok && st1.mtimeMs === pvRel.mtimeMs, 'statPreview 与预览拿到同一个 mtime（不靠重读内容）')
    ok(st1.abs === pvRel.abs, 'statPreview 返回 realpath（身份与预览一致）')
    ok(st1.size === pvRel.size, 'statPreview 同时给出大小')

    /* 内容真的改了：mtime 必须变（否则提示永远不出现） */
    const beforeMtime = st1.mtimeMs
    await writeFile(txt, 'export const a = 2\n', 'utf8')
    const st2 = await statPreview('hello.ts', dir)
    ok(st2.ok && st2.mtimeMs !== beforeMtime, '改写文件后 mtime 变化（提示据此触发）')

    /* 与 readPreview 同一条校验链：越界 / 目录 / 不存在都不能看 */
    ok(!(await statPreview('../outside.txt', dir)).ok, 'statPreview 同样挡住跳出 cwd 的相对路径')
    ok(!(await statPreview('sub', dir)).ok, 'statPreview 不接受目录')
    ok(!(await statPreview('nope.ts', dir)).ok, 'statPreview 对不存在的文件返回 ok:false（不抛）')

    /* ---- 符号链接逃逸：登记的是 realpath，不能拿它当另一个文件 ---- */
    if (process.platform !== 'win32') {
      const link = join(dir, 'link.txt')
      try {
        await symlink(other, link)
        const l = await grantFile(link)
        ok(l.ok && resolve(l.path) === resolve(other), '符号链接解析成真实路径后登记')
        const linkRead = await readGrantedText(link)
        ok(linkRead.ok, '通过链接也能读（因为登记的就是 realpath）')
      } catch {
        /* 平台不支持就跳过 */
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
