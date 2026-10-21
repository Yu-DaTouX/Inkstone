import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

let checks = 0
const ok = (condition, label) => {
  assert.ok(condition, label)
  checks++
  console.log(`✓ ${label}`)
}

function installGlobals() {
  const storage = new Map()
  globalThis.localStorage = {
    getItem: (k) => (storage.has(String(k)) ? storage.get(String(k)) : null),
    setItem: (k, v) => storage.set(String(k), String(v)),
    removeItem: (k) => storage.delete(String(k)),
    clear: () => storage.clear()
  }
  function ElementShim() {}
  ElementShim.prototype = { focus() {}, blur() {}, addEventListener() {}, removeEventListener() {} }
  globalThis.HTMLElement = ElementShim
  globalThis.Element = ElementShim
  globalThis.Node = ElementShim
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })
  globalThis.window = {
    yan: new Proxy({}, { get: () => async () => undefined }),
    HTMLElement: ElementShim,
    Element: ElementShim,
    Node: ElementShim,
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: globalThis.getComputedStyle,
    screen: { orientation: { angle: 0 } },
    location: { href: 'http://localhost/' }
  }
  globalThis.document = {
    readyState: 'loading',
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: {},
    visibilityState: 'visible'
  }
}

async function buildBundle(outdir) {
  const here = process.cwd()
  const p = (rel) => join(here, rel).replace(/\\/g, '/')
  const entry = [
    "import * as React from 'react'",
    "import { renderToStaticMarkup } from 'react-dom/server'",
    `import * as Page from '${p('src/renderer/src/features/schedule/ScheduleTasksPage.tsx')}'`,
    `import * as Draft from '${p('src/renderer/src/features/schedule/schedule-draft.ts')}'`,
    `import * as Client from '${p('src/renderer/src/features/schedule/schedule-client.ts')}'`,
    `import * as i18n from '${p('src/renderer/src/i18n/index.tsx')}'`,
    "export { React, renderToStaticMarkup, Page, Draft, Client, i18n }"
  ].join('\n')
  const outfile = join(outdir, 'v3-schedule-ui.bundle.cjs')
  await build({
    stdin: { contents: entry, resolveDir: here, loader: 'tsx' },
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    logLevel: 'silent',
    loader: { '.css': 'empty' }
  })
  return outfile
}

function mockBridge(responses = {}) {
  const calls = []
  const record = (name) => (...args) => {
    calls.push({ name, args })
    const reply = responses[name]
    return Promise.resolve(typeof reply === 'function' ? reply(...args) : (reply ?? { ok: true }))
  }
  return {
    calls,
    list: record('list'),
    create: record('create'),
    update: record('update'),
    setEnabled: record('setEnabled'),
    remove: record('remove'),
    runNow: record('runNow')
  }
}

const task = (over = {}) => ({
  id: over.id ?? 't1',
  name: over.name ?? '每日简报',
  prompt: over.prompt ?? '总结今天的改动',
  trigger: over.trigger ?? { kind: 'daily', time: '09:00' },
  enabled: over.enabled ?? true,
  createdBy: over.createdBy ?? 'user',
  createdAt: over.createdAt ?? 1000,
  ...(over.model ? { model: over.model } : {}),
  ...(over.nextRunAt ? { nextRunAt: over.nextRunAt } : {}),
  ...(over.lastRunAt ? { lastRunAt: over.lastRunAt } : {}),
  ...(over.lastError ? { lastError: over.lastError } : {}),
  ...(over.pendingApproval ? { pendingApproval: true } : {})
})

async function main() {
  installGlobals()
  const outdir = await mkdtemp(join(tmpdir(), 'inkstone-v3-schedule-ui-'))
  const require = createRequire(import.meta.url)

  try {
    const bundle = require(await buildBundle(outdir))
    const { React, renderToStaticMarkup, Page, Draft, Client, i18n } = bundle
    const { createElement } = React
    const t = (lang) => (key, vars) => i18n.translate(lang, key, vars)
    const zh = t('zh-CN')
    const en = t('en-US')
    const render = (element) => renderToStaticMarkup(element)

    const onceAt = new Date(2026, 0, 2, 9, 30, 0, 0).getTime()
    const cases = [
      ['daily', { kind: 'daily', time: '09:05' }],
      ['weekdays', { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '08:00' }],
      ['weekly', { kind: 'weekly', days: [1, 3], time: '21:00' }],
      ['interval', { kind: 'interval', minutes: 60 }],
      ['once', { kind: 'once', at: onceAt }]
    ]
    for (const [name, trigger] of cases) {
      const draft = Draft.draftFromTask(task({ trigger }))
      const round = Draft.triggerFromDraft(draft)
      assert.deepEqual(round, trigger, `往返保持 ${name} 触发规则`)
      checks++
      console.log(`✓ 往返保持 ${name} 触发规则`)
    }
    ok(Draft.draftFromTask(task({ trigger: { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '08:00' } })).kind === 'weekdays', '工作日五点识别为 weekdays 选项')
    ok(Draft.draftFromTask(task({ trigger: { kind: 'weekly', days: [1, 2], time: '08:00' } })).kind === 'weekly', '非工作日组合保留为每周选项')
    ok(Draft.blankDraft('C:/work').cwd === 'C:/work', '新建草稿带上默认工作目录')
    ok(Draft.WEEK_ORDER.join(',') === '1,2,3,4,5,6,0', '星期顺序为周一到周日')

    const empty = Draft.checkDraft({ ...Draft.blankDraft(), prompt: '   ' }, zh)
    ok(!empty.ok && empty.code === 'needPrompt' && empty.message === zh('sched.needPrompt'), '空指令被拒（needPrompt，文案走 i18n）')
    const noAt = Draft.checkDraft({ ...Draft.blankDraft(), prompt: 'x', kind: 'once', at: '' }, zh)
    ok(!noAt.ok && noAt.code === 'needAt' && noAt.message === zh('sched.needAt'), '单次触发缺时间被拒（needAt）')
    const tooOften = Draft.checkDraft({ ...Draft.blankDraft(), prompt: 'x', kind: 'interval', minutes: 1 }, zh)
    ok(!tooOften.ok && tooOften.code === 'invalidTrigger' && tooOften.message.includes('5 分钟'), '间隔小于 5 分钟被 shared 规则拒绝')
    const noDay = Draft.checkDraft({ ...Draft.blankDraft(), prompt: 'x', kind: 'weekly', days: [], time: '09:00' }, zh)
    ok(!noDay.ok && noDay.code === 'invalidTrigger' && noDay.message === zh('sched.needDays'), '每周不选任何一天被 shared 规则拒绝')
    const badTime = Draft.checkDraft({ ...Draft.blankDraft(), prompt: 'x', kind: 'daily', time: '25:00' }, zh)
    ok(!badTime.ok && badTime.code === 'invalidTrigger', '非法 HH:MM 被 shared 规则拒绝')
    const enLong = Draft.checkDraft({ ...Draft.blankDraft(), prompt: 'x'.repeat(12001) }, en)
    ok(!enLong.ok && enLong.message === en('sched.promptTooLong', { max: 12000 }), '英文字面量报错不出现中文')
    const enTooOften = Draft.checkDraft({ ...Draft.blankDraft(), prompt: 'x', kind: 'interval', minutes: 1 }, en)
    ok(!enTooOften.ok && !/[\u4e00-\u9fff]/.test(enTooOften.message), '英文界面下间隔报错不含中文')

    const valid = Draft.checkDraft({ name: '  简报  ', prompt: '  总结  ', cwd: '  ', model: '', kind: 'daily', time: '9:05', days: [1], minutes: 60, at: '' }, zh)
    ok(valid.ok, '合法草稿通过校验')
    ok(valid.ok && valid.input.name === '简报', '名称去掉首尾空白')
    ok(valid.ok && valid.input.prompt === '总结', '指令去掉首尾空白')
    ok(valid.ok && valid.input.cwd === undefined && valid.input.model === undefined, '空工作目录 / 模型不下发覆盖值')
    ok(valid.ok && valid.input.trigger.kind === 'daily' && valid.input.trigger.time === '09:05', '触发时间经 shared 规整为 HH:MM')

    const longPrompt = Draft.checkDraft({ ...Draft.blankDraft(), prompt: 'x'.repeat(12001) }, zh)
    ok(!longPrompt.ok, '超长指令被拒')

    const input = Draft.checkDraft({ ...Draft.blankDraft(), name: 'n', prompt: 'p' }, zh).input
    const bridge = mockBridge({
      list: [task()],
      create: { ok: true, task: task() },
      update: { ok: true, task: task() },
      setEnabled: { ok: true },
      remove: { ok: true },
      runNow: { ok: true, sessionId: 's1' }
    })
    const listed = await Client.loadTasks(bridge)
    ok(bridge.calls[0].name === 'list' && listed.length === 1, 'loadTasks 调用 list 并原样返回')
    await Client.saveTask(bridge, undefined, input)
    ok(bridge.calls[1].name === 'create' && bridge.calls[1].args[0] === input, '无 id 时 saveTask 调用 create(input)')
    await Client.saveTask(bridge, 't1', input)
    ok(bridge.calls[2].name === 'update' && bridge.calls[2].args[0] === 't1' && bridge.calls[2].args[1] === input, '有 id 时 saveTask 调用 update(id, input)')
    await Client.setTaskEnabled(bridge, 't1', false)
    ok(bridge.calls[3].name === 'setEnabled' && bridge.calls[3].args[0] === 't1' && bridge.calls[3].args[1] === false, 'setTaskEnabled 调用 setEnabled(id, bool)')
    await Client.removeTask(bridge, 't1')
    ok(bridge.calls[4].name === 'remove' && bridge.calls[4].args[0] === 't1', 'removeTask 调用 remove(id)')
    await Client.runTaskNow(bridge, 't1')
    ok(bridge.calls[5].name === 'runNow' && bridge.calls[5].args[0] === 't1', 'runTaskNow 调用 runNow(id)')

    const card = (over, lang = 'zh-CN') =>
      render(
        createElement(Page.ScheduleTaskCard, {
          task: task(over),
          busy: false,
          lang,
          t: lang === 'en-US' ? en : zh,
          onToggle: () => {},
          onRunNow: () => {},
          onEdit: () => {},
          onDelete: () => {}
        })
      )
    const onCard = card({ nextRunAt: Date.UTC(2026, 0, 2, 1, 0, 0), lastRunAt: Date.UTC(2026, 0, 1, 1, 0, 0), model: 'anthropic/claude-x' })
    ok(onCard.includes('data-testid="schedule-t1"') && onCard.includes('data-state="on"'), '启用任务渲染为 on 状态')
    ok(onCard.includes('每日简报') && onCard.includes('每天 09:00'), '卡片显示名称与触发描述')
    ok(onCard.includes('下次') && onCard.includes('上次'), '启用任务显示下次与上次时间')
    ok(onCard.includes('claude-x'), '卡片把 provider/id 显示为模型名，完整值在 title')

    const pendingCard = card({ pendingApproval: true, createdBy: 'model', enabled: false })
    ok(pendingCard.includes('data-state="pending"'), '模型创建待确认任务渲染为 pending 状态')
    ok(pendingCard.includes(zh('sched.pending')) && pendingCard.includes(zh('sched.byModel')), '待确认与模型创建标签都在')

    const pausedCard = card({ enabled: false, lastError: '目标会话已变化，未发送指令' })
    ok(pausedCard.includes('data-state="off"') && pausedCard.includes(zh('sched.paused')), '暂停任务渲染为 off 状态并带已暂停标签')
    ok(pausedCard.includes('目标会话已变化'), '上次运行错误显示在卡片上')

    ok(Page.formatWhen(undefined, 'zh-CN') === '—', '缺失时间显示破折号，不猜值')

    ok(Page.describeTriggerText({ kind: 'weekly', days: [1, 3], time: '21:00' }, zh, 'zh-CN') === '每周一、三 21:00', '中文每周描述列出星期')
    ok(Page.describeTriggerText({ kind: 'weekly', days: [1, 3], time: '21:00' }, en, 'en-US') === 'Mon, Wed at 21:00', '英文每周描述列出星期')
    ok(Page.describeTriggerText({ kind: 'weekly', days: [1, 2, 3, 4, 5], time: '08:00' }, en, 'en-US') === 'Weekdays at 08:00', '英文工作日描述')
    ok(Page.describeTriggerText({ kind: 'weekly', days: [0, 6], time: '10:00' }, en, 'en-US') === 'Weekends at 10:00', '英文周末描述')
    ok(Page.describeTriggerText({ kind: 'interval', minutes: 120 }, en, 'en-US') === 'Every 2 hours', '英文整小时间隔描述')
    ok(Page.describeTriggerText({ kind: 'interval', minutes: 90 }, zh, 'zh-CN') === '每 90 分钟', '中文非整小时间隔描述')
    ok(!/[\u4e00-\u9fff]/.test(Page.describeTriggerText({ kind: 'once', at: Date.UTC(2026, 0, 2, 9, 30) }, en, 'en-US')), '英文单次描述不含中文')
    const enCard = card({ name: 'Brief', prompt: 'summarize today', trigger: { kind: 'weekly', days: [1, 3], time: '21:00' } }, 'en-US')
    ok(enCard.includes('Mon, Wed at 21:00') && !/[\u4e00-\u9fff]/.test(enCard), '英文卡片副标题不再出中文')

    const pageClient = mockBridge({ list: [] })
    const pageHtml = render(createElement(i18n.I18nProvider, null, createElement(Page.ScheduleTasksPage, { client: pageClient })))
    ok(pageHtml.includes('data-testid="v3-schedule-page"'), '页面根节点使用 v3-schedule-page')
    ok(pageHtml.includes(zh('sched.title')) && pageHtml.includes(zh('sched.new')), '页面显示标题与新建入口')
    ok(pageHtml.includes(zh('sched.notice')), '页面明确写出定时任务的运行说明')
    ok(!pageHtml.includes('data-testid^="schedule-t"') && !pageHtml.match(/data-testid="schedule-t/), '首帧没有任务快照时不渲染假任务')
    ok(pageClient.calls.length === 0, 'SSR 首帧不发任何 IPC（请求在 effect 里）')

    const pageSrc = await readFile(join(process.cwd(), 'src/renderer/src/features/schedule/ScheduleTasksPage.tsx'), 'utf8')
    ok(pageSrc.includes("from '../../ui'"), '页面控件来自 v3 ui/ primitives')
    ok(pageSrc.includes("from './schedule-draft'") && pageSrc.includes("from './schedule-client'"), '页面复用本地草稿与 IPC 转发模块')
    ok(!pageSrc.includes("components/ui") && !pageSrc.includes("styles/"), '页面不引入 v2 控件或 styles/*')
    ok(!pageSrc.includes('setInterval(') || pageSrc.includes('30_000') , '页面只做 30s 只读刷新，没有自建触发通道')
    ok(pageSrc.includes('loadTasks(') && pageSrc.includes('saveTask(') && pageSrc.includes('setTaskEnabled(') && pageSrc.includes('removeTask(') && pageSrc.includes('runTaskNow('), '增删改启停都经既有 IPC 转发函数')

    const clientSrc = await readFile(join(process.cwd(), 'src/renderer/src/features/schedule/schedule-client.ts'), 'utf8')
    ok(clientSrc.includes('window.yan.schedule'), '客户端缺省读 preload 暴露的 window.yan.schedule')
    ok(clientSrc.includes('bridge.list()') && clientSrc.includes('bridge.create(') && clientSrc.includes('bridge.update(') && clientSrc.includes('bridge.setEnabled(') && clientSrc.includes('bridge.remove(') && clientSrc.includes('bridge.runNow('), '客户端逐一转发既有 IPC 方法')

    const css = await readFile(join(process.cwd(), 'src/renderer/src/features/schedule/schedule-tasks.css'), 'utf8')
    const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '')
    ok(css.startsWith('@layer features'), 'CSS 落在 features 层')
    ok(!cssCode.includes('@import') && !/@keyframes/.test(cssCode), 'CSS 不 @import、不自建关键帧')
    ok(!/styles\/|components\//.test(cssCode), 'CSS 不依赖 v2 样式目录')
    ok(cssCode.includes('grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)'), '弹性列使用 minmax(0, 1fr)')

    console.log(`\nv3-schedule-ui: ${checks} checks passed`)
  } finally {
    await rm(outdir, { recursive: true, force: true })
  }
}

await main()
