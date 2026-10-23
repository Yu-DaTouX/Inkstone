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

  const cliPath = join(dir, 'fake-pi.mjs')
  await writeFile(
    cliPath,
    "process.stdin.resume()\nprocess.stdin.on('end', () => process.exit(0))\nprocess.stdout.write('{\"type\":\"revision\",\"revision\":1}\\n')\n"
  )
  const real = new PiRpc({ cwd: dir, piBin: cliPath })
  real.spawn()
  assert.equal(real.running, true, '首次 spawn 后 running 为真')
  await real.close()
  assert.equal(real.running, false, 'close 后 running 为假')
  await new Promise((resolve) => setTimeout(resolve, 400))
  real.spawn()
  assert.equal(real.running, true, 'close 之后再次 spawn 会复位状态，command 不会误报「pi 未运行」')
  await real.close()
  assert.equal(real.running, false, '结束时进程已收尾')

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

  console.log('test-rpc-lifecycle: 全部通过')
} finally {
  await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
