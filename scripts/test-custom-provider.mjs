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
}

export default runCustomProviderTests
