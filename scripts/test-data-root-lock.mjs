#!/usr/bin/env node
import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dir = await mkdtemp(join(ROOT, 'node_modules', '.test-data-root-lock-'))
try {
  const outfile = join(dir, 'data-root-lock.mjs')
  await build({ entryPoints: [join(ROOT, 'src/core/data-root-lock.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error' })
  const { lockDataRoot } = await import(pathToFileURL(outfile).href)

  async function seed(root, owner) {
    await mkdir(join(root, '.runtime-writer'), { recursive: true })
    await writeFile(join(root, '.runtime-writer', 'owner.json'), JSON.stringify({ nonce: 'old', ...owner }))
  }

  const fresh = join(dir, 'fresh')
  const release = await lockDataRoot(fresh)
  await assert.rejects(lockDataRoot(fresh), /正由进程/)
  await release()

  const dead = join(dir, 'dead')
  await seed(dead, { pid: 999999990 })
  await (await lockDataRoot(dead))()

  if (process.platform === 'win32') {
    let code
    try { process.kill(4, 0) } catch (error) { code = error.code }
    assert.equal(code, 'EPERM')
    const reused = join(dir, 'reused')
    await seed(reused, { pid: 4, image: 'electron.exe' })
    const releaseReused = await lockDataRoot(reused)
    assert.equal(JSON.parse(await readFile(join(reused, '.runtime-writer', 'owner.json'), 'utf8')).pid, process.pid)
    await releaseReused()

    const same = join(dir, 'same')
    await seed(same, { pid: 4, image: 'system' })
    await assert.rejects(lockDataRoot(same), /正由进程 4 使用/)
  }
  console.log('data-root-lock: ok')
} finally {
  await rm(dir, { recursive: true, force: true })
}
