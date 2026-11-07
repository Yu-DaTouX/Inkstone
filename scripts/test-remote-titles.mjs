import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile('src/main/remote-host.ts', 'utf8')
const ast = ts.createSourceFile('remote-host.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
let fn = ''
let consts = ''
ts.forEachChild(ast, (node) => {
  if (ts.isFunctionDeclaration(node) && ['withDesktopTitles', 'remoteQueueOf'].includes(node.name?.text)) fn += node.getText(ast).replace(/^export /, '') + '\n'
  if (ts.isVariableStatement(node) && /QUEUE_(ITEMS|TEXT)_MAX/.test(node.getText(ast))) consts += node.getText(ast) + '\n'
})
assert.ok(fn.includes('withDesktopTitles') && fn.includes('remoteQueueOf'), '找得到两个函数')
const js = ts.transpileModule(`${consts}${fn}\nexport { withDesktopTitles, remoteQueueOf }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const { withDesktopTitles, remoteQueueOf } = await import(`data:text/javascript,${encodeURIComponent(js)}`)

const list = [
  { id: 'a', title: '第一句原话', named: false },
  { id: 'b', title: 'pi 会话名', named: true },
  { id: 'c', title: '第一句原话', named: false },
  { id: 'd', title: '没有任何标题记录', named: false }
]
const out = withDesktopTitles(list, { a: '手动改的名', c: '  ' }, { a: 'AI 标题', b: 'AI 标题 b', c: 'AI 标题 c' })
assert.equal(out[0].title, '手动改的名', '手动改名优先')
assert.equal(out[0].named, true, '手动改名记为已命名')
assert.equal(out[1].title, 'AI 标题 b', '与桌面一致：AI 标题优先于 pi 会话名')
assert.equal(out[2].title, 'AI 标题 c', '空白的手动名不生效，回到 AI 标题')
assert.equal(out[2].named, false, '只有 AI 标题时不算手动命名')
assert.equal(out[3], list[3], '没有标题记录时原样返回同一对象')
assert.equal(list[0].title, '第一句原话', '不改动缓存里的原对象')
assert.equal(remoteQueueOf(null), undefined, '没有运行实例时不带队列')
assert.equal(remoteQueueOf({ steering: [], followUp: ['  '] }), undefined, '只有空白时不带队列')
const q = remoteQueueOf({ steering: ['插一句'], followUp: ['<subagent-notification id="x" status="done">\n…', 'x'.repeat(600), ...Array.from({ length: 30 }, (_, i) => `第 ${i}`)] })
assert.deepEqual(q.steering, ['插一句'], '插话原样带上')
assert.ok(!q.followUp.some((t) => t.startsWith('<subagent-notification')), '子代理通知不当作排队消息')
assert.equal(q.followUp[0].length, 501, '过长的排队消息截到 500 字加省略号')
assert.equal(q.followUp.length, 20, '最多带 20 条')
console.log('test-remote-titles: 14 项通过')
