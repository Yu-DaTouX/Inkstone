import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
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
