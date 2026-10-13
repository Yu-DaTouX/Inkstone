import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const root = await mkdtemp(join(tmpdir(), 'inkstone-durable-'))
try {
 const outfile = join(root, 'helper.mjs')
 await build({ entryPoints: ['src/main/write-file-durable.ts'], outfile, bundle: true, platform: 'node', format: 'esm' })
 const { writeFileDurable } = await import(pathToFileURL(outfile).href)
 const file = join(root, 'owned.tmp')
 await writeFileDurable(file, '持久临时内容')
 assert.equal(await readFile(file, 'utf8'), '持久临时内容')
 await assert.rejects(writeFileDurable(file, '不得覆盖'), { code: 'EEXIST' })
 assert.equal(await readFile(file, 'utf8'), '持久临时内容')
 console.log('write-file-durable: 3 assertions passed (真实临时文件，不模拟断电)')
} finally { await rm(root, { recursive: true, force: true }) }
