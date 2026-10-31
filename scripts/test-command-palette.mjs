import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

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
  const submit = await load(SUBMIT_ENTRY, 'composer-submit')
  try {
    const S = submit.module

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
    eq(r.calls.at(-1), ['openSettings', 'models'], '/model 无参数打开模型设置')
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

    r = recordingPort({ text: '继续', attachments: [], commands, roundRunning: false, isCompacting: true })
    eq(await S.submitComposerInput(r.port), 'queued', '回合已停但仍在压缩时也先悬着')
    ok(r.calls.some((c) => c[0] === 'holdSend'), '回合已停但仍在压缩时走 holdSend')
    ok(!r.calls.some((c) => c[0] === 'send'), '回合已停但仍在压缩时不直接发送')

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

    const attachment = { id: 'full', name: '原附件.png', size: 123, preview: 'preview', kind: 'image', data: 'abc', mimeType: 'image/png' }
    r = recordingPort({ text: '完整恢复', attachments: [attachment], readAttachments: () => [attachment], send: async () => false })
    await S.submitComposerInput(r.port)
    eq(r.calls.find(c => c[0] === 'restoreAttachments')?.[1], [attachment], '发送失败保留附件名称、尺寸与预览')

    console.log(`command-palette 检查通过：${checks} 项`)
  } finally {
    await rm(submit.dir, { recursive: true, force: true })
  }
}

await main()
