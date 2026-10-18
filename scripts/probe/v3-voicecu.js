;(async () => {
  const out = []
  const check = (condition, label) => {
    out.push(`  ${condition ? '✓' : '✗'} ${label}`)
    return !!condition
  }
  const note = (label) => out.push(`  · ${label}`)
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (predicate, timeout = 4000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      try {
        if (predicate()) return true
      } catch {
      }
      await wait(50)
    }
    return false
  }
  const q = (testId) => document.querySelector(`[data-testid="${testId}"]`)
  const store = window.__yanStore

  try {
    out.push('=== v3 语音输入分页 / 电脑操作块（隔离探针）===')
    check(await until(() => document.documentElement.dataset.ui === 'v3' && q('v3-sidebar'), 8000), 'v3 外壳已挂载')
    if (!store || !q('v3-sidebar')) throw new Error('v3 外壳或隔离探针 store 不可用')
    try {
      localStorage.setItem('yan.onboarded', '1')
    } catch {
    }
    const onboarding = document.querySelector('.v3-ob-overlay')
    if (onboarding) {
      onboarding.querySelector('.ui-dialog__close')?.click()
      await until(() => !document.querySelector('.v3-ob-overlay'), 3000)
    }

    out.push('')
    out.push('--- 1. 语音深链接 ---')
    store.getState().openSettings('voice')
    check(await until(() => !!q('caps-settings'), 4000), '旧 voice 深链接进入能力页')
    check(await until(() => !!q('settings-voice'), 4000), '直接落在「本机工具」分页的本地转写')
    check(q('caps-tab-tools')?.getAttribute('aria-selected') === 'true', '本机工具页签处于选中')
    check(await until(() => !!q('voice-state'), 4000), '显示就绪状态行')
    check(await until(() => !!q('voice-binary') && !!q('voice-models'), 4000), '有识别引擎与模型两块')
    check(await until(() => !!document.querySelector('[data-testid^="voice-model-"]'), 6000), '列出候选模型')

    out.push('')
    out.push('--- 2. 识别语言（真实写设置，随后还原）---')
    const before = store.getState().settings?.voiceInput?.language ?? 'auto'
    const target = before === 'en' ? 'zh' : 'en'
    note(`当前语言 ${before}，临时切到 ${target}`)
    q(`voice-language-${target}`)?.click()
    check(await until(() => store.getState().settings?.voiceInput?.language === target, 4000), '语言设置已写入并读回')
    q(`voice-language-${before}`)?.click()
    check(await until(() => (store.getState().settings?.voiceInput?.language ?? 'auto') === before, 4000), '已还原语言设置')

    out.push('')
    out.push('--- 3. 电脑操作块 ---')
    q('caps-tab-tools')?.click()
    const present = await until(() => !!q('cap-computer-use'), 5000)
    if (present) {
      check(true, '本机工具分页里有电脑操作块')
      const sw = q('cap-computer-use-switch')
      check(!!sw, '有开关')
      const status = await window.yan.computerUse.status().catch(() => null)
      note(`宿主返回 supported=${status?.supported} uvx=${JSON.stringify(status?.uvx)} enabled=${status?.enabled}`)
      if (status && !status.uvx) check(sw?.hasAttribute('data-disabled') || sw?.querySelector('input')?.disabled, '没有 uv 时开关禁用')
      else check(true, '已有 uv，开关可用（本探针不点开关）')
    } else {
      const status = await window.yan.computerUse.status().catch(() => null)
      check(status && status.supported === false, `不支持的平台不显示该块（supported=${status?.supported}）`)
    }
    out.push('证据范围：v3 语音页签 / 电脑操作块的 DOM 与只读状态；仅切换并还原识别语言，未下载模型、未装 uv、未开电脑操作。')
  } catch (error) {
    out.push(`  ✗ 场景异常：${error?.stack ?? error}`)
  }
  return out.join('\n')
})()
