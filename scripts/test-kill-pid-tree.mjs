import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const work = await mkdtemp(join(tmpdir(), 'yan-kill-tree-'))
try {
  const outfile = join(work, 'git-service.mjs')
  await build({
    entryPoints: ['src/main/git-service.ts'], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    external: ['electron'], plugins: [{ name: 'electron-stub', setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ loader: 'js', contents: 'export const app = { getPath: () => process.cwd() }' }))
    } }]
  })
  const { killPidTree } = await import(pathToFileURL(outfile).href)
  const alive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  assert.ok(child.pid && alive(child.pid), '子进程在运行')
  const result = killPidTree(child.pid, () => child.kill())
  assert.ok(result instanceof Promise, 'killPidTree 返回 Promise')
  await result
  assert.equal(alive(child.pid), false, 'Promise 返回时进程树已经结束，不是刚发出 taskkill')
  assert.equal(await killPidTree(undefined, () => {}), undefined, '没有 pid 时走兜底并正常返回')
  console.log('kill-pid-tree: ok')
} finally {
  await rm(work, { recursive: true, force: true })
}
