import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'inkstone-pending-switch-'))
let checks = 0
const check = (value, message) => { assert.ok(value, message); checks++; console.log('PASS', message) }
const holdLock = (file, ms) => new Promise((done, fail) => {
  const script = `$f = [System.IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); Start-Sleep -Milliseconds ${ms}; $f.Close()`
  const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (chunk) => {
    out += chunk
    if (out.includes('locked')) done(child)
  })
  child.on('error', fail)
  child.on('exit', (code) => { if (!out.includes('locked')) fail(new Error(`pwsh exited ${code}`)) })
})
try {
  const out = join(root, 'pending.mjs')
  await build({ entryPoints: [resolve('src/main/pending-model-switch.ts')], outfile: out, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { writePendingModelSwitch, readPendingModelSwitch, takePendingModelSwitch, PENDING_MODEL_SWITCH_DIR } = await import(pathToFileURL(out).href)
  const data = join(root, 'data')
  const dir = join(data, PENDING_MODEL_SWITCH_DIR)
  const leftovers = async () => (await readdir(dir).catch(() => [])).filter((name) => name.endsWith('.tmp'))

  writePendingModelSwitch('s1', { provider: 'p', id: 'a' }, data)
  check(readPendingModelSwitch('s1', data)?.id === 'a', '写入后能读回待切换项')
  writePendingModelSwitch('s1', null, data)
  check(readPendingModelSwitch('s1', data) === null, '传 null 清掉待切换项')

  if (process.platform === 'win32') {
    writePendingModelSwitch('s2', { provider: 'p', id: 'a' }, data)
    const file = join(dir, 's2.json')
    const locker = await holdLock(file, 150)
    const started = Date.now()
    writePendingModelSwitch('s2', { provider: 'p', id: 'b', thinkingLevel: 'high' }, data)
    const waited = Date.now() - started
    await new Promise((done) => locker.on('exit', done))
    check(waited >= 30, `目标文件被占用时重试等待而不是立即失败（等了 ${waited}ms）`)
    check(JSON.parse(await readFile(file, 'utf8')).id === 'b', '占用解除后覆盖写入成功')
    check((await leftovers()).length === 0, '重试成功后不留临时文件')

    const relock = await holdLock(file, 150)
    check(takePendingModelSwitch('s2', data)?.id === 'b', '取走时文件被占用也能删掉')
    await new Promise((done) => relock.on('exit', done))
    check(readPendingModelSwitch('s2', data) === null, '取走后不再残留')
  }

  await mkdir(join(dir, 's3.json'), { recursive: true })
  assert.throws(() => writePendingModelSwitch('s3', { provider: 'p', id: 'a' }, data))
  check(true, '目标被目录占住时最终报错，不会无限重试')
  check((await leftovers()).length === 0, '写入失败时清掉临时文件')
  console.log(`PASS: pending model switch ${checks} checks`)
} finally {
  await rm(root, { recursive: true, force: true })
}
