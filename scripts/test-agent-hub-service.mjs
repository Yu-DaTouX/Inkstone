import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const root = await mkdtemp(join(tmpdir(), 'inkstone-hub-service-'))
process.env.YAN_DATA_DIR = root; process.env.YAN_PI_DIR = join(root, 'pi')
await build({ entryPoints: ['src/main/agent-hub/service.ts'], outfile: 'out/test/agent-hub-service.mjs', bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' })
const { AgentHubService } = await import(pathToFileURL(resolve('out/test/agent-hub-service.mjs')))
const deps = { dataDir: root, piDir: join(root, 'pi'), resourcesDir: resolve('resources'), browser: () => null, projects: async () => [{ id: 'fixture', name: 'fixture', cwd: root }], piBin: async () => undefined }
const hub = new AgentHubService(deps)
const template = { id: 'fixture-template', name: 'Fixture', agent: 'codex', mode: 'managed', prompt: 'fixture prompt', inputOwner: 'desktop', approvalId: 'old-approval', reviewOf: 'old-artifact' }
await hub.command({ action: 'save-template', template }, 'phone:one')
assert.deepEqual(Object.keys(hub.templates.get(template.id)).filter((k) => ['inputOwner', 'approvalId', 'reviewOf'].includes(k)), [], 'templates must not carry old authority or frozen artifact identity')
await assert.rejects(hub.command({ action: 'save-template', template }, 'pi:delegate'), /仅由/)
// 用保持运行的离线执行器替代 launch；检查宿主事实与并发边界，不模拟模型成功。
hub.adapters = [{ agent: 'codex', available: true, modes: ['managed', 'terminal'] }]
hub.launch = async (task) => { task.status = 'running' }
const request = (id) => ({ requestId: id, projectId: 'fixture', prompt: 'offline fixture', agent: 'codex', mode: 'managed' })
const [first, duplicate] = await Promise.all([hub.command({ action: 'create', request: request('fixture-duplicate') }), hub.command({ action: 'create', request: request('fixture-duplicate') })])
assert.equal(first.taskId, duplicate.taskId); assert.equal(hub.tasks.size, 1)
await hub.command({ action: 'create', request: request('fixture-root-two') })
const third = await hub.command({ action: 'create', request: request('fixture-root-three') })
assert.equal(hub.live.size, 2); assert.equal(hub.tasks.get(third.taskId).status, 'queued')
const parent = hub.tasks.get(first.taskId)
const child = await hub.create(request('fixture-child-one'), 'fixture-parent', parent)
const waitingChild = await hub.create(request('fixture-child-two'), 'fixture-parent', parent)
assert.equal(hub.live.size, 3); assert.equal(hub.tasks.get(child.taskId).status, 'running')
assert.equal(hub.tasks.get(waitingChild.taskId).status, 'queued')
await hub.command({ action: 'cancel', taskId: first.taskId })
assert.equal(hub.tasks.get(child.taskId).status, 'cancelled')
assert.equal(hub.tasks.get(waitingChild.taskId).status, 'cancelled')
await assert.rejects(hub.create(request('fixture-late-child'), 'fixture-parent', parent), /来源已结束/)

const terminal = [...hub.tasks.values()].find((t) => t.status === 'running')
terminal.terminalId = 'offline-terminal'; terminal.inputOwner = 'desktop'; terminal.inputEpoch = 1
await hub.command({ action: 'claim-input', taskId: terminal.id, epoch: 1 }, 'phone:one')
await assert.rejects(hub.command({ action: 'input', taskId: terminal.id, epoch: 1, data: 'late' }, 'desktop'), /输入权/)
terminal.inputExpiresAt = 0
await hub.snapshot()
assert.equal(terminal.inputOwner, undefined); assert.equal(terminal.inputEpoch, 3)

const run = hub.live.get(terminal.id)
const approval = hub.requestApproval(terminal, run, 'command', 'fixture approval', '')
const pending = [...hub.approvals.values()].find((a) => a.status === 'pending')
await hub.command({ action: 'answer', approvalId: pending.id, answer: 'accept' })
assert.equal(await approval, 'accept')
await assert.rejects(hub.command({ action: 'answer', approvalId: pending.id, answer: 'accept' }), /失效/)
const question = hub.requestApproval(terminal, run, 'question', 'fixture question', '', undefined, false, [{ id: 'choice', question: 'fixture choice' }])
const waiting = [...hub.approvals.values()].find((a) => a.status === 'pending')
await assert.rejects(hub.command({ action: 'answer', approvalId: waiting.id, answer: 'accept' }), /填写/)
await hub.command({ action: 'answer', approvalId: waiting.id, answer: 'accept', answers: { choice: 'fixture answer' } })
assert.equal(await question, 'accept')
delete terminal.terminalId
await hub.shutdown()
const previousRun = parent.runId
parent.workspace = root
parent.report = 'previous-run-fixture-report'
parent.artifact = { patchPath: 'fixture.patch', reportPath: 'fixture-report.md', tree: 'fixture-tree', sha256: 'fixture-hash' }
hub.changed()
hub.accepting = true
await hub.command({ action: 'resume', taskId: parent.id })
assert.notEqual(parent.runId, previousRun)
assert.equal(parent.artifact, undefined, 'new run must not inherit the previous frozen artifact')
assert.equal(hub.runs.get(previousRun).report, 'previous-run-fixture-report')
assert.equal(hub.runs.get(previousRun).artifact.sha256, 'fixture-hash')
await hub.shutdown()
const saved = JSON.parse(await readFile(join(root, 'agent-hub', 'tasks.json'), 'utf8'))
saved.tasks[0].status = 'running'; saved.tasks[1].status = 'queued'
await writeFile(join(root, 'agent-hub', 'tasks.json'), JSON.stringify(saved))
const restored = new AgentHubService(deps)
assert.equal(restored.tasks.get(saved.tasks[0].id).status, 'uncertain')
assert.equal(restored.tasks.get(saved.tasks[1].id).status, 'cancelled')
assert.equal(restored.live.size, 0)
assert.equal(restored.hasBusy(), true, 'uncertain history retains resource guards')
assert.equal(restored.hasLiveWork(), false, 'restored uncertain history does not trigger a running-task exit warning')
restored.live.set('fixture-active-exit', { approvalResponses: new Map() })
assert.equal(restored.hasLiveWork(), true, 'live execution still requires exit confirmation')
restored.live.delete('fixture-active-exit')
assert.equal(restored.runs.get(previousRun).artifact.sha256, 'fixture-hash')
assert.equal(restored.templates.get(template.id).prompt, 'fixture prompt')
restored.adapters = [{ agent: 'codex', available: true, modes: ['managed', 'terminal'] }]
restored.launch = async task => { task.status = 'running' }
const blank = await restored.command({ action: 'create', request: { requestId: 'fixture-blank-terminal', projectId: 'fixture', agent: 'codex', mode: 'terminal', prompt: '' } })
assert.equal(restored.tasks.get(blank.taskId).prompt, '')
assert.equal(restored.tasks.get(blank.taskId).title, 'codex 终端')
assert.equal(restored.tasks.get(blank.taskId).timeoutMinutes, 0, 'native interactive terminals have no implicit managed-task timeout')
const terminalIds = [blank.taskId]
for (let i = 2; i <= 5; i++) terminalIds.push((await restored.command({ action: 'create', request: { requestId: `fixture-blank-terminal-${i}`, projectId: 'fixture', agent: 'codex', mode: 'terminal', prompt: '' } })).taskId)
assert.equal(terminalIds.filter(id => restored.tasks.get(id).status === 'running').length, 4, 'four interactive terminals can run without consuming managed-task slots')
assert.equal(restored.tasks.get(terminalIds[4]).status, 'queued')
await restored.command({ action: 'cancel', taskId: terminalIds[0] })
assert.equal(restored.tasks.get(terminalIds[4]).status, 'running', 'closing an interactive run releases its slot')
await assert.rejects(restored.command({ action: 'create', request: { requestId: 'fixture-blank-managed', projectId: 'fixture', agent: 'codex', mode: 'managed', prompt: '' } }), /受管任务/)
await restored.shutdown()
console.log('Agent Hub service checks passed: async dispatch deduplication, child slot reservation, parent cancellation, late delegation denial, input epoch/expiry, one-shot approval, question validation, restart without replay and preserved run artifacts.')
