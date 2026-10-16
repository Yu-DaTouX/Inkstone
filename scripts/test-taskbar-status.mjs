import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import { transform } from 'esbuild'

const source = await readFile('src/main/index.ts', 'utf8')
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
const names = ['refreshTaskbar', 'notifyBlockedTerminal']
const functions = names.map((name) => {
  const node = ast.statements.find((item) => ts.isFunctionDeclaration(item) && item.name?.text === name)
  assert.ok(node, `实际入口必须保留 ${name}`)
  return node.getText(ast)
}).join('\n')
const { code } = await transform(functions, { loader: 'ts', format: 'cjs' })

let checks = 0
const check = (condition, message) => { assert.ok(condition, message); checks += 1 }
const progress = [], overlays = [], notices = []
let focused = false, mainBusy = false, children = 0, waiting = false
let settings = { sound: { notifications: true } }
let deferred
const fakeWindow = (id) => ({
  id, isDestroyed: () => false, isFocused: () => focused,
  isMinimized: () => false, show() {}, restore() {}, focus() {},
  setProgressBar: (...args) => progress.push(args),
  setOverlayIcon: (...args) => overlays.push(args)
})
class FakeNotification {
  static isSupported() { return true }
  constructor(options) { this.options = options }
  on() {}
  show() { notices.push(this.options) }
}
const context = vm.createContext({
  process: { platform: 'win32' }, win: fakeWindow(1),
  runners: { hasBusy: () => mainBusy },
  subagentService: { current: () => ({ runningCount: children }) },
  approvals: { list: () => waiting ? [{}] : [] }, hasBlockedTerminal: () => false, hasWorkingTerminal: () => false,
  taskbarProjection: undefined, blockedTerminalNotices: new Map(),
  trayImage: () => 'fake-tray-image', Notification: FakeNotification,
  getSettings: () => deferred ?? Promise.resolve(settings)
})
vm.runInContext(code, context)
const refresh = () => context.refreshTaskbar()
const notify = async (id, status) => { context.notifyBlockedTerminal(id, status); await Promise.resolve(); await Promise.resolve() }

refresh()
check(progress.at(-1)[0] === -1 && overlays.at(-1)[0] === null, '初始空闲会清除进度与角标')
const initialProgress = progress.length, initialOverlays = overlays.length
refresh()
check(progress.length === initialProgress && overlays.length === initialOverlays, '相同投影不反复调用系统 API')
children = 1
refresh()
check(progress.at(-1)[0] === 2 && progress.at(-1)[1].mode === 'indeterminate', '只有子 Agent 运行时也显示忙碌')
children = 0
mainBusy = true
refresh()
check(progress.length === initialProgress + 1, '忙碌来源变更但外观不变时不重复调用')
mainBusy = false
refresh()
check(progress.at(-1)[0] === -1, '所有来源空闲时清除忙碌')
waiting = true
refresh()
check(overlays.at(-1)[0] === 'fake-tray-image' && overlays.at(-1)[1].includes('处理'), '待批准显示角标及可访问说明')
waiting = false
context.hasBlockedTerminal = () => true
refresh()
check(overlays.length === initialOverlays + 1, '批准转终端 blocked 不重复画角标')
context.hasBlockedTerminal = () => false
refresh()
check(overlays.at(-1)[0] === null, '等待解除后移除角标')
context.win = fakeWindow(2)
refresh()
check(progress.length === initialProgress + 3 && overlays.length === initialOverlays + 3, '新窗口补发当前投影')
const beforeForce = overlays.length
context.refreshTaskbar(true)
check(overlays.length === beforeForce + 1, '系统主题变化允许强制刷新角标')
context.process.platform = 'linux'
const beforeNonWindows = progress.length
mainBusy = true
refresh()
check(progress.length === beforeNonWindows, '非 Windows 静默跳过任务栏 API')
context.process.platform = 'win32'

await notify('terminal-a', { state: 'blocked', kind: 'permission', title: '审批' })
check(notices.length === 1 && notices[0].body === '审批', '后台进入 blocked 时通知')
await notify('terminal-a', { state: 'blocked', kind: 'permission', title: '标题变化', progress: 20 })
check(notices.length === 1, '同种等待的标题/进度变化不重复通知')
await notify('terminal-a', { state: 'blocked', kind: 'question' })
check(notices.length === 2 && notices.at(-1).title.includes('回答'), '等待类型变化会给出对应提示')
await notify('terminal-a', { state: 'working' })
await notify('terminal-a', { state: 'blocked', kind: 'question' })
check(notices.length === 3, '解除后再进入等待允许新通知')
focused = true
await notify('terminal-b', { state: 'blocked' })
check(notices.length === 3, '前台不通知')
focused = false
settings = { sound: { notifications: false } }
await notify('terminal-c', { state: 'blocked' })
check(notices.length === 3, '遵守现有系统通知开关')
settings = { sound: { notifications: true } }
let resolveSettings
deferred = new Promise((resolve) => { resolveSettings = resolve })
context.notifyBlockedTerminal('terminal-d', { state: 'blocked' })
context.notifyBlockedTerminal('terminal-d', undefined)
resolveSettings(settings)
await Promise.resolve(); await Promise.resolve()
check(notices.length === 3, '异步设置迟到后不通知已解除的等待')
deferred = undefined
await notify('terminal-e', { state: 'done' })
check(notices.length === 3, 'done 默认不通知')
mainBusy = false
context.hasWorkingTerminal = () => true
refresh()
check(progress.at(-1)[0] === 2, '只有明确上报working的终端也驱动任务栏忙碌')
context.hasWorkingTerminal = () => false
refresh()
check(progress.at(-1)[0] === -1, '终端工作报告解除后清除进度')

const terminalSource = await readFile('src/main/terminal.ts', 'utf8')
const terminalAst = ts.createSourceFile('terminal.ts', terminalSource, ts.ScriptTarget.Latest, true)
const workingFn = terminalAst.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'hasWorkingTerminal')
assert.ok(workingFn)
const workingCode = (await transform(workingFn.getText(terminalAst), { loader: 'ts', format: 'cjs' })).code
const fakeSessions = new Map()
const terminalContext = vm.createContext({ sessions: fakeSessions, exports: {}, module: { exports: {} } })
vm.runInContext(workingCode, terminalContext)
fakeSessions.set('plain', { info: { alive: true } })
check(!terminalContext.hasWorkingTerminal(), '没有上报的普通shell不被推测为忙碌')
fakeSessions.set('dead', { info: { alive: false, status: { state: 'working' } } })
check(!terminalContext.hasWorkingTerminal(), '退出终端的旧working报告不驱动忙碌')
fakeSessions.set('live', { info: { alive: true, status: { state: 'working' } } })
check(terminalContext.hasWorkingTerminal(), '正式getter统计明确活终端工作事实')
console.log(`taskbar-status: ${checks} 项假窗口/通知检查通过（未做实际 Windows 视觉验收）`)
