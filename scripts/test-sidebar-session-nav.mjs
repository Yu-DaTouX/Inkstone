import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const file = (relative) => fileURLToPath(new URL(`../src/renderer/src/${relative}`, import.meta.url)).replace(/\\/g, '/')

async function load(relative) {
  const bundled = await build({
    stdin: { contents: `export * from ${JSON.stringify(file(relative))}\n`, resolveDir: root, loader: 'ts' },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm'
  })
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
}

const nav = await load('features/sidebar/session-nav.ts')
const undo = await load('features/sidebar/session-undo.ts')
const keys = await load('app/shortcuts.ts')

const view = { top: 0, bottom: 300 }
const row = (path, top, height = 30, viewport = view) => ({ path, top, bottom: top + height, viewport })

{
  const rows = Array.from({ length: 12 }, (_, i) => row(`p${i}`, i * 30))
  assert.deepEqual(nav.visibleJumpPaths(rows), ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'], '只取前 9 个可见行')
  const scrolled = Array.from({ length: 12 }, (_, i) => row(`p${i}`, i * 30 - 100))
  assert.deepEqual(nav.visibleJumpPaths(scrolled).slice(0, 2), ['p3', 'p4'], '滚出视口超过一半的行不编号')
  assert.deepEqual(nav.visibleJumpPaths([row('a', 0), row('a', 30), row('b', 60, 0)]), ['a'], '重复路径与零高度行跳过')
  const shelf = { top: 400, bottom: 500 }
  assert.deepEqual(nav.visibleJumpPaths([row('a', 0), row('s', 420, 30, shelf)]), ['a', 's'], '每行按自己的滚动容器判断可见')
  const map = nav.jumpIndexMap(['x', 'y', 'z'])
  assert.equal(map.get('x'), 1)
  assert.equal(map.get('z'), 3)
  assert.equal(map.get('w'), undefined)
}

{
  const ev = (key, extra = {}) => ({ key, ctrl: true, meta: false, alt: false, shift: false, mac: false, ...extra })
  assert.equal(keys.resolveSessionJump(ev('1')), 0, 'Ctrl+1 打开第一个')
  assert.equal(keys.resolveSessionJump(ev('9')), 8, 'Ctrl+9 打开第九个')
  assert.equal(keys.resolveSessionJump(ev('0')), null, 'Ctrl+0 留给缩放')
  assert.equal(keys.resolveSessionJump(ev('1', { shift: true })), null)
  assert.equal(keys.resolveSessionJump(ev('1', { alt: true })), null)
  assert.equal(keys.resolveSessionJump(ev('1', { ctrl: false })), null, '没有修饰键不跳')
  assert.equal(keys.resolveSessionJump(ev('1', { inTerminal: true })), null, '终端里让出')
  assert.equal(keys.resolveSessionJump(ev('1', { modalOpen: true })), null, '模态打开时不跳')
  assert.equal(keys.resolveSessionJump(ev('1', { composing: true })), null)
  assert.equal(keys.resolveSessionJump(ev('1', { repeat: true })), null)
  assert.equal(keys.resolveSessionJump(ev('2', { mac: true, ctrl: false, meta: true })), 1, 'mac 用 Cmd')
  assert.equal(keys.resolveSessionJump(ev('2', { mac: true })), null, 'mac 上 Ctrl 不算')
  assert.equal(keys.isSessionJumpModifier('Control', false), true)
  assert.equal(keys.isSessionJumpModifier('Meta', true), true)
  assert.equal(keys.isSessionJumpModifier('Control', true), false)
  assert.deepEqual(keys.sessionJumpConflicts(), [], '默认快捷键不占用 Ctrl+1..9')
  const overrides = { newSession: ['Ctrl', '3'] }
  assert.deepEqual(keys.sessionJumpConflicts(overrides), ['newSession'], '改键占用 Ctrl+数字时报出冲突')
  assert.equal(keys.resolveSessionJump(ev('3'), overrides), null, '被改键占用的数字让给改键')
  assert.equal(keys.resolveSessionJump(ev('4'), overrides), 3, '其他数字照常')
  assert.equal(keys.resolveV3Shortcut({ key: '3', ctrl: true, meta: false, alt: false, shift: false }, overrides), 'newSession')
  assert.equal(keys.resolveV3Shortcut({ key: '1', ctrl: true, meta: false, alt: false, shift: false }), null, '全局表不处理 Ctrl+1')
}

{
  assert.equal(nav.nextSessionAfter(['a', 'b', 'c'], 'b'), 'c', '归档后前进到下一个')
  assert.equal(nav.nextSessionAfter(['a', 'b', 'c'], 'c'), 'b', '末尾时退到上一个')
  assert.equal(nav.nextSessionAfter(['a'], 'a'), null, '没有其他会话回首页')
  assert.equal(nav.nextSessionAfter(['C:\\s\\a.jsonl', 'C:\\s\\b.jsonl'], 'c:/s/a.jsonl'), 'C:\\s\\b.jsonl', '路径大小写与分隔符不敏感')
  assert.equal(nav.nextSessionAfter(['a', 'b'], 'x'), 'a', '列表里找不到时取第一个')
}

{
  const node = (attrs, parent = null, matches = () => false) => ({
    attrs,
    parent,
    getAttribute: (name) => attrs[name] ?? null,
    closest(selector) {
      let current = this
      while (current) {
        if (matches.call(current, selector)) return current
        current = current.parent
      }
      return null
    }
  })
  const isRow = function (selector) { return selector === nav.SESSION_FILE_DROP_ROW && 'data-session-path' in this.attrs }
  const rowNode = node({ 'data-session-path': 'C:/s/a.jsonl' }, null, isRow)
  const title = node({}, rowNode, isRow)
  const inner = node({}, title, isRow)
  assert.equal(nav.fileDropRowPath(inner), 'C:/s/a.jsonl', '从行内任意子元素解析到会话路径')
  assert.equal(nav.fileDropRowPath(node({}, null, isRow)), null, '行外不是目标')
  assert.equal(nav.fileDropRowPath(null), null)
  assert.equal(nav.fileDropRowPath(node({ 'data-session-path': '' }, null, isRow)), null, '空路径不是目标')
}

{
  assert.equal(undo.createUndoTicket(undefined, 'a', 'A'), null, '没有令牌就不给撤销')
  assert.equal(undo.createUndoTicket('  ', 'a', 'A'), null)
  const ticket = undo.createUndoTicket('t1|t2', 'a', 'A')
  assert.equal(undo.canUndo(ticket), true)
  assert.equal(undo.claimUndo(ticket), 't1|t2', '首次点击拿到完整令牌')
  assert.equal(undo.claimUndo(ticket), null, '进行中不重复撤销')
  undo.releaseUndo(ticket, false)
  assert.equal(undo.canUndo(ticket), true, '恢复失败后可重试')
  assert.equal(undo.claimUndo(ticket), 't1|t2')
  undo.releaseUndo(ticket, true)
  assert.equal(undo.canUndo(ticket), false, '恢复成功后令牌作废')
  assert.equal(undo.claimUndo(ticket), null)
  const late = undo.createUndoTicket('t3', 'b', 'B')
  undo.expireUndo(late)
  assert.equal(undo.canUndo(late), false, '提示关闭后令牌过期')
  assert.equal(undo.claimUndo(late), null, '过期后不能撤销')
  const busy = undo.createUndoTicket('t4', 'c', 'C')
  undo.claimUndo(busy)
  undo.expireUndo(busy)
  undo.releaseUndo(busy, false)
  assert.equal(undo.canUndo(busy), true, '撤销进行中提示关闭不影响失败重试')
  assert.ok(undo.SESSION_UNDO_WINDOW_MS >= 5000)
}

console.log('sidebar session nav ok')
