export const meta = { description: '新增服务商的 API key 入口：列表可见、真实 IPC 保存、独立移除；只存合成 Key，不发模型请求' }

const PROVIDERS = ['cerebras', 'moonshotai', 'moonshotai-cn', 'minimax', 'zai', 'huggingface', 'xiaomi-token-plan-sgp', 'vercel-ai-gateway']

export default async function run({ cdp, check, waitFor, shot, sleep }) {
  await cdp.evaluate('window.__yanStore.getState().openSettings()')
  await waitFor('!!document.querySelector("[data-testid=v3-settings-nav-models]")')
  await cdp.evaluate('document.querySelector("[data-testid=v3-settings-nav-models]").click()')
  await waitFor('!!document.querySelector("[data-testid=ms-service-cerebras]")')
  await cdp.evaluate('document.querySelector("[data-testid=ms-toggle-keys]")?.click()')
  await sleep(400)

  const rows = await cdp.evaluate(`${JSON.stringify(PROVIDERS)}.map((id) => {
    const all = document.querySelectorAll('[data-testid="ms-service-' + id + '"]')
    const row = all[0]
    return { id, count: all.length, visible: !!row?.getBoundingClientRect().height,
      add: !!row?.querySelector('[data-testid="ms-set-' + id + '"]'), text: row?.textContent ?? '' }
  })`)
  for (const row of rows) {
    check(`${row.id} 在列表里只有一行且有添加 Key 入口`, row.count === 1 && row.visible && row.add, row.text)
  }
  check('未配置的服务商仍算未配置', rows.every((row) => !row.text.includes('已可用')))

  await cdp.evaluate('document.querySelector("[data-testid=ms-service-cerebras]").scrollIntoView({ block: "center" })')
  await shot('new-providers-zh-dark')

  const saved = await cdp.evaluate('window.yan.addApiKey("cerebras", "ONLY_SYNTHETIC_FIXTURE", "Cerebras fixture")')
  check('Cerebras 通过真实 IPC 保存测试 Key', saved.ok, saved.error)
  const providers = await cdp.evaluate('window.yan.authProviders()')
  const cerebras = providers.filter((item) => item.id === 'cerebras')
  check('保存后只有一条 cerebras 且来自 auth.json', cerebras.length === 1 && cerebras[0].status === 'ready' && cerebras[0].source === 'auth.json', cerebras)
  const pools = await cdp.evaluate('window.yan.apiKeys()')
  check('Key 进入该服务商的账号池', pools.cerebras?.length === 1 && pools.cerebras[0].active)
  check('其他新服务商没有被顺带标成已配置', PROVIDERS.filter((id) => id !== 'cerebras').every((id) => providers.find((item) => item.id === id)?.status === 'missing'))

  await cdp.evaluate('window.__yanStore.getState().patchSettings({ lang: "en-US" })')
  await sleep(300)
  const english = await cdp.evaluate('document.querySelector("[data-testid=ms-service-cerebras]")?.textContent ?? ""')
  check('英文界面照常显示该服务商', english.includes('Cerebras'), english)
  await cdp.evaluate('window.__yanStore.getState().patchSettings({ lang: "zh-CN" })')

  const removed = await cdp.evaluate('window.yan.clearAuth("cerebras")')
  check('测试 Key 可移除', removed.ok, removed.error)
  const after = await cdp.evaluate('window.yan.authProviders()')
  check('移除后回到未配置', after.find((item) => item.id === 'cerebras')?.status === 'missing')
}
