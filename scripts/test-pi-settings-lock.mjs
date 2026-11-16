import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { utimesSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import lockfile from 'proper-lockfile'
import { isolatedChildEnv } from './lib/test-env.mjs'

let checks = 0
const ok = (condition, label, detail = '') => {
  assert.ok(condition, detail ? `${label}: ${detail}` : label)
  checks++
  console.log(`  ✓ ${label}`)
}

const root = await mkdtemp(join(tmpdir(), 'inkstone-pi-settings-lock-'))
try {
  const mainBundle = join(root, 'main.mjs')
  await build({
    entryPoints: ['src/main/native-compaction-line.ts'],
    outfile: mainBundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" }
  })
  const { modifyPiSettings } = await import(pathToFileURL(mainBundle).href)
  const extension = await import(pathToFileURL(resolve('resources/pi-extensions/native-session-bridge.js')).href)

  const mainChild = join(root, 'main-child.mjs')
  await writeFile(mainChild, `
import { modifyPiSettings } from ${JSON.stringify(pathToFileURL(mainBundle).href)}
const [file, key, count] = process.argv.slice(2)
let locked = 0
for (let i = 0; i < Number(count); i++) {
  for (;;) {
    try {
      await modifyPiSettings(file, (settings) => ({ next: { ...settings, [key]: (settings?.[key] ?? 0) + 1 }, result: null }))
      break
    } catch (error) {
      if (error?.code !== 'ELOCKED') throw error
      locked++
    }
  }
  await new Promise((done) => setTimeout(done, Math.random() * 8))
}
console.log(JSON.stringify({ locked }))
`)
  const extensionChild = join(root, 'extension-child.mjs')
  await writeFile(extensionChild, `
import { writeEnabledModels } from ${JSON.stringify(pathToFileURL(resolve('resources/pi-extensions/native-session-bridge.js')).href)}
const [file, count] = process.argv.slice(2)
let locked = 0
for (let i = 0; i < Number(count); i++) {
  for (;;) {
    try {
      writeEnabledModels(file, ['p' + i])
      break
    } catch (error) {
      if (error?.code !== 'ELOCKED') throw error
      locked++
    }
  }
  await new Promise((done) => setTimeout(done, Math.random() * 8))
}
console.log(JSON.stringify({ locked }))
`)
  const run = (script, args) => new Promise((done, fail) => {
    const child = spawn(process.execPath, [script, ...args], { env: isolatedChildEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('error', fail)
    child.on('close', (code) => (code === 0 ? done(out) : fail(new Error(`child exited ${code}: ${err}`))))
  })

  console.log('\n--- 并发：砚主进程与 pi 子进程里的扩展同时改 settings.json ---')
  const shared = join(root, 'settings.json')
  await writeFile(shared, JSON.stringify({ keep: 'user-value', nested: { a: 1 } }), 'utf8')
  await Promise.all([
    run(mainChild, [shared, 'a', '40']),
    run(mainChild, [shared, 'b', '40']),
    run(mainChild, [shared, 'c', '40']),
    run(extensionChild, [shared, '40'])
  ])
  const merged = JSON.parse(await readFile(shared, 'utf8'))
  ok(merged.a === 40 && merged.b === 40 && merged.c === 40, '三个进程各改自己的键，计数一次都没丢', JSON.stringify(merged))
  ok(JSON.stringify(merged.enabledModels) === JSON.stringify(['p39']) && merged.keep === 'user-value' && merged.nested.a === 1, '扩展写的 enabledModels 与原有的其他键都还在', JSON.stringify(merged))
  const leftovers = (await readdir(root)).filter((name) => name.startsWith('settings.json.'))
  ok(leftovers.length === 0, '结束后没有遗留 .lock 目录或 .tmp 文件', leftovers.join(','))

  console.log('\n--- 与 pi 原生的 proper-lockfile 是同一把锁 ---')
  const file = join(root, 'compat', 'settings.json')
  await mkdir(join(root, 'compat'), { recursive: true })
  await writeFile(file, JSON.stringify({ base: 1 }), 'utf8')
  const release = lockfile.lockSync(file, { realpath: false })
  ok((await stat(`${file}.lock`)).isDirectory(), 'pi 的 lockSync(settings.json) 用的锁目录是 settings.json.lock')
  const startedAt = Date.now()
  let mainError
  try {
    await modifyPiSettings(file, (settings) => ({ next: { ...settings, mine: 1 }, result: null }))
  } catch (error) {
    mainError = error
  }
  ok(mainError?.code === 'ELOCKED' && Date.now() - startedAt >= 150, '锁被 pi 占着：主进程按 pi 的节奏重试约 200ms 后报错，不是静默写入', `${mainError?.code} ${Date.now() - startedAt}ms`)
  let extensionError
  try {
    extension.writeEnabledModels(file, ['x'])
  } catch (error) {
    extensionError = error
  }
  ok(extensionError?.code === 'ELOCKED' && /没有写入/.test(extensionError.message), '锁被 pi 占着：扩展同样报错而不是写入', String(extensionError?.message))
  ok(JSON.stringify(JSON.parse(await readFile(file, 'utf8'))) === JSON.stringify({ base: 1 }), '两边失败时 settings.json 保持原样')
  release()
  await modifyPiSettings(file, (settings) => ({ next: { ...settings, mine: 1 }, result: null }))
  extension.writeEnabledModels(file, ['x'])
  const afterRelease = JSON.parse(await readFile(file, 'utf8'))
  ok(afterRelease.mine === 1 && afterRelease.base === 1 && afterRelease.enabledModels?.[0] === 'x', 'pi 释放后两边都能写，互不覆盖')

  let nativeBlockedInMain = ''
  await modifyPiSettings(file, (settings) => {
    try {
      lockfile.lockSync(file, { realpath: false })
    } catch (error) {
      nativeBlockedInMain = error.code
    }
    return { result: null }
  })
  ok(nativeBlockedInMain === 'ELOCKED', '砚主进程写入期间，pi 的 lockSync 会被挡住')
  let nativeBlockedInExtension = ''
  extension.withFileLockSync(file, () => {
    try {
      lockfile.lockSync(file, { realpath: false })
    } catch (error) {
      nativeBlockedInExtension = error.code
    }
  })
  ok(nativeBlockedInExtension === 'ELOCKED', '扩展写入期间，pi 的 lockSync 同样会被挡住')
  ok(!(await stat(`${file}.lock`).then(() => true, () => false)), '写完后两边都释放了锁')

  console.log('\n--- 过期的锁 ---')
  const stale = join(root, 'stale', 'settings.json')
  await mkdir(join(root, 'stale'), { recursive: true })
  await writeFile(stale, JSON.stringify({ base: 1 }), 'utf8')
  await mkdir(`${stale}.lock`)
  const old = new Date(Date.now() - 30_000)
  await utimes(`${stale}.lock`, old, old)
  await modifyPiSettings(stale, (settings) => ({ next: { ...settings, mine: 1 }, result: null }))
  ok(JSON.parse(await readFile(stale, 'utf8')).mine === 1, '主进程：超过 10 秒没更新的锁按过期处理')
  await mkdir(`${stale}.lock`)
  await utimes(`${stale}.lock`, old, old)
  extension.writeEnabledModels(stale, ['y'])
  ok(JSON.parse(await readFile(stale, 'utf8')).enabledModels?.[0] === 'y', '扩展：过期的锁同样被接管')

  console.log('\n--- Windows 上锁目录正在被删时的 EPERM/EBUSY ---')
  const fsShim = {
    name: 'fs-shim',
    setup(b) {
      b.onResolve({ filter: /^node:fs$/ }, () => ({ path: 'fs', namespace: 'fs-shim' }))
      b.onLoad({ filter: /.*/, namespace: 'fs-shim' }, () => ({
        loader: 'js',
        contents: `
import { createRequire } from 'node:module'
const real = createRequire(import.meta.url)('node:fs')
const hooks = () => (globalThis.__fsHooks ??= {})
export const { existsSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } = real
export const mkdirSync = (path, options) => {
  const hook = hooks().mkdir
  if (hook && String(path).endsWith('.lock')) hook(path)
  return real.mkdirSync(path, options)
}
export const statSync = (path, options) => {
  const result = real.statSync(path, options)
  const hook = hooks().stat
  if (hook && String(path).endsWith('.lock')) hook(path)
  return result
}
`
      }))
    }
  }
  const shimmedBundle = join(root, 'extension-shimmed.mjs')
  await build({ entryPoints: [resolve('resources/pi-extensions/native-session-bridge.js')], outfile: shimmedBundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [fsShim] })
  const shimmed = await import(pathToFileURL(shimmedBundle).href)
  const transient = join(root, 'transient', 'settings.json')
  await mkdir(join(root, 'transient'), { recursive: true })
  await writeFile(transient, JSON.stringify({ base: 1 }), 'utf8')
  for (const code of ['EPERM', 'EBUSY']) {
    let failures = 2
    globalThis.__fsHooks = { mkdir: () => { if (failures-- > 0) throw Object.assign(new Error(code), { code }) } }
    shimmed.writeEnabledModels(transient, [code])
    ok(failures < 0 && JSON.parse(await readFile(transient, 'utf8')).enabledModels?.[0] === code, `扩展：取锁时遇到 ${code} 当作被占用重试后写入成功`)
  }
  globalThis.__fsHooks = { mkdir: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) } }
  let alwaysEperm
  try {
    shimmed.writeEnabledModels(transient, ['never'])
  } catch (error) {
    alwaysEperm = error
  }
  ok(alwaysEperm?.code === 'ELOCKED' && alwaysEperm.cause?.code === 'EPERM' && JSON.parse(await readFile(transient, 'utf8')).enabledModels?.[0] === 'EBUSY', '扩展：EPERM 持续不消时超过次数后报 ELOCKED（带原始错误），不写入')
  globalThis.__fsHooks = { mkdir: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) } }
  let accessError
  try {
    shimmed.writeEnabledModels(transient, ['never'])
  } catch (error) {
    accessError = error
  }
  ok(accessError?.code === 'EACCES', '扩展：其它错误码仍然直接抛出')

  const takeover = join(root, 'takeover', 'settings.json')
  await mkdir(join(root, 'takeover'), { recursive: true })
  await writeFile(takeover, JSON.stringify({ base: 1 }), 'utf8')
  await mkdir(`${takeover}.lock`)
  await utimes(`${takeover}.lock`, old, old)
  let renewed = false
  globalThis.__fsHooks = { stat: (path) => {
    if (renewed) return
    renewed = true
    const now = new Date()
    utimesSync(path, now, now)
  } }
  let takeoverError
  try {
    shimmed.writeEnabledModels(takeover, ['stolen'])
  } catch (error) {
    takeoverError = error
  }
  ok(renewed && takeoverError?.code === 'ELOCKED' && (await stat(`${takeover}.lock`)).isDirectory() && JSON.parse(await readFile(takeover, 'utf8')).enabledModels === undefined, '扩展：过期接管前再 stat 一次，发现锁刚被别的进程更新就不删它')
  await rm(`${takeover}.lock`, { recursive: true, force: true })
  globalThis.__fsHooks = {}

  const lockStub = {
    name: 'lockfile-stub',
    setup(b) {
      b.onResolve({ filter: /^proper-lockfile$/ }, () => ({ path: 'lockfile', namespace: 'lock-stub' }))
      b.onLoad({ filter: /.*/, namespace: 'lock-stub' }, () => ({
        loader: 'js',
        contents: `export default { lock: async () => {
  const plan = globalThis.__lockPlan
  plan.calls++
  if (plan.failures.length) throw Object.assign(new Error(plan.failures[0]), { code: plan.failures.shift() })
  return async () => { plan.released++ }
} }`
      }))
    }
  }
  const stubbedBundle = join(root, 'lock-stubbed.mjs')
  await build({ entryPoints: [resolve('src/main/pi-settings-file-lock.ts')], outfile: stubbedBundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [lockStub] })
  const stubbed = await import(pathToFileURL(stubbedBundle).href)
  globalThis.__lockPlan = { calls: 0, released: 0, failures: ['ELOCKED', 'EPERM', 'EBUSY'] }
  let ran = 0
  await stubbed.withPiSettingsFileLock(join(root, 'stub', 'settings.json'), async () => { ran++ })
  ok(ran === 1 && globalThis.__lockPlan.calls === 4 && globalThis.__lockPlan.released === 1, '主进程：ELOCKED/EPERM/EBUSY 都按被占用重试，取到锁后执行并释放', JSON.stringify(globalThis.__lockPlan))
  globalThis.__lockPlan = { calls: 0, released: 0, failures: ['EACCES'] }
  const denied = await stubbed.withPiSettingsFileLock(join(root, 'stub', 'settings.json'), async () => 'ran').catch((error) => error)
  ok(denied?.code === 'EACCES' && globalThis.__lockPlan.calls === 1, '主进程：其它错误码不重试，直接抛出')
  globalThis.__lockPlan = { calls: 0, released: 0, failures: Array.from({ length: 20 }, () => 'EPERM') }
  const exhausted = await stubbed.withPiSettingsFileLock(join(root, 'stub', 'settings.json'), async () => 'ran').catch((error) => error)
  ok(exhausted?.code === 'EPERM' && globalThis.__lockPlan.calls === 10, '主进程：EPERM 持续不消时最多尝试 10 次后抛出', JSON.stringify(globalThis.__lockPlan))

  console.log('\n--- 文件不存在时 ---')
  const fresh = join(root, 'fresh', 'settings.json')
  await modifyPiSettings(fresh, (settings) => ({ next: { ...(settings ?? {}), first: true }, result: null }))
  ok(JSON.parse(await readFile(fresh, 'utf8')).first === true, '主进程：settings.json 还不存在时也能取锁并创建')
  const freshExt = join(root, 'fresh-ext', 'settings.json')
  extension.writeEnabledModels(freshExt, ['z'])
  ok(JSON.parse(await readFile(freshExt, 'utf8')).enabledModels?.[0] === 'z', '扩展：settings.json 还不存在时也能取锁并创建')

  console.log(`${checks}/${checks} 通过`)
} finally {
  await rm(root, { recursive: true, force: true })
}
