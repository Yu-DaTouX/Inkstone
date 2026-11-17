export const meta = { description: 'OpenCode Zen / Go：设置入口、独立 Key 保存与原生模型目录，不发送模型请求' }

export default async function run({ cdp, check, waitFor, shot, sleep }) {
  await cdp.evaluate('window.__yanStore.getState().openSettings()')
  await waitFor('!!document.querySelector("[data-testid=v3-settings-nav-models]")')
  await cdp.evaluate('document.querySelector("[data-testid=v3-settings-nav-models]").click()')
  await waitFor('!!document.querySelector("[data-testid=ms-service-opencode-go]")')
  await cdp.evaluate('document.querySelector("[data-testid=ms-toggle-keys]")?.click()')
  await sleep(400)

  const rows = await cdp.evaluate(`['opencode', 'opencode-go'].map((id) => {
    const row = document.querySelector('[data-testid="ms-service-' + id + '"]')
    return { id, text: row?.textContent ?? '', visible: !!row?.getBoundingClientRect().height,
      add: !!row?.querySelector('[data-testid="ms-set-' + id + '"]') }
  })`)
  for (const row of rows) {
    check(`${row.id} 有可见的添加 Key 入口`, row.visible && row.add, row.text)
  }
  check('提示区分 Zen 余额与 Go 套餐', rows[0].text.includes('按用量扣余额') && rows[1].text.includes('Go 套餐额度'))
  check('提示免费聊天模型客户端限制', rows[0].text.includes('仅限 OpenCode 客户端'))
  await cdp.evaluate('document.querySelector("[data-testid=ms-service-opencode]").scrollIntoView({ block: "center" })')
  await shot('opencode-settings-zh-dark')

  for (const [provider, label] of [['opencode', 'Zen fixture'], ['opencode-go', 'Go fixture']]) {
    const saved = await cdp.evaluate(`window.yan.addApiKey(${JSON.stringify(provider)}, 'ONLY_SYNTHETIC_FIXTURE', ${JSON.stringify(label)})`)
    check(`${provider} 通过真实 IPC 保存测试 Key`, saved.ok, saved.error)
    await waitFor('s.conn === "ready"', 60000)
    let models = []
    for (let attempt = 0; attempt < 100 && models.length === 0; attempt++) {
      models = await cdp.evaluate(`window.yan.listModels().then((items) => items.filter((item) => item.provider === ${JSON.stringify(provider)}))`)
      if (models.length === 0) await sleep(150)
    }
    check(`${provider} 直接使用 pi 原生模型目录`, models.length > 0, models.map((model) => model.id))
    check(`${provider} 保留原生 API 与上下文能力`, models.length > 0 && models.every((model) => !!model.api && model.contextWindow > 0))
  }

  const providers = await cdp.evaluate('window.yan.authProviders()')
  const pools = await cdp.evaluate('window.yan.apiKeys()')
  for (const id of ['opencode', 'opencode-go']) {
    check(`${id} 只显示一个已配置条目`, providers.filter((item) => item.id === id && item.status === 'ready').length === 1)
    check(`${id} Key 独立保存在账号池`, pools[id]?.length === 1 && pools[id][0].active)
  }

  await cdp.evaluate('window.__yanStore.getState().patchSettings({ lang: "en-US", theme: "light" })')
  await sleep(500)
  const english = await cdp.evaluate('document.querySelector("[data-testid=ms-service-opencode-go]")?.textContent ?? ""')
  check('Go 英文提示存在', english.includes('Go workspace') && english.includes('separately from Zen'))
  await cdp.evaluate('document.querySelector("[data-testid=ms-service-opencode-go]").scrollIntoView({ block: "center" })')
  await shot('opencode-settings-en-light')

  const removed = await cdp.evaluate('window.yan.clearAuth("opencode")')
  check('Zen Key 可单独移除', removed.ok, removed.error)
  const remaining = await cdp.evaluate('window.yan.authProviders()')
  check('移除 Zen 不影响 Go', remaining.find((item) => item.id === 'opencode')?.status === 'missing' && remaining.find((item) => item.id === 'opencode-go')?.status === 'ready')
}
