/*
 * 自定义 API 服务单测（src/shared/custom-provider.ts，实施-23 M1）。
 *
 * 重点不是"能不能存"，而是：
 *   · 砚只动 `yan-` 前缀的条目，用户手工写的 provider 与未知字段必须原样保留；
 *   · 密钥永远不回明文，`!command` 一律拒绝；
 *   · 坏输入（空模型、重复 id、非法 URL）要有可读的拒绝理由。
 */

export async function runCustomProviderTests(ok, mod) {
  const {
    validateCustomProvider,
    readCustomProviders,
    mergeCustomProviders,
    isYanProviderId,
    validateBaseUrl,
    hasExecutablePrefix,
    maskCustomProvider,
    CUSTOM_API_CHOICES,
    PI_API_IDS
  } = mod

  /* ── api 选择表 ── */
  ok(
    CUSTOM_API_CHOICES.every((choice) => PI_API_IDS.includes(choice.id)),
    '通用表单里的协议都在 pi 的 api ID 集合内'
  )
  ok(
    !CUSTOM_API_CHOICES.some((choice) => choice.id === 'google-vertex' || choice.id === 'bedrock-converse-stream'),
    '需要项目/区域/凭证的协议不出现在通用表单里'
  )

  /* ── id 与危险前缀 ── */
  ok(isYanProviderId('yan-my-api') === true, 'yan- 前缀的 id 合法')
  ok(isYanProviderId('openai') === false, '非 yan- 前缀不属于砚（不碰用户的 provider）')
  ok(isYanProviderId('yan-') === false, '空前缀不合法')
  ok(isYanProviderId('yan-Bad') === false, '大写不合法')
  ok(hasExecutablePrefix('!curl secret') === true, '! 开头的可执行字符串被识别')
  ok(hasExecutablePrefix('sk-abc') === false, '普通 key 不算可执行字符串')

  /* ── Base URL ── */
  ok(validateBaseUrl('https://api.example.com/v1') === null, 'https 合法')
  ok(validateBaseUrl('http://127.0.0.1:8080/v1') === null, '本地 http 合法')
  ok(typeof validateBaseUrl('ftp://x') === 'string', '非 http(s) 协议被拒')
  ok(typeof validateBaseUrl('not a url') === 'string', '不是 URL 被拒')
  ok(typeof validateBaseUrl('!curl evil') === 'string', '! 开头的 URL 被拒')
  ok(typeof validateBaseUrl('') === 'string', '空 URL 被拒')

  /* ── 表单校验 ── */
  const good = validateCustomProvider({
    id: 'yan-demo',
    api: 'openai-completions',
    baseUrl: 'https://api.example.com/v1',
    models: [{ id: 'demo-1', name: 'Demo', contextWindow: 128000, maxTokens: 8192, reasoning: true, input: ['text', 'image'] }],
    apiKey: 'sk-demo'
  })
  ok(good.ok === true, '完整表单通过校验', JSON.stringify(good.errors))
  ok(good.value?.models[0].contextWindow === 128000, 'context window 被保留')
  ok(good.value?.models[0].reasoning === true, '推理能力被保留')

  const noModels = validateCustomProvider({
    id: 'yan-demo',
    api: 'openai-completions',
    baseUrl: 'https://api.example.com/v1',
    models: []
  })
  ok(noModels.ok === false && noModels.errors.some((e) => e.includes('模型')), '没有模型时拒绝')

  const dupModels = validateCustomProvider({
    id: 'yan-demo',
    api: 'openai-completions',
    baseUrl: 'https://api.example.com/v1',
    models: [{ id: 'a' }, { id: 'a' }]
  })
  ok(dupModels.ok === false && dupModels.errors.some((e) => e.includes('重复')), '模型 ID 重复时拒绝')

  const badApi = validateCustomProvider({
    id: 'yan-demo',
    api: 'google-vertex',
    baseUrl: 'https://api.example.com/v1',
    models: [{ id: 'a' }]
  })
  ok(badApi.ok === false, '不在通用表单里的协议被拒（不会显示成可用选项）')

  const execKey = validateCustomProvider({
    id: 'yan-demo',
    api: 'openai-completions',
    baseUrl: 'https://api.example.com/v1',
    models: [{ id: 'a' }],
    apiKey: '!op read secret'
  })
  ok(execKey.ok === false, '! 开头的 API Key 被拒')
  ok(!execKey.value, '被拒时不产生可写盘的值')

  const execModel = validateCustomProvider({
    id: 'yan-demo',
    api: 'openai-completions',
    baseUrl: 'https://api.example.com/v1',
    models: [{ id: '!rm -rf' }]
  })
  ok(execModel.ok === false, '! 开头的模型 ID 被拒')

  /* ── 读回：不回密钥明文 ── */
  const disk = {
    providers: {
      'yan-demo': {
        api: 'openai-completions',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-super-secret',
        models: [{ id: 'demo-1', name: 'Demo', contextWindow: 1000 }],
        myCustomField: 'keep-me'
      },
      openai: { apiKey: 'sk-user-owned' }
    },
    someUnknownTopLevel: 42
  }
  const views = readCustomProviders(disk)
  ok(views.length === 1 && views[0].id === 'yan-demo', '只读砚拥有的条目')
  ok(views[0].hasApiKey === true, '报告「已设置密钥」')
  ok(!JSON.stringify(views).includes('sk-super-secret'), '读回结果里没有密钥明文')
  ok(views[0].models[0].name === 'Demo', '模型字段被读出')

  /* ── 合并：保留其它 provider 与未知字段 ── */
  const merged = mergeCustomProviders(
    disk,
    [{ id: 'yan-demo', api: 'openai-responses', baseUrl: 'https://new.example.com/v1', models: [{ id: 'demo-2' }] }],
    []
  )
  ok(merged.changed === true, '更新砚条目会被标记为有变化')
  ok(merged.next.someUnknownTopLevel === 42, '顶层未知字段原样保留')
  ok(!!(merged.next.providers).openai, '用户的其它 provider 原样保留')
  const demo = (merged.next.providers)['yan-demo']
  ok(demo.api === 'openai-responses', 'protocol 被更新')
  ok(demo.apiKey === 'sk-super-secret', '没重新输入密钥时沿用磁盘上的旧 key')
  ok(demo.myCustomField === 'keep-me', '条目里的未知字段也保留')

  const withNewKey = mergeCustomProviders(disk, [
    { id: 'yan-demo', api: 'openai-completions', baseUrl: 'https://api.example.com/v1', models: [{ id: 'demo-1' }], apiKey: 'sk-new' }
  ])
  ok((withNewKey.next.providers)['yan-demo'].apiKey === 'sk-new', '填了新密钥就覆盖')

  /* ── 删除只删自己的 ── */
  const removed = mergeCustomProviders(disk, [], ['yan-demo'])
  ok(!(removed.next.providers)['yan-demo'], '删除移除砚的条目')
  ok(!!(removed.next.providers).openai, '删除不动用户的 provider')
  const removedForeign = mergeCustomProviders(disk, [], ['openai'])
  ok(!!(removedForeign.next.providers).openai, '传入非 yan- 前缀的删除请求会被忽略')

  /* ── 坏磁盘数据 ── */
  ok(readCustomProviders(null).length === 0, '没有 models.json 时返回空列表')
  ok(readCustomProviders({ providers: 'bad' }).length === 0, 'providers 不是对象时返回空列表')
  ok(readCustomProviders({ providers: { 'yan-x': null } }).length === 1, '条目是 null 也能读（不抛）')
  const untouched = mergeCustomProviders(null, [], [])
  ok(untouched.changed === false, '没有任何改动时不写盘')

  /* ── 遮罩 ── */
  const masked = maskCustomProvider({ id: 'yan-a', api: 'openai-completions', baseUrl: 'https://x', models: [], hasApiKey: true })
  ok(masked.apiKeyLabel === '••••••' && !JSON.stringify(masked).includes('sk-'), '遮罩只显示存在状态')

  await runCapabilityTests(ok, mod)
}

/*
 * 接入时补齐模型能力：中转站的 /models 往往只给 id，能否思考、单模型协议要从端点附带字段
 * 与 pi 自带模型目录里找。用户反馈「有些模型没思考档位」就是因为这一步缺失。
 */
async function runCapabilityTests(ok, mod) {
  const { parseModelEntries, parseModelList, describeDiscoveredModels, catalogKey, validateCustomProvider, readCustomProviders } = mod

  /* ── 端点附带的能力字段 ── */
  const commandcode = {
    object: 'list',
    data: [
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', context_length: 1000000, supported_endpoints: ['/messages'] },
      { id: 'gpt-6-astra', context_length: 272000, supported_endpoints: ['/chat/completions', '/responses'] },
      { id: 'deepseek/deepseek-v4-pro', supported_endpoints: ['/chat/completions'] },
      { id: 'vendor/unknown-model', supported_endpoints: ['/chat/completions'] }
    ]
  }
  const found = parseModelEntries(commandcode)
  ok(found.length === 4 && found[0].contextWindow === 1000000, '读出端点给的上下文长度')
  ok(found[0].endpoints?.join() === '/messages', '读出端点给的开放接口')
  ok(parseModelList(commandcode).join() === found.map((m) => m.id).join(), 'parseModelList 与 parseModelEntries 的 id 一致')
  const openrouter = parseModelEntries({ data: [{ id: 'a/b', supported_parameters: ['tools', 'reasoning'], architecture: { input_modalities: ['text', 'image'] } }] })
  ok(openrouter[0].reasoning === true && openrouter[0].image === true, 'OpenRouter 式 supported_parameters / input_modalities 被识别')

  /* ── 归一化键 ── */
  ok(catalogKey('Qwen/Qwen3.8-Max') === 'qwen3-8-max' && catalogKey('x:free') === 'x', '键去掉厂商前缀、:free 与点号差异')
  ok(catalogKey(' deepseek/deepseek-v4-pro ') === catalogKey('deepseek-v4-pro'), '带不带厂商前缀查到同一个键')

  /* ── 随包扩展用的生成物与 TS 源一致（扩展与设置页共用这一套判断） ── */
  const { spawnSync } = await import('node:child_process')
  const fresh = spawnSync(process.execPath, ['scripts/build-model-capabilities.mjs', '--check'], { encoding: 'utf8' })
  ok(fresh.status === 0, 'resources/pi-extensions/generated/model-capabilities.mjs 与 TS 源一致', (fresh.stderr || fresh.stdout).trim())

  const catalog = {
    'claude-sonnet-5-5': { provider: 'anthropic', api: 'anthropic-messages', reasoning: true, input: ['text', 'image'], contextWindow: 1000000, maxTokens: 128000, thinkingLevelMap: { off: null, max: 'max' } },
    'gpt-6-astra': { provider: 'openai', api: 'openai-responses', reasoning: true, maxTokens: 128000, thinkingLevelMap: { off: null, xhigh: 'xhigh' } },
    'deepseek-v4-pro': { provider: 'deepseek', api: 'openai-completions', reasoning: true, maxTokens: 384000, thinkingLevelMap: { high: 'high', max: 'max' } }
  }
  const described = describeDiscoveredModels(found, { api: 'openai-completions', baseUrl: 'https://api.example.com/provider/v1/' }, catalog)
  const [claude, gpt, deepseek, unknown] = described
  ok(claude.api === 'anthropic-messages', '只开放 /messages 的模型单独改走 Anthropic 协议')
  ok(claude.baseUrl === 'https://api.example.com/provider', '改走 Anthropic 时地址去掉 /v1（SDK 自己拼 /v1/messages）')
  ok(claude.reasoning === true && claude.thinkingLevelMap?.max === 'max', 'Claude 从目录拿到思考能力与档位映射（协议一致）')
  ok(claude.name === 'Claude Sonnet 5.5' && claude.input?.includes('image'), '名称与图片输入被补上')
  ok(gpt.api === undefined && gpt.baseUrl === undefined, '开放了服务默认协议的模型不改协议')
  ok(gpt.reasoning === true && gpt.thinkingLevelMap === undefined, '协议与目录不一致时只标能思考，不照搬档位映射')
  ok(gpt.contextWindow === 272000 && gpt.maxTokens === 128000, '上下文以端点为准，输出上限取目录')
  ok(deepseek.reasoning === true && deepseek.thinkingLevelMap === undefined, 'Chat Completions 不照搬档位映射（各家方言不同）')
  ok(unknown.reasoning === undefined && unknown.api === undefined, '目录里没有的模型不猜')

  const anthropicProvider = describeDiscoveredModels(
    [{ id: 'gpt-6-astra', endpoints: ['/chat/completions'] }],
    { api: 'anthropic-messages', baseUrl: 'https://relay.example.com' },
    catalog
  )
  ok(anthropicProvider[0].api === 'openai-completions' && anthropicProvider[0].baseUrl === 'https://relay.example.com/v1', 'Anthropic 服务里只开放 Chat Completions 的模型补上 /v1')

  /* ── 校验与读回保留单模型字段 ── */
  const valid = validateCustomProvider({ id: 'yan-relay', api: 'openai-completions', baseUrl: 'https://api.example.com/v1', models: described })
  ok(valid.ok, '带单模型协议的条目能通过校验')
  const kept = valid.value?.models[0]
  ok(kept?.api === 'anthropic-messages' && kept.baseUrl === 'https://api.example.com/provider' && kept.thinkingLevelMap?.max === 'max', '校验保留单模型协议、地址与档位映射')
  const badApi = validateCustomProvider({ id: 'yan-relay', api: 'openai-completions', baseUrl: 'https://a.example/v1', models: [{ id: 'm', api: 'bedrock-converse-stream' }] })
  ok(!badApi.ok, '单模型协议不在可选范围时拒绝')
  const badUrl = validateCustomProvider({ id: 'yan-relay', api: 'openai-completions', baseUrl: 'https://a.example/v1', models: [{ id: 'm', baseUrl: '!curl x' }] })
  ok(!badUrl.ok, '单模型地址也不能是可执行字符串')
  const noReasoningMap = validateCustomProvider({ id: 'yan-relay', api: 'openai-completions', baseUrl: 'https://a.example/v1', models: [{ id: 'm', thinkingLevelMap: { high: 'high' } }] })
  ok(noReasoningMap.ok && noReasoningMap.value?.models[0].thinkingLevelMap === undefined, '取消「推理」后不保留档位映射')
  const views = readCustomProviders({ providers: { 'yan-relay': { api: 'openai-completions', baseUrl: 'https://a.example/v1', models: [{ id: 'c', api: 'anthropic-messages', baseUrl: 'https://a.example', reasoning: true, thinkingLevelMap: { max: 'max', bogus: 'x' } }] } } })
  ok(views[0].models[0].api === 'anthropic-messages' && views[0].models[0].thinkingLevelMap?.bogus === undefined, '读回保留单模型协议，丢弃未知档位键')

  /* ── 随包能力表：生成过、覆盖常见原厂模型 ── */
  const { readFileSync } = await import('node:fs')
  const table = JSON.parse(readFileSync('resources/pi-extensions/generated/pi-model-catalog.json', 'utf8'))
  const models = table.models ?? {}
  ok(Object.keys(models).length > 300, `能力表有内容（${Object.keys(models).length} 个模型，pi ${table.piVersion}）`)
  ok(models['claude-sonnet-4-6']?.reasoning === true && models['claude-sonnet-4-6']?.api === 'anthropic-messages', '能力表里 Claude 取原厂条目且支持思考')
  await runCommandcodeExtensionTests(ok, table.models)

  /* 升级 pi 后忘了重新生成能力表，新模型就又没有思考档位 */
  let runtime
  try { runtime = JSON.parse(readFileSync('resources/pi-runtime/current.json', 'utf8')).version } catch { runtime = undefined }
  ok(!runtime || runtime === table.piVersion, `能力表对应随包 pi 版本（表 ${table.piVersion} / 运行时 ${runtime ?? '无'}；不一致就跑 node scripts/gen-pi-model-catalog.mjs）`)
}

/*
 * 内置 Command Code 扩展（resources/pi-extensions/commandcode.js）：凭证页填了密钥的新用户
 * 不手写 models.json 也要有模型，且能思考的模型要有档位。
 */
async function runCommandcodeExtensionTests(ok, catalog) {
  const { mkdtempSync, writeFileSync, rmSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const ext = await import('../resources/pi-extensions/commandcode.js')
  const dir = mkdtempSync(join(tmpdir(), 'yan-cc-ext-'))
  try {
    ok(ext.hasCredential(dir, {}) === false, '没有凭证时不接管')
    ok(ext.hasCredential(dir, { COMMANDCODE_API_KEY: 'k' }) === true, '环境变量里的密钥也算凭证')
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ commandcode: { type: 'api_key', key: 'user_x' } }))
    ok(ext.hasCredential(dir, {}) === true, '凭证页写进 auth.json 的密钥被识别')
    ok(ext.handWritten(dir) === false, 'models.json 没写 commandcode 时由扩展接管')
    writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: { commandcode: { baseUrl: 'https://x', models: [] } } }))
    ok(ext.handWritten(dir) === true, '用户手写了 commandcode 时让位')

    const body = { data: [
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', context_length: 1000000, supported_endpoints: ['/messages'] },
      { id: 'moonshotai/Kimi-K2.6', supported_endpoints: ['/chat/completions'] },
      { id: 'vendor/no-such-model', supported_endpoints: ['/chat/completions'] }
    ] }
    let asked = ''
    const entries = await ext.fetchModels(catalog, async (url, init) => {
      asked = url
      ok(!init?.headers, '拉模型列表不带密钥（公开接口）')
      return { ok: true, json: async () => body }
    })
    ok(asked === `${ext.BASE_URL}/models`, '从 Command Code 的 /models 拉列表')
    const models = ext.toPiModels(entries)
    const claude = models.find((m) => m.id === 'claude-sonnet-4-6')
    const kimi = models.find((m) => m.id === 'moonshotai/Kimi-K2.6')
    const unknown = models.find((m) => m.id === 'vendor/no-such-model')
    ok(claude?.api === 'anthropic-messages' && claude.baseUrl === 'https://api.commandcode.ai/provider', 'Claude 走 Anthropic 接口，地址去掉 /v1')
    ok(claude?.reasoning === true && kimi?.reasoning === true, '能思考的模型被标出（有思考档位）')
    ok(unknown?.reasoning === false && unknown.contextWindow > 0 && unknown.maxTokens > 0, '不认识的模型不标思考，但定义完整')
    ok(models.every((m) => m.name && Array.isArray(m.input) && m.cost && m.contextWindow && m.maxTokens), 'pi 要求的字段（名称、输入、费用、上下文、输出上限）齐全')

    const failing = await ext.fetchModels(catalog, async () => ({ ok: false, status: 503 })).then(() => 'resolved', () => 'rejected')
    ok(failing === 'rejected', '端点出错时抛出，由调用方沿用缓存')

    /* 扩展入口：凭证在、未手写 → 注册；手写 → 不注册 */
    const registered = []
    const pi = { registerProvider: (id, config) => registered.push({ id, config }) }
    rmSync(join(dir, 'models.json'))
    writeFileSync(join(dir, 'yan-commandcode-models.json'), JSON.stringify({ models: entries }))
    const prev = process.env.PI_CODING_AGENT_DIR
    const realFetch = globalThis.fetch
    /* 后台刷新不能真的联网：单测离线 */
    globalThis.fetch = async () => ({ ok: true, json: async () => body })
    process.env.PI_CODING_AGENT_DIR = dir
    try {
      await ext.default(pi)
      ok(registered[0]?.id === 'commandcode' && registered[0].config.models.length === 3, '有缓存时先用缓存注册 commandcode')
      ok(!('apiKey' in registered[0].config), '扩展不碰密钥，交给 pi 从 auth.json 取')
      registered.length = 0
      writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: { commandcode: { baseUrl: 'https://x', models: [] } } }))
      await ext.default(pi)
      ok(registered.length === 0, '手写配置存在时扩展什么也不做')
    } finally {
      await new Promise((r) => setTimeout(r, 50))
      globalThis.fetch = realFetch
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = prev
    }
    ok(existsSync(join(dir, 'yan-commandcode-models.json')), '缓存文件在 pi 目录里')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export default runCustomProviderTests
