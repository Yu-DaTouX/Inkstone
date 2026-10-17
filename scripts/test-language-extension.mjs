import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function withSettings(lang, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'yan-lang-'))
  try {
    if (lang !== null) writeFileSync(join(dir, 'desktop.json'), JSON.stringify({ lang }), 'utf8')
    const prev = process.env.YAN_DATA_DIR
    process.env.YAN_DATA_DIR = dir
    try {
      return fn()
    } finally {
      if (prev === undefined) delete process.env.YAN_DATA_DIR
      else process.env.YAN_DATA_DIR = prev
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function runLanguageExtensionTests(ok, mod) {
  const { languageSystemPrompt, default: extension } = mod

  const zh = languageSystemPrompt('zh-CN')
  const en = languageSystemPrompt('en-US')
  ok(typeof zh === 'string' && zh.includes('推理'), 'zh-CN 的句子明确要求推理也跟随', String(zh))
  ok(typeof en === 'string' && /think/i.test(en), 'en-US 的句子明确要求推理也跟随', String(en))
  ok(languageSystemPrompt('ja-JP') === null, '不认识的语言不注入任何要求', String(languageSystemPrompt('ja-JP')))
  ok(languageSystemPrompt(undefined) === null, '语言缺失时也不注入', String(languageSystemPrompt(undefined)))

  const handlers = {}
  extension({ on: (name, fn) => (handlers[name] = fn) })
  ok(typeof handlers.before_agent_start === 'function', '扩展注册了 before_agent_start')

  const run = (lang, base) =>
    withSettings(lang, () => handlers.before_agent_start({ type: 'before_agent_start', systemPrompt: base }, {}))

  const zhOut = run('zh-CN', 'BASE')
  ok(zhOut?.systemPrompt === `BASE\n\n${zh}`, '中文界面：追加在已有系统提示之后（不覆盖原提示）', String(zhOut?.systemPrompt))
  const zhNoBase = run('zh-CN', '')
  ok(zhNoBase?.systemPrompt === zh, '没有原提示时也能注入', String(zhNoBase?.systemPrompt))
  const enOut = run('en-US', 'BASE')
  ok(enOut?.systemPrompt === `BASE\n\n${en}`, '英文界面：注入英文要求', String(enOut?.systemPrompt))
  ok(run('ja-JP', 'BASE') === undefined, '不认识的语言：返回 undefined（不写 systemPrompt）')
  ok(run(null, 'BASE') === undefined, '设置读不到：返回 undefined（不猜语言）')
  ok(
    withSettings('zh-CN', () => {
      const dir = process.env.YAN_DATA_DIR
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'desktop.json'), '{ 坏掉的 json', 'utf8')
      return handlers.before_agent_start({ type: 'before_agent_start', systemPrompt: 'BASE' }, {})
    }) === undefined,
    'desktop.json 坏了也不注入（不影响这一轮）'
  )

  ok(handlers.before_provider_request === undefined, '只写进系统提示，不在每次请求里插消息（保持缓存前缀稳定）')

  const { readFileSync } = await import('node:fs')
  const mainSrc = readFileSync('src/main/index.ts', 'utf8')
  ok(
    !mainSrc.includes('推理（思考过程）与回复一律使用简体中文'),
    '主进程里不再重复维护这句措辞（单一真源在扩展里）'
  )
}
