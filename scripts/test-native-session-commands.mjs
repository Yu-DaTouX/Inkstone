/**
 * pi 原生输入命令的定向检查（不启动 Electron、不调用模型、不联网）。
 *
 * 覆盖两处本轮改动的纯逻辑：
 *   · `src/main/command-registry.ts` —— `/tree` `/import` `/reload` `/scoped-models`
 *     `/trust` `/share` 从「仅兼容显示」升级为可执行的 yan 命令，`/export` 带路径；
 *     `/hotkeys` `/changelog` 仍是兼容项（不能变成无效果按钮）。
 *   · `src/renderer/src/lib/composer-submit.ts` —— 命令路由到 `nativeSession`，
 *     `/compact` 后缀透传、`/export *.jsonl` 走 JSONL、`!`/`!!` 的上下文语义、
 *     失败保留草稿附件并报告原文、运行中拒绝替换/重载。
 *
 * 与 `test-command-palette.mjs` 用同一套 esbuild 加载真实模块的做法。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const REGISTRY_ENTRY = 'src/main/command-registry.ts'
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
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'neutral', format: 'esm', logLevel: 'silent' })
  return { module: await import(pathToFileURL(outfile).href), dir }
}

const YAN = (name, executable = true) => ({ name, source: 'yan', executable })

/** 记录型端口：把 nativeSession / store 动作调用顺序留下来。 */
function recordingPort(over = {}) {
  const { actions: actionOverrides, ...rest } = over
  const calls = []
  const actions = {
    runBash: (cmd, options) => calls.push(['runBash', cmd, options]),
    openSettings: (tab) => calls.push(['openSettings', tab]),
    newSession: () => calls.push(['newSession']),
    compact: (custom) => calls.push(['compact', custom]),
    openBrowser: (url) => calls.push(['openBrowser', url]),
    setModel: (provider, id) => calls.push(['setModel', provider, id]),
    exportHtml: (path) => calls.push(['exportHtml', path]),
    copyLastReply: () => calls.push(['copyLastReply']),
    clone: () => calls.push(['clone']),
    setManualTitle: (id, title) => calls.push(['setManualTitle', id, title]),
    setThinking: (level) => calls.push(['setThinking', level]),
    nativeSession: (action, args) => {
      calls.push(['nativeSession', action, args])
      return Promise.resolve({ ok: true })
    },
    notify: (level, text) => calls.push(['notify', level, text]),
    ...(actionOverrides ?? {})
  }
  const port = {
    text: '',
    attachments: [],
    commands: [],
    models: [],
    t: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
    session: null,
    thinkingLevels: [],
    roundRunning: false,
    isCompacting: false,
    clearText: () => calls.push(['clearText']),
    clearAll: () => calls.push(['clearAll']),
    restoreText: (raw) => calls.push(['restoreText', raw]),
    restoreAttachments: (saved) => calls.push(['restoreAttachments', saved]),
    readAttachments: () => [],
    send: () => Promise.resolve(true),
    holdSend: () => {},
    focusComposer: () => calls.push(['focusComposer']),
    ...rest,
    actions
  }
  return { port, calls }
}

const registryCommands = (R) => {
  const local = R.localCommandDescriptors()
  return {
    local,
    find: (name) => local.find((command) => command.name === name)
  }
}

async function main() {
  const registry = await load(REGISTRY_ENTRY, 'command-registry')
  const submit = await load(SUBMIT_ENTRY, 'composer-submit')
  try {
    const R = registry.module
    const S = submit.module

    /* ── 注册表：新增命令是正式可执行的 yan 命令 ── */
    const { find } = registryCommands(R)
    for (const name of ['tree', 'import', 'reload', 'scoped-models', 'trust', 'share']) {
      const command = find(name)
      ok(command?.source === 'yan' && command.executable === true, `/${name} 是可执行的 yan 命令`)
      ok(!!command?.usage?.startsWith(`/${name}`), `/${name} 带用法提示`)
      ok(!!command?.description, `/${name} 有说明`)
      const compat = R.localCommandDescriptors().find((c) => c.name === name && c.source === 'compatibility')
      ok(!compat, `/${name} 不再是兼容项（不会只给说明不执行）`)
    }
    const exp = find('export')
    ok(exp?.source === 'yan' && exp.executable === true, '/export 仍可执行')
    ok(exp?.usage === '/export [路径]', '/export 用法带可选路径')
    ok(exp?.description?.includes('jsonl'), '/export 说明区分 JSONL 与 HTML')

    /* ── 注册表：/hotkeys /changelog 保持兼容并给出真实入口 ── */
    for (const name of ['hotkeys', 'changelog']) {
      const command = find(name)
      ok(command?.source === 'compatibility' && command.executable === false, `/${name} 仍是兼容项`)
      ok(!!command?.availability, `/${name} 说明桌面端入口（不是无效果按钮）`)
    }

    /* ── 提交分发：命令列表 ── */
    const commands = [
      YAN('tree'),
      YAN('import'),
      YAN('reload'),
      YAN('scoped-models'),
      YAN('trust'),
      YAN('share'),
      YAN('export'),
      YAN('compact'),
      { name: 'hotkeys', source: 'compatibility', executable: false, availability: '按钮悬停里标有快捷键' },
      { name: 'changelog', source: 'compatibility', executable: false, availability: '版本信息在关于页' },
      { name: 'help', source: 'pi', executable: true }
    ]

    /* 每条新增命令都路由到 nativeSession，并且只在成功后清空草稿 */
    const routed = [
      ['/tree', 'tree', undefined],
      ['/import C:\\sessions\\a.jsonl', 'import', 'C:\\sessions\\a.jsonl'],
      ['/reload', 'reload', undefined],
      ['/scoped-models', 'scoped-models', undefined],
      ['/trust', 'trust', undefined],
      ['/share', 'share', undefined]
    ]
    for (const [text, action, args] of routed) {
      const r = recordingPort({ text, commands })
      eq(await S.submitComposerInput(r.port), 'handled', `${text} 被分发消费`)
      const call = r.calls.find((c) => c[0] === 'nativeSession')
      eq(call, ['nativeSession', action, args], `${text} 路由到 nativeSession(${action})`)
      ok(r.calls.some((c) => c[0] === 'clearAll'), `${text} 成功后清空草稿`)
      ok(!r.calls.some((c) => c[0] === 'send'), `${text} 不发给模型`)
    }

    /* ── /export：.jsonl 走 JSONL，其余走 HTML（带路径） ── */
    let r = recordingPort({ text: '/export C:\\tmp\\a.jsonl', commands })
    await S.submitComposerInput(r.port)
    ok(r.calls.some((c) => c[0] === 'nativeSession' && c[1] === 'export-jsonl' && c[2] === 'C:\\tmp\\a.jsonl'), '/export *.jsonl 路由 JSONL')
    ok(!r.calls.some((c) => c[0] === 'exportHtml'), '/export *.jsonl 不调 HTML 导出')

    r = recordingPort({ text: '/export C:\\tmp\\a.HTML', commands })
    await S.submitComposerInput(r.port)
    eq(r.calls.find((c) => c[0] === 'exportHtml'), ['exportHtml', 'C:\\tmp\\a.HTML'], '/export 非 .jsonl 走 HTML 并透传路径')
    ok(!r.calls.some((c) => c[0] === 'nativeSession'), '/export HTML 不碰 nativeSession')

    r = recordingPort({ text: '/export', commands })
    await S.submitComposerInput(r.port)
    eq(r.calls.find((c) => c[0] === 'exportHtml'), ['exportHtml', undefined], '/export 无路径时不传路径')

    /* ── /compact 后缀作为自定义指令透传 ── */
    r = recordingPort({ text: '/compact 只保留代码改动', commands })
    await S.submitComposerInput(r.port)
    eq(r.calls.find((c) => c[0] === 'compact'), ['compact', '只保留代码改动'], '/compact 后缀透传')
    r = recordingPort({ text: '/compact', commands })
    await S.submitComposerInput(r.port)
    eq(r.calls.find((c) => c[0] === 'compact'), ['compact', undefined], '/compact 无后缀不传参数')

    /* ── 失败：保留草稿附件、报告原文，不先 clearAll ── */
    const failPort = (text, action, error) =>
      recordingPort({
        text,
        commands,
        attachments: [{ id: 'a1', kind: 'image', data: 'x', mimeType: 'image/png' }],
        readAttachments: () => [{ id: 'a1' }],
        actions: { nativeSession: () => Promise.resolve({ ok: false, error }) }
      })
    r = failPort('/trust', 'trust', 'pi trust.json 写入失败')
    eq(await S.submitComposerInput(r.port), 'handled', '/trust 失败仍被消费')
    ok(r.calls.some((c) => c[0] === 'notify' && c[1] === 'error' && c[2] === 'pi trust.json 写入失败'), '/trust 失败报告原文')
    ok(!r.calls.some((c) => c[0] === 'clearAll'), '/trust 失败不清空草稿')
    ok(r.calls.some((c) => c[0] === 'focusComposer'), '/trust 失败把焦点还给输入框')

    r = recordingPort({
      text: '/compact',
      commands,
      actions: { compact: () => Promise.resolve({ ok: false, error: '上下文不可压缩' }) }
    })
    await S.submitComposerInput(r.port)
    ok(r.calls.some((c) => c[0] === 'notify' && c[1] === 'error' && c[2] === '上下文不可压缩'), '/compact 失败报告原文')
    ok(!r.calls.some((c) => c[0] === 'clearAll'), '/compact 失败保留草稿')

    r = recordingPort({
      text: '/export',
      commands,
      actions: { exportHtml: () => Promise.resolve({ ok: false, error: '没有可导出的会话' }) }
    })
    await S.submitComposerInput(r.port)
    ok(r.calls.some((c) => c[0] === 'notify' && c[1] === 'error' && c[2] === '没有可导出的会话'), '/export 失败报告原文')
    ok(!r.calls.some((c) => c[0] === 'clearAll'), '/export 失败保留草稿')

    /* ── 运行中：import / reload 明确拒绝，tree 等仍可打开 ── */
    for (const text of ['/import a.jsonl', '/reload']) {
      const run = recordingPort({ text, commands, roundRunning: true })
      await S.submitComposerInput(run.port)
      ok(!run.calls.some((c) => c[0] === 'nativeSession'), `${text} 运行中被拒绝`)
      ok(run.calls.some((c) => c[0] === 'notify' && c[1] === 'info'), `${text} 运行中给出说明`)
      ok(!run.calls.some((c) => c[0] === 'clearAll'), `${text} 运行中保留草稿`)
    }
    r = recordingPort({ text: '/tree', commands, roundRunning: true })
    await S.submitComposerInput(r.port)
    ok(r.calls.some((c) => c[0] === 'nativeSession' && c[1] === 'tree'), '/tree 运行中仍可打开（只浏览不改会话）')

    /* ── nativeSession 未接入：说明并保留草稿，不制造无效果按钮 ── */
    r = recordingPort({ text: '/tree', commands, actions: { nativeSession: undefined } })
    await S.submitComposerInput(r.port)
    ok(r.calls.some((c) => c[0] === 'notify' && c[1] === 'info'), '/tree 未接入时给出说明')
    ok(!r.calls.some((c) => c[0] === 'clearAll'), '/tree 未接入时保留草稿')

    /* ── ! / !!：直执行与排除上下文 ── */
    r = recordingPort({ text: '!echo hi', commands })
    await S.submitComposerInput(r.port)
    eq(r.calls.find((c) => c[0] === 'runBash'), ['runBash', 'echo hi', undefined], '! 前缀直接执行且进入上下文')

    r = recordingPort({ text: '!!echo hi', commands })
    await S.submitComposerInput(r.port)
    eq(r.calls.find((c) => c[0] === 'runBash'), ['runBash', 'echo hi', { excludeFromContext: true }], '!! 前缀排除模型上下文')
    ok(r.calls.some((c) => c[0] === 'clearText'), '!! 只清文字不清附件')
    ok(!r.calls.some((c) => c[0] === 'clearAll'), '!! 不动附件')

    /* ── 兼容命令与未知命令沿用既有行为 ── */
    for (const text of ['/hotkeys', '/changelog']) {
      const compat = recordingPort({ text, commands })
      await S.submitComposerInput(compat.port)
      ok(compat.calls.some((c) => c[0] === 'notify' && c[1] === 'info'), `/${text.slice(1)} 给出兼容说明`)
      ok(!compat.calls.some((c) => c[0] === 'clearAll' || c[0] === 'clearText'), `/${text.slice(1)} 不清空草稿`)
      ok(!compat.calls.some((c) => c[0] === 'send'), `/${text.slice(1)} 不发模型`)
    }

    r = recordingPort({ text: '/nope', commands })
    eq(await S.submitComposerInput(r.port), 'sent', '未知命令落回普通发送（既有行为）')

    console.log(`native-session-commands 检查通过：${checks} 项`)
  } finally {
    await rm(registry.dir, { recursive: true, force: true })
    await rm(submit.dir, { recursive: true, force: true })
  }
}

await main()
