import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const outdir = join('.tmp', 'canvas-w2-直接微调', 'source-map')
await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })
try {
  await build({
    entryPoints: ['src/shared/html-source-map.ts', 'src/shared/html-edit-patch.ts'],
    outdir,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
  const map = await import(pathToFileURL(join(outdir, 'html-source-map.js')).href)
  const patch = await import(pathToFileURL(join(outdir, 'html-edit-patch.js')).href)

  const count = (value, needle) => value.split(needle).length - 1
  const markedAttribute = (value, offset) => value.includes(`data-yan-src="${offset}"`)

  const doc = [
    '<!doctype html>',
    '<html><head><title>a <b> c</title><style>.x::after{content:"<i>"}</style></head>',
    '<body><!-- <div>fake</div> -->',
    '<p class="a" title="x > y">hi</p>',
    '<br>',
    '<img src="a.png" alt="">',
    '<textarea><span>raw</span></textarea>',
    '<div><span>s</span></div>',
    '<script>var s = "<span>fake</span>";</script>',
    '</body></html>'
  ].join('\n')

  assert.deepEqual(
    map.scanHtmlStartTags(doc).map((tag) => `${tag.name}@${tag.offset}`).slice(0, 4),
    [`html@${doc.indexOf('<html')}`, `head@${doc.indexOf('<head')}`, `title@${doc.indexOf('<title')}`, `style@${doc.indexOf('<style')}`],
    '扫描器按出现顺序给出开始标签与原文件偏移'
  )
  const scanned = map.scanHtmlStartTags(doc)
  assert.deepEqual(
    scanned.map((tag) => tag.name.toLowerCase()),
    ['html', 'head', 'title', 'style', 'body', 'p', 'br', 'img', 'textarea', 'div', 'span', 'script'],
    '注释、script/style/textarea/title 内容里的假标签不算元素'
  )
  assert.equal(scanned.find((tag) => tag.name === 'br').selfClosing, false, 'void 元素没有自闭合斜杠')
  assert.equal(scanned.find((tag) => tag.name === 'img').selfClosing, false, 'img 也按 void 处理')
  assert.equal(map.scanHtmlStartTags('<img src="a"/>')[0].selfClosing, true, '识别 XHTML 风格自闭合')
  assert.equal(map.scanHtmlStartTags('<p title="a > b">x</p>')[0].end, '<p title="a > b">'.length, '属性值里的 > 不结束标签')
  assert.equal(map.scanHtmlStartTags("<p title='a > b'>x</p>")[0].end, "<p title='a > b'>".length, '单引号同样处理')

  const marked = map.markHtmlSourceOffsets(doc)
  assert.equal(count(marked, 'data-yan-src'), scanned.length, '每个开始标签各加一次偏移')
  assert.ok(markedAttribute(marked, doc.indexOf('<p class')), 'p 的偏移指向原文件里的开始标签')
  assert.ok(markedAttribute(marked, doc.indexOf('<br>')), 'void 元素也标记')
  assert.ok(marked.includes('<!-- <div>fake</div> -->'), '注释内容原样保留')
  assert.ok(marked.includes('<span>raw</span></textarea>'), 'textarea 内容不被标记')
  assert.ok(marked.includes('var s = "<span>fake</span>";</script>'), 'script 内容不被标记')
  assert.ok(marked.includes('.x::after{content:"<i>"}</style>'), 'style 内容不被标记')
  assert.ok(marked.includes('<img src="a.png" alt="" data-yan-src='), '没有自闭合斜杠时属性加在 > 之前')
  assert.ok(map.markHtmlSourceOffsets('<img src="a"/>').includes('data-yan-src="0"/>'), '自闭合标签的偏移加在斜杠之前')

  const upper = '<DIV Class="X"><SPAN>y</SPAN></DIV>'
  const upperMarked = map.markHtmlSourceOffsets(upper)
  assert.ok(markedAttribute(upperMarked, 0) && markedAttribute(upperMarked, upper.indexOf('<SPAN')), '标签名大小写不影响标记')

  const existing = '<p data-yan-src="12">x</p>'
  assert.equal(map.markHtmlSourceOffsets(existing), existing, '已有 data-yan-src 不重复添加')
  assert.equal(count(map.markHtmlSourceOffsets(existing), 'data-yan-src'), 1)

  assert.equal(map.markHtmlSourceOffsets(''), '', '空文档原样返回')
  assert.equal(map.markHtmlSourceOffsets('plain text & <'), 'plain text & <', '没有完整标签的尖括号原样保留')
  assert.equal(map.markHtmlSourceOffsets('<!-- open'), '<!-- open', '未闭合注释不产生标记')
  assert.equal(map.markHtmlSourceOffsets('<div title="open'), '<div title="open', '未闭合的开标签跳过')

  const attrs = map.scanHtmlAttributes('<a href="x" download data-a=\'1\'>')
  assert.deepEqual(attrs.map((item) => item.name), ['href', 'download', 'data-a'], '属性扫描覆盖布尔属性与不同引号')
  assert.equal(map.readHtmlTagAttribute('<a href="x?a=1&amp;b=2">', 'href'), 'x?a=1&amp;b=2', '读取属性值')
  assert.equal(map.readHtmlTagAttribute('<a download>', 'download'), '', '布尔属性读成空串')
  assert.equal(map.setHtmlTagAttribute('<a>', 'href', 'x'), '<a href="x">', '新增属性')
  assert.equal(map.setHtmlTagAttribute('<a href="x">', 'href', null), '<a>', '删除属性不留空白')
  assert.equal(map.setHtmlTagAttribute('<a href="x">', 'href', 'a"b'), '<a href="a&quot;b">', '属性值转义引号')

  const html = '<div id="a" style="color: red; padding: 1px">ok</div>'
  const styled = patch.patchHtmlAtOffset(html, 0, 'div', {
    styles: [
      { property: 'color', value: 'blue' },
      { property: 'padding', value: null },
      { property: 'font-size', value: '18px' }
    ]
  })
  assert.equal(styled.ok, true)
  assert.equal(styled.html, '<div id="a" style="color: blue; font-size: 18px">ok</div>', '合并内联样式并保留其他声明')

  const replaced = patch.patchHtmlAtOffset(html, 0, 'div', { text: 'done' })
  assert.equal(replaced.ok, true)
  assert.equal(replaced.html, '<div id="a" style="color: red; padding: 1px">done</div>', '纯文本叶子可替换文字')

  const withStyleAndText = patch.patchHtmlAtOffset(html, 0, 'div', {
    styles: [{ property: 'color', value: 'green' }],
    text: '<b>bold</b>'
  })
  assert.equal(withStyleAndText.ok, true)
  assert.equal(
    withStyleAndText.html,
    '<div id="a" style="color: green; padding: 1px">&lt;b&gt;bold&lt;/b&gt;</div>',
    '改动标签后文本替换的位置仍然正确'
  )

  const children = '<div><b>x</b></div>'
  assert.deepEqual(patch.patchHtmlAtOffset(children, 0, 'div', { text: 'y' }), { ok: false, error: 'text-children' }, '有子标签时拒绝替换文字')
  assert.deepEqual(patch.patchHtmlAtOffset('<br>', 0, 'br', { text: 'y' }), { ok: false, error: 'text-children' }, 'void 元素没有文本')
  assert.deepEqual(patch.patchHtmlAtOffset('<div>a</div>', 0, 'div', { text: 'b' }).ok, true)

  assert.deepEqual(patch.patchHtmlAtOffset(html, 1, 'div', { text: 'x' }), { ok: false, error: 'offset' }, '偏移不在开始标签上就失败')
  assert.deepEqual(patch.patchHtmlAtOffset(html, 0, 'span', { text: 'x' }), { ok: false, error: 'offset' }, '偏移处的标签名不一致就失败')
  assert.deepEqual(patch.patchHtmlAtOffset(html, 0, 'div', {}), { ok: false, error: 'empty' }, '空补丁不写回')
  assert.deepEqual(
    patch.patchHtmlAtOffset(html, 0, 'div', { attributes: [{ name: 'href', value: 'x' }] }).html,
    '<div id="a" style="color: red; padding: 1px" href="x">ok</div>',
    '设置属性时保留其余属性'
  )
  assert.deepEqual(
    patch.patchHtmlAtOffset(html, 0, 'div', { attributes: [{ name: 'id', value: null }] }).html,
    '<div style="color: red; padding: 1px">ok</div>',
    '属性值为 null 时删除属性'
  )
  assert.deepEqual(
    patch.patchHtmlAtOffset(html, 0, 'div', { attributes: [{ name: 'on click', value: 'x' }] }),
    { ok: false, error: 'attributes' },
    '非法属性名被拒绝'
  )
  assert.deepEqual(
    patch.patchHtmlAtOffset(html, 0, 'div', { styles: [{ property: 'color', value: 'red; background: url(x)' }] }),
    { ok: false, error: 'styles' },
    '非法样式值明确报错，不静默丢弃'
  )
  assert.deepEqual(patch.patchHtmlAtOffset('<p style="color: red">x</p>', 0, 'p', { styles: [{ property: 'color', value: 'red' }] }), { ok: false, error: 'empty' }, '没有变化时报告无改动')
  assert.equal(
    patch.patchHtmlAtOffset('<p style="color:red;color:blue">x</p>', 0, 'p', { styles: [{ property: 'color', value: 'green' }] }).html,
    '<p style="color: green">x</p>',
    '同名重复声明一并替换'
  )
  assert.deepEqual(patch.patchHtmlAtOffset('<a href="#">x</a>', 0, 'a', { attributes: [{ name: 'onclick', value: 'alert(1)' }] }), { ok: false, error: 'attributes' }, '拒绝事件属性')
  assert.deepEqual(patch.patchHtmlAtOffset('<a href="#">x</a>', 0, 'a', { attributes: [{ name: 'href', value: ' JavaScript:alert(1)' }] }), { ok: false, error: 'attributes' }, '拒绝 javascript 链接')
  assert.equal(patch.patchHtmlAtOffset('<a href="#">x</a>', 0, 'a', { attributes: [{ name: 'href', value: 'https://example.com' }] }).ok, true, '普通链接可改')
  const cdata = map.markHtmlSourceOffsets('<svg><![CDATA[ <g> ]]></svg><p>y</p>')
  assert.ok(cdata.includes('<![CDATA[ <g> ]]>'), 'CDATA 内不加标记')
  const selfScript = map.markHtmlSourceOffsets('<script src="a.js"/><div>x</div></script><p>y</p>')
  assert.ok(selfScript.includes('<div>x</div>') && /<p data-yan-src="\d+">y/.test(selfScript), '写成自闭合的 script 仍按原始文本跳过')

  const merged = patch.mergeInlineStyle('--gap: 4px; color: red; font-weight: 700', [
    { property: 'color', value: 'blue' },
    { property: 'font-weight', value: null }
  ])
  assert.equal(merged, '--gap: 4px; color: blue', '自定义属性保留，删除的声明消失')
  assert.equal(patch.mergeInlineStyle('', []), null, '没有声明时返回 null')
  assert.equal(patch.mergeInlineStyle('color: red', [{ property: 'color', value: null }]), null, '删光后返回 null')

  assert.equal(patch.isHtmlTextLeaf('<p>a</p>', 0, 'p'), true)
  assert.equal(patch.isHtmlTextLeaf('<p><b>a</b></p>', 0, 'p'), false)
  assert.equal(patch.isHtmlTextLeaf('<p>a', 0, 'p'), false, '没有结束标签不算文本叶子')
  assert.deepEqual(
    patch.htmlElementSpan('<p>a</p>', 0, 'p'),
    { name: 'p', tagStart: 0, tagEnd: 3, contentStart: 3, contentEnd: 4, closeStart: 4, closeEnd: 8 },
    '元素区间覆盖开始标签、内容与结束标签'
  )

  const plain = '<p>hi</p>'
  const plainMarked = map.markHtmlSourceOffsets(plain)
  const offsetText = /data-yan-src="(\d+)"/.exec(plainMarked)[1]
  const offset = Number(offsetText)
  assert.equal(plain.slice(offset, offset + 2), '<p', '标记的偏移能在原文件里定位到同名开始标签')
  const written = patch.patchHtmlAtOffset(plain, offset, 'p', { styles: [{ property: 'color', value: 'red' }] })
  assert.equal(written.ok, true)
  assert.equal(written.html, '<p style="color: red">hi</p>', '偏移坐标与标记扫描器一致')

  const editOut = join(outdir, 'html-edit-ipc.mjs')
  const files = new Map()
  globalThis.__editFiles = files
  const stub = (name, contents) => ({
    name,
    setup(b) {
      b.onResolve({ filter: new RegExp(`^(\\.\\.\\/(settings|file-editor|file-path-gate))$`) }, (args) => ({ path: args.path, namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: contents[args.path] ?? '', loader: 'js' }))
    }
  })
  await build({
    entryPoints: ['src/main/ipc/html-edit-ipc.ts'],
    outfile: editOut,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    plugins: [
      stub('html-edit-stubs', {
        '../settings': 'export async function getSettings(){return {cwd:"/"}}',
        '../file-path-gate': 'export function pathKey(p){return p}',
        '../file-editor': [
          'import { createHash } from "node:crypto"',
          'const hashOf = (text) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")',
          'export async function readEditableFile(cwd, target) {',
          '  const files = globalThis.__editFiles',
          '  const text = files.get(target)',
          '  if (text === undefined) return { ok: false, error: "missing" }',
          '  return { ok: true, text, hash: hashOf(text), abs: target }',
          '}',
          'export async function writeEditableFile(cwd, target, text, expected) {',
          '  const files = globalThis.__editFiles',
          '  const current = files.get(target)',
          '  if (current === undefined) return { status: "failed", error: "missing" }',
          '  if (expected && expected !== hashOf(current)) return { status: "conflict" }',
          '  files.set(target, text)',
          '  return { status: "ok", hash: hashOf(text) }',
          '}'
        ].join('\n')
      })
    ]
  })
  const edit = await import(pathToFileURL(editOut).href)
  assert.equal(edit.frameHashProblem('', 'abc'), 'draft', '草稿画框没有磁盘哈希，拒绝写回')
  assert.equal(edit.frameHashProblem('abc', 'abc'), null, '帧哈希与磁盘一致时放行')
  assert.equal(edit.frameHashProblem('abc', 'def'), 'conflict', '帧哈希与磁盘不一致时报冲突')

  const handlers = new Map()
  edit.registerHtmlEditIpc(
    { handle: (channel, fn) => handlers.set(channel, fn), rawHandle: (channel, fn) => handlers.set(channel, fn) },
    { resolveFileContext: async () => ({ ok: true, context: { cwd: '/' } }) }
  )
  const apply = handlers.get('yan:htmlEdit:apply')
  const undo = handlers.get('yan:htmlEdit:undo')
  const source = '<div class="a">hi</div>'
  files.set('/site/index.html', source)
  const diskHash = createHash('sha256').update(Buffer.from(source, 'utf8')).digest('hex')
  const request = {
    path: '/site/index.html',
    sha256: diskHash,
    sourceOffset: 0,
    tag: 'div',
    patch: { styles: [{ property: 'color', value: 'red' }] }
  }
  assert.deepEqual(await apply({ ...request, frameHash: '' }), { ok: false, error: 'draft' }, '没有帧哈希时拒绝写回')
  assert.deepEqual(await apply({ ...request, frameHash: 'f'.repeat(64) }), { ok: false, error: 'conflict' }, '帧哈希不符时拒绝写回')
  assert.equal(files.get('/site/index.html'), source, '被拒绝的请求不写文件')
  const applied = await apply({ ...request, frameHash: diskHash })
  assert.equal(applied.ok, true, '帧哈希与磁盘一致时写回')
  assert.equal(files.get('/site/index.html'), '<div class="a" style="color: red">hi</div>', '写回内容按偏移应用')
  assert.equal(applied.sha256, createHash('sha256').update(Buffer.from(files.get('/site/index.html'), 'utf8')).digest('hex'), '返回写回后的 sha256')
  assert.deepEqual(await undo({ path: '/site/index.html', sha256: diskHash }), { ok: false, error: 'undo' }, '旧 sha256 不能撤销')
  const undone = await undo({ path: '/site/index.html', sha256: applied.sha256 })
  assert.equal(undone.ok, true, '用写回返回的 sha256 撤销')
  assert.equal(files.get('/site/index.html'), source, '撤销恢复原文')
  assert.deepEqual(await undo({ path: '/site/index.html', sha256: applied.sha256 }), { ok: false, error: 'undo' }, '撤销后清掉撤销记录')

  console.log('html source map: scanner / attributes / marking / patch / frame hash passed')
} finally {
  await rm(outdir, { recursive: true, force: true })
}
