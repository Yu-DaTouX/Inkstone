import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
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

    ok(Page.formatWhen(undefined, 'zh-CN') === '—', '缺失时间显示破折号，不猜值')

    ok(Page.describeTriggerText({ kind: 'weekly', days: [1, 3], time: '21:00' }, zh, 'zh-CN') === '每周一、三 21:00', '中文每周描述列出星期')
    ok(Page.describeTriggerText({ kind: 'weekly', days: [1, 3], time: '21:00' }, en, 'en-US') === 'Mon, Wed at 21:00', '英文每周描述列出星期')
    ok(Page.describeTriggerText({ kind: 'weekly', days: [1, 2, 3, 4, 5], time: '08:00' }, en, 'en-US') === 'Weekdays at 08:00', '英文工作日描述')
    ok(Page.describeTriggerText({ kind: 'weekly', days: [0, 6], time: '10:00' }, en, 'en-US') === 'Weekends at 10:00', '英文周末描述')
    ok(Page.describeTriggerText({ kind: 'interval', minutes: 120 }, en, 'en-US') === 'Every 2 hours', '英文整小时间隔描述')
    ok(Page.describeTriggerText({ kind: 'interval', minutes: 90 }, zh, 'zh-CN') === '每 90 分钟', '中文非整小时间隔描述')
    ok(!/[\u4e00-\u9fff]/.test(Page.describeTriggerText({ kind: 'once', at: Date.UTC(2026, 0, 2, 9, 30) }, en, 'en-US')), '英文单次描述不含中文')

    const pageClient = mockBridge({ list: [] })
    const pageHtml = render(createElement(i18n.I18nProvider, null, createElement(Page.ScheduleTasksPage, { client: pageClient })))
    ok(!pageHtml.includes('data-testid^="schedule-t"') && !pageHtml.match(/data-testid="schedule-t/), '首帧没有任务快照时不渲染假任务')
    ok(pageClient.calls.length === 0, 'SSR 首帧不发任何 IPC（请求在 effect 里）')

    console.log(`\nv3-schedule-ui: ${checks} checks passed`)
  } finally {
    await rm(outdir, { recursive: true, force: true })
  }
}

await main()
