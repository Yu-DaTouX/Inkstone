import './lib/test-isolate.mjs'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitFor = async (check, ms) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return check()
}

await runSuite(import.meta.url, async (ok, compile) => {
  const { ProcessTreeWatch, PiTreeRegistry, descendantsOf, parseProcessScan, listWindowsProcesses } = await compile('src/main/process-tree.ts', { packages: 'external' })

  const parsed = parseProcessScan('10,1,1000\r\nbad line\r\n11,10,1500\n')
  ok(parsed.length === 2 && parsed[1].ppid === 10 && parsed[1].created === 1500, '进程表解析只收合法行')

  const T = 1_000_000
  const rows = [
    { pid: 100, ppid: 1, created: T },
    { pid: 101, ppid: 100, created: T + 10 },
    { pid: 102, ppid: 101, created: T + 20 },
    { pid: 103, ppid: 100, created: T - 90_000 },
    { pid: 104, ppid: 555, created: T + 30 },
    { pid: 105, ppid: 100, created: T + 9_000 }
  ]
  const seeds = [{ pid: 100, ppid: 1, created: T }]
  ok(descendantsOf(rows, seeds, T - 2000).map((r) => r.pid).sort().join() === '101,102,105', '只认根的子孙：排除更早创建（pid 复用）与无关父进程的进程')
  ok(descendantsOf(rows, seeds, T - 2000, T + 5000).map((r) => r.pid).join() === '101,102', '根退出之后才创建的进程不算它的子孙')

  {
    const killed = []
    let table = rows
    const watch = new ProcessTreeWatch(100, { listProcesses: async () => table, kill: async (pid) => { killed.push(pid) }, now: () => T })
    await watch.snapshot()
    ok(watch.trackedPids().sort().join() === '101,102,105', '快照记下全部子孙', watch.trackedPids().join())
    table = [
      { pid: 100, ppid: 1, created: T + 777_000 },
      { pid: 102, ppid: 101, created: T + 20 },
      { pid: 105, ppid: 100, created: T + 9_999_999 },
      { pid: 104, ppid: 555, created: T + 30 },
      { pid: 900, ppid: 4, created: T + 50 }
    ]
    const swept = await watch.sweep(T + 100_000)
    ok(swept.join() === '102', '根与中间进程已退出后只结束仍存活且创建时间一致的孙进程（pid 被复用的、无关进程都不动）', swept.join())
    ok(killed.join() === '102', '只对存活的最上层调用结束', killed.join())
  }
  {
    const killed = []
    const table = [
      { pid: 201, ppid: 200, created: T + 10 },
      { pid: 202, ppid: 201, created: T + 20 },
      { pid: 203, ppid: 200, created: T + 90_000 }
    ]
    const watch = new ProcessTreeWatch(200, { listProcesses: async () => table, kill: async (pid) => { killed.push(pid) }, now: () => T })
    const swept = await watch.sweep(T + 1000)
    ok(swept.sort().join() === '201,202' && killed.join() === '201', '没有快照时根已退出，仍按陈旧的父进程号找到并结束它创建的子树，退出之后新来的不动', `${swept.join()}|${killed.join()}`)
  }
  {
    const killed = []
    const failing = new ProcessTreeWatch(300, { listProcesses: async () => { throw new Error('scan failed') }, kill: async (pid) => { killed.push(pid) } })
    ok((await failing.sweep()).length === 0 && killed.length === 0, '进程表读不到时不结束任何进程')
  }

  {
    const killed = []
    const table = [
      { pid: 400, ppid: 1, created: T + 5_000_000 },
      { pid: 401, ppid: 400, created: T + 5_000_100 }
    ]
    const watch = new ProcessTreeWatch(400, { listProcesses: async () => table, kill: async (pid) => { killed.push(pid) }, now: () => T })
    watch.markExited(T + 1000)
    const swept = await watch.sweep()
    ok(swept.length === 0 && killed.length === 0, '根已退出且它的 pid 被新进程复用：新进程与其子进程都不结束，创建时间核对不上的根也不当作自己的')
    ok(watch.rootCreated() === null, '创建时间对不上的进程不会被记成根')
  }
  {
    const killed = []
    const table = [{ pid: 500, ppid: 1, created: T + 100 }, { pid: 501, ppid: 500, created: T + 150 }]
    const watch = new ProcessTreeWatch(500, { listProcesses: async () => table, kill: async (pid) => { killed.push(pid) }, now: () => T })
    await watch.snapshot()
    ok(watch.rootCreated() === T + 100, '记下根进程自己的创建时间')
    table.splice(0, 2, { pid: 500, ppid: 1, created: T + 7_000_000 }, { pid: 501, ppid: 500, created: T + 7_000_050 })
    watch.markExited(T + 2000)
    const swept = await watch.sweep()
    ok(swept.length === 0 && killed.length === 0, '根的 pid 被复用后，复用者名下的子进程晚于根的退出时间，不算它的子孙')
  }
  {
    let scans = 0
    const watch = new ProcessTreeWatch(600, { listProcesses: async () => { scans++; return [] }, isAlive: () => false, kill: async () => {} })
    ok((await watch.sweep(undefined, { cheap: true })).length === 0 && scans === 0, '快速结束：根与记下的进程都不在时不再扫描')
    const alive = new ProcessTreeWatch(600, { listProcesses: async () => { scans++; return [] }, isAlive: () => true, kill: async () => {} })
    await alive.sweep(undefined, { cheap: true })
    ok(scans === 1, '快速结束：pid 看起来还在时扫描一次，用创建时间核对')
  }
  {
    const killed = []
    const table = [
      { pid: 701, ppid: 700, created: T - 5000 },
      { pid: 702, ppid: 700, created: T + 100 }
    ]
    const watch = new ProcessTreeWatch(700, { listProcesses: async () => table, kill: async (pid) => { killed.push(pid) }, now: () => T })
    watch.markExited(T + 1000)
    await watch.sweep()
    ok(killed.join() === '702', '从没见过根进程时，只认 spawn 之后（下限为启动前 1 秒）创建的子进程；更早的、属于该 pid 上一任的孤儿不动', killed.join())
  }
  {
    const [first, second] = await Promise.all([listWindowsProcesses(), listWindowsProcesses()])
    ok(first === second, '1.5 秒内的扫描共用同一份结果')
    const fresh = await listWindowsProcesses({ since: Date.now() })
    ok(fresh !== first && fresh.length > 0, '要求晚于某时刻的扫描会重新取，不复用旧结果')
    ok(fresh.some((row) => row.pid === process.pid && /node/i.test(row.name ?? '') && (row.commandLine ?? '').length > 0), '扫描结果带进程名和命令行')
  }
  {
    const killed = []
    const table = [
      { pid: 800, ppid: 1, created: T },
      { pid: 801, ppid: 800, created: T + 10, name: 'node.exe', commandLine: 'node mcp.js --mcp' },
      { pid: 802, ppid: 801, created: T + 20 },
      { pid: 803, ppid: 800, created: T + 30, name: 'node.exe', commandLine: 'node dev.js' },
      { pid: 804, ppid: 803, created: T + 40 }
    ]
    const skipped = []
    const watch = new ProcessTreeWatch(800, { listProcesses: async () => table, kill: async (pid) => { killed.push(pid) }, now: () => T, select: (row) => /--mcp/.test(row.commandLine ?? ''), onSkipped: (rows) => skipped.push(...rows.map((row) => row.pid)) })
    watch.markExited(T + 500)
    table.splice(0, 1)
    await watch.sweep()
    ok(killed.join() === '801', '带选择器时只对选中的服务进程及其子孙下手，其余子进程不动', killed.join())
    ok(skipped.join() === '803', '没选中的直接子进程只回报（用于记日志）', skipped.join())
  }
  {
    const scans = []
    const registry = new PiTreeRegistry({
      platform: 'win32',
      scanDelaysMs: [20, 80],
      intervalMs: 40,
      listProcesses: async () => { scans.push(1); return rows },
      kill: async () => {},
      now: () => T
    })
    const watch = registry.watch(100)
    ok(registry.size === 1 && watch.trackedPids().length === 0, '登记后先不扫描')
    ok(await waitFor(() => watch.trackedPids().length === 3, 2000), '定时扫描把子孙记入快照')
    registry.release(watch)
    const after = scans.length
    await new Promise((resolve) => setTimeout(resolve, 150))
    ok(registry.size === 0 && scans.length === after, '释放最后一个后停止定时扫描', `${after} -> ${scans.length}`)
    ok(new PiTreeRegistry({ platform: 'linux' }).watch(100) === null && new PiTreeRegistry({ platform: 'win32' }).watch(undefined) === null, '非 Windows 或没有 pid 时不登记')
  }

  if (process.platform === 'win32') {
    const dir = mkdtempSync(join(tmpdir(), 'yan-process-tree-'))
    const spawned = []
    try {
      const holder = join(dir, 'holder.cjs')
      writeFileSync(holder, [
        "require('node:fs').writeFileSync(process.argv[2], String(process.pid))",
        'setInterval(() => {}, 1000)'
      ].join('\n'))
      const fakePi = join(dir, 'fake-pi.cjs')
      writeFileSync(fakePi, [
        "const { spawn } = require('node:child_process')",
        `spawn('cmd.exe', ['/d', '/s', '/c', ${JSON.stringify(`""${process.execPath}" "${holder}" "${join(dir, 'holder.pid')}""`)}], { stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: true })`,
        'setInterval(() => {}, 1000)'
      ].join('\n'))
      const piSpawnedAt = Date.now()
      const pi = spawn(process.execPath, [fakePi], { stdio: 'ignore', windowsHide: true })
      spawned.push(pi.pid)
      const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
      spawned.push(bystander.pid)
      const holderPidFile = join(dir, 'holder.pid')
      ok(await waitFor(() => existsSync(holderPidFile) && readFileSync(holderPidFile, 'utf8').length > 0, 15_000), '假 pi 起了 cmd 包装的孙进程')
      const holderPid = Number(readFileSync(holderPidFile, 'utf8'))
      spawned.push(holderPid)

      const watch = new ProcessTreeWatch(pi.pid, { listProcesses: listWindowsProcesses, now: () => piSpawnedAt })
      await watch.snapshot()
      ok(watch.trackedPids().includes(holderPid), '真实进程表里记下了 cmd 之下的孙进程', watch.trackedPids().join())
      const wrapperPid = (await listWindowsProcesses()).find((row) => row.pid === holderPid).ppid
      ok(wrapperPid !== pi.pid && watch.trackedPids().includes(wrapperPid), '孙进程的父进程是被记下的 cmd 包装器')

      process.kill(wrapperPid)
      const exited = new Promise((resolve) => pi.once('exit', resolve))
      pi.kill()
      await exited
      ok(await waitFor(() => !alive(wrapperPid), 5000), 'cmd 包装器与假 pi 都已退出')
      ok(alive(holderPid), '孤儿孙进程仍在运行（父进程链已断）')
      const swept = await watch.sweep(Date.now())
      ok(swept.includes(holderPid), '结束时扫到了孤儿孙进程', swept.join())
      ok(await waitFor(() => !alive(holderPid), 8000), '孤儿孙进程已被结束')
      ok(alive(bystander.pid), '不在 pi 子孙里的无关进程（例如用户在终端里起的）不受影响')
    } finally {
      for (const pid of spawned) try { process.kill(pid) } catch {}
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
})
