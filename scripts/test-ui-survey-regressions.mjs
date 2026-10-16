import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { build } from 'esbuild'
const ast = path => ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, path.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
function find(tree, predicate) { let result; function visit(n) { if (!result && predicate(n)) result = n; ts.forEachChild(n, visit) } visit(tree); assert.ok(result); return result }
const noticeBuild = await build({ entryPoints: ['src/shared/subagent-notice.ts'], bundle: true, write: false, platform: 'node', format: 'esm' })
const { parseSubagentNotice } = await import('data:text/javascript;base64,' + Buffer.from(noticeBuild.outputFiles[0].text).toString('base64'))
const sessions = ast('src/main/sessions.ts')
const userText = find(sessions, n => ts.isFunctionDeclaration(n) && n.name?.text === 'userMessageText')
const context = vm.createContext({ parseSubagentNotice })
vm.runInContext(ts.transpileModule(userText.getText(sessions), {}).outputText, context)
assert.equal(context.userMessageText({ role: 'user', content: '<subagent-notification id="long-fixture-id" status="done">\n子任务已完成：检查通过\n正文\n</subagent-notification>' }), '子任务已完成：检查通过')
const ownersBuild = await build({ entryPoints: ['src/renderer/src/state/resource-owners.ts'], bundle: true, write: false, platform: 'node', format: 'cjs' })
const module = { exports: {} }
const browserContext = vm.createContext({ module, exports: module.exports, localStorage: { getItem: () => null, setItem() {} } })
vm.runInContext(ownersBuild.outputFiles[0].text, browserContext)
Object.assign(browserContext, module.exports)
browserContext.claimResource('browser', 'A')
assert.equal(browserContext.claimResource('browser', 'B'), 'A', 'focus/split does not steal ownership')
const remote = ast('src/main/remote-host.ts')
const remoteSummary = find(remote, n => ts.isFunctionDeclaration(n) && n.name?.text === 'remoteSessionSummary')
const remoteContext = vm.createContext({ basename, exports: {} })
vm.runInContext(ts.transpileModule(remoteSummary.getText(remote), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, remoteContext)
const dto = remoteContext.remoteSessionSummary({ id: 's1', title: 'fixture', path: '/private/s1.jsonl', cwd: '/private/project', createdAt: 1, updatedAt: 2, messageCount: 1 })
assert.equal(dto.cwdName, 'project')
assert.equal(dto.path, undefined)
assert.equal(dto.cwd, undefined)
console.log('ui-survey-regressions: notice title, browser ownership and basic remote DTO passed (source fixtures, not screenshots/device)')
