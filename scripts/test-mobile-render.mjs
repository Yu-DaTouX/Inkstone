import { loadApp, createHarness, env, marksSet, sleep } from './mobile-render/host.mjs'
import { startFakeDesktop } from './mobile-render/fake-desktop.mjs'

const lib = await loadApp()
const failures = []
let passed = 0
const check = (cond, message, detail) => {
  if (cond) { passed++; return }
  failures.push(detail === undefined ? message : `${message}（${detail}）`)
}

const consoleNoise = []
const realError = console.error
const realWarn = console.warn
console.error = (...args) => { consoleNoise.push(args.map(String).join(' ').slice(0, 240)) }
console.warn = (...args) => { consoleNoise.push(args.map(String).join(' ').slice(0, 240)) }

async function boot({ lang = 'zh-CN', left = false, width = 390, height = 844, fold, desktop = {}, scheme = 'light' } = {}) {
  const desk = await startFakeDesktop(desktop)
  env.window = { width, height }
  env.scheme = scheme
  env.alerts.length = 0
  env.opened.length = 0
  env.nativeModules.InkstoneFoldLayout = fold ? { getCurrent: async () => fold } : undefined
  marksSet('ui:prefs', JSON.stringify({ lang, leftHanded: left }))
  const conn = await lib.pair(desk.baseUrl, desk.startPairing(), '测试手机')
  globalThis.__keychain.entry = { username: 'x', password: JSON.stringify(conn) }
  const h = createHarness(lib)
  await h.mount(h.createElement(lib.App))
  await h.waitFor(() => h.byLabel(lang === 'zh-CN' ? '打开手机设置' : 'Open phone settings').length, '首页出现')
  return { desk, h, conn, async close() { await h.unmount(); await desk.stop() } }
}
const L = (zh, en, lang) => (lang === 'zh-CN' ? zh : en)

async function openSession(h, title) {
  await h.pressLabel(title)
  await h.waitFor(() => h.inputs().length, '会话输入框出现')
  await h.settle(60)
}

async function flowFull(lang) {
  const t = (zh, en) => L(zh, en, lang)
  const ctx = await boot({ lang })
  const { desk, h } = ctx
  const tag = `[${lang}]`
  check(h.has(t('第一个会话', '第一个会话')) && h.has(t('项目', 'Projects')), `${tag} 首页显示项目与会话`)
  await openSession(h, '第一个会话')
  check(h.has('你好，我能帮你做什么？'), `${tag} 会话显示历史消息`)
  await h.waitFor(() => desk.calls.some((c) => c[0] === 'insight'), `${tag} 进入会话请求 insight`)

  await h.pressLabel(t('打开会话详情', 'Open session details'))
  await h.waitFor(() => h.has(t('用量', 'Usage')), `${tag} 详情出现用量`)
  { const all = h.text(); check(all.includes('40%') && /12k tokens/.test(all), `${tag} 用量显示百分比与令牌`, all.replace(/[· ]{20,}/g, '…').slice(-700)) }
  check(h.has('src/a.ts') && h.has('+3'), `${tag} 更改列表显示文件与增删行`)
  for (const label of [t('置顶', 'Pin'), t('归档', 'Archive'), t('压缩上下文', 'Compact context'), t('删除', 'Delete')]) check(h.byLabel(label).length === 1, `${tag} 操作区有「${label}」`)

  await h.pressLabel(t('置顶', 'Pin'))
  await h.waitFor(() => desk.calls.some((c) => c[0] === 'flags'), `${tag} 置顶发出请求`)
  check(JSON.stringify(desk.calls.find((c) => c[0] === 'flags')[2]) === '{"pinned":true}', `${tag} 置顶请求体`)
  await h.waitFor(() => h.byLabel(t('取消置顶', 'Unpin')).length, `${tag} 置顶后按钮变为取消置顶`)

  await h.pressLabel(t('压缩上下文', 'Compact context'))
  await h.waitFor(() => desk.calls.some((c) => c[0] === 'compact'), `${tag} 压缩发出请求`)

  const before = desk.calls.filter((c) => c[0] === 'compact').length
  desk.state.running = true
  await h.pressLabel(t('压缩上下文', 'Compact context'))
  check(desk.calls.filter((c) => c[0] === 'compact').length === before + 1, `${tag} 运行中点压缩仍会发请求（由电脑端 409 拦截）`)
  await h.waitFor(() => h.has('运行中不能压缩'), `${tag} 压缩 409 的原文显示出来`)
  desk.state.running = false

  check(h.has('main') && h.byLabel(t('分支 main，点按切换', 'Branch main, tap to switch')).length === 1, `${tag} 环境区有可点的分支行`)
  desk.state.branches.push({ name: 'conflict', current: false })
  await h.pressLabel(t('分支 main，点按切换', 'Branch main, tap to switch'))
  await h.waitFor(() => h.byLabel(t('切换到 dev', 'Switch to dev')).length, `${tag} 分支面板列出分支`)
  check(h.byLabel(t('当前分支 main', 'Current branch main')).length === 1, `${tag} 分支面板标出当前分支`)
  check(h.has(t('其他工作区', 'Other worktree')), `${tag} 其他工作区的分支带标记`)
  await h.pressLabel(t('当前分支 main', 'Current branch main'))
  check(!desk.calls.some((c) => c[0] === 'switchBranch'), `${tag} 点当前分支不发请求`)
  await h.pressLabel(t('切换到 conflict', 'Switch to conflict'))
  await h.waitFor(() => h.has('有未提交的改动会被覆盖'), `${tag} 分支切换 409 显示原文`)
  check(h.byLabel(t('切换到 dev', 'Switch to dev')).length === 1, `${tag} 失败后面板仍在`)
  await h.pressLabel(t('切换到 dev', 'Switch to dev'))
  await h.waitFor(() => !h.byLabel(t('切换到 dev', 'Switch to dev')).length, `${tag} 切换成功后面板关闭`)
  check(desk.calls.some((c) => c[0] === 'switchBranch' && c[2] === 'dev'), `${tag} 切换分支请求内容`)
  await h.settle(200)
  check(h.byLabel(t('分支 dev，点按切换', 'Branch dev, tap to switch')).length === 1, `${tag} 切换后详情里的分支名更新`, h.all('[data-rn="Pressable"]').map((n) => n.getAttribute('aria-label')).filter(Boolean).join('|'))

  await h.pressLabel(t('删除', 'Delete'))
  const alert = env.alerts.at(-1)
  check(alert?.title === t('删除这个会话？', 'Delete this session?') && alert.buttons.length === 2, `${tag} 删除先弹确认`)
  check(!desk.calls.some((c) => c[0] === 'delete'), `${tag} 确认前不发删除请求`)
  await h.alertButton(t('取消', 'Cancel'))
  check(!desk.calls.some((c) => c[0] === 'delete'), `${tag} 取消不删除`)
  await h.pressLabel(t('删除', 'Delete'))
  await h.alertButton(t('删除', 'Delete'))
  await h.waitFor(() => h.has('当前使用中的会话不能删除'), `${tag} 删除 409 显示原文`)
  check(h.byLabel(t('删除', 'Delete')).length === 1, `${tag} 删除失败后详情仍在`)
  desk.state.activeSessionId = null
  await h.pressLabel(t('删除', 'Delete'))
  await h.alertButton(t('删除', 'Delete'))
  await h.waitFor(() => h.byLabel(t('打开手机设置', 'Open phone settings')).length && !h.has('当前使用中'), `${tag} 删除成功回到首页`)
  check(!desk.state.sessions.some((s) => s.id === 's-1'), `${tag} 电脑端会话已删除`)
  await h.settle(100)
  check(!h.byLabel('第一个会话').length && h.byLabel('要删除的会话').length === 1, `${tag} 首页列表同步`)

  await ctx.close()
}

for (const lang of ['zh-CN', 'en-US']) await flowFull(lang)

console.error = realError
console.warn = realWarn
const nonNoise = consoleNoise.filter((line) => !/not wrapped in act|ReactDOMTestUtils/.test(line))
if (nonNoise.length) console.log('控制台输出（前 10 条）：\n' + [...new Set(nonNoise)].slice(0, 10).join('\n'))
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`)
for (const line of failures) console.log('  失败：' + line)
process.exit(failures.length ? 1 : 0)
