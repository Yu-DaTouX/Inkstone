import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

// Exercise the shipped JSONL entry and real cross-process writer exclusion.
export async function runServiceCliTests() {
  const root = await mkdtemp(join(tmpdir(), 'inkstone-service-cli-'))
  const config = join(root, 'config.json'), source = join(root, 'input.txt')
  await writeFile(source, 'CLI INPUT')
  await writeFile(config, JSON.stringify({ dataRoot: join(root, 'data'), guardExtension: resolve('resources/pi-extensions/service-authority.js') }))
  const children = new Set()
  function host() {
    const child = spawn(process.execPath, ['scripts/agent-service.mjs', config], { stdio: ['pipe', 'pipe', 'pipe'] })
    children.add(child)
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk })
    const ended = new Promise(done => child.once('exit', code => { children.delete(child); done({ code, stderr }) }))
    const lines = [], waiters = []
    createInterface({ input: child.stdout }).on('line', line => { const value = JSON.parse(line); if (waiters.length) waiters.shift()(value); else lines.push(value) })
    return { child, ended, next: () => lines.length ? Promise.resolve(lines.shift()) : Promise.race([new Promise(done => waiters.push(done)), ended.then(result => { throw new Error(JSON.stringify(result)) }), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('CLI response timed out')), 20000); timer.unref() })]), send: value => child.stdin.write(JSON.stringify(value) + '\n') }
  }
  try {
    let first = host(); assert.equal((await first.next()).type, 'ready')
    const second = host(); const conflict = await second.ended
    assert.notEqual(conflict.code, 0); assert.match(conflict.stderr, /使用/)
    const create = { id: 'cli-create-0001', action: 'create', payload: { title: 'CLI task', files: [source] } }
    first.send(create); const created = await first.next(); assert.equal(created.ok, true)
    first.send({ id: 'close-1', action: 'close' }); assert.equal((await first.next()).ok, true); assert.equal((await first.ended).code, 0)
    first = host(); await first.next(); first.send(create)
    const replay = await first.next(); assert.equal(replay.result.id, created.result.id)
    first.send({ ...create, payload: { title: 'different', files: [] } }); assert.equal((await first.next()).ok, false)
    first.send({ id: 'snapshot-1', action: 'snapshot' }); assert.equal((await first.next()).result.tasks.length, 1)
    first.send({ id: 'close-2', action: 'close' }); await first.next(); assert.equal((await first.ended).code, 0)
    console.log('PASS: shipped Node JSONL entry, cross-process data-root exclusion, durable create replay and payload mismatch rejection')
  } finally { for (const child of children) child.kill() }
}
if (process.argv[1]?.endsWith('test-agent-service-cli.mjs')) await runServiceCliTests()
