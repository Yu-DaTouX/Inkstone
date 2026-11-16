import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runSuite } from './lib/test-suite.mjs'

const DAY = 24 * 60 * 60 * 1000

const atomicSpy = {
  name: 'atomic-write-spy',
  setup(b) {
    const real = resolve('src/main/atomic-write.ts')
    b.onResolve({ filter: /^\.\/atomic-write$/ }, () => ({ path: 'spy', namespace: 'atomic-spy' }))
    b.onLoad({ filter: /.*/, namespace: 'atomic-spy' }, () => ({
      loader: 'js',
      resolveDir: process.cwd(),
      contents: `
import { atomicWriteFile as real, atomicWriteFileSync as realSync } from ${JSON.stringify(real.replaceAll('\\', '/'))}
export const atomicWriteFile = async (file, content, options) => { (globalThis.__atomicCalls ??= []).push({ file, options }); return real(file, content, options) }
export const atomicWriteFileSync = (file, content) => { (globalThis.__atomicCalls ??= []).push({ file }); return realSync(file, content) }
`
    }))
  }
}

async function exists(path) {
  return stat(path).then(() => true, () => false)
}

async function rejection(work) {
  try {
    await work()
    return null
  } catch (error) {
    return error
  }
}

await runSuite(import.meta.url, async (ok, compile) => {
  const root = await mkdtemp(join(tmpdir(), 'inkstone-data-writes-'))
  try {
    console.log('\n--- compaction-lines.json：损坏先备份，拒绝覆盖 ---')
    const lines = await compile('src/main/native-compaction-line.ts')
    const piDir = process.env.YAN_PI_DIR
    const yanDir = process.env.YAN_DATA_DIR
    const recordFile = join(yanDir, 'compaction-lines.json')
    const settingsFile = join(piDir, 'settings.json')
    const model = [{ provider: 'p', id: 'm', contextWindow: 200_000 }]
    await mkdir(piDir, { recursive: true })
    await mkdir(yanDir, { recursive: true })
    await writeFile(settingsFile, JSON.stringify({ theme: 'dark' }), 'utf8')
    await lines.syncNativeCompactionLines(model, 100_000)
    ok(JSON.parse(await readFile(recordFile, 'utf8'))['p/m'] === 100_000 && JSON.parse(await readFile(settingsFile, 'utf8')).compaction.modelOverrides['p/m'].reserveTokens === 100_000, '首次同步写出压缩线，并记下哪些项是砚写的')

    const garbage = '{ not json ::: 里面可能有记录'
    await writeFile(recordFile, garbage, 'utf8')
    await lines.syncNativeCompactionLines(model, 80_000)
    const copies = []
    for (const name of (await readdir(yanDir)).filter((entry) => entry.startsWith('compaction-lines.json.corrupt-'))) {
      if ((await readFile(join(yanDir, name), 'utf8')) === garbage) copies.push(name)
    }
    ok(copies.length === 1, '记录文件损坏：先备份成 .corrupt-<时间>，原文不变')

    await writeFile(recordFile, '[1,2,3]', 'utf8')
    const refused = await rejection(() => lines.syncNativeCompactionLines(model, 60_000))
    ok(refused && (await readFile(recordFile, 'utf8')) === '[1,2,3]', '记录文件结构不对：拒绝覆盖，原文件保持原样', String(refused?.message))
    ok((await readdir(yanDir)).every((name) => !name.endsWith('.tmp')), '没有遗留 .tmp')

    await writeFile(recordFile, '{ broken-again', 'utf8')
    const settingsBefore = await readFile(settingsFile, 'utf8')
    const warns = []
    const realWarn = console.warn
    console.warn = (...args) => { warns.push(args.map(String).join(' ')) }
    try {
      await lines.syncNativeCompactionLines(model, 80_000)
      await lines.syncNativeCompactionLines(model, 80_000)
      await lines.syncNativeCompactionLines(model, 80_000)
    } finally {
      console.warn = realWarn
    }
    const again = []
    for (const name of (await readdir(yanDir)).filter((entry) => entry.startsWith('compaction-lines.json.corrupt-'))) {
      if ((await readFile(join(yanDir, name), 'utf8')) === '{ broken-again') again.push(name)
    }
    ok(again.length === 1, '记录文件损坏且设置没变化：只备份一份，连续同步不再重复备份', String(again.length))
    ok(JSON.stringify(JSON.parse(await readFile(recordFile, 'utf8'))) === '{}', '备份后立即写回一份空文档')
    ok(warns.length === 1 && warns[0].includes('lost') && warns[0].includes('left as they are'), '说明 owned 丢失后只记日志（一次）', warns.join(' | '))
    ok((await readFile(settingsFile, 'utf8')) === settingsBefore, '不猜测、不删除 settings.json 里已有的覆盖项')

    console.log('\n--- ultracode-sessions.json：串行读改写、损坏先备份 ---')
    const ultra = await compile('src/main/ultracode-sessions.ts')
    const ultraFile = join(root, 'ultracode-sessions.json')
    await Promise.all(Array.from({ length: 30 }, (_, index) => ultra.setUltracodeOn(`s${index}`, true, ultraFile)))
    const all = JSON.parse(await readFile(ultraFile, 'utf8'))
    ok(Object.keys(all).length === 30 && ultra.isUltracodeOn('s7', ultraFile), '30 个并发开关都保留，没有互相覆盖')
    await Promise.all([ultra.setUltracodeOn('s0', false, ultraFile), ultra.setUltracodeOn('s1', false, ultraFile)])
    ok(Object.keys(JSON.parse(await readFile(ultraFile, 'utf8'))).length === 28 && !ultra.isUltracodeOn('s0', ultraFile), '并发关闭同样不丢')
    ok((await readdir(root)).every((name) => !name.endsWith('.tmp')), '写完没有遗留 .tmp')

    await writeFile(ultraFile, '{ broken', 'utf8')
    ok(!ultra.isUltracodeOn('s5', ultraFile), '读取时遇到损坏文件按「未开启」处理，不会改动它')
    ok((await readFile(ultraFile, 'utf8')) === '{ broken', '只读查询不碰损坏文件')
    await ultra.setUltracodeOn('fresh', true, ultraFile)
    const ultraCopies = (await readdir(root)).filter((name) => name.startsWith('ultracode-sessions.json.corrupt-'))
    ok(ultraCopies.length === 1 && (await readFile(join(root, ultraCopies[0]), 'utf8')) === '{ broken' && ultra.isUltracodeOn('fresh', ultraFile), '写入前先把损坏的原文件备份，再写新内容')
    await writeFile(ultraFile, '[]', 'utf8')
    ok((await rejection(() => ultra.setUltracodeOn('x', true, ultraFile))) && (await readFile(ultraFile, 'utf8')) === '[]', '结构不对（数组）：拒绝覆盖')

    console.log('\n--- 同步原子写（sources 链接文件） ---')
    const atomic = await compile('src/main/atomic-write.ts')
    const target = join(root, 'sync', 'links.json')
    atomic.atomicWriteFileSync(target, '[1]')
    atomic.atomicWriteFileSync(target, '[2]')
    ok((await readFile(target, 'utf8')) === '[2]' && (await readdir(join(root, 'sync'))).length === 1, '同步原子写：覆盖成功且不留临时文件')
    const dirTarget = join(root, 'sync', 'dir.json')
    await mkdir(dirTarget)
    let threw = false
    try {
      atomic.atomicWriteFileSync(dirTarget, 'x')
    } catch {
      threw = true
    }
    ok(threw && (await readdir(join(root, 'sync'))).every((name) => !name.endsWith('.tmp')), '同步原子写：rename 失败时抛错并删掉自己的临时文件')

    const renameShim = {
      name: 'rename-shim',
      setup(b) {
        b.onResolve({ filter: /^node:fs$/ }, () => ({ path: 'fs', namespace: 'rename-shim' }))
        b.onLoad({ filter: /.*/, namespace: 'rename-shim' }, () => ({
          loader: 'js',
          contents: `
import { createRequire } from 'node:module'
const real = createRequire(import.meta.url)('node:fs')
export const { lstatSync, mkdirSync, rmSync, writeFileSync } = real
export const renameSync = (from, to) => {
  const plan = globalThis.__renamePlan
  if (plan) {
    plan.calls++
    if (plan.failures > 0) {
      plan.failures--
      throw Object.assign(new Error(plan.code), { code: plan.code })
    }
  }
  return real.renameSync(from, to)
}
`
        }))
      }
    }
    const flaky = await compile('src/main/atomic-write.ts', { plugins: [renameShim] })
    const flakyTarget = join(root, 'sync-retry', 'links.json')
    for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
      globalThis.__renamePlan = { code, failures: 2, calls: 0 }
      flaky.atomicWriteFileSync(flakyTarget, `["${code}"]`)
      ok(globalThis.__renamePlan.calls === 3 && (await readFile(flakyTarget, 'utf8')) === `["${code}"]` && (await readdir(join(root, 'sync-retry'))).length === 1, `同步原子写：rename 遇到 ${code} 重试后成功，不留临时文件`, JSON.stringify(globalThis.__renamePlan))
    }
    globalThis.__renamePlan = { code: 'EBUSY', failures: 1000, calls: 0 }
    const exhausted = await rejection(() => flaky.atomicWriteFileSync(flakyTarget, '["never"]'))
    ok(exhausted?.code === 'EBUSY' && globalThis.__renamePlan.calls === 6 && (await readFile(flakyTarget, 'utf8')) === '["EACCES"]' && (await readdir(join(root, 'sync-retry'))).length === 1, '同步原子写：重试有限（共 6 次），用尽后抛错、原文件不变、临时文件被删', JSON.stringify(globalThis.__renamePlan))
    globalThis.__renamePlan = { code: 'ENOSPC', failures: 1000, calls: 0 }
    const other = await rejection(() => flaky.atomicWriteFileSync(flakyTarget, '["x"]'))
    ok(other?.code === 'ENOSPC' && globalThis.__renamePlan.calls === 1, '同步原子写：非瞬时错误码不重试')
    const flakyDir = join(root, 'sync-retry', 'dir.json')
    await mkdir(flakyDir)
    globalThis.__renamePlan = { code: 'EPERM', failures: 1000, calls: 0 }
    const dirError = await rejection(() => flaky.atomicWriteFileSync(flakyDir, 'x'))
    ok(dirError?.code === 'EPERM' && globalThis.__renamePlan.calls === 1, '同步原子写：目标是目录时不重试')
    globalThis.__renamePlan = undefined

    console.log('\n--- session-layout / session-chains 用 durable 写 ---')
    const layout = await compile('src/main/session-layout.ts', { plugins: [atomicSpy] })
    globalThis.__atomicCalls = []
    await layout.rememberSession({ sessionId: 'durable-1', sessionFile: join(root, 'a.jsonl'), cwd: root, scope: 'global' })
    const layoutCall = globalThis.__atomicCalls.find((call) => call.file.endsWith('session-layout.json'))
    ok(layoutCall?.options?.durable === true, 'session-layout 落盘带 durable: true', JSON.stringify(layoutCall))
    const chain = await compile('src/main/session-chain-service.ts', { plugins: [atomicSpy] })
    globalThis.__atomicCalls = []
    const store = new chain.SessionChainStore({ root: join(root, 'chain-durable') })
    await store.link('C:/s/a.jsonl', 'C:/s/b.jsonl', 'h')
    const chainCall = globalThis.__atomicCalls.find((call) => call.file.endsWith('session-chains.json'))
    ok(chainCall?.options?.durable === true, 'session-chains 落盘带 durable: true', JSON.stringify(chainCall))
    delete globalThis.__atomicCalls
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await runSuite(import.meta.url, async (ok, compile) => {
  const root = await mkdtemp(join(tmpdir(), 'inkstone-stale-temp-'))
  try {
    console.log('\n--- 启动清扫残留临时文件 ---')
    const sweep = await compile('src/main/stale-temp-sweep.ts')
    ok(sweep.tempOwnerPid('handoffs.json.8100.c1b97144.tmp') === 8100, '识别 <名>.<pid>.<8位hex>.tmp')
    ok(sweep.tempOwnerPid('yan-commandcode-models.json.tmp-42284') === 42284, '识别 <名>.tmp-<pid>')
    ok(sweep.tempOwnerPid('x.json.123.tmp') === 123 && sweep.tempOwnerPid('x.json.123.0b8a6f7e-1111-4222-8333-444455556666.tmp') === 123 && sweep.tempOwnerPid('x.json.123.1767225600000.tmp') === 123, '识别 <名>.<pid>.tmp、<名>.<pid>.<uuid>.tmp、<名>.<pid>.<时间戳>.tmp')
    ok(['settings.json', 'auth.json', 'notes.tmp', 'readme.123.tmp', 'models.json.bak', 'a.json.corrupt-123', 'a.json.abc.tmp', 'a.json.0.tmp', 'a.json.12345678901.tmp'].every((name) => sweep.tempOwnerPid(name) === null), '正常文件、备份与不带 pid 的 .tmp 都不匹配')

    const old = new Date(Date.now() - 3 * DAY)
    const fresh = new Date(Date.now() - 60 * 60 * 1000)
    const make = async (dir, name, when, text = 'x') => {
      await mkdir(dir, { recursive: true })
      const file = join(dir, name)
      await writeFile(file, text, 'utf8')
      await utimes(file, when, when)
      return file
    }
    const yan = join(root, 'yan')
    const agent = join(root, 'agent')
    const oldNames = ['handoffs.json.8100.c1b97144.tmp', 'models.json.tmp-8200', 'a.json.8300.tmp', 'b.json.8400.0b8a6f7e-1111-4222-8333-444455556666.tmp']
    const oldFiles = []
    for (const name of oldNames) oldFiles.push(await make(yan, name, old), await make(agent, name.replace('json', 'md'), old))
    const freshTmp = await make(yan, 'fresh.json.8100.c1b97144.tmp', fresh)
    const aliveTmp = await make(yan, 'alive.json.9999.deadbeef.tmp', old)
    const ownTmp = await make(yan, `own.json.${process.pid}.deadbeef.tmp`, old)
    const keep = []
    for (const name of ['settings.json', 'auth.json', 'notes.tmp', 'readme.123.tmp', 'models.json.bak', 'handoffs.json.corrupt-1700000000000', 'sessions.json']) keep.push(await make(yan, name, old))
    const nestedDir = join(yan, 'sub')
    const nested = await make(nestedDir, 'inner.json.8100.c1b97144.tmp', old)
    const dirNamedLikeTmp = join(yan, 'dir.json.8500.tmp')
    await mkdir(dirNamedLikeTmp)
    await utimes(dirNamedLikeTmp, old, old)

    const removed = await sweep.sweepStaleTemps({ dirs: [yan, agent, yan, join(root, 'missing')], isAlive: (pid) => pid === 9999 })
    ok(removed.length === oldFiles.length && (await Promise.all(oldFiles.map(exists))).every((present) => !present), '超过 1 天、pid 已退出、命名匹配的临时文件都被清掉（两个目录各 4 种命名）', `${removed.length}/${oldFiles.length}`)
    ok(await exists(freshTmp), '不满 1 天的临时文件不动（可能刚写到一半）')
    ok(await exists(aliveTmp), 'pid 还活着的不动')
    ok(await exists(ownTmp), '当前进程自己的不动')
    ok((await Promise.all(keep.map(exists))).every(Boolean), '正常文件、备份、.corrupt 等一个都没误删')
    ok((await exists(nested)) && (await stat(dirNamedLikeTmp)).isDirectory(), '只扫顶层：子目录里的文件和同名目录不动')

    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
    const deadPid = Number(dead.stdout)
    ok(sweep.processAlive(process.pid) && !sweep.processAlive(deadPid), 'processAlive：当前进程为真、已退出的进程为假', String(deadPid))
    const realOld = await make(yan, `real.json.${deadPid}.c1b97144.tmp`, old)
    const realRemoved = await sweep.sweepStaleTemps({ dirs: [yan] })
    ok(realRemoved.includes(realOld) && !(await exists(realOld)), '默认用真实的进程探测：已退出进程留下的旧临时文件被清掉')

    console.log('\n--- commandcode 缓存 rename 失败时删自己的 tmp ---')
    const commandcode = await import(pathToFileURL(resolve('resources/pi-extensions/commandcode.js')).href)
    const cacheDir = join(root, 'commandcode')
    await mkdir(cacheDir, { recursive: true })
    const cacheFile = join(cacheDir, 'yan-commandcode-models.json')
    commandcode.writeCache(cacheFile, [{ id: 'm' }])
    ok(JSON.parse(await readFile(cacheFile, 'utf8')).models[0].id === 'm' && (await readdir(cacheDir)).length === 1, '正常写入：只有缓存文件，没有 tmp')
    const blocked = join(cacheDir, 'blocked.json')
    await mkdir(blocked)
    commandcode.writeCache(blocked, [{ id: 'm' }])
    ok((await readdir(cacheDir)).every((name) => !name.includes('.tmp-')) && (await stat(blocked)).isDirectory(), 'rename 失败（目标是目录）：不抛错，也不留 .tmp-<pid>')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
