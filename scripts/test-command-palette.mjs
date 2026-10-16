import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HOST_ENTRY = 'src/renderer/src/lib/host-actions.ts'
const SUBMIT_ENTRY = 'src/renderer/src/lib/composer-submit.ts'

let checks = 0
const ok = (condition, message) => {
  assert.ok(condition, message)
  checks += 1
}
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks += 1
}

async function load(entry, name) {
  const dir = await mkdtemp(join(tmpdir(), `inkstone-${name}-`))
  const outfile = join(dir, `${name}.mjs`)
  const result = await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'neutral',
    format: 'esm',
    metafile: true,
    logLevel: 'silent'
  })
  return { module: await import(pathToFileURL(outfile).href), dir, inputs: Object.keys(result.metafile.inputs) }
}

const keyState = (over = {}) => ({
  key: '',
  ctrl: false,
  meta: false,
  alt: false,
  shift: false,
  composing: false,
  repeat: false,
  altGraph: false,
  inTerminal: false,
  modalOpen: false,
  ...over
})

function recordingRuntime() {
  const calls = []
  return {
    calls,
    runtime: {
      openSettings: (tab) => calls.push(['openSettings', tab]),
      newSession: () => calls.push(['newSession']),
      newSessionProject: () => calls.push(['newSessionProject']),
      setPermission: (mode) => calls.push(['setPermission', mode]),
      setTheme: (theme) => calls.push(['setTheme', theme]),
      toggleRail: () => calls.push(['toggleRail']),
      launchTool: (kind) => calls.push(['launchTool', kind]),
      copyLastReply: () => calls.push(['copyLastReply']),
      stopRun: () => calls.push(['stopRun']),
      openShortcutSheet: () => calls.push(['openShortcutSheet'])
    }
  }
}

function recordingPort(over = {}) {
  const calls = []
  const port = {
    text: '',
    attachments: [],
    commands: [],
    models: [],
    t: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
    actions: {
      runBash: (cmd) => calls.push(['runBash', cmd]),
      openSettings: (tab) => calls.push(['openSettings', tab]),
      newSession: () => calls.push(['newSession']),
      compact: () => calls.push(['compact']),
      openBrowser: (url) => calls.push(['openBrowser', url]),
      setModel: (provider, id) => calls.push(['setModel', provider, id]),
      exportHtml: () => calls.push(['exportHtml']),
      copyLastReply: () => calls.push(['copyLastReply']),
      clone: () => calls.push(['clone']),
      setManualTitle: (id, title) => calls.push(['setManualTitle', id, title]),
      setThinking: (level) => calls.push(['setThinking', level]),
      notify: (level, text) => calls.push(['notify', level, text])
    },
    session: null,
    thinkingLevels: [],
    roundRunning: false,
    isCompacting: false,
    clearText: () => calls.push(['clearText']),
    clearAll: () => calls.push(['clearAll']),
    restoreText: (raw) => calls.push(['restoreText', raw]),
    restoreAttachments: (saved) => calls.push(['restoreAttachments', saved]),
    readAttachments: () => [],
    send: (text, images, mode) => {
      calls.push(['send', text, images, mode])
      return Promise.resolve(true)
    },
    holdSend: (text, images) => calls.push(['holdSend', text, images]),
    focusComposer: () => calls.push(['focusComposer']),
    ...over
  }
  return { port, calls }
}

const YAN = (name, executable = true, extra = {}) => ({ name, source: 'yan', executable, ...extra })

async function main() {
  const host = await load(HOST_ENTRY, 'host-actions')
  const submit = await load(SUBMIT_ENTRY, 'composer-submit')
  try {
    const H = host.module
    const S = submit.module

    ok(H.HOST_ACTIONS.length >= 20, '宿主动作表非空')
    const ids = new Set(H.HOST_ACTIONS.map((a) => a.id))
    eq(ids.size, H.HOST_ACTIONS.length, '动作 ID 不重复')
    for (const action of H.HOST_ACTIONS) {
      if (action.binding) ok(!!H.KEY_BINDINGS[action.binding], `绑定 ${action.binding} 存在于键位表`)
      if (action.settingsTab) ok(typeof action.settingsTab === 'string', '设置页动作带导航 ID')
      if (action.tool) ok(typeof action.tool === 'string', '工具动作带 kind')
    }
    ok(H.QUICK_ACTION_IDS.length === 3, '空输入正好给三条常用动作')
    for (const id of H.QUICK_ACTION_IDS) ok(ids.has(id), `常用动作 ${id} 在动作表内`)

    const avail = {
      running: false,
      hasLastReply: false,
      hasProject: false,
      permission: 'danger',
      theme: 'dark',
      browserOpen: false
    }
    const byId = (id) => H.HOST_ACTIONS.find((a) => a.id === id)
    ok(H.isHostActionDisabled(byId('newSessionProject'), avail), '没有项目时「项目新对话」禁用')
    ok(H.hostActionDisabledReason(byId('newSessionProject'), avail) === 'action.needProject', '禁用原因可读')
    ok(H.isHostActionDisabled(byId('themeDark'), avail), '已是深色时深色动作禁用')
    ok(H.isHostActionDisabled(byId('permissionDanger'), avail), '已是该权限档时对应动作禁用')
    ok(H.isHostActionDisabled(byId('copyLastReply'), avail), '没有回复时复制禁用')
    ok(H.isHostActionDisabled(byId('stopRun'), avail), '没有运行时不提供停止')
    const avail2 = { ...avail, running: true, hasLastReply: true, hasProject: true, permission: 'all', theme: 'light' }
    for (const id of ['newSessionProject', 'themeDark', 'permissionDanger', 'copyLastReply', 'stopRun']) {
      ok(!H.isHostActionDisabled(byId(id), avail2), `${id} 在对应状态下可用`)
    }

    eq(H.tokensOf('  模型  设置 模型 '), ['模型', '设置'], 'token 去重且去空白')
    const label = (a) => a.labelKey
    ok(H.filterHostActions('', label).length === H.HOST_ACTIONS.length, '空查询返回全部动作')
    const filtered = H.filterHostActions('settingsAbout', label)
    eq(filtered.map((a) => a.id), ['settingsAbout'], 'token 全部命中才保留')

    const rec = recordingRuntime()
    await H.runHostAction('settingsMarket', rec.runtime)
    eq(rec.calls.at(-1), ['openSettings', 'market'], '设置页动作走 openSettings(tab)')
    await H.runHostAction('launchTerminal', rec.runtime)
    eq(rec.calls.at(-1), ['launchTool', 'terminal'], '工具动作走工作区启动入口')
    await H.runHostAction('themeLight', rec.runtime)
    eq(rec.calls.at(-1), ['setTheme', 'light'], '主题动作走 setTheme')
    await H.runHostAction('permissionAll', rec.runtime)
    eq(rec.calls.at(-1), ['setPermission', 'all'], '权限动作走 setPermission')
    await H.runHostAction('copyLastReply', rec.runtime)
    eq(rec.calls.at(-1), ['copyLastReply'], '复制动作走正式 store 动作')
    await H.runHostAction('stopRun', rec.runtime)
    eq(rec.calls.at(-1), ['stopRun'], '停止动作走正式 store 动作')
    await H.runHostAction('newSessionProject', rec.runtime)
    eq(rec.calls.at(-1), ['newSessionProject'], '项目新对话走 runtime')
    const bad = await H.runHostAction('nope', rec.runtime)
    ok(!bad.ok && bad.error === 'unknown-action', '未知动作不静默成功')

    const resolve = (over) => H.resolveShortcut(keyState(over))
    eq(resolve({ key: 'k', ctrl: true }), 'openSessionSwitcher', 'Ctrl+K 打开切换器')
    eq(resolve({ key: 'k', ctrl: true, inTerminal: true }), null, '终端里 Ctrl+K 让给 shell')
    eq(resolve({ key: 'b', ctrl: true }), 'toggleRail', 'Ctrl+B 开关左栏')
    eq(resolve({ key: 'b', ctrl: true, inTerminal: true }), null, '终端里 Ctrl+B 让给终端')
    eq(resolve({ key: 'l', ctrl: true }), 'focusComposer', 'Ctrl+L 聚焦输入框')
    eq(resolve({ key: 'l', ctrl: true, inTerminal: true }), null, '终端里 Ctrl+L 是清屏')
    eq(resolve({ key: 'C', ctrl: true, shift: true }), 'copyLastReply', 'Ctrl+Shift+C 复制回复')
    eq(resolve({ key: 'c', ctrl: true, shift: true, inTerminal: true }), null, '终端里 Ctrl+Shift+C 让给终端')
    eq(resolve({ key: ',', ctrl: true }), 'openSettings', 'Ctrl+, 打开设置')
    eq(resolve({ key: '/', ctrl: true }), 'shortcutSheet', 'Ctrl+/ 打开快捷键表')
    eq(resolve({ key: 'n', ctrl: true }), 'newSession', 'Ctrl+N 新对话')
    eq(resolve({ key: 'P', ctrl: true, shift: true }), 'cycleModelBack', 'Ctrl+Shift+P 上一模型优先于 Ctrl+P')
    eq(resolve({ key: 'p', ctrl: true }), 'cycleModel', 'Ctrl+P 下一模型')
    eq(resolve({ key: 'Tab', shift: true }), 'cycleThinking', 'Shift+Tab 切换思考档位')
    eq(resolve({ key: 'k', ctrl: true, composing: true }), null, '输入法组合态不触发')
    eq(resolve({ key: 'k', ctrl: true, repeat: true }), null, '长按重复不重复触发')
    eq(resolve({ key: ',', ctrl: true, altGraph: true }), null, 'AltGraph 不当作快捷键')
    eq(resolve({ key: 'k', ctrl: true, modalOpen: true }), null, '模态打开时全局分发让位')
    eq(resolve({ key: 'Escape' }), null, '本轮不新增全局 Esc 停止')
    eq(resolve({ key: 'k', ctrl: true, alt: true }), null, 'Ctrl+Alt+K 不误发')

    const commands = [
      YAN('compact'),
      YAN('new'),
      YAN('browser'),
      YAN('model'),
      YAN('thinking'),
      YAN('session'),
      YAN('name'),
      YAN('export'),
      YAN('login'),
      { name: 'panel', source: 'compatibility', executable: false, availability: '仅终端界面有效', description: '终端命令' },
      { name: 'help', source: 'pi', executable: true }
    ]

    let r = recordingPort({ text: '/compact', attachments: [], commands })
    eq(await S.submitComposerInput(r.port), 'handled', '/compact 被分发消费')
    ok(r.calls.some((c) => c[0] === 'compact'), '/compact 调用 compact')
    ok(r.calls.some((c) => c[0] === 'clearAll'), '/compact 清空草稿与附件')
    ok(!r.calls.some((c) => c[0] === 'send'), '/compact 不发给模型')

    r = recordingPort({ text: '/login', attachments: [], commands })
    await S.submitComposerInput(r.port)
    eq(r.calls.at(-1), ['openSettings', 'auth'], '/login 路由到模型设置')

    r = recordingPort({ text: '/panel', attachments: [], commands })
    await S.submitComposerInput(r.port)
    ok(r.calls.some((c) => c[0] === 'notify' && c[1] === 'info'), '兼容命令给说明')
    ok(!r.calls.some((c) => c[0] === 'clearAll' || c[0] === 'clearText'), '兼容命令不清空草稿')
    ok(r.calls.some((c) => c[0] === 'focusComposer'), '兼容命令把焦点还给输入框')
    ok(!r.calls.some((c) => c[0] === 'send'), '兼容命令不发模型')

    r = recordingPort({ text: '/model', attachments: [], commands, models: [] })
    await S.submitComposerInput(r.port)
    eq(r.calls.at(-1), ['openSettings', 'status'], '/model 无参数打开状态页')
    ok(!r.calls.some((c) => c[0] === 'clearAll'), '/model 无参不清草稿')

    r = recordingPort({ text: '/model openai/gpt-5', attachments: [], commands, models: [{ provider: 'openai', id: 'gpt-5', name: 'GPT-5' }] })
    await S.submitComposerInput(r.port)
    eq(r.calls.at(-1), ['setModel', 'openai', 'gpt-5'], '/model 命中后切换模型')

    r = recordingPort({ text: '/browser https://example.com', attachments: [], commands })
    await S.submitComposerInput(r.port)
    eq(r.calls.at(-1), ['openBrowser', 'https://example.com'], '/browser 带 URL')

    r = recordingPort({ text: '/thinking', attachments: [], commands, thinkingLevels: ['low', 'high'], session: { thinkingLevel: 'low' } })
    await S.submitComposerInput(r.port)
    ok(r.calls.some((c) => c[0] === 'notify' && c[1] === 'info'), '/thinking 无参只报告当前档位')
    r = recordingPort({ text: '/thinking high', attachments: [], commands, thinkingLevels: ['low', 'high'] })
    await S.submitComposerInput(r.port)
    eq(r.calls.at(-1), ['setThinking', 'high'], '/thinking 有参切换档位')

    r = recordingPort({ text: '/name 我的会话', attachments: [], commands })
    await S.submitComposerInput(r.port)
    eq(r.calls.at(-1), ['setManualTitle', '', '我的会话'], '/name 设置手动标题')
    r = recordingPort({ text: '/session', attachments: [], commands, session: { sessionId: 's1', messageCount: 3, sessionFile: '/tmp/s.jsonl' } })
    await S.submitComposerInput(r.port)
    ok(r.calls.some((c) => c[0] === 'notify'), '/session 报告会话信息')

    r = recordingPort({ text: '/help', attachments: [], commands })
    eq(await S.submitComposerInput(r.port), 'sent', 'pi 命令落回发送')
    ok(r.calls.some((c) => c[0] === 'send' && c[1] === '/help'), 'pi 命令作为普通输入发出')
    ok(r.calls.some((c) => c[0] === 'clearAll'), '发送前清空草稿')

    r = recordingPort({ text: '你好', attachments: [], commands })
    await S.submitComposerInput(r.port)
    ok(r.calls.some((c) => c[0] === 'send' && c[1] === '你好'), '普通文本发送')

    r = recordingPort({
      text: '',
      attachments: [{ id: 'i1', kind: 'image', data: 'abc', mimeType: 'image/png' }],
      commands
    })
    await S.submitComposerInput(r.port)
    const sent = r.calls.find((c) => c[0] === 'send')
    ok(!!sent && sent[2]?.length === 1, '只带图片也能发送')

    r = recordingPort({ text: '/help', attachments: [], commands, roundRunning: true })
    eq(await S.submitComposerInput(r.port), 'queued', '运行中发送走排队')
    ok(r.calls.some((c) => c[0] === 'send' && c[3] === 'followUp'), '运行中发送带 followUp 模式')

    r = recordingPort({ text: '继续', attachments: [], commands, roundRunning: true, isCompacting: true })
    eq(await S.submitComposerInput(r.port), 'queued', '压缩期间消息先悬着')
    ok(r.calls.some((c) => c[0] === 'holdSend'), '压缩期间走 holdSend')

    r = recordingPort({
      text: '会失败的',
      attachments: [{ id: 'i2', kind: 'image', data: 'x', mimeType: 'image/png' }],
      commands,
      readAttachments: () => [{ id: 'i2' }],
      send: (text, images) => {
        r.calls.push(['send', text, images, undefined])
        return Promise.resolve(false)
      }
    })
    await S.submitComposerInput(r.port)
    ok(r.calls.some((c) => c[0] === 'restoreText' && c[1] === '会失败的'), '发送失败恢复草稿')
    ok(r.calls.some((c) => c[0] === 'restoreAttachments'), '发送失败恢复附件')

    r = recordingPort({ text: '!echo hi', attachments: [], commands })
    await S.submitComposerInput(r.port)
    ok(r.calls.some((c) => c[0] === 'runBash' && c[1] === 'echo hi'), '! 前缀走直执行')
    ok(!r.calls.some((c) => c[0] === 'send'), '! 前缀不发给模型')

    r = recordingPort({ text: '  !echo hi', attachments: [], commands })
    await S.submitComposerInput(r.port)
    ok(!r.calls.some((c) => c[0] === 'runBash'), '前导空格不触发直执行')
    ok(r.calls.some((c) => c[0] === 'send'), '带前导空格的 ! 按普通文本发送')

    r = recordingPort({ text: '   ', attachments: [], commands })
    eq(await S.submitComposerInput(r.port), 'empty', '空输入直接返回')

    const originalKeys = H.KEY_BINDINGS.toggleRail.keys
    try {
      H.KEY_BINDINGS.toggleRail.keys = ['Ctrl', 'Q']
      eq(resolve({ key: 'q', ctrl: true }), 'toggleRail', '按键分发从与展示同一绑定表读取')
      eq(resolve({ key: 'b', ctrl: true }), null, '绑定更新后不残留独立硬编码旧键')
    } finally {
      H.KEY_BINDINGS.toggleRail.keys = originalKeys
    }

    const attachment = { id: 'full', name: '原附件.png', size: 123, preview: 'preview', kind: 'image', data: 'abc', mimeType: 'image/png' }
    r = recordingPort({ text: '完整恢复', attachments: [attachment], readAttachments: () => [attachment], send: async () => false })
    await S.submitComposerInput(r.port)
    eq(r.calls.find(c => c[0] === 'restoreAttachments')?.[1], [attachment], '发送失败保留附件名称、尺寸与预览')

    console.log(`command-palette 检查通过：${checks} 项`)
  } finally {
    await rm(host.dir, { recursive: true, force: true })
    await rm(submit.dir, { recursive: true, force: true })
  }
}

await main()
