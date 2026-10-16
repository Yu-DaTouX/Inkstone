import './lib/stdio-guard.mjs'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { selectRunGroups } from './lib/visual-matrix-selection.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electron = createRequire(import.meta.url)('electron')

const ALL = ['0', '1', '2', '3', '4', '5', '6', '7', '8', 'onboarding']
const wanted = process.argv.slice(2).filter(Boolean)
const only = (process.env.YAN_MATRIX_ONLY ?? '').split(',').filter(Boolean)
const groups = selectRunGroups(wanted, only, ALL)

const GROUP_TIMEOUT_MS = Number(process.env.YAN_MATRIX_TIMEOUT_MS ?? 12 * 60_000)

let current = null

function killTree(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
    }
  }
  try {
    child.kill()
  } catch {
  }
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    killTree(current)
    process.exit(130)
  })
}

function runGroup(g) {
  return new Promise((resolvePromise) => {
    const env = { ...process.env, YAN_MATRIX_GROUP: g }
    delete env.ELECTRON_RUN_AS_NODE
    console.log(`\n${'='.repeat(64)}\n▶ 组 ${g}\n${'='.repeat(64)}`)

    const child = spawn(electron, [join(root, 'scripts/visual-matrix.mjs')], {
      cwd: root,
      env,
      stdio: 'inherit',
      windowsHide: true
    })
    current = child

    const timer = setTimeout(() => {
      console.log(`  ⤺ 组 ${g} 超过 ${Math.round(GROUP_TIMEOUT_MS / 1000)}s 没结束 → 收掉进程树，继续下一组`)
      killTree(child)
    }, GROUP_TIMEOUT_MS)

    const done = (code) => {
      clearTimeout(timer)
      if (current === child) current = null
      resolvePromise(code)
    }
    child.on('exit', (code) => done(code ?? -1))
    child.on('error', (err) => {
      console.error(`  ✗ 组 ${g} 起不来：${err.message}`)
      done(-1)
    })
  })
}

const results = []
for (const g of groups) {
  results.push({ g, code: await runGroup(g) })
}

console.log(`\n${'='.repeat(64)}`)
const bad = results.filter((r) => r.code !== 0)
for (const r of results) console.log(`  ${r.code === 0 ? '✓' : '✗'} 组 ${r.g}（退出码 ${r.code}）`)
console.log(bad.length ? `✗ ${bad.length}/${results.length} 组失败` : `✓ 全部 ${results.length} 组通过`)
process.exit(bad.length ? 1 : 0)
