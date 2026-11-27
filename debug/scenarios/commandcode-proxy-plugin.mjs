import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const meta = { description: '隔离实例里从插件市场安装 Command Code 代理，自动建好自定义服务并取到模型，再卸载；本机 3050 被占用时加 --env YAN_COMMANDCODE_PROXY_PORT=<端口>' }

export default async function run({ box, cdp, sleep, check, shot }) {
  const row = '[data-testid="caps-market-commandcode-proxy"]'
  const marker = join(box.dataDir, 'plugins', 'commandcode-proxy', 'plugin', '.installed-by-inkstone')
  const provider = () => { try { return JSON.parse(readFileSync(join(box.piDir, 'models.json'), 'utf8')).providers?.['yan-commandcode-proxy'] } catch { return undefined } }
  const status = () => cdp.evaluate(`window.yan.plugins.action('commandcode-proxy', 'status')`)
  const until = async (fn, label, tries = 160) => {
    for (let i = 0; i < tries; i++) { if (await fn()) return; await sleep(250) }
    throw new Error(`等待超时：${label}`)
  }
  const press = async (text) => {
    await cdp.evaluate(`Array.from(document.querySelectorAll('${row} button')).find(b => b.textContent.trim() === ${JSON.stringify(text)})?.click()`)
    await until(() => cdp.evaluate(`!!document.querySelector('[data-testid="caps-confirm-accept"]')`), '确认框')
    await sleep(300)
    await cdp.evaluate(`document.querySelector('[data-testid="caps-confirm-accept"]').click()`)
  }

  await cdp.evaluate(`window.__yanStore.getState().patchSettings({ lang: 'zh-CN' })`)
  await cdp.evaluate(`window.__yanStore.getState().openSettings('market')`)
  await until(() => cdp.evaluate(`!!document.querySelector('${row}')`), '插件市场出现 Command Code 代理')
  await cdp.evaluate(`document.querySelector('${row}').scrollIntoView({ block: 'center' })`)
  await sleep(500)
  check('安装前未安装、没有自定义服务', !existsSync(marker) && !provider())

  await press('安装')
  await until(() => existsSync(marker), '安装标记')
  await until(async () => (await status())?.status?.running === true, '代理运行')
  const url = (await status()).status.url
  check('从插件市场安装后代理在本机运行', /^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(url) && (await fetch(url.replace(/\/v1$/, '/health'))).ok, url)
  await until(() => !!provider(), '自动建立自定义服务')
  const saved = provider()
  check('自动建立 yan-commandcode-proxy，指向本机代理且不含密钥', saved.baseUrl === url && saved.api === 'openai-completions' && !('apiKey' in saved) && saved.models.length > 0 && saved.models.every(model => !model.baseUrl), JSON.stringify({ baseUrl: saved.baseUrl, count: saved.models.length, sample: saved.models.slice(0, 3).map(model => model.id) }))
  const fill = '[data-testid="caps-market-ccproxy-fill-key"]'
  await until(() => cdp.evaluate(`!!document.querySelector('${fill}') && document.querySelector('${row}').textContent.includes('未填 Key')`), '插件行提示未填 Key')
  check('插件行显示「未填 Key」和「填写 Key」按钮', await cdp.evaluate(`document.querySelector('${row}').textContent.includes('还没填 API Key')`))
  await sleep(500)
  await shot('ccproxy-installed-v3')

  await cdp.evaluate(`document.querySelector('${fill}').click()`)
  await until(() => cdp.evaluate(`!!document.querySelector('[data-testid="ms-custom-form"]')`), '跳到模型页并打开编辑表单')
  await sleep(1200)
  const page = await cdp.evaluate(`({
    warn: !!document.querySelector('[data-testid="ms-custom-key-missing-yan-commandcode-proxy"]'),
    fold: document.querySelector('[data-testid="ms-custom-toggle"]')?.textContent ?? '',
    toggle: document.querySelector('[data-testid="ms-custom-models-toggle"]')?.textContent ?? '',
    rows: document.querySelectorAll('[data-testid="ms-custom-form"] .ms-custom-model').length,
    local: !!document.querySelector('[data-testid="ms-local-launch-row-yan-commandcode-proxy"]'),
    keyFocused: document.activeElement?.matches('[data-testid="ms-custom-form"] input[type="password"]') === true
  })`)
  check('跳转后 API Key 输入框已聚焦', page.keyFocused, JSON.stringify(page))
  check('模型页自定义服务行有未填 Key 警示，折叠标题注明', page.warn && page.fold.includes('未填 Key'), JSON.stringify(page))
  check('编辑表单里 105 个模型默认折叠', page.rows === 0 && /显示 \d+ 个模型/.test(page.toggle), JSON.stringify(page))
  check('本地模型启动设置不再列出代理服务', !page.local)
  await shot('ccproxy-fill-key-form')

  await cdp.evaluate(`(() => { const input = document.querySelector('[data-testid="ms-custom-form"] input[type="password"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, 'user_inkstonescenario'); input.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await sleep(300)
  await cdp.evaluate(`document.querySelector('[data-testid="ms-custom-save"]').click()`)
  await until(() => provider()?.apiKey === 'user_inkstonescenario', '保存 Key')
  await until(() => cdp.evaluate(`!document.querySelector('[data-testid="ms-custom-key-missing-yan-commandcode-proxy"]')`), '警示消失')
  await until(() => cdp.evaluate(`window.__yanStore.getState().models.some(m => m.provider === 'yan-commandcode-proxy')`), '模型菜单出现代理模型', 240)
  const menuCount = await cdp.evaluate(`window.__yanStore.getState().models.filter(m => m.provider === 'yan-commandcode-proxy').length`)
  check('填 Key 后警示消失，模型菜单出现代理模型', menuCount > 0, String(menuCount))
  await sleep(500)
  await shot('ccproxy-key-saved')
  const quota = await cdp.evaluate(`window.yan.accountQuota().then(r => r.cards.filter(c => c.provider === 'yan-commandcode-proxy').map(c => ({ name: c.name, status: c.status, error: c.error ?? c.message ?? null })))`)
  check('额度面板出现代理服务的 Command Code 卡片（假 Key 应报认证错误）', quota.length === 1 && quota[0].name.includes('Command Code'), JSON.stringify(quota))

  await cdp.evaluate(`window.__yanStore.getState().openSettings('market')`)
  await until(() => cdp.evaluate(`!!document.querySelector('${row}')`), '回到插件市场')
  await until(() => cdp.evaluate(`document.querySelector('${row}').textContent.includes('可用：') && !document.querySelector('${fill}')`), '插件行变为可用')
  check('填 Key 后插件行显示可用、不再提示', true)
  await press('卸载')
  await until(() => !existsSync(marker), '卸载移除插件目录')
  await until(() => fetch(url.replace(/\/v1$/, '/health')).then(() => false, () => true), '代理进程退出')
  check('卸载后代理停止，自定义服务保留', !!provider())
}
