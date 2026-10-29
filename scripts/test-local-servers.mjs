#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const workDir = join(root, '.tmp', 'local-servers', 'unit')
await rm(workDir, { recursive: true, force: true })
await mkdir(workDir, { recursive: true })

const outDir = join(workDir, 'out')
await build({
  entryPoints: ['src/main/browser/local-servers.ts'],
  outdir: outDir,
  outbase: 'src',
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const mod = await import(pathToFileURL(join(outDir, 'main', 'browser', 'local-servers.js')).href)

let checks = 0
const ok = (condition, label) => {
  assert.ok(condition, label)
  checks++
}
const eq = (actual, expected, label) => {
  assert.deepEqual(actual, expected, label)
  checks++
}

const NETSTAT = `
活动连接

  协议  本地地址          外部地址        状态           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1024
  TCP    0.0.0.0:5173           0.0.0.0:0              LISTENING       4040
  TCP    127.0.0.1:1420         0.0.0.0:0              LISTENING       4040
  TCP    127.0.0.1:63342        0.0.0.0:0              LISTENING       8080
  TCP    127.0.0.1:80           0.0.0.0:0              LISTENING       9000
  TCP    [::]:135               [::]:0                 LISTENING       1024
  TCP    [::]:7680              [::]:0                 LISTENING       2200
  TCP    [::1]:3000             [::]:0                 LISTENING      4545
  TCP    192.168.1.20:5000      0.0.0.0:0              LISTENING       6060
  TCP    127.0.0.1:5173         127.0.0.1:62088        ESTABLISHED     4040
  UDP    0.0.0.0:5353           *:*                                    2000
`

const netstatRows = mod.parseNetstatListening(NETSTAT)
eq(
  netstatRows.map((row) => `${row.host}|${row.port}`),
  ['0.0.0.0|5173', '127.0.0.1|1420', '127.0.0.1|63342', '::|7680', '::1|3000'],
  'netstat：只留本机监听行，丢掉系统端口、80 端口、局域网地址与已建立连接'
)
ok(netstatRows[0].pid === 4040, 'netstat：解析出 PID')
ok(netstatRows.every((row) => row.port >= 1024), 'netstat：1024 以下端口被丢弃')

eq(mod.parseNetstatListening(''), [], 'netstat：空输出返回空列表')
eq(
  mod.parseNetstatListening('  TCP    127.0.0.1:5173   0.0.0.0:0   ESTABLISHED   1'),
  [],
  'netstat：非 LISTENING 的 TCP 行不算监听'
)

const TASKLIST = `"System","4","Services","0","1,234 K"
"node.exe","4040","Console","1","123,456 K"
"svchost.exe","1024","Services","0","9,876 K"
"chrome.exe","8080","Console","1","500,000 K"
"Docker Desktop.exe","2200","Console","1","300,000 K"
`
const names = mod.parseWindowsTasklist(TASKLIST)
eq(names.get(4040), 'node', 'tasklist：去掉 .exe 后缀')
eq(names.get(4), 'System', 'tasklist：系统进程名按原样保留')
eq(names.get(2200), 'Docker Desktop', 'tasklist：进程名里的空格与逗号字段不串列')

const attached = mod.attachProcessNames(netstatRows, names)
eq(attached[0].processName, 'node', 'netstat + tasklist：按 PID 关联进程名')

const selected = mod.selectLocalServers(attached, 4545)
eq(
  selected.map((row) => row.port),
  [1420, 5173, 7680, 63342],
  '合并候选：排除系统进程、自身 PID，并按端口去重排序'
)

ok(mod.isSystemProcessName('svchost'), '系统进程名识别：svchost')
ok(mod.isSystemProcessName(' LSASS '), '系统进程名识别：忽略大小写与空白')
ok(!mod.isSystemProcessName('node'), '系统进程名识别：node 不算系统进程')
ok(!mod.isSystemProcessName(undefined), '系统进程名识别：未知进程名不算系统进程')

eq(
  mod
    .selectLocalServers(
      [
        { host: '127.0.0.1', port: 6379, pid: 1024, processName: 'svchost' },
        { host: '127.0.0.1', port: 6390, pid: 4, processName: 'System' },
        { host: '0.0.0.0', port: 6391, pid: 999, processName: 'node' },
        { host: '127.0.0.1', port: 6391, pid: 999, processName: 'node' },
        { host: '127.0.0.1', port: 6392, pid: 4545, processName: 'yan' }
      ],
      4545
    )
    .map((row) => `${row.host}|${row.port}`),
  ['0.0.0.0|6391'],
  '合并候选：系统进程与自身进程被去掉，同一端口只留一行'
)

const LSOF = `COMMAND   PID    USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    4040 yudatou   23u  IPv4 0x1234567890abcdef      0t0  TCP 127.0.0.1:5173 (LISTEN)
node    4040 yudatou   24u  IPv6 0x1234567890abcdea      0t0  TCP [::1]:5173 (LISTEN)
python  5050 yudatou    5u  IPv4 0x1234567890abcdeb      0t0  TCP *:8000 (LISTEN)
Google  6060 yudatou   12u  IPv4 0x1234567890abcdec      0t0  TCP 192.168.1.20:9000 (LISTEN)
node    4040 yudatou   25u  IPv4 0x1234567890abcded      0t0  TCP 127.0.0.1:5173->127.0.0.1:62088 (ESTABLISHED)
`
const lsofRows = mod.parseLsofListening(LSOF)
eq(
  lsofRows.map((row) => `${row.processName}|${row.host}|${row.port}|${row.pid}`),
  ['node|127.0.0.1|5173|4040', 'node|::1|5173|4040', 'python|0.0.0.0|8000|5050'],
  'lsof：解析监听行，星号地址视作 0.0.0.0，丢局域网与已建立连接'
)
eq(mod.parseLsofListening('lsof: command not found'), [], 'lsof：无法识别的内容返回空列表')

eq(mod.parseListenEndpoint('*:3000'), { host: '0.0.0.0', port: 3000 }, '端点：* 视作 0.0.0.0')
eq(mod.parseListenEndpoint('[::1]:3000'), { host: '::1', port: 3000 }, '端点：IPv6 去掉方括号')
eq(mod.parseListenEndpoint('127.0.0.1'), null, '端点：没有端口不算端点')
eq(mod.parseListenEndpoint('127.0.0.1:0'), null, '端点：端口 0 丢弃')
eq(mod.parseListenEndpoint('127.0.0.1:70000'), null, '端点：超出范围的端口丢弃')
eq(mod.parseListenEndpoint('127.0.0.1:5173x'), null, '端点：端口带杂字符丢弃')

ok(mod.parseHtmlTitle('<html><head><title>Vite + React &amp; Co</title></head></html>') === 'Vite + React & Co', '标题：解析并解码实体')
ok(mod.parseHtmlTitle('<title>\n  My   App \n</title>') === 'My App', '标题：折叠空白')
ok(mod.parseHtmlTitle('<title></title>') === undefined, '标题：空标题当作没有')
ok(mod.parseHtmlTitle('<html><body>no title</body></html>') === undefined, '标题：没有 title 标签')
ok(mod.parseHtmlTitle('<TITLE data-x="1">中文站点</TITLE>') === '中文站点', '标题：带属性与大写')
ok((mod.parseHtmlTitle(`<title>${'长'.repeat(400)}</title>`) ?? '').length === 160, '标题：截断到 160 字符')

const ranked = mod.rankLocalServers([
  { url: 'http://127.0.0.1:4310', port: 4310, host: '127.0.0.1', processName: 'QQ' },
  { url: 'http://127.0.0.1:9222', port: 9222, host: '127.0.0.1', processName: 'node', title: 'Content shell remote debugging' },
  { url: 'http://127.0.0.1:3682', port: 3682, host: '127.0.0.1', processName: 'electron' },
  { url: 'http://127.0.0.1:5173', port: 5173, host: '127.0.0.1', processName: 'node.exe', title: 'Vite App' },
  { url: 'http://127.0.0.1:8000', port: 8000, host: '127.0.0.1', processName: 'python' }
])
eq(ranked.map((s) => s.port), [5173, 8000, 4310], '排序：开发运行时优先，剔除 Electron 与远程调试页')

console.log(`✓ local-servers 纯函数测试通过（${checks} 项）`)
