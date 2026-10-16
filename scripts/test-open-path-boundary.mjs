import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { runInNewContext } from 'node:vm'
import { transform } from 'esbuild'

const source = await readFile('src/main/index.ts', 'utf8')
const start = source.indexOf("  handle('yan:openPath',")
const end = source.indexOf('\n  })', start)
assert.ok(start >= 0 && end > start)
const snippet = source.slice(start, end + '\n  })'.length)
const { code } = await transform(snippet, { loader: 'ts' })
const fsCalls = [], shellCalls = []
let callback
runInNewContext(code, {
  handle: (channel, fn) => { assert.equal(channel, 'yan:openPath'); callback = fn },
  existsSync: path => { fsCalls.push(path); return path !== 'missing' },
  dirname,
  shell: { openPath: async path => { shellCalls.push(path); return '' } }
})
for (const path of ['\\\\server\\share\\file.txt', '//server/share/file.txt', '  //server/share/file.txt', '\\/server/share', '/\\server/share']) {
  const result = await callback(path)
  assert.equal(result.error, 'network path', path)
}
assert.equal(fsCalls.length, 0, '网络路径在existsSync前拒绝')
assert.equal(shellCalls.length, 0, '网络路径不调系统壳')
assert.equal((await callback(null)).error, 'empty path')
assert.equal((await callback({})).error, 'empty path')
assert.equal((await callback('missing')).error, 'missing')
assert.equal((await callback('C:/fixture/document.txt')).ok, true)
assert.equal(shellCalls.length, 1)
console.log('open-path-boundary: 12 assertions passed (UNC/混合分隔符/类型/正常路径)')
