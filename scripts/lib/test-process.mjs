import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { finished } from 'node:stream/promises'
import { createTestSandbox } from './test-env.mjs'

export async function runTestProcess({ script, logPath, timeoutMs = 120_000, cwd = resolve() }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('测试超时必须是正数')
  await mkdir(dirname(logPath), { recursive: true })
  const sandbox = createTestSandbox()
  const started = Date.now()
  const log = createWriteStream(logPath, { flags: 'wx' })
  let child
  let timer
  let timedOut = false
  let error
  let tail = ''
  let stopped = false
  const stop = () => {
    if (!child?.pid || stopped) return
    stopped = true
    if (process.platform === 'win32') {
      const killed = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000, stdio: 'ignore' })
      if (killed.status !== 0) child.kill('SIGKILL')
    } else {
      try { process.kill(-child.pid, 'SIGKILL') } catch (failure) {
        if (failure.code !== 'ESRCH') child.kill('SIGKILL')
      }
    }
  }
  log.on('error', (failure) => { error = failure; stop() })
  const logDone = finished(log).catch((failure) => { error = failure })
  try {
    child = spawn(process.execPath, [script], {
      cwd, env: sandbox.env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
    })
    const collect = (chunk) => {
      tail = (tail + chunk.toString('utf8')).slice(-8000)
      log.write(chunk)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (failure) => { error = failure })
    timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    const { code, signal } = await new Promise((done) => child.once('close', (code, signal) => done({ code, signal })))
    stopped = true
    clearTimeout(timer)
    log.end()
    await logDone
    return {
      ok: code === 0 && !timedOut && !error,
      code, signal, timedOut, error: error?.message,
      elapsed: Date.now() - started, tail, logPath
    }
  } finally {
    clearTimeout(timer)
    log.end()
    await logDone
    await rm(sandbox.root, { recursive: true, force: true, maxRetries: 3 })
  }
}

export async function runTestPool(scripts, run, concurrency = 4) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('并发数必须是正整数')
  const queue = [...scripts]
  const results = new Map()
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let script = queue.shift(); script; script = queue.shift()) results.set(script, await run(script))
  }))
  return scripts.map((script) => results.get(script))
}
