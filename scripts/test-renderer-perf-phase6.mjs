import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const key = Symbol.for('inkstone.test.phase6.store')
  let reads = []
  let subscriptions = 0
  const state = new Proxy({ session: null, settings: null, titles: { a: '自动标题' }, manualTitles: { a: '手动标题' } }, {
    get(target, property) {
      reads.push(property)
      return Reflect.get(target, property)
    }
  })
  globalThis[key] = { select: (selector) => { subscriptions++; return selector(state) }, getState: () => state }
  try {
    const { CommandPalette, SessionSwitcher, ShortcutSheet, usePaletteFileOwner, I18nProvider } = await compile('', {
      jsx: 'automatic', loader: { '.css': 'empty' }, packages: 'external',
      stdin: {
        resolveDir: process.cwd(),
        contents: `
          export { CommandPalette } from './src/renderer/src/features/commands/CommandPalette'
          export { SessionSwitcher } from './src/renderer/src/features/commands/SessionSwitcher'
          export { ShortcutSheet } from './src/renderer/src/features/commands/ShortcutSheet'
          export { usePaletteFileOwner } from './src/renderer/src/features/commands/use-palette-file-search'
          export { I18nProvider } from './src/renderer/src/i18n'
        `
      },
      plugins: [{
        name: 'phase6-store',
        setup(build) {
          build.onResolve({ filter: /\/state\/store$/ }, () => ({ path: 'store', namespace: 'phase6' }))
          build.onResolve({ filter: /^\.\/store$/ }, ({ importer }) => /[/\\]state[/\\][^/\\]+$/.test(importer) ? { path: 'store', namespace: 'phase6' } : null)
          build.onLoad({ filter: /.*/, namespace: 'phase6' }, () => ({ contents: `
            const stub = globalThis[Symbol.for('inkstone.test.phase6.store')]
            export const useStore = Object.assign(stub.select, { getState: stub.getState, subscribe: () => () => {} })
          ` }))
        }
      }]
    })
    const dismiss = () => {}
    const render = (component, props) => renderToStaticMarkup(createElement(I18nProvider, null, createElement(component, props)))
    assert.equal(render(CommandPalette, { isOpen: false, onOpenChange: dismiss }), '')
    assert.equal(render(ShortcutSheet, { isOpen: false, onOpenChange: dismiss }), '')
    assert.equal(render(SessionSwitcher, { control: { state: null, pick: dismiss } }), '')
    assert.deepEqual(reads, [])
    assert.equal(subscriptions, 0)
    ok(true, '关闭的命令面板、快捷键表与会话切换器不订阅或读取主 Store')

    render(CommandPalette, { isOpen: true, onOpenChange: dismiss })
    assert.ok(subscriptions > 0)
    assert.deepEqual([...new Set(reads)], ['settings', 'session'])
    ok(true, '打开空查询只读取主题和停止指令所需状态，不读取会话列表、标题、消息或运行实例')

    reads = []
    const markup = render(SessionSwitcher, { control: {
      state: { items: [{ id: 'a', path: 'a', title: '原始标题', updatedAt: Date.now() }], index: 0, keys: [] }, pick: dismiss
    } })
    assert.match(markup, /手动标题/)
    assert.deepEqual([...new Set(reads)], ['titles', 'manualTitles', 'peekedPath', 'session'])
    ok(true, '打开切换器仍实时读取标题，且手动标题优先')

    function Probe() { assert.equal(usePaletteFileOwner('message'), null); return null }
    reads = []
    renderToStaticMarkup(createElement(Probe))
    assert.deepEqual(reads, [])
    ok(true, '消息模式跳过文件归属输入，不读取运行实例或会话列表')
  } finally {
    delete globalThis[key]
  }

  const { matchSettings } = await compile('src/renderer/src/features/settings/search/search-model.ts')
  let labelReads = 0
  let sectionReads = 0
  const fixture = (id, en, zh, keywords) => ({
    id, section: 'appearance', get en() { labelReads++; return en }, zh, keywords
  })
  const entries = [
    fixture('keyword-a', 'First', '第一', ['Pro File']),
    fixture('alternate', 'Other', 'Profile 备用'),
    fixture('section', 'Unrelated', '分区'),
    fixture('prefix', 'Profile Name', '名称'),
    fixture('keyword-b', 'Second', '第二', ['PROFILE']),
    fixture('substring', 'User Profile', '用户')
  ]
  const sectionLabel = () => { sectionReads++; return 'Profile Settings' }
  const ids = (items) => items.map(({ id }) => id)
  assert.deepEqual(matchSettings(entries, '  ', 'en-US', sectionLabel), [])
  assert.equal(labelReads, 0)
  assert.equal(sectionReads, 0)
  const first = matchSettings(entries, '  PRO file  ', 'en-US', sectionLabel)
  assert.deepEqual(ids(first), ['prefix', 'substring', 'keyword-a', 'keyword-b', 'alternate', 'section'])
  assert.equal(sectionReads, 1)
  assert.equal(labelReads, entries.length)
  assert.strictEqual(first[0], entries[3])
  assert.deepEqual(ids(matchSettings(entries, 'profile', 'en-US', sectionLabel, 3)), ['prefix', 'substring', 'keyword-a'])
  assert.deepEqual(ids(matchSettings(entries, 'profile', 'zh-CN', sectionLabel)), ['alternate', 'keyword-a', 'keyword-b', 'prefix', 'substring', 'section'])
  assert.deepEqual(ids(matchSettings(entries.slice(1), 'profile', 'en-US', () => 'Appearance')), ['prefix', 'substring', 'keyword-b', 'alternate'])
  assert.equal(labelReads, entries.length)
  ok(true, '设置搜索空查询不建索引，多次输入复用预处理；保持双语得分、并列顺序、条数及动态条目过滤')
})
