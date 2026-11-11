import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

let checks = 0
const ok = (condition, label, detail) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : ` ← ${JSON.stringify(detail)}`}`)
  checks++
}
const wait = async (predicate, ms = 3000) => {
  const deadline = Date.now() + ms
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
  return predicate()
}

const dir = await mkdtemp(join(tmpdir(), 'inkstone-local-file-server-'))
try {
  const fsStub = `
    import * as real from 'fs'
    export * from 'fs'
    export function createReadStream(...args) {
      const stream = real.createReadStream(...args)
      globalThis.__localFileStreams = [...(globalThis.__localFileStreams ?? []), stream]
      return stream
    }
  `
  const plugin = {
    name: 'fs-spy',
    setup(api) {
      api.onResolve({ filter: /^node:fs$/ }, () => ({ path: 'fs-spy', namespace: 'fixture' }))
      api.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: fsStub, loader: 'js', resolveDir: process.cwd() }))
    }
  }
  const outfile = join(dir, 'local-file-server.mjs')
  await build({ entryPoints: ['src/main/browser/local-file-server.ts'], outfile, bundle: true, platform: 'node', format: 'esm', plugins: [plugin], logLevel: 'silent' })
  const { serveLocalFile, closeAllLocalFileServers } = await import(pathToFileURL(outfile).href)

  const root = join(dir, 'site')
  await mkdir(root)
  await writeFile(join(root, 'index.html'), '<html>ok</html>')
  await writeFile(join(root, 'big.txt'), Buffer.alloc(16 * 1024 * 1024, 97))

  const entry = await serveLocalFile(join(root, 'index.html'), root)
  const bigUrl = new URL('big.txt', entry)
  globalThis.__localFileStreams = []
  await new Promise((resolve, reject) => {
    const req = request(bigUrl, { headers: { 'sec-fetch-dest': 'document' } }, (res) => {
      res.once('data', () => {
        res.destroy()
        resolve()
      })
    })
    req.on('error', () => resolve())
    req.end()
    setTimeout(() => reject(new Error('no data')), 5000).unref()
  })
  ok(globalThis.__localFileStreams.length === 1, '请求创建了一条源文件流', globalThis.__localFileStreams.length)
  ok(await wait(() => globalThis.__localFileStreams[0].destroyed), '客户端中断后源文件流被销毁（句柄释放）')

  const status = await new Promise((resolve, reject) => {
    request(new URL('index.html', entry), { headers: { 'sec-fetch-dest': 'document' } }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    }).on('error', reject).end()
  })
  ok(status === 200, '中断之后服务仍能正常响应', status)

  await closeAllLocalFileServers()
  const refused = await new Promise((resolve) => {
    request(new URL('index.html', entry), { headers: { 'sec-fetch-dest': 'document' } }, () => resolve(false)).on('error', () => resolve(true)).end()
  })
  ok(refused, '关闭全部本地文件服务器后原端口不再接受连接')

  const again = await serveLocalFile(join(root, 'index.html'), root)
  ok(again !== entry, '关闭后再次请求会重新起服务并换新地址', again)
  await closeAllLocalFileServers()
  await closeAllLocalFileServers()
  ok(true, '重复关闭不抛错')
} finally {
  await rm(dir, { recursive: true, force: true })
}
console.log(`browser local-file-server: ${checks} checks passed`)
