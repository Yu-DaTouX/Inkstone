/**
 * 界面语言扩展（resources/pi-extensions/language.js）的单测。
 *
 * 为什么值得钉住：语言要求从「启动参数 `--append-system-prompt`」搬到了
 * 「扩展每轮注入」—— 这条路一旦坏了，只有真调模型才看得出来（而且模型
 * 服从性是软的，失败会像“模型偶尔不听话”）。所以把**机制**确定性测掉：
 *   · 读到 zh-CN / en-US 时注入的句子是什么（推理与回复两种都要说清楚）；
 *   · 读不到设置 / 认不出的值时**什么都不注入**（不猜一种语言强加给模型）；
 *   · 与已有 systemPrompt 的拼接方式（不能把原提示顶掉）。
 *
 * 语言真的生效那部分仍然由 `npm run test:live -- language` 做（要真实模型）。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 造一个只带 desktop.json 的隔离数据目录，并让扩展读到它 */
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

  /* 1. 句子本身：两句语言都要**明确覆盖推理**（用户报过“回复中文、推理还是英文”） */
  const zh = languageSystemPrompt('zh-CN')
  const en = languageSystemPrompt('en-US')
  ok(typeof zh === 'string' && zh.includes('推理'), 'zh-CN 的句子明确要求推理也跟随', String(zh))
  ok(typeof en === 'string' && /think/i.test(en), 'en-US 的句子明确要求推理也跟随', String(en))
  ok(languageSystemPrompt('ja-JP') === null, '不认识的语言不注入任何要求', String(languageSystemPrompt('ja-JP')))
  ok(languageSystemPrompt(undefined) === null, '语言缺失时也不注入', String(languageSystemPrompt(undefined)))

  /* 2. 机制：注册 before_agent_start，按设置返回 systemPrompt */
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

  /*
   * 3. 主通道：before_provider_request 在最后一条 user 消息**前**插一条独立消息。
   *
   * 为什么这条最要紧：只往系统提示末尾追加时，模型实测**不服从**
   *（句子落在 11k 提示的最后 60 字符里）；改成贴近用户消息的独立消息后 2/2 服从。
   */
  const provider = handlers.before_provider_request
  ok(typeof provider === 'function', '扩展注册了 before_provider_request')

  const payload = {
    model: 'm',
    messages: [
      { role: 'developer', content: 'BASE' },
      { role: 'user', content: '第一个问题' },
      { role: 'assistant', content: '回答' },
      { role: 'user', content: '第二个问题' }
    ]
  }
  const withLang = withSettings('en-US', () =>
    provider({ type: 'before_provider_request', payload }, {})
  )
  ok(Array.isArray(withLang?.messages), '有 payload.messages 时会返回修改后的 payload', String(withLang?.messages?.length))
  ok(withLang?.messages?.length === payload.messages.length + 1, '只多出一条消息（不重写对话）')
  ok(withLang?.messages?.[3]?.content === en, '插入的那条就是那一句指令', String(withLang?.messages?.[3]?.content))
  ok(withLang?.messages?.[3]?.role === 'developer', '角色跟着 provider 已有的写法（developer）', String(withLang?.messages?.[3]?.role))
  ok(withLang?.messages?.[4]?.content === '第二个问题', '插在**最后一条 user 之前**（位置最强）')
  ok(payload.messages.length === 4, '不改动传进来的原数组（无副作用）')
  const localPayload = {
    model: 'qwen3-local',
    messages: [
      { role: 'system', content: 'BASE' },
      { role: 'user', content: '本地模型的问题' }
    ]
  }
  const localOut = withSettings('zh-CN', () =>
    provider({ type: 'before_provider_request', payload: localPayload }, { model: { provider: 'local' } })
  )
  ok(localOut?.messages?.length === 2, '本地 provider 不插入中间 system 消息')
  ok(
    localOut?.messages?.[1]?.content === `本地模型的问题\n\n${zh}`,
    '本地 provider 把同一句语言约束贴到最后一条 user 消息'
  )
  ok(localOut?.messages?.[1]?.role === 'user', '本地 provider 保持 Qwen chat template 可接受的 user 角色')
  ok(
    withSettings('zh-CN', () => provider({ type: 'before_provider_request', payload: { ...payload } }, {}) )?.messages?.[3]
      ?.content === zh,
    '中文界面插的是中文那句'
  )
  ok(
    withSettings('ja-JP', () => provider({ type: 'before_provider_request', payload }, {})) === undefined,
    '不认识的语言：不动 payload'
  )
  ok(
    provider({ type: 'before_provider_request', payload: { messages: 'nope' } }, {}) === undefined,
    'payload 结构不认识（没有 messages 数组）时不动它'
  )
  ok(
    withSettings('en-US', () => provider({ type: 'before_provider_request', payload: { messages: [{ role: 'developer', content: 'x' }] } }, {})) === undefined,
    '没有 user 消息时不动 payload'
  )

  /*
   * 4. 措辞单点：句子只应该在这一处维护。
   *    如果哪天有人又把它复制回主进程（两处会漂移），这条会提醒。
   */
  const { readFileSync } = await import('node:fs')
  const mainSrc = readFileSync('src/main/index.ts', 'utf8')
  ok(
    !mainSrc.includes('推理（思考过程）与回复一律使用简体中文'),
    '主进程里不再重复维护这句措辞（单一真源在扩展里）'
  )
}
