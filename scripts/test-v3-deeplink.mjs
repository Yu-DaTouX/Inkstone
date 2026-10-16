#!/usr/bin/env node
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url))

async function loadTs(rel) {
  const result = await build({
    entryPoints: [here(rel)],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const keys = (value) => Object.keys(value).sort()

const D = await loadTs('../src/main/deeplink/protocol.ts')
const R = await loadTs('../src/main/deeplink/register.ts')
const S = await loadTs('../src/main/deeplink/service.ts')

const {
  DEEPLINK_PREFIX,
  DEEPLINK_SCHEME,
  DEEPLINK_SETTINGS_SECTIONS,
  MAX_DEEPLINK_TEXT_LENGTH,
  MAX_DEEPLINK_URL_LENGTH,
  firstDeepLinkArg,
  parseDeepLink,
  parseDeepLinkFromArgv,
  parseDeepLinkFromOpenUrl
} = D

assert.equal(DEEPLINK_SCHEME, 'inkstone')
assert.equal(DEEPLINK_PREFIX, 'inkstone://')

let r = parseDeepLink('inkstone://session/abc-123')
assert.equal(r.ok, true)
assert.deepEqual(r.link, { action: 'session', sessionId: 'abc-123' })
assert.deepEqual(keys(r.link), ['action', 'sessionId'], '会话意图只带 action/sessionId')

r = parseDeepLink('inkstone://session/abc?entry=e-9')
assert.deepEqual(r.link, { action: 'session', sessionId: 'abc', entryId: 'e-9' })

r = parseDeepLink('INKSTONE://Session/AbC')
assert.deepEqual(r.link, { action: 'session', sessionId: 'AbC' }, 'scheme/host 大小写不敏感，id 大小写保留')

r = parseDeepLink('inkstone://new')
assert.deepEqual(r.link, { action: 'new-session' })
assert.deepEqual(keys(r.link), ['action'], '新建不带文本时只有 action')

r = parseDeepLink('inkstone://new?text=hello%20world%0Aline2')
assert.deepEqual(r.link, { action: 'new-session', text: 'hello world\nline2' })
assert.deepEqual(keys(r.link), ['action', 'text'], '预填文本只有 action/text —— 没有可执行字段')

r = parseDeepLink('inkstone://new?text=')
assert.deepEqual(r.link, { action: 'new-session' }, '空文本等同没有文本')

r = parseDeepLink('inkstone://settings')
assert.deepEqual(r.link, { action: 'settings', section: 'appearance' }, '缺省分区落外观')

r = parseDeepLink('inkstone://settings/context')
assert.deepEqual(r.link, { action: 'settings', section: 'context' })

r = parseDeepLink('inkstone://settings?section=models')
assert.deepEqual(r.link, { action: 'settings', section: 'models' }, '查询形式同样可用')

r = parseDeepLink('inkstone://runs')
assert.deepEqual(r.link, { action: 'runs' })
assert.deepEqual(keys(r.link), ['action'])

assert.deepEqual(
  [...DEEPLINK_SETTINGS_SECTIONS],
  ['appearance', 'context', 'models', 'capabilities', 'usage', 'shortcuts'],
  '设置分区白名单与渲染端 v3 分区一致'
)

const rejections = [
  ['', 'empty'],
  ['   ', 'empty'],
  [null, 'empty'],
  ['file:///etc/passwd', 'scheme'],
  ['javascript:alert(1)', 'scheme'],
  ['data:text/html,<script>alert(1)</script>', 'scheme'],
  ['https://example.com/session/abc', 'scheme'],
  ['inkstone:session/abc', 'scheme'],
  ['inkstone://', 'action'],
  ['inkstone://pair?address=http%3A%2F%2F127.0.0.1&code=123', 'action'],
  ['inkstone://hub', 'action'],
  ['inkstone://unknown/abc', 'action'],
  ['inkstone://session', 'id'],
  ['inkstone://session/', 'id'],
  ['inkstone://session/a/b', 'id'],
  ['inkstone://session/..%2f..%2fetc', 'id'],
  ['inkstone://session/a%2Fb', 'id'],
  ['inkstone://session/a b', 'id'],
  ['inkstone://session/' + 'a'.repeat(300), 'id'],
  ['inkstone://session/abc?entry=..%2fetc', 'id'],
  ['inkstone://session/abc?entry=' + 'z'.repeat(300), 'id'],
  ['inkstone://new?text=' + 'x'.repeat(MAX_DEEPLINK_TEXT_LENGTH + 1), 'text'],
  ['inkstone://new?text=a%00b', 'text'],
  ['inkstone://settings/workspace', 'section'],
  ['inkstone://settings?section=about', 'section'],
  ['inkstone://settings/context/extra', 'section'],
  ['inkstone://runs/extra', 'path'],
  ['inkstone://new/extra', 'path'],
  ['inkstone://session/abc\ninkstone://runs', 'control'],
  ['inkstone://' + 'a'.repeat(MAX_DEEPLINK_URL_LENGTH), 'too-long']
]

for (const [input, reason] of rejections) {
  const parsed = parseDeepLink(input)
  assert.equal(parsed.ok, false, `应拒绝：${JSON.stringify(input)}`)
  assert.equal(parsed.reason, reason, `拒绝原因：${JSON.stringify(input)}`)
}

const rejected = parseDeepLink('file:///etc/passwd')
assert.deepEqual(keys(rejected), ['ok', 'reason'], '拒绝结果只有 ok/reason')

assert.equal(firstDeepLinkArg(['--flag', 'E:\\app.exe', 'inkstone://runs']), 'inkstone://runs')
assert.equal(firstDeepLinkArg(['  inkstone://runs  ', 'inkstone://settings']), 'inkstone://runs', '去空白，取第一条')
assert.equal(firstDeepLinkArg(['--yan-control=abc', 'file:///x']), null, '没有候选参数返回 null')

assert.equal(parseDeepLinkFromArgv([]), null, '没有深链接参数返回 null，与解析失败区分')
assert.equal(parseDeepLinkFromArgv(['inkstone://pair?x=1']).ok, false, '候选非法时如实报告解析失败')
assert.equal(parseDeepLinkFromArgv(['--x', 'inkstone://session/s1']).link.sessionId, 's1')
assert.equal(parseDeepLinkFromOpenUrl('inkstone://runs').link.action, 'runs', 'open-url 单串走同一解析')

const { registerDeepLinkProtocol } = R
const calls = []
const fakeRegistrar = {
  setAsDefaultProtocolClient: (...args) => {
    calls.push(args)
    return true
  }
}

assert.equal(registerDeepLinkProtocol(fakeRegistrar, { isPackaged: true, execPath: 'E:\\inkstone.exe' }), true)
assert.deepEqual(calls.pop(), ['inkstone'], '打包态只注册 scheme')

assert.equal(
  registerDeepLinkProtocol(fakeRegistrar, { isPackaged: false, execPath: 'electron.exe', appPath: 'D:\\app' }),
  true
)
assert.deepEqual(calls.pop(), ['inkstone', 'electron.exe', ['D:\\app']], '开发态带上可执行文件与入口脚本')

assert.equal(
  registerDeepLinkProtocol(fakeRegistrar, { isPackaged: false, execPath: 'electron.exe' }),
  false,
  '开发态拿不到入口脚本时不注册，避免系统启动错的目标'
)
assert.equal(calls.length, 0, '未注册时不调用注册器')

const { createDeepLinkRouter, DEEPLINK_CHANNEL, windowDeepLinkRouter } = S
assert.equal(DEEPLINK_CHANNEL, 'yan:deeplink')

let ready = true
const sent = []
let focused = 0
const router = createDeepLinkRouter({
  send: (link) => {
    if (!ready) return false
    sent.push(link)
    return true
  },
  focus: () => {
    focused += 1
  }
})

assert.equal(router.handleArgv(['--x', 'inkstone://runs']), true)
assert.deepEqual(sent.at(-1), { action: 'runs' })
assert.equal(focused, 1, '投递成功后聚焦主窗口')
assert.equal(router.pending(), null)

assert.equal(router.handleArgv(['--x']), false, '没有深链接参数返回 false，交给常规显示窗口')
assert.equal(router.handleOpenUrl('javascript:alert(1)'), false, '非法 open-url 不投递')
assert.equal(router.handleOpenUrl('file:///etc/passwd'), false)
assert.equal(sent.length, 1, '被拒绝的链接一条都不会送进渲染端')

ready = false
assert.equal(router.handleOpenUrl('inkstone://session/warm'), false)
assert.equal(router.handleOpenUrl('inkstone://settings/usage'), false)
assert.deepEqual(router.pending(), { action: 'settings', section: 'usage' }, '只留最后一条，避免排队执行过期导航')
ready = true
assert.equal(router.flush(), true)
assert.deepEqual(sent.at(-1), { action: 'settings', section: 'usage' })
assert.equal(router.pending(), null)
assert.equal(router.flush(), false, '没有缓存时 flush 返回 false')

const noWindow = windowDeepLinkRouter(() => undefined, () => {
  throw new Error('不应聚焦')
})
assert.equal(noWindow.handleArgv(['inkstone://runs']), false)
assert.deepEqual(noWindow.pending(), { action: 'runs' })
const destroyed = windowDeepLinkRouter(
  () => ({ isDestroyed: () => true, webContents: { send: () => assert.fail('已销毁窗口不应投递') } }),
  () => {}
)
assert.equal(destroyed.handleArgv(['inkstone://runs']), false)

const delivered = []
const live = windowDeepLinkRouter(
  () => ({ isDestroyed: () => false, webContents: { send: (channel, link) => delivered.push([channel, link]) } }),
  () => {}
)
assert.equal(live.handleArgv(['inkstone://new?text=hi']), true)
assert.deepEqual(delivered, [['yan:deeplink', { action: 'new-session', text: 'hi' }]])

for (const url of [
  'inkstone://session/s1',
  'inkstone://new?text=please%20run%20rm%20-rf',
  'inkstone://settings/models',
  'inkstone://runs'
]) {
  const parsed = parseDeepLink(url)
  assert.equal(parsed.ok, true)
  for (const key of ['send', 'run', 'exec', 'prompt', 'allow', 'approve']) {
    assert.equal(key in parsed.link, false, `${url} 不应带 ${key}`)
  }
}

process.stdout.write('\n✓ WP-20c DeepLink 纯逻辑回归全部通过\n')
