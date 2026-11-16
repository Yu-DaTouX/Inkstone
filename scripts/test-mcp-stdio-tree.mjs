import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
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
  const { StdioTreeClientTransport, killProcessTree } = await compile('src/main/mcp/stdio-tree-transport.ts', { packages: 'external' })
  const dir = mkdtempSync(join(tmpdir(), 'yan-mcp-tree-'))
  const spawned = []
  const server = (name, exitOnEof) => {
    const file = join(dir, `${name}.cjs`)
    writeFileSync(file, [
      `require('node:fs').writeFileSync(${JSON.stringify(join(dir, `${name}.pid`))}, String(process.pid))`,
      "process.stdin.on('data', () => {})",
      exitOnEof ? "process.stdin.on('end', () => process.exit(0))" : '',
      'setInterval(() => {}, 1000)'
    ].join('\n'))
    return file
  }
  const start = async (file, killTree, platform = process.platform, options = {}) => {
    const transport = new StdioTreeClientTransport(
      process.platform === 'win32'
        ? { command: 'cmd.exe', args: ['/d', '/c', process.execPath, file], stderr: 'ignore' }
        : { command: process.execPath, args: [file], stderr: 'ignore' },
      killTree,
      1800,
      platform,
      options
    )
    await transport.start()
    const pidFile = file.replace(/\.cjs$/, '.pid')
    await waitFor(() => existsSync(pidFile), 10_000)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    spawned.push(pid)
    return { transport, pid }
  }
  try {
    if (process.platform === 'win32') {
      const stubborn = await start(server('stubborn', false))
      ok(alive(stubborn.pid), '包装器下的服务进程已启动')
      await stubborn.transport.close()
      ok(await waitFor(() => !alive(stubborn.pid), 3000), '服务不理 stdin 结束时，关闭会连同包装器下的孙进程一起结束')

      const seen = []
      const slow = await start(server('slow', false), async (pid) => {
        seen.push(alive(pid))
        await new Promise((resolve) => setTimeout(resolve, 2500))
        await killProcessTree(pid)
      })
      await slow.transport.close()
      ok(seen.length === 1 && seen[0] === true, '进程树结束时包装器仍在运行', `seen=${JSON.stringify(seen)}`)
      ok(!alive(slow.pid), 'taskkill 再慢，close 返回前孙进程也已结束')
    }

    const calls = []
    const polite = await start(server('polite', true), async (pid) => { calls.push(pid) }, 'win32', { listProcesses: async () => [] })
    const started = Date.now()
    await polite.transport.close()
    ok(Date.now() - started < 1800 && calls.length === 0, '服务按 stdin 结束自行退出时不动用进程树结束', `${Date.now() - started}ms calls=${calls.length}`)
    ok(await waitFor(() => !alive(polite.pid), 3000), '自行退出的服务确实退出')

    let base = 0
    const fakeRows = (rootPid) => [
      { pid: rootPid, ppid: 1, created: base },
      { pid: 90001, ppid: rootPid, created: base + 10 },
      { pid: 90002, ppid: 90001, created: base + 20 },
      { pid: 90003, ppid: rootPid, created: base - 600_000 },
      { pid: 90004, ppid: 4242, created: base + 30 },
      { pid: 90005, ppid: rootPid, created: base + 40 }
    ]
    const fakeAlive = (pid) => pid === 90001 || pid === 90002 || pid === 90003 || pid === 90004
    const afterExit = (rootPid, extra) => [
      ...fakeRows(rootPid).filter((row) => row.pid !== rootPid && row.pid !== 90005),
      ...extra
    ]
    const watched = (rowsFor) => {
      const state = { calls: 0, transport: null }
      return {
        state,
        options: {
          listProcesses: async () => {
            const index = state.calls++
            if (index === 0) base = Date.now()
            return index === 0 || !state.transport ? [] : rowsFor(state.transport.pid, index)
          },
          isAlive: fakeAlive
        }
      }
    }
    {
      const killed = []
      const fake = watched((pid, index) => (index < 2 ? fakeRows(pid) : afterExit(pid, [])))
      const survivor = await start(server('tree-polite', true), async (pid) => { killed.push(pid) }, 'win32', fake.options)
      fake.state.transport = survivor.transport
      await survivor.transport.close()
      ok(fake.state.calls === 3, '启动记一次、关闭前一次、动手前再扫一次核对', String(fake.state.calls))
      ok(killed.length === 1 && killed[0] === 90001, '外层已退出时仍结束仍存活的子孙进程（只对最上层调用，排除无关与创建更早的 pid）', JSON.stringify(killed))
      await survivor.transport.close()
      ok(fake.state.calls === 3, '重复 close 不再扫描')
    }
    {
      const killed = []
      const fake = watched((pid, index) => (index < 2 ? fakeRows(pid) : afterExit(pid, []).map((row) => (row.pid === 90001 || row.pid === 90002 ? { ...row, created: row.created + 5_000_000 } : row))))
      const reused = await start(server('tree-pid-reuse', true), async (pid) => { killed.push(pid) }, 'win32', fake.options)
      fake.state.transport = reused.transport
      await reused.transport.close()
      ok(fake.state.calls === 3 && killed.length === 0, '记下的 pid 在动手前已被别的进程复用（创建时间不同）时不结束它', JSON.stringify(killed))
    }
    {
      const killed = []
      const fake = watched((pid, index) => (index < 2
        ? [{ pid, ppid: 1, created: base }]
        : [{ pid, ppid: 1, created: base + 9_000_000 }, { pid: 91001, ppid: pid, created: base + 9_000_100 }]))
      fake.options.isAlive = (pid) => pid === 91001 || pid === fake.state.rootPid
      const rootReuse = await start(server('tree-root-reuse', true), async (pid) => { killed.push(pid) }, 'win32', fake.options)
      fake.state.transport = rootReuse.transport
      fake.state.rootPid = rootReuse.transport.pid
      await rootReuse.transport.close()
      ok(fake.state.calls === 3 && killed.length === 0, '服务进程已退出且 pid 被新进程复用时，新进程和它的子进程都不结束', JSON.stringify(killed))
    }
    {
      const killed = []
      let scans = 0
      const dead = await start(server('tree-dead', true), async (pid) => { killed.push(pid) }, 'win32', {
        listProcesses: async () => { if (scans++ === 0) base = Date.now(); return base === 0 || !dead ? [] : fakeRows(dead.transport.pid) },
        isAlive: () => false
      })
      await dead.transport.close()
      ok(killed.length === 0 && scans === 2, '子孙都已退出时不动用进程树结束，也不做第三次扫描', `${killed.length}/${scans}`)
    }
    {
      const killed = []
      const broken = await start(server('tree-scan-fails', true), async (pid) => { killed.push(pid) }, 'win32', {
        listProcesses: async () => { throw new Error('powershell missing') },
        isAlive: () => true
      })
      await broken.transport.close()
      ok(killed.length === 0, '进程表读取失败时 close 照常完成')
    }
    {
      const stuck = await start(server('tree-scan-stuck', true), async () => {}, 'win32', {
        listProcesses: () => new Promise(() => {}),
        isAlive: () => false,
        scanCapMs: 300
      })
      const began = Date.now()
      await stuck.transport.close()
      ok(Date.now() - began < 3000, '进程表读取卡住时按上限放行，不会一直等', `${Date.now() - began}ms`)
    }
    {
      const scans = []
      const off = await start(server('tree-linux', true), async () => {}, 'linux', { listProcesses: async () => { scans.push(1); return [] } })
      await off.transport.close()
      ok(scans.length === 0, '非 Windows 不扫描进程表')
    }

    {
      const noisy = join(dir, 'noisy.cjs')
      writeFileSync(noisy, [
        "process.stderr.write('x'.repeat(10000) + '\\n')",
        "process.stderr.write('\\u001b[31mfatal: cannot open license sk-abcdefghijklmnop pass=letmein-please\\u001b[0m\\n')",
        "process.stdin.on('data', () => {})",
        "process.stdin.on('end', () => process.exit(0))",
        'setInterval(() => {}, 1000)'
      ].join('\n'))
      const transport = new StdioTreeClientTransport({ command: process.execPath, args: [noisy] }, async () => {}, 1800, 'linux', { secretValues: ['letmein-please', 'abc'] })
      await transport.start()
      await waitFor(() => transport.stderrTail().includes('fatal'), 5000)
      const tail = transport.stderrTail()
      ok(tail.includes('fatal: cannot open license') && tail.length <= 4097, 'stderr 只保留末尾一段', String(tail.length))
      ok(!tail.includes('sk-abcdefghijklmnop') && !tail.includes('letmein-please') && tail.includes('[redacted]'), 'stderr 里的密钥形状与配置里的敏感值都已遮蔽')
      ok(!tail.includes('\u001b'), 'stderr 里的终端控制序列已去掉')
      await transport.close()
    }

    if (process.platform === 'win32') {
      const grand = join(dir, 'grand.cjs')
      writeFileSync(grand, [
        `require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'grand.pid'))}, String(process.pid))`,
        'setInterval(() => {}, 1000)'
      ].join('\n'))
      const orphaner = join(dir, 'orphaner.cjs')
      writeFileSync(orphaner, [
        `require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'orphaner.pid'))}, String(process.pid))`,
        `require('node:child_process').spawn(process.execPath, [${JSON.stringify(grand)}], { detached: true, stdio: 'ignore', windowsHide: true }).unref()`,
        "process.stdin.on('data', () => {})",
        "process.stdin.on('end', () => process.exit(0))",
        'setInterval(() => {}, 1000)'
      ].join('\n'))
      const real = await start(orphaner)
      await waitFor(() => existsSync(join(dir, 'grand.pid')), 10_000)
      const grandPid = Number(readFileSync(join(dir, 'grand.pid'), 'utf8'))
      spawned.push(grandPid)
      ok(alive(grandPid), '孙进程已启动')
      await real.transport.close()
      ok(await waitFor(() => !alive(real.pid), 3000), '包装器按 stdin 结束自行退出')
      ok(await waitFor(() => !alive(grandPid), 3000), '包装器先退出后，残留的孙进程也被结束')
    }

    const offCalls = []
    const other = await start(server('other', false), async (pid) => { offCalls.push(pid) }, 'linux')
    await other.transport.close()
    ok(offCalls.length === 0, '非 Windows 不走 taskkill')
    if (alive(other.pid)) process.kill(other.pid)
  } finally {
    for (const pid of spawned) if (alive(pid)) process.kill(pid)
    rmSync(dir, { recursive: true, force: true })
  }
})
