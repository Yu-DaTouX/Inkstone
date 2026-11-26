import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { diffObservations, filterElements, textMatches, elementLine, ITEM_LIMIT } = await compile('src/main/browser/observation-format.ts')
  const el = (ref, role, name, extra = {}) => ({ ref, role, name, box: [0, 0, 10, 10], ...extra })
  const page = (elements, extra = {}) => ({ url: 'https://example.com/', title: 'Example', text: 'Hello\nWorld', elements, ...extra })

  ok(elementLine(el('e3', 'textbox', 'Name', { value: 'Ann', disabled: true })) === 'e3 textbox "Name" ="Ann" disabled', '元素行：短 ref、角色、名称、值与禁用')
  ok(elementLine(el('e4', 'link', 'x'.repeat(90))).length < 80, '元素行：长名称截断')
  ok(ITEM_LIMIT === 80, '默认清单上限仍是 80 行')
  ok(elementLine(el('e5', 'link', 'checks', { href: '/o/r/actions/runs/1/job/2' })) === 'e5 link "checks" → /o/r/actions/runs/1/job/2', '元素行：链接带地址')
  ok(filterElements([el('e6', 'link', 'checks', { href: '/a/job/9' }), el('e7', 'link', 'checks', { href: '/a/workflow' })], { find: '/job/' }).map((e) => e.ref).join() === 'e6', '--find 也匹配链接地址')

  const list = [el('e1', 'button', 'Save'), el('e2', 'link', 'Help', { offscreen: true }), el('e3', 'textbox', 'Search', { value: 'alpha' })]
  ok(filterElements(list, {}).map((e) => e.ref).join() === 'e1,e3', '默认只列视口内元素')
  ok(filterElements(list, { all: true }).length === 3, '--all 含视口外')
  ok(filterElements(list, { find: 'help' }).map((e) => e.ref).join() === 'e2', '--find 按名称找，含视口外、不分大小写')
  ok(filterElements(list, { find: 'ALPHA' }).map((e) => e.ref).join() === 'e3', '--find 也匹配当前值')
  ok(filterElements(list, { role: 'button' }).map((e) => e.ref).join() === 'e1', '--role 按角色过滤')
  ok(filterElements(list, { scopeRefs: ['e2'] }).map((e) => e.ref).join() === 'e2', '--in 只列范围内元素（含视口外）')

  const hits = textMatches('abc Alpha def alpha', 'alpha', 5, 3)
  ok(hits.length === 2 && hits[0].offset === 4 && hits[1].offset === 14, '正文查找返回全部位置')
  ok(textMatches('abc', '  ', 5).length === 0, '空查找词不返回结果')

  const before = page([el('e1', 'button', 'Save'), el('e3', 'textbox', 'Search', { value: '' }), el('e5', 'link', 'Gone')])
  const after = page([el('e1', 'button', 'Save'), el('e3', 'textbox', 'Search', { value: 'alpha' }), el('e9', 'button', 'Undo')], { text: 'Hello\nWorld\nSaved 1 item' })
  const changes = diffObservations(before, after)
  ok(changes.includes('+ e9 button "Undo"'), '变化摘要列出新增元素', changes.join(' | '))
  ok(changes.includes('- e5 link "Gone"'), '变化摘要列出消失元素')
  ok(changes.includes('~ e3 textbox "Search" ="alpha"'), '变化摘要列出值变化')
  ok(changes.includes('+ 文本 "Saved 1 item"'), '变化摘要列出新出现的文字')
  ok(!changes.some((line) => line.startsWith('url')), '地址没变时不报地址')
  ok(diffObservations(before, before).length === 0, '没有变化时为空')

  const navigated = page([el('e20', 'link', 'Next')], { url: 'https://example.com/b', title: 'B' })
  const nav = diffObservations(before, navigated)
  ok(nav[0] === 'url → https://example.com/b' && nav[1] === 'title → "B"', '换页报新地址与标题')
  ok(nav.some((line) => line.startsWith('文档已更换')) && nav.includes('+ e20 link "Next"') && !nav.some((line) => line.startsWith('- ')), '换文档时列新页面元素，不逐个列旧元素')

  const many = page(Array.from({ length: 40 }, (_, i) => el(`e${i + 100}`, 'button', `B${i}`)))
  const capped = diffObservations(page([el('e1', 'button', 'x')]), many)
  ok(capped.length <= 16 && /另有/.test(capped.at(-1)), '变化摘要有上限并说明剩余数量', String(capped.length))

  const offscreenOnly = diffObservations(page([el('e1', 'button', 'x'), el('e2', 'button', 'far', { offscreen: true })]), page([el('e1', 'button', 'x')]))
  ok(offscreenOnly.length === 0, '视口外元素因数量上限没测到时不当作消失')
})
