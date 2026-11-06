export const meta = { description: '模型菜单供应商提示：短提示、悬停延迟、pi 可用状态、窄窗、深浅主题与键盘' }

export default async function run({ cdp, check, waitFor, sleep, shot }) {
  await cdp.evaluate(`window.__yanStore.getState().patchSettings({
    lang: 'zh-CN',
    uiScale: 1,
    modelProviderOrder: ['commandcode', 'openai-codex', 'deepseek', 'anthropic'],
    modelFavorites: [
      { provider: 'commandcode', id: 'deepseek-v4.1-flash' },
      { provider: 'openai-codex', id: 'gpt-6.1-sol' },
      { provider: 'anthropic', id: 'claude-opus-5.5' }
    ]
  })`)
  await cdp.evaluate(`window.__yanStore.setState(s => ({
    models: [
      { provider: 'commandcode', id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash (latest)', contextWindow: 1000000, maxTokens: 32000, reasoning: true },
      { provider: 'openai-codex', id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', contextWindow: 500000, maxTokens: 32000, reasoning: true },
      { provider: 'anthropic', id: 'claude-opus-5.5', name: 'Claude Opus 5.5', contextWindow: 1000000, maxTokens: 32000, reasoning: true }
    ],
    authProviders: [
      { id: 'openai-codex', name: 'openai-codex', status: 'missing', inAppLogin: true },
      { id: 'deepseek', name: 'deepseek', status: 'unknown' }
    ],
    session: { ...s.session, model: { provider: 'anthropic', id: 'claude-opus-5.5', name: 'Claude Opus 5.5' } }
  }))`)
  const key = async (key, extra = {}) => {
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key, ...extra })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key, ...extra })
    await sleep(350)
  }
  const hover = async (provider) => {
    const point = await cdp.evaluate(`(() => {
      const r = document.querySelector('[data-model-picker-provider="${provider}"] button').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`)
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  }
  for (const [theme, width, height] of [['light', 920, 860], ['dark', 680, 720]]) {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await waitFor(`innerWidth === ${width} && innerHeight === ${height}`, 5000)
    await cdp.evaluate(`window.__yanStore.getState().patchSettings({ theme: '${theme}' })`)
    await cdp.evaluate(`document.querySelector('[data-chat-provider-model-picker]').click()`)
    await waitFor(`!!document.querySelector('[data-model-picker-content]')`)
    await sleep(400)
    check(`${theme} 收藏保留三个模型`, await cdp.evaluate(`document.querySelectorAll('[data-model-picker-content] [role="option"]').length === 3`))
    await hover('openai-codex')
    await sleep(80)
    check(`${theme} 不再立即弹出提示`, await cdp.evaluate(`!document.querySelector('[data-slot="tooltip-popup"]')`))
    await sleep(500)
    await waitFor(`!!document.querySelector('[data-slot="tooltip-popup"]')`, 2000)
    const tip = await cdp.evaluate(`(() => {
      const el = document.querySelector('[data-slot="tooltip-popup"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { text: el.textContent.trim(), x: r.x, right: r.right, width: r.width, height: r.height };
    })()`)
    check(`${theme} 提示仅显示供应商名称`, tip?.text === 'openai-codex', tip)
    check(`${theme} 提示保持紧凑且未超出窗口`, tip && tip.width < 160 && tip.height < 40 && tip.x >= 0 && tip.right <= width)
    const menu = await cdp.evaluate(`(() => { const r = document.querySelector('[data-model-picker-content]').getBoundingClientRect(); return { left: r.left, right: r.right } })()`)
    check(`${theme} 提示位于整个菜单外侧`, tip && (tip.right <= menu.left || tip.x >= menu.right), { tip, menu })
    await sleep(200)
    await shot(`model-picker-${theme}-${width}`)
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: width - 8, y: 100 })
    await sleep(450)
    await cdp.evaluate(`document.querySelector('[data-model-picker-provider="openai-codex"] button').click()`)
    await sleep(180)
    check(`${theme} pi 可用模型不再要求补登录`, await cdp.evaluate(`(() => {
      const panel = document.querySelector('[data-model-picker-content]');
      return panel.textContent.includes('GPT-6.1 Sol') && !panel.textContent.includes('尚未') && !panel.textContent.includes('打开设置');
    })()`))
    await cdp.evaluate(`document.querySelector('[data-model-picker-provider="deepseek"] button').click()`)
    await sleep(180)
    check(`${theme} 无可用模型时仍保留配置入口`, await cdp.evaluate(`document.querySelector('[data-model-picker-content]').textContent.includes('尚未填写 API Key')`))
    await cdp.evaluate(`document.querySelector('[data-model-picker-provider="favorites"] button').click()`)
    await sleep(180)
    await key('ArrowLeft')
    check(`${theme} 键盘可从搜索进入供应商栏`, await cdp.evaluate(`document.activeElement.closest('[data-model-picker-provider]')?.getAttribute('data-model-picker-provider') === 'favorites'`))
    await key('ArrowRight')
    check(`${theme} 键盘可返回搜索`, await cdp.evaluate(`document.activeElement.matches('[data-model-picker-content] input')`))
    await key('Escape')
    await waitFor(`!document.querySelector('[data-model-picker-content]')`)
    check(`${theme} Escape 关闭并回到输入框`, await cdp.evaluate(`!document.querySelector('[data-model-picker-content]') && document.activeElement.matches('[data-testid="composer-input"]')`))
  }
  await cdp.call('Emulation.clearDeviceMetricsOverride')
}
