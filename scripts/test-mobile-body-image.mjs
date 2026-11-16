import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const built = await build({ stdin: { contents: `export * from './src/bodyImage'; export * from './src/messageBlocks'`, resolveDir: 'mobile', loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false })
const M = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const host = 'http://192.168.1.5:37892'
const relay = 'relay://My-PC'
const attachment = `${host}/remote/v1/sessions/s%201/images/m1/0`
const artifact = `${host}/remote/v1/sessions/s1/artifacts/a1`

const tap = [
  'http://attacker.example/p?d=secret',
  'https://attacker.example/p?d=secret',
  '//attacker.example/p.png',
  'HTTPS://Attacker.Example/p.png',
  'HtTp://attacker.example/p.png',
  '  https://attacker.example/p.png  ',
  '\thttps://attacker.example/p.png\n',
  'ht\ttps://attacker.example/p.png',
  'https:\\\\attacker.example\\p.png',
  '\\\\attacker.example/p.png',
  'https://192.168.1.5:37892@attacker.example/remote/v1/sessions/s1/images/m1/0',
  'http://192.168.1.5:37892.attacker.example/remote/v1/sessions/s1/images/m1/0',
  `${host}/remote/v1/sessions/s1/images/m1/0?d=secret`,
  `${host}/remote/v1/sessions/s1/images/m1/0#d=secret`,
  `${host}/remote/v1/status`,
  `${host}/remote/v1/sessions/s1/images/../../questions`,
  `${host}/remote/v1/sessions/s1/artifacts/..`,
  `${host}/remote/v1/sessions/s1/artifacts/%2E%2e`,
  `${host}/remote/v1/sessions/./artifacts/a1`,
  'http://192.168.1.5:37893/remote/v1/sessions/s1/images/m1/0',
  'https://192.168.1.5:37892/remote/v1/sessions/s1/images/m1/0'
]
for (const url of tap) {
  assert.equal(M.needsTapToLoad(url, host), true, `外部地址必须点按加载：${JSON.stringify(url)}`)
  assert.equal(M.needsTapToLoad(url), true, `没有宿主地址时同样点按加载：${JSON.stringify(url)}`)
}

const auto = [
  attachment,
  artifact,
  ` ${attachment} `,
  attachment.replace('http://', 'HTTP://'),
  'data:image/png;base64,iVBORw0KGgo=',
  ' DATA:image/gif;base64,R0lGOD== ',
  'C:\\Users\\me\\shot.png',
  '/home/me/shot.png',
  'shot.png',
  'file:///C:/Users/me/shot.png',
  'javascript:alert(1)',
  'ftp://attacker.example/p.png'
]
for (const url of auto) assert.equal(M.needsTapToLoad(url, host), false, `不需要点按：${JSON.stringify(url)}`)

assert.deepEqual(M.planBodyImage(attachment, host), { kind: 'host', uri: attachment })
assert.deepEqual(M.planBodyImage(` ${artifact}`, host), { kind: 'host', uri: artifact })
assert.deepEqual(M.planBodyImage(`${relay}/remote/v1/sessions/s1/images/m1/2`, relay), { kind: 'host', uri: `${relay}/remote/v1/sessions/s1/images/m1/2` })
assert.equal(M.planBodyImage(attachment).kind, 'remote', '不知道宿主地址时宿主形状的地址也要点按')
assert.equal(M.planBodyImage(attachment, '').kind, 'remote')

assert.deepEqual(M.planBodyImage('https://Attacker.Example:8443/p.png?d=1', host), { kind: 'remote', uri: 'https://Attacker.Example:8443/p.png?d=1', host: 'attacker.example' })
assert.deepEqual(M.planBodyImage('//cdn.example.com/a.png', host), { kind: 'remote', uri: 'https://cdn.example.com/a.png', host: 'cdn.example.com' })
assert.deepEqual(M.planBodyImage('  HTTP://user:pw@evil.example/x  ', host), { kind: 'remote', uri: 'HTTP://user:pw@evil.example/x', host: 'evil.example' })
assert.equal(M.planBodyImage('https://trusted.example@evil.example/x', host).host, 'evil.example')
assert.equal(M.planBodyImage('http://[2001:db8::1]:8080/x.png', host).host, '[2001:db8::1]')
assert.equal(M.planBodyImage('https:///x.png', host).host, 'x.png', '和 OkHttp 一样跳过多余斜杠')
assert.deepEqual(M.planBodyImage('ht\ttps:\\\\attacker.example\\p.png', host), { kind: 'remote', uri: 'https://attacker.example/p.png', host: 'attacker.example' })

assert.deepEqual(M.planBodyImage('data:image/png;base64,iVBORw0KGgo=', host), { kind: 'inline', uri: 'data:image/png;base64,iVBORw0KGgo=' })
assert.equal(M.planBodyImage('data:text/html,<img src=x>', host).kind, 'local', '非图片的 data: 不渲染')
assert.deepEqual(M.planBodyImage('C:\\Users\\me\\shot.png', host), { kind: 'local', name: 'shot.png' })
assert.deepEqual(M.planBodyImage('/home/me/shot.png', host), { kind: 'local', name: 'shot.png' })

const blocks = M.parseMessageBlocks('前言\n![x](https://attacker.example/p?d=secret)\n后记', false)
const image = blocks.find((block) => block.kind === 'image')
assert.ok(image, '整行图片解析成 image 块')
assert.equal(M.needsTapToLoad(image.url, host), true, '消息里的远程图片块需要点按加载')

console.log('mobile-body-image: 消息图片点按加载判定通过')
