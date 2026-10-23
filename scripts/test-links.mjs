export async function runLinkTests(ok) {
  const { classifyLink, parseFileLink } = await import('../out/test/links.mjs')

  const kindOf = (href) => classifyLink(href).kind

  ok(kindOf('https://example.com/a?b=1') === 'url', 'https 链接 → 内部浏览器')
  ok(kindOf('http://localhost:5173/') === 'url', 'http 本机地址 → 内部浏览器')
  ok(classifyLink('https://example.com:8443/x').url === 'https://example.com:8443/x', '带端口不被当成行号')
  ok(kindOf('mailto:a@b.com') === 'url', 'mailto → 交系统处理')

  ok(kindOf('javascript:alert(1)') === 'invalid', 'javascript: 被拒绝')
  ok(kindOf('JavaScript:alert(1)') === 'invalid', '协议名大小写不敏感')
  ok(kindOf('data:text/html,<script>x</script>') === 'invalid', 'data: 被拒绝')
  ok(kindOf('vbscript:msgbox') === 'invalid', 'vbscript: 被拒绝')
  ok(kindOf('vscode://file/x') === 'invalid', '未知自定义协议一律拒绝（不做猜测）')

  ok(classifyLink('file:///C:/a/b.ts').path === 'C:/a/b.ts', 'file:///C:/… → Windows 路径')
  ok(classifyLink('file:///home/x/y.md').path === '/home/x/y.md', 'file:///home/… → 类 Unix 路径')
  ok(classifyLink('file:///C:/a%20b/c.ts').path === 'C:/a b/c.ts', 'file:// 里的 %20 会解码')

  ok(kindOf('C:\\Users\\a\\b.ts') === 'file', 'Windows 绝对路径 → 文件预览')
  ok(classifyLink('C:/a/b.ts:42').line === 42, '`path:42` 解析出行号')
  ok(classifyLink('C:/a/b.ts:42').path === 'C:/a/b.ts', '行号与路径分开')
  ok(classifyLink('C:\\a\\b.ts').line === undefined, '`C:\\a` 里的盘符不当行号')
  ok(kindOf('\\\\server\\share\\x.txt') === 'file', 'UNC 路径 → 文件预览')
  ok(kindOf('/home/x/y.ts') === 'file', '类 Unix 绝对路径 → 文件预览')

  ok(classifyLink('src/main/index.ts').path === 'src/main/index.ts', '项目内相对路径 → 文件预览')
  ok(kindOf('./docs/x.md') === 'file', './ 开头的相对路径')
  ok(classifyLink('docs/x.md:12').line === 12, '相对路径也支持行号')
  ok(kindOf('../../etc/passwd') === 'file', '带 .. 的路径仍归类为 file（越界由主进程判定）')

  const encoded = '.local-docs/evidence/2026-10-23-%E5%90%8E%E7%AB%AF%E9%80%BB%E8%BE%91%E5%AE%A1%E6%9F%A5/%E5%AE%A1%E6%9F%A5%E7%BB%93%E6%9E%9C.md'
  ok(classifyLink(encoded).path === '.local-docs/evidence/2026-10-23-后端逻辑审查/审查结果.md', 'Markdown 编码过的中文相对路径解码后再预览')
  ok(classifyLink('E:%5Cpi-desktop%5Ca%20b.md').path === 'E:\\pi-desktop\\a b.md', '编码过的反斜杠 Windows 路径仍是文件，不被当成 e: 协议')
  ok(classifyLink('E:/pi-desktop/%E5%AE%A1%E6%9F%A5.md:12').line === 12, '编码过的绝对路径仍解析行号')
  ok(classifyLink('/home/x/%E6%96%87%E4%BB%B6.md').path === '/home/x/文件.md', '编码过的类 Unix 路径解码')
  ok(classifyLink('docs/100%.md').path === 'docs/100%.md', '坏的 percent escape 保留原样，不抛错')
  ok(kindOf('docs/a%00.md') === 'invalid', '解码出 NUL 的路径被拒绝')
  ok(classifyLink('https://example.com/%E5%AE%A1').url === 'https://example.com/%E5%AE%A1', '网页链接保持编码原样')

  ok(parseFileLink('src/main/index.ts#L42')?.line === 42, '#L42 解析为首行')
  ok(parseFileLink('src/main/index.ts#L42-L60')?.line === 42, '#L42-L60 取首行')
  ok(parseFileLink('src/main/index.ts#L42-L60')?.lineEnd === 60, '#L42-L60 带出范围末行')
  ok(parseFileLink('src/main/index.ts#L42')?.lineEnd === undefined, '单行链接不写末行（界面不画一行高的范围）')
  ok(parseFileLink('src/main/index.ts#L42-L42')?.lineEnd === undefined, '#L42-L42 当作单行（不造空范围）')
  ok(
    classifyLink('src/main/index.ts#L42-L60').kind === 'file' &&
      classifyLink('src/main/index.ts#L42-L60').lineEnd === 60,
    '分类结果把范围一并带出去（路径不含 `#L42-L60`）'
  )
  const ranged = classifyLink('src/main/index.ts#L42-L60')
  ok(ranged.kind === 'file' && ranged.path === 'src/main/index.ts', '范围不当文件名的一部分')
  ok(
    classifyLink('file:///C:/a/b.ts#L7-L9').lineEnd === 9,
    'file URL 也支持范围'
  )
  ok(classifyLink('src/main/index.ts#L42').line === 42, '显式文件链接接入 #L42')
  ok(classifyLink('file:///C:/a/b.ts#L7').path === 'C:/a/b.ts', 'file URL 兼容 #L7 路径')
  ok(classifyLink('file:///C:/a/b.ts#L7').line === 7, 'file URL 兼容 #L7 行号')
  ok(parseFileLink('https://example.com/a#L42') === undefined, '外部 URL 不被文件解析器接管')
  ok(parseFileLink('src/main/index.ts#L0') === undefined, '零行号被拒绝')
  ok(parseFileLink('src/main/index.ts#L60-L42') === undefined, '反向行号范围被拒绝')
  ok(parseFileLink('src/%ZZ/index.ts#L42') === undefined, '坏的 percent escape 被拒绝')

  ok(kindOf('') === 'invalid', '空链接 → invalid')
  ok(kindOf(undefined) === 'invalid', 'undefined → invalid')
  ok(kindOf('foo') === 'invalid', '没有分隔符也没有扩展名的短词不当路径')
  ok(kindOf('C:\\a\\b\0.ts') === 'invalid', '含 NUL 的路径被拒绝')
}
