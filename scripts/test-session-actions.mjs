import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import vm from 'node:vm'
import ts from 'typescript'

const child = spawnSync(process.execPath, ['scripts/test-v3-composer-ownership.mjs', '--session-actions-only'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
process.stdout.write(child.stdout ?? '')
process.stderr.write(child.stderr ?? '')
assert.equal(child.error, undefined)
assert.equal(child.status, 0)
assert.match(child.stdout, /结果：\d+ 通过 \/ 0 失败/)

function find(tree, predicate) {
  let found
  const visit = node => { if (!found && predicate(node)) found = node; ts.forEachChild(node, visit) }
  visit(tree)
  assert.ok(found)
  return found
}
const file = 'src/main/agent.ts'
const tree = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
const method = find(tree, node => ts.isMethodDeclaration(node) && node.name.getText(tree) === 'enqueueCapabilityChange')
const compiled = ts.transpileModule(`class Fixture { ${method.getText(tree)} }\nglobalThis.Fixture = Fixture`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const context = vm.createContext({})
vm.runInContext(compiled, context)
for (const field of ['session', 'rpc', 'generation']) {
  const agent = new context.Fixture()
  agent.rpc = {}
  agent.state = { sessionId: 'A' }
  agent.capabilityOpts = { runnerGeneration: 5 }
  let release
  agent.capabilityChangeTail = new Promise(resolve => { release = resolve })
  let writes = 0
  const result = agent.enqueueCapabilityChange(async () => { writes++; return { ok: true } })
  if (field === 'session') agent.state = { sessionId: 'B' }
  if (field === 'rpc') agent.rpc = {}
  if (field === 'generation') agent.capabilityOpts = { runnerGeneration: 6 }
  release()
  assert.equal((await result).ok, false)
  assert.equal(writes, 0)
}
const ready = new context.Fixture()
ready.rpc = {}
ready.state = { sessionId: 'A' }
ready.capabilityOpts = { runnerGeneration: 5 }
ready.capabilityChangeTail = Promise.resolve()
assert.equal((await ready.enqueueCapabilityChange(async () => ({ ok: true }))).ok, true)

const turnFile = 'src/renderer/src/features/session/TurnView.tsx'
const turn = ts.createSourceFile(turnFile, readFileSync(turnFile, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const button = find(turn, node => ts.isJsxOpeningElement(node) && node.attributes.properties.some(prop => ts.isJsxAttribute(prop) && prop.name.getText(turn) === 'data-testid' && prop.initializer?.text === 'v3-msg-fork'))
const handler = button.attributes.properties.find(prop => ts.isJsxAttribute(prop) && prop.name.getText(turn) === 'onPress').initializer.expression
const source = ts.transpileModule('globalThis.click = ' + handler.getText(turn), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const forked = []
const forkContext = vm.createContext({ forkAt: entryId => forked.push(entryId), msg: { entryId: 'first', text: '继续' } })
vm.runInContext(source, forkContext)
forkContext.click()
forkContext.msg = { entryId: 'second', text: '继续' }
forkContext.click()
assert.deepEqual(forked, ['first', 'second'])
console.log('PASS session actions: renderer target races, queued session/RPC/generation guards, duplicate-text fork entry IDs')
