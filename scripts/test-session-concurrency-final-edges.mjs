import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from '../node_modules/esbuild/lib/main.js'

export async function runSessionConcurrencyFinalEdgesTests(ok) {
  const section = (name) => console.log(`\n## ${name}`)
  const temp = await mkdtemp(join(tmpdir(), 'yan-final-edges-'))

  const bundleToFile = async (entry, name, plugins) => {
    const outfile = join(temp, name)
    await build({
      entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      logLevel: 'silent',
      ...(plugins ? { plugins } : {})
    })
    return import(pathToFileURL(outfile).href)
  }

  const { submitComposerInput } = await bundleToFile('../src/renderer/src/lib/composer-submit.ts', 'composer-submit.mjs')

  function makePort(overrides = {}) {
    const calls = { runBash: [], clearText: 0, clearAll: 0, restoreText: [], restoreAttachments: [], notify: [] }
    const state = { text: overrides.text ?? '', attachments: overrides.attachments ?? [] }
    const port = {
      get text() {
        return state.text
      },
      get attachments() {
        return state.attachments
      },
      commands: [],
      models: [],
      t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
      actions: {
        runBash: async (cmd, options) => {
          calls.runBash.push({ cmd, options })
          return overrides.runBash ? overrides.runBash(cmd, options) : { ok: true }
        },
        openSettings: () => {},
        newSession: () => {},
        compact: () => {},
        openBrowser: () => {},
        setModel: () => {},
        exportHtml: () => {},
        copyLastReply: () => {},
        clone: () => {},
        setManualTitle: () => {},
        setThinking: () => {},
        notify: (level, text) => calls.notify.push({ level, text })
      },
      session: null,
      thinkingLevels: [],
      roundRunning: false,
      isCompacting: false,
      clearText: () => {
        calls.clearText += 1
        state.text = ''
      },
      clearAll: () => {
        calls.clearAll += 1
        state.text = ''
        state.attachments = []
      },
      restoreText: (raw) => {
        calls.restoreText.push(raw)
        state.text = state.text ? `${raw}\n${state.text}` : raw
      },
      restoreAttachments: (saved) => {
        calls.restoreAttachments.push(saved)
        state.attachments = [...saved, ...state.attachments.filter((item) => !saved.some((kept) => kept.id === item.id))]
      },
      readAttachments: () => state.attachments,
      send: async () => true,
      holdSend: () => {},
      focusComposer: () => {}
    }
    return { port, calls, state }
  }

  const attachment = (id) => ({ id, kind: 'image', name: `${id}.png`, data: 'AAAA', mimeType: 'image/png', size: 4 })

  section('composer-submit：`!` 成功只清文字')
  {
    const { port, calls, state } = makePort({ text: '!echo hi', attachments: [attachment('a1')] })
    const outcome = await submitComposerInput(port)
    ok(outcome === 'handled', '`!` 返回 handled', outcome)
    ok(calls.runBash.length === 1 && calls.runBash[0].cmd === 'echo hi', '命令去掉前缀与空白后直执行', JSON.stringify(calls.runBash[0]))
    ok(calls.runBash[0].options === undefined, '单个 `!` 不带 excludeFromContext', JSON.stringify(calls.runBash[0].options))
    ok(calls.clearText === 1 && calls.clearAll === 0, '成功只清文字、不动附件', JSON.stringify(calls))
    ok(state.text === '', '成功后草稿清空')
    ok(calls.restoreText.length === 0 && calls.restoreAttachments.length === 0, '成功不恢复')
    ok(state.attachments.length === 1, '附件留在输入框（沿用既有行为）')
  }

  section('composer-submit：`!!` 保留 excludeFromContext 且失败恢复')
  {
    const { port, calls, state } = makePort({
      text: '!!rm -rf build',
      attachments: [attachment('a1')],
      runBash: () => ({ ok: false, error: '同 cwd 冲突' })
    })
    const outcome = await submitComposerInput(port)
    ok(outcome === 'handled', '`!!` 失败仍返回 handled', outcome)
    ok(calls.runBash[0].cmd === 'rm -rf build', '`!!` 去掉两个前缀', calls.runBash[0].cmd)
    ok(calls.runBash[0].options?.excludeFromContext === true, '`!!` 的 excludeFromContext 不丢', JSON.stringify(calls.runBash[0].options))
    ok(state.text === '!!rm -rf build', '失败把命令原文放回草稿', JSON.stringify(state.text))
    ok(calls.restoreAttachments.length === 1, '失败把附件快照交回恢复', JSON.stringify(calls.restoreAttachments))
    ok(state.attachments.filter((a) => a.id === 'a1').length === 1, '附件恢复不产生重复', JSON.stringify(state.attachments))
  }

  section('composer-submit：runBash 抛异常也恢复')
  {
    const { port, calls, state } = makePort({
      text: '!deploy',
      attachments: [attachment('a1')],
      runBash: () => {
        throw new Error('通道断开')
      }
    })
    const outcome = await submitComposerInput(port)
    ok(outcome === 'handled', '抛异常仍返回 handled', outcome)
    ok(state.text === '!deploy', '抛异常把命令原文放回草稿', JSON.stringify(state.text))
    ok(calls.restoreAttachments.length === 1, '抛异常把附件放回')
    ok(calls.notify.some((n) => n.level === 'error' && /通道断开/.test(n.text)), '抛异常给出错误提示', JSON.stringify(calls.notify))
  }

  section('composer-submit：旧 void 返回视为已执行')
  {
    const { port, calls, state } = makePort({ text: '!whatever', runBash: () => undefined })
    const outcome = await submitComposerInput(port)
    ok(outcome === 'handled', 'void 返回仍 handled', outcome)
    ok(calls.clearText === 1 && calls.restoreText.length === 0, '旧实现不恢复，保持原行为', JSON.stringify(calls))
    ok(state.text === '', '旧实现成功后草稿清空')
  }

  section('composer-submit：恢复不覆盖 await 期间的新草稿')
  {
    const { port, calls, state } = makePort({
      text: '!long-task',
      runBash: () => {
        state.text = '用户新敲的内容'
        return { ok: false, error: '失败' }
      }
    })
    await submitComposerInput(port)
    ok(state.text.includes('!long-task') && state.text.includes('用户新敲的内容'), '恢复是追加式：命令与 await 期间的新草稿都在', JSON.stringify(state.text))
    ok(calls.restoreText[0] === '!long-task', '恢复的正是原始命令原文', JSON.stringify(calls.restoreText))
  }

  section('composer-submit：只有 `!` 没有命令时不执行')
  {
    const { port, calls } = makePort({ text: '!' })
    const outcome = await submitComposerInput(port)
    ok(outcome === 'empty', '空命令返回 empty', outcome)
    ok(calls.runBash.length === 0 && calls.clearText === 0, '空命令不调用 runBash、不清草稿', JSON.stringify(calls))
  }
}

async function main() {
  let passed = 0
  let failed = 0
  await runSessionConcurrencyFinalEdgesTests((cond, label, detail) => {
    if (cond) {
      passed += 1
      console.log(`  [ok] ${label}`)
    } else {
      failed += 1
      console.error(`  [FAIL] ${label}${detail === undefined ? '' : ` -> ${detail}`}`)
    }
  })
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main()
