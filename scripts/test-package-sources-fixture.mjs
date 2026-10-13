import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writePackageSourcesForTest } from './helpers/package-sources-fixture.mjs'
const root = await mkdtemp(join(tmpdir(), 'inkstone-package-fixture-'))
try {
 const file = join(root, 'settings.json')
 await writeFile(file, '{broken')
 assert.throws(() => writePackageSourcesForTest(file, ['npm:fixture']))
 assert.equal(await readFile(file, 'utf8'), '{broken')
 await writeFile(file, JSON.stringify({ other: 'kept' }))
 writePackageSourcesForTest(file, ['npm:fixture'])
 assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { other: 'kept', packages: ['npm:fixture'] })
 assert.deepEqual(await readdir(root), ['settings.json'])
 assert.equal((await readFile('src/main/packages.ts', 'utf8')).includes('writePackageSourcesForTest'), false)
 console.log('package-sources-fixture: 5 assertions passed (纯测试，无pi CLI/安装)')
} finally { await rm(root, { recursive: true, force: true }) }
