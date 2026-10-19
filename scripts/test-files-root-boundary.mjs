import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { win32, posix } from 'node:path'
import { runInNewContext } from 'node:vm'
import { transform } from 'esbuild'
import { sliceDeclaration } from './lib/source-slice.mjs'
const source = await readFile('src/main/file-path-gate.ts', 'utf8')
const snippet = sliceDeclaration(source, 'export function lexicalJoin(').replace(/^export /, '')
const { code } = await transform(snippet + '\nglobalThis.safeJoin=lexicalJoin', { loader: 'ts' })
for (const [path, root, normal] of [[win32, 'C:\\', 'C:\\project'], [posix, '/', '/project']]) {
 const context = { resolve: path.resolve, join: path.join, sep: path.sep }
 runInNewContext(code, context)
 assert.equal(context.safeJoin(root, 'child/file.txt'), path.join(root, 'child/file.txt'))
 assert.equal(context.safeJoin(normal, 'child/file.txt'), path.join(normal, 'child/file.txt'))
 assert.equal(context.safeJoin(normal, '../outside.txt'), null)
 assert.equal(context.safeJoin(root, 'D:/outside.txt'), null)
}
console.log('files-root-boundary: 8 assertions passed (路径纯函数，不代表跨平台产品验收)')
