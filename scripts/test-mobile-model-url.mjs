import assert from 'node:assert/strict'
import { build } from 'esbuild'
const built = await build({ entryPoints: ['mobile/src/assistant/model.ts'], bundle: true, platform: 'node', format: 'esm', write: false })
const { safeModelBaseUrl, chat, listModels } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
for (const url of ['http://remote.example/v1', 'http://192.168.1.2/v1', 'https://user:key@remote.example/v1', 'ftp://remote.example']) assert.throws(() => safeModelBaseUrl(url))
assert.equal(safeModelBaseUrl('https://remote.example/v1/'), 'https://remote.example/v1')
assert.equal(safeModelBaseUrl('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234/v1')
assert.equal(safeModelBaseUrl('http://[::1]:1234/v1'), 'http://[::1]:1234/v1')
await assert.rejects(chat({ baseUrl: 'http://remote.example', apiKey: 'fixture', messages: [], model: 'fixture' }), /HTTPS/)
await assert.rejects(listModels('http://remote.example', 'fixture'), /HTTPS/)
console.log('mobile-model-url: 9 assertions passed (纯函数/请求前拒绝，不连接真机或模型)')
