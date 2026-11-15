import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { runInNewContext } from 'node:vm'
import { build, transform } from 'esbuild'

const shared = await build({ entryPoints: ['src/shared/network-path.ts'], bundle: true, format: 'iife', globalName: 'networkPath', platform: 'neutral', write: false, logLevel: 'silent' })
const networkContext = {}
runInNewContext(shared.outputFiles[0].text, networkContext)
const { isNetworkPath } = networkContext.networkPath

const source = await readFile('src/main/ipc/shell-ipc.ts', 'utf8')
const snippet = (channel) => {
  const start = source.indexOf(`  handle('${channel}',`)
  const end = source.indexOf('\n  })', start)
  assert.ok(start >= 0 && end > start, channel)
  return source.slice(start, end + '\n  })'.length)
}
const fsCalls = [], shellCalls = []
const handlers = {}
const context = {
  handle: (channel, fn) => { handlers[channel] = fn },
  existsSync: path => { fsCalls.push(path); return path !== 'missing' },
  statSync: () => ({ isDirectory: () => false }),
  openBlockedByName: () => false,
  isNetworkPath,
  dirname,
  shell: {
    openPath: async path => { shellCalls.push(path); return '' },
    showItemInFolder: path => { shellCalls.push(path) }
  }
}
for (const channel of ['yan:openPath', 'yan:revealPath']) {
  const { code } = await transform(snippet(channel), { loader: 'ts' })
  runInNewContext(code, context)
}
const open = handlers['yan:openPath']
const reveal = handlers['yan:revealPath']
let checks = 0
const networkPaths = ['\\\\server\\share\\file.txt', '//server/share/file.txt', '  //server/share/file.txt', '\\/server/share', '/\\server/share', '\\\\?\\UNC\\server\\share\\file.txt', '\\\\.\\pipe\\x', '\\\\.\\C:\\..\\UNC\\server\\share', '\\??\\UNC\\server\\share\\file.txt', '\\??\\C:\\fixture\\document.txt']
for (const path of networkPaths) {
  assert.equal((await open(path)).error, 'network path', path)
  assert.equal((await reveal(path)).ok, false, path)
  checks += 2
}
assert.equal(fsCalls.length, 0, '网络路径在existsSync前拒绝')
assert.equal(shellCalls.length, 0, '网络路径不调系统壳')
assert.equal((await open(null)).error, 'empty path')
assert.equal((await open({})).error, 'empty path')
assert.equal((await open('missing')).error, 'missing')
assert.equal((await open('C:/fixture/document.txt')).ok, true)
checks += 4
for (const path of ['\\\\?\\C:\\fixture\\document.txt', '\\\\.\\C:\\fixture\\document.txt']) {
  assert.equal((await open(path)).ok, true, `本地长路径可以打开：${path}`)
  assert.equal((await reveal(path)).ok, true, `本地长路径可以定位：${path}`)
  checks += 2
}
assert.equal((await reveal('C:/fixture/document.txt')).ok, true)
assert.equal(shellCalls.length, 6)
checks += 2
console.log(`open-path-boundary: ${checks} assertions passed (UNC/混合分隔符/本地长路径/类型/正常路径)`)
