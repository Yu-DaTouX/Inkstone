// Run the exact webRequest initiator selection from browser.ts against the real boundary policy.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
const source = readFileSync('src/main/browser.ts', 'utf8')
const ast = ts.createSourceFile('browser.ts', source, ts.ScriptTarget.Latest, true)
const names = new Set(['requestFrame', 'frameUrl', 'initiator'])
const statements = []
function visit(node) {
  if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => names.has(d.name.getText(ast)))) statements.push(node.getText(ast))
  ts.forEachChild(node, visit)
}
visit(ast)
assert.equal(statements.length, 3, 'fixture extracts the actual request callback')
const code = ts.transpileModule(statements.join('\n') + '\nglobalThis.origin = initiator', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const built = buildSync({ entryPoints: ['src/main/browser/network-boundary.ts'], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
const module = { exports: {} }
vm.runInNewContext(built, { module, exports: module.exports, URL, require: createRequire(import.meta.url) })
const decide = module.exports.decideRequestBoundary
const owner = { committedUrl: 'https://remote.invalid/', openerUrl: 'https://opener.invalid/' }
function check(frame, resourceType, expectedOrigin, expected, options = {}) {
  const ctx = { details: { frame, resourceType }, owner }
  vm.runInNewContext(code, ctx)
  assert.equal(ctx.origin, expectedOrigin)
  assert.equal(decide({ targetHost: '127.0.0.1', initiatorUrl: ctx.origin, resourceType, requestedByUs: false, ...options }), expected)
}
check({ url: 'about:blank', parent: { url: 'http://127.0.0.1:39873/fixture' } }, 'subFrame', 'http://127.0.0.1:39873/fixture', 'allow')
check({ url: 'http://127.0.0.1:39873/target', parent: { url: 'https://remote.invalid/' } }, 'subFrame', 'https://remote.invalid/', 'block-private')
check({ url: 'http://127.0.0.1:39873/target' }, 'subFrame', '', 'block-private')
check(undefined, 'subFrame', '', 'block-private')
check({ url: 'http://localhost:39873/child' }, 'xhr', 'http://localhost:39873/child', 'allow')
check({ url: 'https://remote.invalid/child', parent: { url: 'http://localhost:39873/' } }, 'xhr', 'https://remote.invalid/child', 'block-private')
check(undefined, 'mainFrame', owner.committedUrl, 'block-private')
check(undefined, 'mainFrame', owner.committedUrl, 'allow', { requestedByUs: true })
check({ url: 'about:blank', parent: { url: 'http://localhost:39873/' } }, 'subFrame', 'http://localhost:39873/', 'block-private', { targetHost: '169.254.169.254' })
const oldOrigin = 'about:blank'
assert.equal(decide({ targetHost: '127.0.0.1', initiatorUrl: oldOrigin, resourceType: 'subFrame', requestedByUs: false }), 'block-private', 'negative control: old target URL blocks local iframe')
console.log('PASS browser frame initiator: 9 boundary cases plus old-policy negative control; no Electron/network/model')
