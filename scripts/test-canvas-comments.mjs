#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

let checks = 0
const ok = (condition, label) => {
  assert.ok(condition, label)
  checks++
  console.log(`✓ ${label}`)
}

const outdir = join('.tmp', 'canvas-w2-评论钉')
await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })
try {
  await build({
    entryPoints: [
      'src/renderer/src/features/preview/canvas-tools/comment-store.ts',
      'src/renderer/src/features/preview/canvas-tools/comment-text.ts'
    ],
    outdir,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
  const store = await import(pathToFileURL(join(outdir, 'comment-store.js')).href)
  const text = await import(pathToFileURL(join(outdir, 'comment-text.js')).href)

  ok(store.COMMENT_STORE_PREFIX === 'yan.canvas.comments.v1', '存储键带版本前缀')
  ok(store.COMMENT_LIMIT === 200, '单文件评论上限 200 条')
  ok(store.COMMENT_IMAGE_LIMIT === 4, '发送到聊天最多 4 张截图')
  ok(store.commentStorageKey('/repo/a/index.html') === 'yan.canvas.comments.v1:/repo/a/index.html', '键名带成果文件绝对路径')

  const styles = {
    color: 'rgb(11, 11, 11)',
    backgroundColor: 'rgba(0, 0, 0, 0)',
    fontFamily: 'Inter',
    fontSize: '16px',
    fontWeight: '600',
    lineHeight: '24px',
    letterSpacing: 'normal',
    textAlign: 'start',
    padding: '8px',
    margin: '0px',
    borderRadius: '4px',
    display: 'block',
    width: '100px',
    height: '30px'
  }
  const element = (overrides = {}) => ({
    frameId: 'desktop',
    path: '0.1',
    selector: 'h2.title',
    tag: 'h2',
    id: '',
    classes: ['title'],
    text: '标题',
    rect: { x: 10, y: 20, w: 100, h: 30 },
    styles: { ...styles },
    outerHtml: '<h2 class="title">标题</h2>',
    ...overrides
  })

  assert.deepEqual(store.parseRect({ x: 1, y: 2, w: 3, h: 4 }), { x: 1, y: 2, w: 3, h: 4 })
  assert.deepEqual(store.parseRect({ x: -12, y: -40, w: 100, h: 30 }), { x: -12, y: -40, w: 100, h: 30 }, '页面回报的外框保留负坐标')
  assert.equal(store.parseRect({ x: 1, y: 2, w: 3 }), null, '缺少字段的矩形被拒绝')
  assert.equal(store.parseRect({ x: 1, y: 2, w: Number.NaN, h: 4 }), null, '非有限数值的矩形被拒绝')
  assert.equal(store.parseRect(null), null)

  assert.deepEqual(store.parseDomPath('0.2.1'), [0, 2, 1])
  assert.deepEqual(store.parseDomPath(''), [], '空路径解析为空数组')
  assert.deepEqual(store.parseDomPath('1.a'), [], '非数字路径段被拒绝')
  assert.deepEqual(store.parseDomPath('-1'), [], '负数路径段被拒绝')
  assert.deepEqual(store.parseDomPath('1.2.'), [], '尾部空段落被拒绝')
  ok(true, 'path/selector 重新查询用的路径解析安全')

  assert.equal(store.isPlainTextHtml('<h2 class="title">标题</h2>'), true, '单一文本节点识别为纯文本元素')
  assert.equal(store.isPlainTextHtml('<p>Hello <b>world</b></p>'), false, '含子元素的 HTML 不算纯文本')
  assert.equal(store.isPlainTextHtml('<img src="a.png">'), false, '空元素不算纯文本')
  assert.equal(store.isPlainTextHtml('<div></div>'), false, '无文本元素不算纯文本')
  assert.equal(store.isPlainTextHtml(''), false)
  assert.equal(store.isPlainTextHtml('<br/>'), false)

  assert.equal(store.plainTextNeedle(element()), '标题')
  assert.equal(store.plainTextNeedle(element({ outerHtml: '<h2 class="t">标题</h2>' })), '标题')
  assert.equal(store.plainTextNeedle(element({ outerHtml: '<h2><span>标题</span></h2>' })), '', '有子元素时不拿文字去探测')
  assert.equal(store.plainTextNeedle(element({ text: '标' })), '', '过短文字不拿去探测')

  assert.deepEqual(store.parseComments(null), [], '没有记录时返回空列表')
  assert.deepEqual(store.parseComments('{oops'), [], '坏 JSON 安全回退为空列表')
  assert.deepEqual(store.parseComments('[1,2,3]'), [], '不是对象的条目被丢弃')
  assert.deepEqual(store.parseComments('{"a":1}'), [], '不是数组时回退为空列表')

  const stored = [
    {
      id: 'c-2',
      frameId: 'desktop',
      element: element(),
      content: '第二条',
      createdAt: 2000,
      sentAt: null,
      invalid: false
    },
    {
      id: 'c-1',
      frameId: 'phone',
      element: element({ frameId: 'phone' }),
      content: '第一条',
      createdAt: 1000,
      sentAt: 1500,
      invalid: true
    }
  ]
  const parsed = store.parseComments(JSON.stringify(stored))
  assert.deepEqual(
    parsed.map((comment) => comment.id),
    ['c-1', 'c-2'],
    '按创建时间排序后再编号'
  )
  ok(parsed[0].sentAt === 1500 && parsed[0].invalid === true, '已发送与失效状态可读回')
  ok(parsed[1].element.rect.x === 10 && parsed[1].element.styles.fontSize === '16px', '元素快照含矩形与样式')
  assert.deepEqual(store.parseComments(JSON.stringify([{ id: 'c-1', element: element(), content: ' ' }])), [], '空白评论被丢弃')
  assert.deepEqual(store.parseComments(JSON.stringify([{ id: 'c-1' }])), [], '缺少元素信息的评论被丢弃')
  assert.equal(
    store.parseComments(JSON.stringify([stored[0], stored[0]])).length,
    1,
    '重复 id 只保留一条'
  )
  assert.deepEqual(store.parseComments(store.serializeComments(parsed)), parsed, '序列化后可原样读回')

  const many = []
  for (let index = 0; index < 250; index++) {
    many.push({ id: `c-${index}`, frameId: 'desktop', element: element(), content: `评论 ${index}`, createdAt: index })
  }
  const trimmed = store.parseComments(JSON.stringify(many))
  assert.equal(trimmed.length, 200, '读回时按上限截断')
  assert.equal(trimmed[0].id, 'c-50', '超出上限时丢弃最早的评论')
  assert.equal(trimmed[199].id, 'c-249', '保留最新的评论')

  const snapshot = store.snapshotElement(element({ outerHtml: `<p>${'x'.repeat(900)}</p>`, classes: ['a'] }))
  assert.equal(snapshot.outerHtml.length, store.COMMENT_HTML_CLIP, '保存时裁剪过长的 outerHTML')
  snapshot.rect.x = 999
  snapshot.classes.push('b')
  const source = element()
  const copy = store.snapshotElement(source)
  source.rect.x = 555
  source.classes.push('z')
  ok(copy.rect.x === 10 && copy.classes.length === 1, '快照与原对象不共享引用')
  ok(store.snapshotElement(element({ sourceOffset: 42 })).sourceOffset === 42, '源偏移随快照保存')
  ok(!('sourceOffset' in store.snapshotElement(element())), '没有源偏移时不写这个字段')

  assert.equal(store.commentNumber(parsed, 'c-2'), 2)
  assert.equal(store.commentNumber(parsed, 'nope'), 0, '找不到评论时编号为 0')
  assert.equal(store.elementSummary(element()), 'h2 · h2.title')
  assert.equal(store.elementSummary(element({ selector: '' })), 'h2 · 0.1', '没有选择器时用路径兜底')
  assert.equal(store.commentTextPreview('a'.repeat(200)).endsWith('…'), true, '摘要超长时省略')
  assert.equal(store.commentTextPreview('  多  行  '), '多 行', '摘要压平空白')

  const applied = store.applyResolutions(
    [
      { id: 'c-1', frameId: 'desktop', element: element(), content: '甲', createdAt: 1, sentAt: null, invalid: false },
      { id: 'c-2', frameId: 'desktop', element: element({ rect: { x: 5, y: 5, w: 5, h: 5 } }), content: '乙', createdAt: 2, sentAt: null, invalid: false },
      { id: 'c-3', frameId: 'desktop', element: element(), content: '丙', createdAt: 3, sentAt: null, invalid: true }
    ],
    [
      { id: 'c-1', state: 'missing' },
      { id: 'c-2', state: 'valid', rect: { x: 8, y: 9, w: 10, h: 11 } },
      { id: 'c-3', state: 'valid' }
    ]
  )
  ok(applied.changed, '有变化时报告 changed')
  ok(applied.comments[0].invalid === true, '查询不到的元素把钉标为已失效而不是删除')
  assert.deepEqual(applied.comments[1].element.rect, { x: 8, y: 9, w: 10, h: 11 }, '查询到元素时更新钉的位置')
  ok(applied.comments[2].invalid === false, '重新查询成功后恢复有效')
  const same = store.applyResolutions(applied.comments, [
    { id: 'c-1', state: 'missing' },
    { id: 'c-2', state: 'valid', rect: { x: 8, y: 9, w: 10, h: 11 } },
    { id: 'c-3', state: 'unknown' }
  ])
  ok(!same.changed, '没有变化时不触发重写')
  ok(store.applyResolutions(applied.comments, []).comments.length === 3, '没有校验结果时原样返回')

  const prompt = store.composeCommentPrompt({
    header: '请按下面的画布评论修改 index.html：',
    commentLabel: '评论：',
    entries: [
      { index: 1, reference: '文件：/repo/index.html\n选择器：h2.title', content: '标题太小' },
      { index: 3, reference: '文件：/repo/index.html\n选择器：.hero', content: '整体偏左' }
    ]
  })
  assert.equal(
    prompt,
    '请按下面的画布评论修改 index.html：\n\n[1] 文件：/repo/index.html\n选择器：h2.title\n评论：标题太小\n\n[3] 文件：/repo/index.html\n选择器：.hero\n评论：整体偏左',
    '发送到聊天的文案：开头一句 + 编号元素引用 + 评论内容'
  )

  const storage = {
    data: new Map(),
    getItem(key) {
      return this.data.has(key) ? this.data.get(key) : null
    },
    setItem(key, value) {
      this.data.set(key, String(value))
    }
  }
  const abs = '/repo/index.html'
  const client = store.createCommentStore({ storage, abs })
  const first = client.add({ frameId: 'desktop', element: element(), content: '第一条评论', createdAt: 1000 })
  ok(client.getSnapshot().comments.length === 1 && client.getSnapshot().activeId === first.id, '新增评论后成为当前评论')
  ok(storage.data.has(store.commentStorageKey(abs)), '新增后按绝对路径写入 localStorage')
  const second = client.add({ frameId: 'phone', element: element({ frameId: 'phone', selector: '.cta' }), content: '  第二条  ', createdAt: 2000 })
  assert.equal(second.content, '第二条', '保存时去掉首尾空白')
  assert.equal(store.commentNumber(client.getSnapshot().comments, second.id), 2, '编号按保存顺序递增')

  assert.deepEqual(client.getSnapshot().selected, [first.id, second.id], '新评论默认勾选')
  client.toggleSelected(first.id)
  assert.deepEqual(client.getSnapshot().selected, [second.id], '点击取消勾选')
  client.toggleSelected(first.id)
  assert.deepEqual(client.getSnapshot().selected, [second.id, first.id], '再次点击重新勾选')
  client.selectAll()
  assert.equal(client.getSnapshot().selected.length, 2, '全选勾上所有评论')
  client.selectNone()
  assert.deepEqual(client.getSnapshot().selected, [])

  client.update(first.id, '改过的评论')
  assert.equal(client.getSnapshot().comments[0].content, '改过的评论', '编辑生效')
  client.update(first.id, '   ')
  assert.equal(client.getSnapshot().comments[0].content, '改过的评论', '空内容不覆盖')

  client.markSent([first.id], 5000)
  assert.equal(client.getSnapshot().comments[0].sentAt, 5000, '发送成功后标记已发送')
  client.markSent([first.id], 9000)
  assert.equal(client.getSnapshot().comments[0].sentAt, 5000, '重复标记保留第一次发送时间')
  const reloaded = store.createCommentStore({ storage, abs })
  assert.equal(reloaded.getSnapshot().comments.length, 2, '刷新后从 localStorage 读回评论')
  assert.equal(reloaded.getSnapshot().comments[0].sentAt, 5000, '已发送状态持久化')

  client.clearSent()
  assert.deepEqual(
    client.getSnapshot().comments.map((comment) => comment.id),
    [second.id],
    '清空已发送只删已发送的评论'
  )
  client.resolve([{ id: second.id, state: 'missing' }])
  assert.equal(client.getSnapshot().comments[0].invalid, true, '失效状态进入快照')
  client.remove(second.id)
  assert.deepEqual(client.getSnapshot().comments, [], '删除评论')
  assert.equal(client.getSnapshot().activeId, null, '删除当前评论后清空 activeId')

  const limited = store.createCommentStore({ storage: { getItem: () => null, setItem: () => {} }, abs: '/repo/limit.html' })
  for (let index = 0; index < 205; index++) limited.add({ frameId: 'desktop', element: element(), content: `#${index}`, createdAt: index + 1 })
  assert.equal(limited.getSnapshot().comments.length, 200, '新增超过上限时保留 200 条')
  assert.equal(limited.getSnapshot().comments[199].content, '#204', '保留最新的一条')

  const broken = store.createCommentStore({
    storage: {
      getItem() {
        throw new Error('denied')
      },
      setItem() {
        throw new Error('denied')
      }
    },
    abs: '/repo/broken.html'
  })
  assert.deepEqual(broken.getSnapshot().comments, [], '读取抛错时安全回退')
  assert.doesNotThrow(() => broken.add({ frameId: 'desktop', element: element(), content: '还能用' }), '写入抛错时不影响内存状态')
  assert.equal(broken.getSnapshot().comments.length, 1)

  let notified = 0
  const unsubscribe = broken.subscribe(() => {
    notified++
  })
  broken.setStatus({ tone: 'error', text: 'no' })
  broken.setStatus({ tone: 'error', text: 'no' })
  assert.equal(notified, 1, '相同状态不重复通知订阅者')
  unsubscribe()
  broken.setActive('x')
  assert.equal(notified, 1, '取消订阅后不再通知')

  const today = new Date()
  today.setHours(9, 5, 0, 0)
  assert.equal(store.formatCommentTime(today.getTime(), 'zh-CN'), '09:05', '当天只显示时间')
  const old = new Date(2024, 0, 2, 3, 4, 0, 0)
  assert.equal(store.formatCommentTime(old.getTime(), 'zh-CN'), '1月2日 03:04', '跨天显示日期')
  assert.equal(store.formatCommentTime(old.getTime(), 'en-US'), '1/2 03:04', '英文日期格式')
  assert.equal(store.formatCommentTime(Number.NaN, 'zh-CN'), '', '非法时间返回空字符串')

  const zh = text.canvasCommentText('zh-CN')
  const en = text.canvasCommentText('en-US')
  assert.equal(zh.tool, '评论')
  assert.equal(en.tool, 'Comments')
  assert.equal(zh.promptHeader('a.html').includes('a.html'), true, '中文提示带文件名')
  assert.equal(typeof zh.selectRow(1, 'h2'), 'string')
  assert.equal(typeof en.countLabel(2, 1), 'string')
  assert.equal(text.CANVAS_COMMENT_TEXT['zh-CN'].save, zh.save, '文案表按语言查表')
  ok(
    Object.keys(zh).every((key) => key in en),
    '中英文案键一致'
  )
  ok(
    Object.values(zh).every((value) => (typeof value === 'function' ? value.length >= 0 : typeof value === 'string' && value.length > 0)),
    '中文文案没有空字符串'
  )
  ok(
    Object.values(en).every((value) => (typeof value === 'function' ? value.length >= 0 : typeof value === 'string' && value.length > 0)),
    '英文文案没有空字符串'
  )
} finally {
  await rm(outdir, { recursive: true, force: true })
}

console.log(`\ntest-canvas-comments: ${checks} checks passed`)
