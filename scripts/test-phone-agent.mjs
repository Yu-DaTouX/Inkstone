import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const work = await mkdtemp(join(tmpdir(), 'inkstone-phone-agent-'))
let checks = 0
const ok = (value, label) => { assert.ok(value, label); checks++ }
const eq = (a, b, label) => { assert.deepEqual(a, b, label); checks++ }
const rejects = async (promise, code, label) => {
  try { await promise } catch (error) { eq(error.code, code, label); return }
  assert.fail(`${label}：应当失败`)
}

const DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.demo" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]">
<node index="0" text="设置 &amp; 隐私" resource-id="com.demo:id/title" class="android.widget.TextView" package="com.demo" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[40,100][500,180]" />
<node index="1" text="" resource-id="com.demo:id/ok" class="android.widget.Button" package="com.demo" content-desc="确定" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[100,2000][980,2200]" />
<node index="2" text="" resource-id="com.demo:id/sw" class="android.widget.Switch" package="com.demo" content-desc="" checkable="true" checked="true" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[900,300][1040,380]" />
<node index="3" text="" resource-id="" class="android.view.View" package="com.demo" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,400][1080,500]" />
<node index="4" text="Search" resource-id="com.demo:id/q" class="android.widget.EditText" package="com.demo" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="true" scrollable="false" long-clickable="true" password="false" selected="false" bounds="[40,600][1040,700]" />
<node index="5" text="确定删除" resource-id="" class="android.widget.TextView" package="com.demo" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][0,0]" />
</node></hierarchy>`

try {
  const out = join(work, 'phone.mjs')
  await build({ entryPoints: ['src/main/phone-agent.ts'], outfile: out, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', external: ['electron'] })
  const m = await import(pathToFileURL(out).href)

  const elements = m.parseUiDump(DUMP)
  eq(elements.map((el) => el.ref), ['e1', 'e2', 'e3', 'e4'], '只保留有文字或可交互的元素，零面积与空白容器被丢弃')
  eq(elements[0].text, '设置 & 隐私', 'XML 实体被解码')
  eq(elements[1].desc, '确定', 'content-desc 保留')
  eq([elements[1].x, elements[1].y], [540, 2100], '中心点按 bounds 计算')
  eq(elements[2].flags, ['click', 'on'], '开关状态标成 on/off')
  ok(elements[3].flags.includes('edit') && elements[3].flags.includes('focused'), '输入框标 edit 与 focused')
  eq(m.elementLine(elements[1]), 'e2 Button desc="确定" id=ok (540,2100) [click]', '元素行格式')
  eq(m.findByText(elements, '确定').map((el) => el.ref), ['e2'], '按 desc 精确匹配')
  eq(m.findByText(elements, '隐私').map((el) => el.ref), ['e1'], '没有精确匹配时按包含匹配')
  eq(m.swipePoints('up', 1000, 2000), [500, 1600, 500, 400], 'up 是手指往上移')
  eq(m.swipePoints('sideways', 1000, 2000), null, '未知方向返回 null')

  const calls = []
  const devices = { current: 'List of devices attached\nAAA device product:x model:Pixel_8 device:x transport_id:1\n' }
  const png = Buffer.alloc(32)
  png.writeUInt32BE(0x89504e47, 0)
  png.writeUInt32BE(1080, 16)
  png.writeUInt32BE(2400, 20)
  const adb = async (args) => {
    calls.push(args)
    if (args[0] === 'devices') return Buffer.from(devices.current)
    const command = args[3]
    if (command.startsWith('uiautomator dump')) return Buffer.from(DUMP)
    if (command === 'screencap -p') return png
    if (command === 'wm size') return Buffer.from('Physical size: 1080x2400\n')
    if (command === 'pm list packages') return Buffer.from('package:com.tencent.mm\npackage:com.demo\npackage:com.android.settings\n')
    if (command.startsWith('monkey -p com.missing')) return Buffer.from('** No activities found to run, monkey aborted.\n')
    return Buffer.from('')
  }
  const phone = new m.PhoneAgentCommands({ opsDir: () => work, adb, sleep: async () => {} })
  const shellCalls = () => calls.filter((args) => args[0] === '-s').map((args) => args[3])

  const listed = await phone.run('devices', {})
  eq(listed.summary.devices[0].model, 'Pixel 8', 'devices 解析型号')

  const ui = await phone.run('ui', {})
  eq(ui.summary.device, 'AAA', '只连一台时自动选中')
  eq(ui.summary.app, 'com.demo', '回执带前台应用包名')
  ok(ui.summary.elements.split('\n').length === 4, 'ui 回执列出元素')

  calls.length = 0
  const tapped = await phone.run('tap', { ref: 'e2' })
  ok(shellCalls().includes('input tap 540 2100'), 'tap --ref 点元素中心')
  ok(shellCalls().some((c) => c.startsWith('uiautomator dump')), '动作后自动重新读界面')
  ok(tapped.summary.tapped.startsWith('e2 Button'), '回执说明点了哪个元素')

  calls.length = 0
  await phone.run('tap', { text: '隐私', quiet: true })
  ok(shellCalls().includes('input tap 270 140'), 'tap --text 按文字找元素')
  ok(!shellCalls().slice(1).some((c) => c.startsWith('uiautomator dump')), '--quiet 不再读界面')
  await rejects(phone.run('tap', { text: '不存在的按钮' }), 'phone_text_missing', '找不到文字时报错')
  await rejects(phone.run('tap', { ref: 'e99' }), 'phone_stale_ref', '过期 ref 报错')

  calls.length = 0
  await phone.run('tap', { x: '10', y: '20', hold: '800', quiet: true })
  ok(shellCalls().includes('input swipe 10 20 10 20 800'), '--hold 用原地滑动实现长按')

  calls.length = 0
  await phone.run('swipe', { direction: 'up', quiet: true })
  ok(shellCalls().includes('input swipe 540 1920 540 480 300'), 'swipe --direction 按屏幕尺寸换算')
  await phone.run('swipe', { from: '1,2', to: '3,4', ms: '500', quiet: true })
  ok(shellCalls().includes('input swipe 1 2 3 4 500'), 'swipe --from/--to 原样传坐标')
  await rejects(phone.run('swipe', { from: 'a', to: '3,4' }), 'phone_bad_args', '坐标格式不对报错')

  calls.length = 0
  await phone.run('type', { text: 'hi there', ref: 'e4', enter: true, quiet: true })
  eq(shellCalls().slice(-3), ['input tap 540 650', 'input text hi%sthere', 'input keyevent KEYCODE_ENTER'], 'type 先点输入框、转义空格、再回车')
  await rejects(phone.run('type', { text: '你好' }), 'phone_text_unsupported', '非 ASCII 文字直接报错')

  calls.length = 0
  await phone.run('key', { key: 'back', quiet: true })
  await phone.run('key', { key: 'KEYCODE_CAMERA', quiet: true })
  eq(shellCalls().slice(-2), ['input keyevent KEYCODE_BACK', 'input keyevent KEYCODE_CAMERA'], 'key 支持别名与 KEYCODE 名')
  await rejects(phone.run('key', { key: 'rm -rf' }), 'phone_bad_args', '不认识的按键报错，不进 shell')

  await rejects(phone.run('launch', { package: 'com.x; reboot' }), 'phone_bad_args', '包名校验挡住 shell 注入')
  await rejects(phone.run('launch', { package: 'com.missing.app' }), 'phone_launch_failed', '启动失败时报错')

  const apps = await phone.run('apps', { query: 'tencent' })
  eq(apps.data.packages, ['com.tencent.mm'], 'apps 按关键词过滤')

  const shot = await phone.run('screen', {})
  eq([shot.summary.width, shot.summary.height], [1080, 2400], 'screen 读出 PNG 尺寸')
  ok((await readFile(shot.summary.path)).equals(png), '截图写到 opsDir')

  devices.current = 'List of devices attached\nAAA device model:A\nBBB device model:B\n'
  await rejects(phone.run('ui', {}), 'phone_device_ambiguous', '多台设备时要求 --device')
  const picked = await phone.run('ui', { device: 'BBB' })
  eq(picked.summary.device, 'BBB', '--device 指定设备')
  await rejects(phone.run('ui', { device: 'CCC' }), 'phone_device_missing', '指定的设备不存在时报错')
  devices.current = 'List of devices attached\nAAA unauthorized\n'
  await rejects(phone.run('ui', {}), 'phone_no_device', '没有可用设备时报错')

  console.log(`phone-agent: ${checks} checks passed (fake adb, no device)`)
} finally {
  await rm(work, { recursive: true, force: true })
}
