import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const buildDir = join('.tmp', 'full-audit-1022', 'F6')
await mkdir(buildDir, { recursive: true })
const dir = await mkdtemp(join(buildDir, 'rpc-lifecycle-'))
try {
  const bundle = join(dir, 'protocol.mjs')
  await build({
    entryPoints: ['src/main/protocol.ts'],
    outfile: bundle,
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['electron'],
    logLevel: 'silent'
  })
  const { PiRpc } = await import(pathToFileURL(bundle).href)

  const rpc = new PiRpc({ cwd: process.cwd(), piBin: process.execPath })
  const child = new EventEmitter()
  child.pid = 4242
  child.exitCode = null
  child.signalCode = null
  child.stdin = { end: () => {} }
  child.killed = false
  child.kill = () => {
    child.killed = true
  }
  child.off = child.removeListener.bind(child)
  rpc.child = child

  assert.equal(rpc.running, true, '托管子进程时 running 为真')
  const closed = rpc.close()
  assert.equal(rpc.running, false, 'close 之后 running 立即为假')
  assert.equal(child.listenerCount('exit'), 1, 'close 期间挂了一个 exit 等待者')
  child.emit('exit', 0, null)
  await closed
  assert.equal(child.listenerCount('exit'), 0, 'close 完成后不再残留 exit 监听')
  assert.equal(child.killed, false, '进程自然退出时不需要补 kill')

  const cliPath = resolve(dir, 'fake-pi.mjs')
  await writeFile(
    cliPath,
    "import { createInterface } from 'node:readline'\nconst input = createInterface({ input: process.stdin })\ninput.on('line', (line) => { const { id, type } = JSON.parse(line); console.log(JSON.stringify({ type: 'response', id, command: type, success: true })) })\ninput.on('close', () => process.exit(0))\n"
  )
  const real = new PiRpc({ cwd: dir, piBin: cliPath })
  real.spawn()
  assert.equal(real.running, true, '首次 spawn 后 running 为真')
  assert.equal((await real.command('get_state', {}, { timeoutMs: 2000 })).success, true, '首个进程实际完成 RPC 握手')
  const previous = real.child
  const stopping = real.close()
  const sameClose = real.close() === stopping
  await stopping
  assert.equal(real.running, false, 'close 后 running 为假')
  const staleFrames = []
  real.on('event', (frame) => staleFrames.push(frame))
  real.spawn()
  const replacement = real.child
  try {
    assert.equal(real.running, true, '无需延迟即可启动替代 pi 子进程')
    previous.stdout.emit('data', '{"type":"stale-fixture"}\n')
    previous.emit('close', 0, null)
    assert.equal(staleFrames.length, 0, '旧子进程迟到的 stdout 不进入新 RPC 实例')
    assert.equal(real.running, true, '旧子进程迟到的 close 不关闭替代进程')
    assert.equal((await real.command('get_state', {}, { timeoutMs: 2000 })).success, true, '替代进程仍能独立返回 RPC 回执')
  } finally {
    if (real.running) await real.close()
    else replacement.stdin.end()
  }
  assert.equal(real.running, false, '结束时进程已收尾')
  assert.equal(sameClose, true, '同时关闭时等待同一次收尾')

  const grandchildPidFile = resolve(dir, 'grandchild.pid')
  const stubbornPath = resolve(dir, 'stubborn-pi.mjs')
  const holderPath = resolve(dir, 'mcp-holder.mjs')
  await writeFile(holderPath, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(grandchildPidFile)}, String(process.pid))\nsetInterval(() => {}, 1000)\n`)
  await writeFile(
    stubbornPath,
    [
      "import { spawn } from 'node:child_process'",
      process.platform === 'win32'
        ? `spawn('cmd.exe', ['/d', '/s', '/c', ${JSON.stringify(`""${process.execPath}" "${holderPath}""`)}], { stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: true })`
        : `spawn(process.execPath, [${JSON.stringify(holderPath)}], { stdio: 'ignore' })`,
      "process.stdin.resume()",
      "setInterval(() => {}, 1000)"
    ].join('\n')
  )
  const stubborn = new PiRpc({ cwd: dir, piBin: stubbornPath })
  stubborn.spawn()
  let grandchildPid = 0
  for (let i = 0; i < 100 && !grandchildPid; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    grandchildPid = Number(await readFile(grandchildPidFile, 'utf8').catch(() => '0'))
  }
  if (!grandchildPid) await stubborn.close()
  assert.ok(grandchildPid > 0, '模拟 pi 已启动自己的子进程')
  await stubborn.close()
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
  let gone = false
  for (let i = 0; i < 60 && !gone; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    gone = !alive(grandchildPid)
  }
  if (!gone) process.kill(grandchildPid)
  assert.ok(gone, 'pi 不响应关闭时连同它启动的子进程一起结束')

  await rm(grandchildPidFile, { force: true })
  const automatic = new PiRpc({ cwd: dir, piBin: stubbornPath })
  automatic.spawn()
  const automaticPiPid = automatic.child?.pid
  let keptPid = 0
  for (let i = 0; i < 100 && !keptPid; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    keptPid = Number(await readFile(grandchildPidFile, 'utf8').catch(() => '0'))
  }
  if (!keptPid) await automatic.close()
  assert.ok(keptPid > 0 && automaticPiPid > 0, '自动关闭的用例：模拟 pi 已启动自己的子进程')
  await automatic.close({ killTree: false })
  let piGone = false
  for (let i = 0; i < 30 && !piGone; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    piGone = !alive(automaticPiPid)
  }
  const keptAlive = alive(keptPid)
  try { process.kill(keptPid) } catch {}
  assert.ok(piGone && automatic.running === false, '自动关闭超时时只结束 pi 本身')
  assert.ok(keptAlive, '自动关闭超时时不连带结束 pi 启动的其他进程（dev server、GUI 等）')

  if (process.platform === 'win32') {
    const readPid = async (file) => {
      let pid = 0
      for (let i = 0; i < 200 && !pid; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        pid = Number(await readFile(file, 'utf8').catch(() => '0'))
      }
      return pid
    }
    const waitGone = async (pid, ms) => {
      for (let i = 0; i < ms / 100 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 100))
      return !alive(pid)
    }
    const crashPi = resolve(dir, 'crash-pi.mjs')
    const devPath = resolve(dir, 'dev-server.cjs')
    const devPidFile = resolve(dir, 'dev.pid')
    await writeFile(devPath, "require('node:fs').writeFileSync(" + JSON.stringify(devPidFile) + ", String(process.pid))\nsetInterval(() => {}, 1000)\n")
    const launcherPath = resolve(dir, 'launcher.cjs')
    const agentDir = resolve(dir, 'agent')
    await mkdir(agentDir, { recursive: true })
    await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
      holder: { command: process.execPath, args: [holderPath] },
      launcher: { command: process.execPath, args: [launcherPath] }
    } }))
    const trackedEnv = { PI_CODING_AGENT_DIR: agentDir }
    await writeFile(crashPi, [
      "import { spawn } from 'node:child_process'",
      "spawn('cmd.exe', ['/d', '/s', '/c', " + JSON.stringify('""' + process.execPath + '" "' + holderPath + '""') + "], { stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: true })",
      "spawn(process.execPath, [" + JSON.stringify(devPath) + "], { stdio: 'ignore', detached: true, windowsHide: true })",
      'setTimeout(() => process.exit(1), 7000)'
    ].join('\n'))
    const crashing = new PiRpc({ cwd: dir, piBin: crashPi, trackTree: true, env: trackedEnv })
    const exited = new Promise((resolve) => crashing.once('exit', resolve))
    await writeFile(grandchildPidFile, '0')
    crashing.spawn()
    const crashHolder = await readPid(grandchildPidFile)
    assert.ok(crashHolder > 0, '会崩溃的模拟 pi 起了孙进程')
    await exited
    await crashing.close()
    assert.ok(await waitGone(crashHolder, 8000), 'pi 崩溃退出后它留下的孙进程被结束（cmd 包装器随 pi 退出后孙进程成了孤儿）')
    if (alive(crashHolder)) process.kill(crashHolder)
    const devPid = Number(await readFile(devPidFile, 'utf8').catch(() => '0'))
    assert.ok(devPid > 0 && alive(devPid), 'pi 崩溃后，用户让它起的长期进程（dev server）不被结束')
    process.kill(devPid)

    const orphanPidFile = resolve(dir, 'orphan.pid')
    await writeFile(launcherPath, [
      "const { spawn } = require('node:child_process')",
      "const holder = spawn(process.execPath, [process.argv[2]], { stdio: 'ignore', windowsHide: true, detached: true })",
      'setTimeout(() => process.exit(0), 5500)'
    ].join('\n'))
    const holderOnly = resolve(dir, 'orphan-holder.cjs')
    await writeFile(holderOnly, "require('node:fs').writeFileSync(" + JSON.stringify(orphanPidFile) + ", String(process.pid))\nsetInterval(() => {}, 1000)\n")
    const middlePi = resolve(dir, 'middle-pi.mjs')
    await writeFile(middlePi, [
      "import { spawn } from 'node:child_process'",
      'spawn(process.execPath, [' + JSON.stringify(launcherPath) + ', ' + JSON.stringify(holderOnly) + "], { stdio: 'ignore', windowsHide: true })",
      'process.stdin.resume()',
      "process.stdin.on('end', () => process.exit(0))",
      'setInterval(() => {}, 1000)'
    ].join('\n'))
    const middle = new PiRpc({ cwd: dir, piBin: middlePi, trackTree: true, env: trackedEnv })
    middle.spawn()
    const orphan = await readPid(orphanPidFile)
    assert.ok(orphan > 0, '模拟 pi 的中间进程起了孙进程')
    await new Promise((resolve) => setTimeout(resolve, 6500))
    assert.ok(alive(orphan), '中间进程退出后孙进程成为孤儿，仍在运行')
    await middle.close()
    assert.ok(await waitGone(orphan, 8000), '停止 pi 时按运行期间记下的子孙快照结束已成孤儿的孙进程')
    if (alive(orphan)) process.kill(orphan)
  }

  console.log('test-rpc-lifecycle: 全部通过')
} finally {
  await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
