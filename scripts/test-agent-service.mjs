import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'

export async function runAgentServiceTests({ realPi = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'inkstone-agent-service-'))
  const outfile = join(root, 'service.mjs')
  await build({ entryPoints: ['src/core/agent-service.ts'], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { AgentService } = await import(pathToFileURL(outfile).href)
  const source = join(root, 'original.txt'), dataRoot = join(root, 'data')
  await writeFile(source, 'ORIGINAL')
  const options = { dataRoot, guardExtension: resolve('resources/pi-extensions/service-authority.js') }
  let service = new AgentService(options)
  await service.start()
  try {
    await assert.rejects(new AgentService(options).start(), /使用/)
    const task = await service.create({ title: 'Non-Git document', files: [source] })
    assert.equal(await readFile(join(task.workspace, 'inputs/original.txt'), 'utf8'), 'ORIGINAL')
    assert.equal(task.status, 'ready')
    await assert.rejects(service.run(task.id, 'test'), /缺少模型/)
    assert.equal(service.capabilities().find(c => c.id === 'pi.execute').available, false)
    await writeFile(join(task.workspace, 'outputs/result.txt'), 'DELIVERED')
    assert.equal((await service.outputs(task.id))[0].name, 'result.txt')
    assert.equal((await service.preview(task.id, 'result.txt')).text, 'DELIVERED')
    await assert.rejects(service.preview(task.id, '../../original.txt'), /授权/)
    let plan = await service.planApply(task.id, [{ output: 'result.txt', destination: source }])
    await assert.rejects(service.apply(task.id, plan.approval.id, 'apply-unapproved'), /批准/)
    await service.approve(plan.approval.id, task.generation, true)
    const applied = await service.apply(task.id, plan.approval.id, 'apply-original-001')
    assert.deepEqual(applied.applied, [source])
    assert.equal(await readFile(source, 'utf8'), 'DELIVERED')
    assert.deepEqual(await service.apply(task.id, plan.approval.id, 'apply-original-001'), applied)
    await assert.rejects(service.once(task.id, 'apply-original-001', 'different', {}, async () => 1), /不同请求/)
    // A changed original is compared against the import version, even if planning is later.
    const second = await service.create({ title: 'Original changed', files: [source] })
    await writeFile(join(second.workspace, 'outputs/new.txt'), 'NEW')
    await writeFile(source, 'OTHER-WRITER')
    plan = await service.planApply(second.id, [{ output: 'new.txt', destination: source }])
    await service.approve(plan.approval.id, second.generation, true)
    const conflict = await service.apply(second.id, plan.approval.id, 'apply-conflict-001')
    assert.deepEqual(conflict.conflicts, [source]); assert.equal(await readFile(source, 'utf8'), 'OTHER-WRITER')
    // Concurrent deduplication checks payload equality before returning a pending result.
    let release
    const first = service.once('service', 'pending-operation-1', 'test', { a: 1 }, () => new Promise(resolveDone => { release = resolveDone }))
    await new Promise(resolveTick => setTimeout(resolveTick, 20))
    await assert.rejects(service.once('service', 'pending-operation-1', 'test', { a: 2 }, async () => 2), /不同请求/)
    release(1); assert.equal(await first, 1)
    await service.authorizeChildren(task.id, true)
    const child = await service.create({ title: 'Child', parentId: task.id, files: [join(task.workspace, 'inputs/original.txt')], budget: { maxToolCalls: 10000 } })
    assert.equal(child.budget.maxToolCalls, task.budget.maxToolCalls)
    await assert.rejects(service.create({ title: 'Escalation', parentId: task.id, files: [source] }), /父任务文件授权/)
    await assert.rejects(service.create({ title: 'Unapproved child', parentId: child.id, files: [] }), /未授权子任务/)
    plan = await service.planApply(second.id, [{ output: 'new.txt', destination: join(root, 'new-delivery.txt') }])
    service.store.document.tasks.find(t => t.id === second.id).generation++
    await assert.rejects(service.approve(plan.approval.id, plan.approval.generation, true), /过期/)
    service.store.document.tasks.find(t => t.id === second.id).status = 'running'
    service.store.document.receipts.push({ id: 'crashed', taskId: second.id, generation: 1, requestId: 'unknown-effect-001', operation: 'external', digest: 'unknown', state: 'started' })
    await service.store.save()
    await service.close(); service = new AgentService(options); await service.start()
    assert.equal(service.snapshot().tasks.find(t => t.id === second.id).status, 'uncertain')
    assert.equal(service.store.document.receipts.find(r => r.id === 'crashed').state, 'uncertain')
    await assert.rejects(service.once(second.id, 'unknown-effect-001', 'external', {}, async () => 1))
    const filesBundle = join(root, 'files.mjs')
    await build({ entryPoints: ['src/core/task-files.ts'], outfile: filesBundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    const { planApply, applyOutputs, checkedPath } = await import(pathToFileURL(filesBundle).href)
    const output = join(task.workspace, 'outputs')
    await writeFile(join(output, 'second.txt'), 'SECOND')
    const partialPlan = await planApply(output, [{ output: 'result.txt', destination: join(root, 'part-1.txt') }, { output: 'second.txt', destination: join(root, 'part-2.txt') }])
    const partial = await applyOutputs(output, partialPlan, async (_item, index) => { if (index === 1) throw new Error('fixture interrupt') })
    assert.equal(partial.applied.length, 1); assert.equal(partial.pending.length, 1); assert.match(partial.error, /interrupt/)
    await mkdir(join(root, 'outside'))
    await symlink(join(root, 'outside'), join(output, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(checkedPath(output, 'linked/escape.txt', true), /符号链接/)
    console.log('PASS: non-Git inputs/outputs, versioned apply, partial interruption, approvals, durable dedupe/recovery, child authority and budgets, symlink boundary')
  } finally { await service.close() }
  if (realPi) await realPiTests(root, AgentService)
  console.log(`Evidence: ${root}`)
}

async function realPiTests(root, AgentService) {
  let requests = 0
  const provider = createServer((req, res) => {
    let body = ''
    req.on('data', part => { body += part })
    req.on('end', () => {
      const payload = JSON.parse(body); requests++
      assert.deepEqual(payload.tools.map(t => t.function.name).sort(), ['edit', 'read', 'write'])
      const phase = payload.messages.filter(m => m.role === 'tool').length
      const chunk = (delta, finish_reason = null) => ({ id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (payload.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('WAIT-FOREVER'))) return
      if (phase < 2) {
        const name = phase === 0 ? 'write' : 'read'
        const args = phase === 0 ? { path: 'outputs/report.txt', content: 'OFFICIAL-PI-OUTPUT' } : { path: join(root, 'original.txt') }
        res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `tool-${phase}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }))}\n\n`)
        res.write(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\n`)
      } else {
        res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'Fixture completed; outside file was denied.' }))}\n\n`)
        res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`)
      }
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise(resolveListen => provider.listen(0, '127.0.0.1', resolveListen))
  const options = { dataRoot: join(root, 'real-pi-data'), runtime: { executable: process.execPath, cli: resolve(selectedPiRuntime(resolve('resources/pi-runtime')), 'dist/bundle/cli.js'), kind: 'node' }, guardExtension: resolve('resources/pi-extensions/service-authority.js'), modelConfig: { provider: 'fixture', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'fixture-only', model: { id: 'fixture', contextWindow: 32000, maxTokens: 1024 } } }
  let service = new AgentService(options)
  const until = async (fn, timeout = 40000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (fn()) return; await new Promise(r => setTimeout(r, 50)) } throw new Error('Timed out: ' + JSON.stringify(service.snapshot())) }
  await service.start()
  try {
    const task = await service.create({ title: 'Real Node official pi fixture', files: [join(root, 'original.txt')] })
    await service.run(task.id, 'Write a report, attempt outside read and finish.')
    await until(() => ['completed', 'failed', 'uncertain'].includes(service.snapshot().tasks.find(t => t.id === task.id).status))
    const completed = service.snapshot().tasks.find(t => t.id === task.id)
    assert.equal(completed.status, 'completed', JSON.stringify(completed))
    assert.equal((await service.preview(task.id, 'report.txt')).text, 'OFFICIAL-PI-OUTPUT')
    assert.equal(completed.usage.modelCalls, 3)
    assert.equal(completed.usage.toolCalls, 1, 'outside read rejected before dispatch')
    assert(completed.sessionFile)
    const history = await readFile(completed.sessionFile, 'utf8')
    assert(history.includes('文件路径超出任务授权'))
    await service.close(); service = new AgentService(options); await service.start()
    assert.equal(service.snapshot().tasks.find(t => t.id === task.id).sessionFile, completed.sessionFile)
    assert.equal((await service.preview(task.id, 'report.txt')).text, 'OFFICIAL-PI-OUTPUT')
    const limited = await service.create({ title: 'Strict call budget', files: [], budget: { maxModelCalls: 1 } })
    const before = requests
    await service.run(limited.id, 'Do the same fixture flow.')
    await until(() => service.snapshot().tasks.find(t => t.id === limited.id).status !== 'running')
    assert.equal(requests - before, 1, 'second provider request rejected before reaching upstream')
    assert.equal(service.snapshot().tasks.find(t => t.id === limited.id).usage.modelCalls, 1)
    const waiting = await service.create({ title: 'Cancel provider stream', files: [] })
    await service.run(waiting.id, 'WAIT-FOREVER')
    await until(() => service.snapshot().tasks.find(t => t.id === waiting.id).usage.modelCalls === 1)
    await service.cancel(waiting.id)
    assert.equal(service.snapshot().tasks.find(t => t.id === waiting.id).status, 'cancelled')
    const timed = await service.create({ title: 'Time limit', files: [], budget: { maxTimeMs: 2500 } })
    await service.run(timed.id, 'WAIT-FOREVER')
    await until(() => service.snapshot().tasks.find(t => t.id === timed.id).status === 'failed')
    assert.match(service.snapshot().tasks.find(t => t.id === timed.id).error, /时间预算/)
    const parent = await service.create({ title: 'Parent aggregate budget', files: [], budget: { maxModelCalls: 1 } })
    await service.authorizeChildren(parent.id, true)
    const child = await service.create({ title: 'Child consumes parent', files: [], parentId: parent.id })
    await service.run(child.id, 'Write the same report.')
    await until(() => service.snapshot().tasks.find(t => t.id === child.id).status !== 'running')
    assert.equal(service.snapshot().tasks.find(t => t.id === parent.id).usage.modelCalls, 1)
    assert.equal((await service.preview(child.id, 'report.txt')).text, 'OFFICIAL-PI-OUTPUT')
    await assert.rejects(service.create({ title: 'No more dispatch', files: [], parentId: parent.id }), /预算已耗尽/)
    console.log('PASS: actual Node + official pi + local model, guarded write/outside denial, provider budget, cancel/time limit, saved native session and restart')
  } finally { await service.close(); provider.closeAllConnections(); await new Promise(r => provider.close(r)) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runAgentServiceTests({ realPi: process.argv.includes('--pi') })
