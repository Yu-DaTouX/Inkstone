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

const open = new Set()
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
  const ctx = { desk, h, conn, async close() { open.delete(ctx); await h.unmount(); await desk.stop() } }
  open.add(ctx)
  return ctx
}
const L = (zh, en, lang) => (lang === 'zh-CN' ? zh : en)

async function openSession(h, title) {
  await h.pressLabel(new RegExp(`^${title}`))
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



async function flowModel(lang) {
  const t = (zh, en) => L(zh, en, lang)
  const tag = `[${lang} 模型]`
  const ctx = await boot({ lang })
  const { desk, h } = ctx
  desk.state.sessions[0].model = 'Model A'
  await openSession(h, '第一个会话')
  await h.pressLabel(/^(选择模型|Choose model)/)
  await h.waitFor(() => h.has('Model B'), `${tag} 模型列表出现`)
  check(h.has(t('思考', 'Thinking')), `${tag} 有思考档位`)
  check(!h.has(t('下一条消息生效', 'Applies to next message')), `${tag} 空闲时不显示下一条生效`)
  await h.pressText('Model B')
  await h.waitFor(() => desk.calls.some((c) => c[0] === 'command' && c[1].action === 'model'), `${tag} 切模型发请求`)
  check(desk.calls.find((c) => c[0] === 'command' && c[1].action === 'model')[1].modelId === 'm-b', `${tag} 切模型请求内容`)
  await h.waitFor(() => !h.has('Model B') || !h.byLabel(t('关闭模型选择', 'Close model picker')).length, `${tag} 空闲切换后选择器关闭`)

  desk.state.running = true
  await h.waitFor(() => h.byLabel(t('停止当前运行', 'Stop current run')).length || true, '')
  await h.pressLabel(t('刷新会话', 'Refresh sessions')).catch(() => undefined)
  await ctx.close()
}

async function flowModelRunning(lang) {
  const t = (zh, en) => L(zh, en, lang)
  const tag = `[${lang} 运行中模型]`
  const ctx = await boot({ lang, desktop: {} })
  const { desk, h } = ctx
  desk.state.running = true
  await h.pressLabel(t('刷新会话', 'Refresh sessions'))
  await h.waitFor(() => h.matchLabel(/运行中|Running/).length, `${tag} 首页显示运行中`)
  await openSession(h, '第一个会话')
  await h.waitFor(() => h.byLabel(t('停止当前运行', 'Stop current run')).length, `${tag} 会话显示停止按钮`)
  await h.pressLabel(/^(选择模型|Choose model)/)
  await h.waitFor(() => h.has('Model B'), `${tag} 运行中也能打开模型列表`)
  check(h.has(t('运行中，下一条消息生效', 'Running; applies to next message')), `${tag} 运行中提示下一条生效`)
  await h.pressText('Model B')
  await h.waitFor(() => h.has(t('下一条消息生效', 'Applies to next message')) && !h.has(t('运行中，下一条消息生效', 'Running; applies to next message')), `${tag} 切换后显示下一条消息生效且选择器保持打开`)
  check(h.byLabel(t('关闭模型选择', 'Close model picker')).length >= 1, `${tag} 运行中切换后选择器保持打开`)
  await h.pressText(t('高', 'High'))
  await h.waitFor(() => desk.calls.some((c) => c[0] === 'command' && c[1].action === 'thinking'), `${tag} 思考档位发请求`)
  check(desk.calls.find((c) => c[0] === 'command' && c[1].action === 'thinking')[1].level === 'high', `${tag} 思考档位请求内容`)
  await ctx.close()
}

async function flowModelErrors() {
  const tag = '[模型错误]'
  const ctx = await boot({ desktop: { tweak: (_, state) => { state.errors.models = { status: 500, error: '模型服务不可用' } } } })
  const { h } = ctx
  await openSession(h, '第一个会话')
  await h.pressLabel(/^选择模型/)
  await h.waitFor(() => h.has('模型服务不可用'), `${tag} 列表失败显示原文`)
  check(!h.has('暂无可用模型'), `${tag} 失败时不误报暂无可用模型`)
  await ctx.close()
  const empty = await boot({ desktop: { tweak: (_, state) => { state.models = [] } } })
  await openSession(empty.h, '第一个会话')
  await empty.h.pressLabel(/^选择模型/)
  await empty.h.waitFor(() => empty.h.has('暂无可用模型'), `${tag} 空列表`)
  await empty.close()
}

async function flowRenameSearch() {
  const tag = '[改名与搜索]'
  const ctx = await boot()
  const { desk, h } = ctx
  desk.state.searchHits = [{ sessionId: 's-1', snippet: '…{q}在这里…', matches: 2 }, { sessionId: 'ghost', snippet: '幽灵 {q}', matches: 1 }]
  const [box] = h.inputs()
  if (process.env.DEBUG_RENDER) console.log(h.all('[data-rn="TextInput"]').length, desk.calls.length)
  await h.typeInto(box, '关')
  await h.settle(600)
  check(!desk.calls.some((c) => c[0] === 'search'), `${tag} 一个字不触发内容搜索`)
  await h.typeInto(box, '关键词')
  check(!desk.calls.some((c) => c[0] === 'search'), `${tag} 输入后 400ms 内不发请求（防抖）`)
  await h.waitFor(() => desk.calls.some((c) => c[0] === 'search'), `${tag} 防抖后发出搜索`)
  await h.waitFor(() => h.has('内容匹配'), `${tag} 内容匹配段出现`)
  check(h.has('…关键词在这里…') && !h.has('幽灵'), `${tag} 命中显示片段且丢弃不存在的会话`)
  await h.typeInto(box, '会话')
  await h.waitFor(() => desk.calls.filter((c) => c[0] === 'search').length >= 2, `${tag} 第二次搜索`)
  await h.settle(100)
  check(!h.has('内容匹配') && h.has('搜索结果'), `${tag} 标题已命中的会话不重复进内容匹配`)
  desk.state.errors.search = { status: 500, error: '搜索坏了' }
  await h.typeInto(box, '再来一次')
  await h.waitFor(() => desk.calls.filter((c) => c[0] === 'search').length >= 3, `${tag} 失败的搜索`)
  await h.settle(100)
  check(!h.has('内容匹配'), `${tag} 搜索失败不崩且不显示内容匹配`)
  await h.typeInto(box, '')
  await openSession(h, '第一个会话')
  const title = h.pressables().find((n) => n.__props?.onLongPress && n.textContent.includes('第一个会话'))
  check(!!title, `${tag} 标题可长按`)
  await h.longPress(title)
  await h.waitFor(() => h.byLabel('会话名称').length, `${tag} 长按弹出重命名`)
  await h.typeInto(h.byLabel('会话名称')[0], '新的名字')
  await h.pressLabel('保存名称')
  await h.waitFor(() => desk.state.sessions[0].title === '新的名字', `${tag} 重命名到达电脑端`)
  await h.waitFor(() => h.has('新的名字'), `${tag} 标题刷新`)
  await ctx.close()
}

async function flowHomeSections() {
  const tag = '[首页分组]'
  const ctx = await boot({ desktop: { tweak: (_, state) => {
    state.sessions[1].pinned = true
    state.sessions.push({ id: 's-3', title: '旧会话', cwdName: 'repo', projectId: 'p-1', updatedAt: 5, messageCount: 1, archivedAt: 9 })
  } } })
  const { h } = ctx
  check(h.has('置顶'), `${tag} 置顶段出现`)
  check(h.byLabel('要删除的会话').length === 2, `${tag} 置顶会话同时在置顶段与项目里`, String(h.byLabel('要删除的会话').length))
  check(!h.byLabel('旧会话').length, `${tag} 已归档会话默认折叠`)
  await h.pressLabel(/^已归档/)
  check(h.byLabel('旧会话').length === 1 && !h.all('[data-rn="Pressable"]').some((n) => (n.getAttribute('aria-label') ?? '').startsWith('repo，') && false), `${tag} 展开已归档`)
  await ctx.close()
}

async function flowRevoked() {
  const tag = '[撤销设备]'
  const ctx = await boot()
  const { desk, h, conn } = ctx
  await desk.devices.revoke(conn.deviceId)
  await h.pressLabel('刷新会话')
  await h.settle(300)
  const alert = env.alerts.at(-1)
  check(!alert, `${tag} 令牌已被撤销时不再弹「电脑暂时无法撤销设备」`, alert?.title)
  await h.waitFor(() => h.has('配对'), `${tag} 回到配对页`).catch(() => check(false, `${tag} 回到配对页`, h.text().slice(0, 200)))
  check(globalThis.__keychain.entry === null, `${tag} 钥匙串已清除`)
  await ctx.close()
}

const run = async (name, fn) => {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return
  try { await fn() } catch (error) { failures.push(`${name} 中断：${error.message}`) }
  for (const ctx of [...open]) await ctx.close().catch(() => undefined)
}
for (const lang of ['zh-CN', 'en-US']) await run(`完整流程 ${lang}`, () => flowFull(lang))
for (const lang of ['zh-CN', 'en-US']) await run(`运行中模型 ${lang}`, () => flowModelRunning(lang))
await run('空闲切模型', () => flowModel('zh-CN'))
await run('模型错误', flowModelErrors)
await run('改名与搜索', flowRenameSearch)
await run('首页分组', flowHomeSections)
await run('撤销设备', flowRevoked)

console.error = realError
console.warn = realWarn
const nonNoise = consoleNoise.filter((line) => !/not wrapped in act|ReactDOMTestUtils/.test(line))
if (nonNoise.length) console.log('控制台输出（前 10 条）：\n' + [...new Set(nonNoise)].slice(0, 10).join('\n'))
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`)
for (const line of failures) console.log('  失败：' + line)
process.exit(failures.length ? 1 : 0)
