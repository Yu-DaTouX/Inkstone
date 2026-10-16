import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const appText = fs.readFileSync('src/renderer/src/App.tsx', 'utf8')
const outlineText = fs.readFileSync('src/renderer/src/components/chat/ConversationOutline.tsx', 'utf8')
const app = ts.createSourceFile('App.tsx', appText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const body = app.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'App').body
const declaration = name => body.statements.find(s => ts.isVariableStatement(s) && s.declarationList.declarations.some(d => d.name.getText(app) === name)).getText(app)
const effect = marker => body.statements.find(s => ts.isExpressionStatement(s) && s.getText(app).includes(marker)).getText(app)
const blocks = {
  tail: effect('if (!stickRef.current'),
  settle: effect('const wasStick = stickRef.current'),
  restore: effect('const snap = shownScroll(displayedSession)'),
  navigate: effect('registerScrollToTurn((turnIndex'),
}
const callbacks = ['setStickNow', 'onScroll', 'onVirtualScroll', 'jumpToBottom'].map(declaration).join('\n')

function fixture({ virtual = true, sourceBlocks = blocks } = {}) {
  let queued = []
  let nextId = 0
  const calls = []
  const handle = {
    scrollSize: 42000, scrollOffset: 41175, viewportSize: 825,
    scrollToIndex(index, options) { calls.push([index, options.align]); this.scrollOffset = options.align === 'end' ? 41175 : index * 1000 },
    scrollTo(top) { this.scrollOffset = top },
  }
  const target = { getBoundingClientRect: () => ({ top: 24 - box.scrollTop }) }
  const box = {
    scrollTop: 41175, scrollHeight: 42000, clientHeight: 825,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelector: () => target,
  }
  const ref = current => ({ current })
  const ctx = {
    virtual, calls, turns: [{ kind: 'user', id: 'u0' }, { kind: 'assistant', id: 'a0' }, { kind: 'user', id: 'u1' }],
    renderTurns: [0, 1, 2], stick: true, split: null, vlistKey: 0, scrollIdentity: 'one', sessionIdentity: 'one', splitOn: false,
    stickRef: ref(true), suppressStickScrollRef: ref(false), scrollIntentRef: ref(0),
    vlistSettlingRef: ref(false), vlistRemounts: ref(0), lastTurnIndexRef: ref(2), turnsRef: ref([]),
    vlistRef: ref(handle), streamRef: ref(box), centerRef: ref({ querySelector: () => box }),
    displayedSession: { sessionId: 'one' },
    setStick(value) { ctx.stick = value }, noteScroll() {}, shownScroll: () => null,
    restoreScrollAnchor: () => false, listLooksBlank: () => false, setVlistKey() {},
    registerScrollToTurn(fn) { ctx.navigate = fn },
    requestAnimationFrame(fn) { const id = ++nextId; queued.push([id, fn]); return id },
    cancelAnimationFrame(id) { queued = queued.filter(([key]) => key !== id) },
    useEffect(fn) { ctx.lastEffect = fn }, useLayoutEffect(fn) { ctx.lastEffect = fn },
  }
  vm.createContext(ctx)
  const run = text => vm.runInContext(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, ctx)
  run(callbacks + '\n globalThis.api = { onScroll, onVirtualScroll, jumpToBottom };')
  const effects = {}
  for (const [name, text] of Object.entries(sourceBlocks)) { run(text); effects[name] = ctx.lastEffect }
  effects.navigate()
  return {
    ctx, handle, box, effects, calls,
    frame() { const now = queued; queued = []; for (const [, fn] of now) fn() },
    drain() { for (let i = 0; i < 30 && queued.length; i++) this.frame(); assert.equal(queued.length, 0) },
  }
}

function navigationDuringSettle(sourceBlocks = blocks) {
  const f = fixture({ sourceBlocks })
  f.effects.settle()
  f.ctx.navigate(0)
  f.drain()
  assert.equal(f.handle.scrollOffset, 0, 'stale wasStick must not pull navigation to the tail')
  assert.equal(f.ctx.stickRef.current, false)
  f.effects.tail()
  assert.equal(f.handle.scrollOffset, 0, 'a streaming update must preserve reading position')
}
navigationDuringSettle()
console.log('PASS navigation cancels stale settling tail frames and streaming follow')

{
  const f = fixture()
  f.ctx.navigate(0)
  f.handle.scrollOffset = 41175
  f.ctx.api.onVirtualScroll()
  assert.equal(f.ctx.stickRef.current, false, 'virtual callback must honor navigation suppression')
  f.effects.tail()
  assert.equal(f.calls.filter(([, align]) => align === 'end').length, 0)
  f.drain()
}
console.log('PASS delayed virtual bottom event cannot re-enable follow')

{
  const f = fixture()
  f.effects.settle()
  f.frame()
  f.handle.scrollOffset = 0
  f.ctx.api.onVirtualScroll()
  f.drain()
  assert.equal(f.handle.scrollOffset, 0, 'manual top stays at top during remaining settling frames')
  assert.equal(f.ctx.stickRef.current, false)
}
console.log('PASS manual top cancels remaining mount frames')

for (const virtual of [true, false]) {
  const f = fixture({ virtual })
  f.effects.restore()
  f.ctx.navigate(0)
  f.drain()
  assert.equal(virtual ? f.handle.scrollOffset : f.box.scrollTop, virtual ? 0 : 24)
  assert.equal(f.ctx.stickRef.current, false)
}
console.log('PASS pending snapshot restore cannot override virtual or ordinary navigation')

{
  const f = fixture()
  f.effects.restore()
  f.effects.settle()
  f.drain()
  assert.equal(f.handle.scrollOffset, 41175)
  f.handle.scrollOffset = 41000
  f.effects.tail()
  assert.equal(f.handle.scrollOffset, 41175, 'streaming while following still reaches latest')
  f.ctx.navigate(0)
  f.drain()
  f.ctx.api.jumpToBottom()
  assert.equal(f.handle.scrollOffset, 41175)
  assert.equal(f.ctx.stickRef.current, true)
}
for (const virtual of [true, false]) {
  const f = fixture({ virtual })
  f.ctx.shownScroll = () => ({ atBottom: false, top: 1200 })
  f.effects.restore()
  if (virtual) f.effects.settle()
  f.drain()
  assert.equal(virtual ? f.handle.scrollOffset : f.box.scrollTop, 1200, 'reading snapshot still restores')
  f.effects.tail()
  assert.equal(virtual ? f.handle.scrollOffset : f.box.scrollTop, 1200, 'stream update does not steal restored reading position')
}
{
  const f = fixture({ virtual: false })
  f.box.scrollTop = 40000
  f.effects.tail()
  assert.equal(f.box.scrollTop, 42000, 'ordinary streaming still follows bottom')
  f.box.scrollTop = 0
  f.ctx.api.onScroll()
  f.effects.tail()
  assert.equal(f.box.scrollTop, 0, 'ordinary manual top keeps its reading position')
}
console.log('PASS initial settle, snapshots, both streaming paths and explicit jump-bottom retained')

const oldSettle = blocks.settle.replace(
  'if (wasStick && intent === scrollIntentRef.current && stickRef.current && !suppressStickScrollRef.current)',
  'if (wasStick)'
)
assert.throws(() => navigationDuringSettle({ ...blocks, settle: oldSettle }), /stale wasStick/)
console.log('PASS negative control: old wasStick policy reproduces navigation theft')

const outline = ts.createSourceFile('ConversationOutline.tsx', outlineText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const outlineBody = outline.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'ConversationOutline').body
const geometry = outlineBody.statements.find(s => ts.isVariableStatement(s) && s.declarationList.declarations.some(d => d.name.getText(outline) === 'activeFromGeometry')).getText(outline)
const rows = [{ dataset: { turnId: 'u0' }, getBoundingClientRect: () => ({ top: -900 }) }, { dataset: { turnId: 'u1' }, getBoundingClientRect: () => ({ top: -4 }) }]
const box = { scrollTop: 0, scrollHeight: 42000, clientHeight: 825, getBoundingClientRect: () => ({ top: 0 }), querySelectorAll: () => rows }
const scope = { querySelector: () => box, querySelectorAll: () => { throw Error('must not inspect other panes') } }
const ctx = { root: { current: { offsetParent: scope } }, turns: [0, 1, 2], turnIndexRef: { current: new Map([['u0', 0], ['u1', 1]]) } }
vm.createContext(ctx)
vm.runInContext(ts.transpileModule(geometry + '\nglobalThis.geometry = activeFromGeometry;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx)
assert.equal(ctx.geometry(), 0, 'top highlights first tick')
box.scrollTop = 1000
assert.equal(ctx.geometry(), 1, 'uneven heights use actual turn identity')
box.scrollTop = 41175
assert.equal(ctx.geometry(), 2, 'tail highlights last tick')
console.log('PASS outline top, uneven turn geometry and bottom boundaries')

const listener = outlineBody.statements.find(s => ts.isExpressionStatement(s) && s.getText(outline).includes("document.addEventListener('scroll'")).getText(outline)
class Stream { constructor() { this.classList = { contains: value => value === 'stream' } } }
const ownStream = new Stream()
let scheduled = 0
let onScroll
const listenCtx = {
  HTMLElement: Stream, root: { current: { offsetParent: { querySelector: () => ownStream } } },
  turns: [], useEffect: fn => fn(), requestAnimationFrame: () => ++scheduled,
  document: { addEventListener: (_, fn) => { onScroll = fn } },
}
vm.createContext(listenCtx)
vm.runInContext(ts.transpileModule(listener, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, listenCtx)
onScroll({ target: new Stream() })
assert.equal(scheduled, 0, 'other split pane cannot reset this outline highlight')
onScroll({ target: ownStream })
assert.equal(scheduled, 1, 'own stream still schedules geometry update')
console.log('PASS outline listener ignores foreign pane scroll')

const probeText = fs.readFileSync('scripts/probe/outline.js', 'utf8')
const probe = ts.createSourceFile('outline.js', probeText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
let after0
function findProbe(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'after0') after0 = node.getText(probe)
  ts.forEachChild(node, findProbe)
}
findProbe(probe)
const probeCtx = { ul: [{ id: 'u0' }] }
vm.createContext(probeCtx)
vm.runInContext(after0 + '\nglobalThis.checkTarget = after0;', probeCtx)
assert.equal(probeCtx.checkTarget({ querySelectorAll: () => [] }), false)
assert.equal(probeCtx.checkTarget({ querySelectorAll: () => [{ dataset: { turnId: 'wrong' } }] }), false)
assert.equal(probeCtx.checkTarget({ querySelectorAll: () => [{ dataset: { turnId: 'u0' }, getBoundingClientRect: () => ({ top: 24 }) }], getBoundingClientRect: () => ({ top: 0 }) }), true)
console.log('PASS probe requires the actual target row rather than any/missing row')
console.log('All outline navigation source-isolation regressions passed (no live verification).')
