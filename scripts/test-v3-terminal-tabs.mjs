import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const base = new URL('../src/renderer/src/features/terminal/', import.meta.url)

async function load(name) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(name, base))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const tabs = await load('terminal-tabs.ts')
const find = await load('terminal-find.ts')
const view = await load('terminal-view.ts')

assert.equal(tabs.MAX_TERMINAL_TABS, 12)
assert.equal(tabs.canAddTerminalTab(11), true)
assert.equal(tabs.canAddTerminalTab(12), false)

assert.deepEqual(tabs.terminalTabLabel('pwsh · proj', 0, 2), { kind: 'title', text: 'pwsh · proj', number: 1 })
assert.deepEqual(tabs.terminalTabLabel('  ', 1, 3), { kind: 'numbered', text: '', number: 2 })
assert.deepEqual(tabs.terminalTabLabel('', 0, 1), { kind: 'single', text: '', number: 1 })

assert.equal(tabs.nextTerminalTabIndex(0, 3, 'ArrowRight'), 1)
assert.equal(tabs.nextTerminalTabIndex(2, 3, 'ArrowRight'), 0)
assert.equal(tabs.nextTerminalTabIndex(0, 3, 'ArrowLeft'), 2)
assert.equal(tabs.nextTerminalTabIndex(2, 3, 'Home'), 0)
assert.equal(tabs.nextTerminalTabIndex(0, 3, 'End'), 2)
assert.equal(tabs.nextTerminalTabIndex(0, 3, 'Enter'), null)
assert.equal(tabs.nextTerminalTabIndex(-1, 3, 'ArrowRight'), null)

assert.equal(tabs.pickActiveAfterClose(['a', 'b', 'c'], 'b', 'b'), 'c')
assert.equal(tabs.pickActiveAfterClose(['a', 'b', 'c'], 'c', 'c'), 'b')
assert.equal(tabs.pickActiveAfterClose(['a', 'b'], 'a', 'b'), 'b')
assert.equal(tabs.pickActiveAfterClose(['a'], 'a', 'a'), null)
assert.equal(tabs.pickActiveAfterClose(['a', 'b'], 'a', 'b'), 'b')
assert.deepEqual(tabs.othersThan([{ key: 'a' }, { key: 'b' }], 'a'), [{ key: 'b' }])

assert.equal(tabs.isTerminalTabCloseKey({ key: 'Delete' }), true)
assert.equal(tabs.isTerminalTabCloseKey({ key: 'Backspace' }), true)
assert.equal(tabs.isTerminalTabCloseKey({ key: 'Delete', ctrlKey: true }), false)
assert.equal(tabs.isTerminalTabCloseKey({ key: 'd' }), false)

const lines = ['$ npm run build', 'Build OK', 'build again: build', '', 'error: BUILD failed']
const matches = find.findTerminalMatches(lines, 'build')
assert.deepEqual(
  matches.map((match) => [match.line, match.column, match.length]),
  [
    [0, 10, 5],
    [1, 0, 5],
    [2, 0, 5],
    [2, 13, 5],
    [4, 7, 5]
  ]
)
assert.deepEqual(find.findTerminalMatches(lines, ''), [])
assert.deepEqual(find.findTerminalMatches(['aaa'], 'aa').map((match) => match.column), [0])

assert.equal(find.lastTerminalMatchIndex(matches), 4)
assert.equal(find.stepTerminalMatchIndex(matches, null, 'next'), 0)
assert.equal(find.stepTerminalMatchIndex(matches, null, 'previous'), 4)
assert.equal(find.stepTerminalMatchIndex(matches, matches[0], 'next'), 1)
assert.equal(find.stepTerminalMatchIndex(matches, matches[0], 'previous'), 4)
assert.equal(find.stepTerminalMatchIndex(matches, matches[4], 'next'), 0)
assert.equal(find.stepTerminalMatchIndex(matches, { line: 1, column: 2, length: 5 }, 'next'), 2)
assert.equal(find.stepTerminalMatchIndex(matches, { line: 1, column: 2, length: 5 }, 'previous'), 1)
assert.equal(find.stepTerminalMatchIndex([], null, 'next'), -1)

assert.equal(find.terminalFindKeyAction({ key: 'f', code: 'KeyF', ctrlKey: true }), 'focus')
assert.equal(find.terminalFindKeyAction({ key: 'f', code: 'KeyF', metaKey: true }), 'focus')
assert.equal(find.terminalFindKeyAction({ key: 'Escape' }), 'close')
assert.equal(find.terminalFindKeyAction({ key: 'Enter' }), 'previous')
assert.equal(find.terminalFindKeyAction({ key: 'Enter', shiftKey: true }), 'next')
assert.equal(find.terminalFindKeyAction({ key: 'g', code: 'KeyG', ctrlKey: true }), 'next')
assert.equal(find.terminalFindKeyAction({ key: 'g', code: 'KeyG', ctrlKey: true, shiftKey: true }), 'previous')
assert.equal(find.terminalFindKeyAction({ key: 'Enter', isComposing: true }), null)
assert.equal(find.terminalFindKeyAction({ key: 'a', code: 'KeyA' }), null)

assert.deepEqual(view.normalizeTerminalView(null), view.DEFAULT_TERMINAL_VIEW)
assert.deepEqual(view.normalizeTerminalView({}), view.DEFAULT_TERMINAL_VIEW)
assert.deepEqual(view.normalizeTerminalView({ fontSize: 20, lineHeight: 2, cursorStyle: 'nope', scrollback: 500 }), view.DEFAULT_TERMINAL_VIEW)
const custom = view.normalizeTerminalView({ fontSize: 13, lineHeight: 1.15, cursorStyle: 'bar', cursorBlink: false, scrollback: 5000 })
assert.deepEqual(custom, { fontSize: 13, lineHeight: 1.15, cursorStyle: 'bar', cursorBlink: false, scrollback: 5000 })
assert.equal(view.normalizeTerminalView({ cursorBlink: 'no' }).cursorBlink, true)

const options = view.terminalXtermOptions(view.DEFAULT_TERMINAL_VIEW)
assert.equal(options.fontSize, 12)
assert.equal(options.lineHeight, 1)
assert.equal(options.cursorStyle, 'block')
assert.equal(options.cursorBlink, true)
assert.equal(options.scrollback, 10000)
assert.equal(options.minimumContrastRatio, 3)

const saved = new Map()
const storage = {
  getItem: (key) => (saved.has(key) ? saved.get(key) : null),
  setItem: (key, value) => saved.set(key, value)
}
const store = view.createTerminalViewStore(storage, () => () => {})
assert.deepEqual(store.get(), view.DEFAULT_TERMINAL_VIEW)
let notified = 0
const off = store.subscribe(() => {
  notified += 1
})
store.update({ fontSize: 14 })
assert.equal(notified, 1)
assert.equal(store.get().fontSize, 14)
assert.deepEqual(JSON.parse(saved.get(view.TERMINAL_VIEW_STORAGE_KEY)), { ...view.DEFAULT_TERMINAL_VIEW, fontSize: 14 })
store.update({ fontSize: 14 })
assert.equal(notified, 1)
store.update({ cursorBlink: false })
assert.equal(store.get().cursorBlink, false)
assert.equal(notified, 2)
off()
store.update({ scrollback: 1000 })
assert.equal(notified, 2)
const reopened = view.createTerminalViewStore(storage)
assert.equal(reopened.get().fontSize, 14)
assert.equal(reopened.get().scrollback, 1000)

const broken = view.createTerminalViewStore({ getItem: () => 'not json', setItem: () => {} })
assert.deepEqual(broken.get(), view.DEFAULT_TERMINAL_VIEW)

console.log('test-v3-terminal-tabs: ok')
