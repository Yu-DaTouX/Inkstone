import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const dir = await mkdtemp(join(tmpdir(), 'inkstone-terminal-processes-'))
let pass = 0
async function check(label, fn) {
  await fn()
  pass += 1
  process.stdout.write(`  ✓ ${label}\n`)
}

const state = { calls: 0, running: 0, peak: 0, pending: [], output: '' }
globalThis.__processFake = state

try {
  const outfile = join(dir, 'terminal-processes.cjs')
  await build({
    entryPoints: ['src/main/terminal-processes.ts'],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
    plugins: [
      {
        name: 'fake-exec',
        setup(builder) {
          builder.onResolve({ filter: /^node:child_process$/ }, () => ({ path: 'fake-exec', namespace: 'fixture' }))
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents: `export const execFile = (file, args, options, done) => {
              const s = globalThis.__processFake
              s.calls += 1
              s.running += 1
              s.peak = Math.max(s.peak, s.running)
              const snapshot = s.output
              s.pending.push((error) => {
                s.running -= 1
                done(error, error ? '' : snapshot)
              })
            }`,
            loader: 'js'
          }))
        }
      }
    ]
  })
  const mod = createRequire(import.meta.url)(outfile)
  const tick = () => new Promise((done) => setImmediate(done))
  const finish = async (error) => {
    await tick()
    const next = state.pending.shift()
    assert.ok(next, '应有一个正在跑的查询')
    next(error)
    await tick()
  }
  const ps = (rows) => rows.map(([pid, ppid, name]) => `${pid} ${ppid} ${name}`).join('\n')

  await check('D-08：并发的 childCount 查询同一时刻只跑一个进程表查询，其余共享后续一次查询', async () => {
    Object.assign(state, { calls: 0, running: 0, peak: 0, pending: [], output: ps([[10, 1, 'pwsh']]) })
    const results = [1, 2, 3, 4, 5].map(() => mod.listProcessTree(10, 'linux'))
    await tick()
    eq(state.calls, 1)
    state.output = ps([[10, 1, 'pwsh'], [11, 10, 'node']])
    await finish()
    await tick()
    eq(state.calls, 2)
    await finish()
    const trees = await Promise.all(results)
    assert.equal(state.peak, 1)
    assert.equal(state.calls, 2)
    assert.deepEqual(trees[0].processes, [])
    for (const tree of trees.slice(1)) assert.deepEqual(tree.processes.map((p) => p.name), ['node'])
  })

  await check('D-08：不缓存结果，查询结束后的下一次调用重新查询，忙闲判断不会陈旧', async () => {
    Object.assign(state, { calls: 0, running: 0, peak: 0, pending: [], output: ps([[20, 1, 'pwsh'], [21, 20, 'node']]) })
    const first = mod.listProcessTree(20, 'linux')
    await finish()
    assert.deepEqual((await first).processes.map((p) => p.name), ['node'])
    state.output = ps([[20, 1, 'pwsh']])
    const second = mod.listProcessTree(20, 'linux')
    await finish()
    assert.deepEqual((await second).processes, [])
    assert.equal(state.calls, 2)
  })

  await check('D-08：查询失败只影响等它的调用，之后可以恢复', async () => {
    Object.assign(state, { calls: 0, running: 0, peak: 0, pending: [], output: ps([[30, 1, 'pwsh']]) })
    const failing = [mod.listProcessTree(30, 'linux'), mod.listProcessTree(30, 'linux')]
    await finish(new Error('timeout'))
    await finish(new Error('timeout'))
    assert.deepEqual(await Promise.all(failing), [{ ok: false, processes: [] }, { ok: false, processes: [] }])
    const later = mod.listProcessTree(30, 'linux')
    await finish()
    assert.deepEqual(await later, { ok: true, processes: [] })
    assert.equal(state.peak, 1)
  })

  function eq(actual, expected) {
    assert.equal(actual, expected)
  }

  console.log(`test-terminal-processes: ${pass} 项全部通过`)
} finally {
  delete globalThis.__processFake
  await rm(dir, { recursive: true, force: true })
}
