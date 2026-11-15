import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

function cli(args, env = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^YAN_/.test(key)))
  const out = spawnSync(process.execPath, ['resources/yan-cli/yan.mjs', ...args], { encoding: 'utf8', env: { ...clean, ...env } })
  return { code: out.status, stdout: out.stdout, stderr: out.stderr }
}

await runSuite(import.meta.url, async (ok, compile) => {
  const { runModelAsk } = await compile('src/main/model-ask.ts')
  const base = mkdtempSync(join(tmpdir(), 'yan-model-ask-'))
  const cwd = join(base, 'project')
  mkdirSync(join(cwd, '.git'), { recursive: true })
  writeFileSync(join(cwd, 'in.txt'), '请翻译：你好', 'utf8')
  writeFileSync(join(base, 'outside.txt'), 'x', 'utf8')
  const calls = []
  const deps = (answer = () => ({ text: 'Hello' })) => ({
    call: async (req) => {
      calls.push(req)
      const plan = answer(req)
      if (plan.error) {
        const error = new Error(plan.error)
        error.kind = 'model'
        throw error
      }
      return { text: plan.text, model: req.model, usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4 }, stopReason: 'stop', durationMs: 5 }
    }
  })
  const context = { cwd, model: 'fake/session-model' }
  const fails = async (params, code, label, ctx = context) => {
    let error
    try {
      await runModelAsk(params, ctx, deps())
    } catch (e) {
      error = e
    }
    ok(error?.code === code, label, `${error?.code}: ${error?.message}`)
  }

  try {
    await fails({}, 'model_prompt_required', '缺 prompt 与 promptFile 被拒')
    await fails({ prompt: '  ' }, 'model_prompt_required', '空白 prompt 被拒')
    await fails({ prompt: 'a', promptFile: 'in.txt' }, 'model_param_invalid', 'prompt 与 promptFile 只能二选一')
    await fails({ prompt: 'a', promt: 'x' }, 'model_param_invalid', '不认识的参数被拒（防拼写错误）')
    await fails({ prompt: 'a', timeoutMinutes: 31 }, 'model_param_invalid', 'timeoutMinutes 超过 30 被拒')
    await fails({ prompt: 'a', timeoutMinutes: 1.5 }, 'model_param_invalid', 'timeoutMinutes 非整数被拒')
    await fails({ prompt: 'a', thinking: 'ultra' }, 'model_param_invalid', 'thinking 非法被拒')
    await fails({ prompt: 'a', schema: { pattern: 'x' } }, 'model_param_invalid', '不支持的 schema 被拒')
    await fails({ prompt: 'a', schema: '{"type":"object"' }, 'model_param_invalid', 'schema 字符串不是 JSON 被拒')
    await fails({ promptFile: join(base, 'outside.txt') }, 'model_path_invalid', 'promptFile 在项目外被拒')
    await fails({ promptFile: '../outside.txt' }, 'model_path_invalid', 'promptFile 用 .. 逃出被拒')
    await fails({ promptFile: '.git/config' }, 'model_path_invalid', 'promptFile 指向 .git 被拒')
    await fails({ prompt: 'a', outFile: join(base, 'leak.txt') }, 'model_path_invalid', 'outFile 在项目外被拒')
    await fails({ prompt: 'a', outFile: '\\\\server\\share\\x.txt' }, 'model_path_invalid', 'outFile 为 UNC 被拒')
    await fails({ prompt: 'a' }, 'model_required', '没有模型可用时被拒', { cwd })
    ok(calls.length === 0, '参数不合法时不发起模型调用')

    {
      const controller = new AbortController()
      const out = await runModelAsk({ promptFile: 'in.txt', system: '译成英文', thinking: 'low', timeoutMinutes: 2, 'out-file': 'out/en.txt' }, context, deps(), controller.signal)
      const req = calls.at(-1)
      ok(req.prompt === '请翻译：你好' && req.model === 'fake/session-model' && req.system === '译成英文' && req.thinking === 'low' && req.timeoutMs === 120_000 && req.signal === controller.signal, 'promptFile 读入、默认用会话模型、选项与取消信号传给直接调用', JSON.stringify({ ...req, signal: undefined }))
      ok(readFileSync(join(cwd, 'out', 'en.txt'), 'utf8') === 'Hello', 'outFile 写在项目内（自动建目录）')
      ok(out.data.text === 'Hello' && out.data.usage.totalTokens === 4 && out.data.stopReason === 'stop' && out.summary.kind === 'model' && out.summary.preview === 'Hello' && out.summary.outFile === 'out/en.txt', '结果与摘要带文本、用量、stopReason 与 outFile', JSON.stringify(out.summary))
    }

    {
      await runModelAsk({ prompt: 'x', model: 'fake/other' }, context, deps())
      ok(calls.at(-1).model === 'fake/other' && calls.at(-1).timeoutMs === 300_000, '显式 model 覆盖会话模型；默认超时 5 分钟')
    }

    {
      const out = await runModelAsk({ prompt: 'x', schema: { type: 'object', required: ['en'], properties: { en: { type: 'string' } } } }, context, deps(() => ({ text: '```json\n{"en":"Hi"}\n```' })))
      ok(out.data.json?.en === 'Hi' && /JSON Schema/.test(calls.at(-1).prompt), 'schema：请求附格式要求，结果带校验过的 JSON', JSON.stringify(out.data))
      let error
      try {
        await runModelAsk({ prompt: 'x', schema: { type: 'object', required: ['en'] } }, context, deps(() => ({ text: '{"zh":"嗨"}' })))
      } catch (e) {
        error = e
      }
      ok(error?.code === 'model_schema_failed' && /en/.test(error.message) && error.data?.text === '{"zh":"嗨"}', 'schema 不合格时报错并附原始输出', `${error?.code} ${error?.message}`)
    }

    {
      let error
      try {
        await runModelAsk({ prompt: 'x' }, context, deps(() => ({ error: '429 You exceeded your current quota, please check your plan and billing details.' })))
      } catch (e) {
        error = e
      }
      ok(error?.code === 'model_call_failed' && /exceeded your current quota/.test(error.message), '模型报错原样带回', `${error?.code} ${error?.message}`)
    }

    {
      const help = cli(['--help'])
      ok(help.code === 0 && /yan model ask --request-file/.test(help.stdout), 'yan --help 列出 model ask')
      const group = cli(['model', '--help'])
      ok(group.code === 0 && /promptFile/.test(group.stdout) && /outFile/.test(group.stdout), 'yan model --help 说明请求文件字段', group.stdout.slice(0, 200))
      const missing = cli(['model', 'ask'])
      ok(missing.code === 2 && /prompt/.test(missing.stderr), 'yan model ask 不给 prompt 时直接报用法错误', missing.stderr)
      const unknown = cli(['model', 'chat'])
      ok(unknown.code === 2 && /未知的 model 子命令/.test(unknown.stderr), '未知动作报用法错误', unknown.stderr)
      const req = join(base, 'req.json')
      writeFileSync(req, JSON.stringify({ promptFile: 'in.txt' }), 'utf8')
      const parsed = cli(['model', 'ask', '--request-file', req])
      ok(parsed.code === 3 && /宿主能力服务不可用/.test(parsed.stderr), '请求文件通过 CLI 校验后才连宿主（没有宿主时报不可用）', parsed.stderr)
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
