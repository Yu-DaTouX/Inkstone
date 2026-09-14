/**
 * 链接路由的纯逻辑测试（src/shared/links.ts）。
 *
 * 为什么值得单独测：这是**安全判断** ——
 * 一个 `javascript:` 漏过去就是在渲染进程执行脚本；
 * 一个相对路径漏了 `..` 就是任意文件读取（主进程还会再挡一次，但这里是第一道）。
 */
export async function runLinkTests(ok) {
  const { classifyLink } = await import('../out/test/links.mjs')

  const kindOf = (href) => classifyLink(href).kind

  /* ---- 网页 ---- */
  ok(kindOf('https://example.com/a?b=1') === 'url', 'https 链接 → 内部浏览器')
  ok(kindOf('http://localhost:5173/') === 'url', 'http 本机地址 → 内部浏览器')
  ok(classifyLink('https://example.com:8443/x').url === 'https://example.com:8443/x', '带端口不被当成行号')
  ok(kindOf('mailto:a@b.com') === 'url', 'mailto → 交系统处理')

  /* ---- 危险协议 ---- */
  ok(kindOf('javascript:alert(1)') === 'invalid', 'javascript: 被拒绝')
  ok(kindOf('JavaScript:alert(1)') === 'invalid', '协议名大小写不敏感')
  ok(kindOf('data:text/html,<script>x</script>') === 'invalid', 'data: 被拒绝')
  ok(kindOf('vbscript:msgbox') === 'invalid', 'vbscript: 被拒绝')
  ok(kindOf('vscode://file/x') === 'invalid', '未知自定义协议一律拒绝（不做猜测）')

  /* ---- file:// ---- */
  ok(classifyLink('file:///C:/a/b.ts').path === 'C:/a/b.ts', 'file:///C:/… → Windows 路径')
  ok(classifyLink('file:///home/x/y.md').path === '/home/x/y.md', 'file:///home/… → 类 Unix 路径')
  ok(classifyLink('file:///C:/a%20b/c.ts').path === 'C:/a b/c.ts', 'file:// 里的 %20 会解码')

  /* ---- 绝对路径 ---- */
  ok(kindOf('C:\\Users\\a\\b.ts') === 'file', 'Windows 绝对路径 → 文件预览')
  ok(classifyLink('C:/a/b.ts:42').line === 42, '`path:42` 解析出行号')
  ok(classifyLink('C:/a/b.ts:42').path === 'C:/a/b.ts', '行号与路径分开')
  ok(classifyLink('C:\\a\\b.ts').line === undefined, '`C:\\a` 里的盘符不当行号')
  ok(kindOf('\\\\server\\share\\x.txt') === 'file', 'UNC 路径 → 文件预览')
  ok(kindOf('/home/x/y.ts') === 'file', '类 Unix 绝对路径 → 文件预览')

  /* ---- 相对路径（按会话 cwd 解析） ---- */
  ok(classifyLink('src/main/index.ts').path === 'src/main/index.ts', '项目内相对路径 → 文件预览')
  ok(kindOf('./docs/x.md') === 'file', './ 开头的相对路径')
  ok(classifyLink('docs/x.md:12').line === 12, '相对路径也支持行号')
  ok(kindOf('../../etc/passwd') === 'file', '带 .. 的路径仍归类为 file（越界由主进程判定）')

  /* ---- 不该被当成路径的 ---- */
  ok(kindOf('') === 'invalid', '空链接 → invalid')
  ok(kindOf(undefined) === 'invalid', 'undefined → invalid')
  ok(kindOf('foo') === 'invalid', '没有分隔符也没有扩展名的短词不当路径')
  ok(kindOf('C:\\a\\b\0.ts') === 'invalid', '含 NUL 的路径被拒绝')
}
