#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const KEY = 'NoDefaultCurrentDirectoryInExePath'
const report = { pass: 0, fail: 0 }
async function check(message, fn) {
  try {
    await fn()
    report.pass += 1
    process.stdout.write(`  ✓ ${message}\n`)
  } catch (error) {
    report.fail += 1
    process.stdout.write(`  ✗ ${message}\n    ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'yan-exe-search-guard-'))
const source = fileURLToPath(new URL('../src/main/exe-search-guard.ts', import.meta.url))
const guard = join(root, 'guard.mjs')
await build({ entryPoints: [source], bundle: true, platform: 'node', format: 'esm', outfile: guard, logLevel: 'silent' })

const project = join(root, 'project')
mkdirSync(project, { recursive: true })
const probe = join(root, 'probe.mjs')
writeFileSync(probe, [
  "import { execFile } from 'node:child_process'",
  'const [guardUrl, cwd] = process.argv.slice(2)',
  "const before = process.env.NoDefaultCurrentDirectoryInExePath ?? ''",
  "const mod = guardUrl === '-' ? null : await import(guardUrl)",
  "const after = process.env.NoDefaultCurrentDirectoryInExePath ?? ''",
  "const stripped = mod ? mod.withoutExeSearchGuard({ ...process.env }).NoDefaultCurrentDirectoryInExePath ?? '' : ''",
  "execFile('git', ['--version'], { cwd, windowsHide: true }, (error, stdout, stderr) => {",
  "  process.stdout.write(JSON.stringify({ before, after, stripped, output: `${stdout}${stderr}`.trim(), failed: !!error }))",
  '})'
].join('\n'))

function runProbe(env, withGuard) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [probe, withGuard ? pathToFileURL(guard).href : '-', project], { env, windowsHide: true }, (error, stdout) => {
      if (error) reject(error)
      else resolve(JSON.parse(stdout))
    })
  })
}

const bare = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== KEY.toLowerCase()))

if (process.platform === 'win32') {
  copyFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'), join(project, 'git.exe'))

  await check('没有防护时，工作目录里的同名 exe 会抢在 PATH 之前（确认测试本身有效）', async () => {
    const result = await runProbe(bare, false)
    assert.equal(result.after, '')
    assert.doesNotMatch(result.output, /^git version/)
  })

  await check('加载防护模块后，裸命令不再从工作目录解析', async () => {
    const result = await runProbe(bare, true)
    assert.equal(result.before, '')
    assert.equal(result.after, '1')
    assert.ok(/^git version/.test(result.output) || result.failed, result.output)
    assert.doesNotMatch(result.output, /whoami|\\/)
  })

  await check('交给终端的环境去掉砚自己加的变量', async () => {
    const result = await runProbe(bare, true)
    assert.equal(result.stripped, '')
  })

  await check('用户自己设置过这个变量时保持原值，终端环境也不去掉', async () => {
    const result = await runProbe({ ...bare, [KEY]: 'user' }, true)
    assert.equal(result.after, 'user')
    assert.equal(result.stripped, 'user')
  })
} else {
  await check('非 Windows 平台不设置这个变量', async () => {
    const result = await runProbe(bare, true)
    assert.equal(result.after, '')
  })
}

rmSync(root, { recursive: true, force: true, maxRetries: 3 })
process.stdout.write(`\n同名可执行文件防护：${report.pass} 通过 / ${report.fail} 失败\n`)
if (report.fail || report.pass === 0) process.exitCode = 1
