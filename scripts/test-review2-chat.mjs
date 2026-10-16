import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
async function load(relative) {
  const result = await build({
    entryPoints: [path.join(root, relative)],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    target: 'es2022'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const at = await load('src/renderer/src/features/composer/at-query.ts')
const directory = String.raw`C:\Users\me\Documents\X`.slice(0, -1)
const quotedPath = `@"${directory}"`
const atRange = at.findAtQuery(quotedPath)
assert.equal(atRange?.query, directory)
const completed = at.replaceAtQuery(quotedPath, atRange, `${directory}report.txt`).value
assert.equal(completed, `@"${directory}report.txt"`)

const slash = await load('src/renderer/src/features/composer/slash-query.ts')
assert.deepEqual(slash.findSlashQuery('  /model'), { query: 'model', start: 3, end: 8 })
assert.equal(slash.findSlashQuery('run /model later'), null)

console.log('review2 chat behavior checks: passed (at-query, slash-query)')
