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
  const start = async (file, killTree, platform = process.platform) => {
    const transport = new StdioTreeClientTransport(
      process.platform === 'win32'
        ? { command: 'cmd.exe', args: ['/d', '/c', process.execPath, file], stderr: 'ignore' }
        : { command: process.execPath, args: [file], stderr: 'ignore' },
      killTree,
      1800,
      platform
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
    const polite = await start(server('polite', true), async (pid) => { calls.push(pid) }, 'win32')
    const started = Date.now()
    await polite.transport.close()
    ok(Date.now() - started < 1800 && calls.length === 0, '服务按 stdin 结束自行退出时不动用进程树结束', `${Date.now() - started}ms calls=${calls.length}`)
    ok(await waitFor(() => !alive(polite.pid), 3000), '自行退出的服务确实退出')

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
