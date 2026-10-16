;(async () => {
  const out = [], store = window.__yanStore
  const q = s => document.querySelector(s), qa = s => [...document.querySelectorAll(s)]
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const ok = (value, label) => { out.push('  ' + (value ? '✓' : '✗') + ' ' + label); return !!value }
  const until = async fn => { for (let i = 0; i < 80; i++) { if (fn()) return true; await sleep(100) } return false }
  const key = (el, name) => el.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
  let before
  try {
    if (!await until(() => store.getState().settings)) throw new Error('settings not ready')
    const state = store.getState()
    before = { models: state.models, session: state.session, setModel: state.setModel, runners: state.runners, activeRunnerId: state.activeRunnerId }
    const models = Array.from({ length: 24 }, (_, i) => ({ provider: ['anthropic', 'openai', 'google'][i % 3], id: 'probe-' + i, name: 'Probe ' + String(i).padStart(2, '0') + ' 一个偏长的模型名', reasoning: true }))
    let calls = 0, selected
    state.closeSettings()
    store.setState({ models, runners: [], activeRunnerId: null, session: { ...state.session, model: models[16], isStreaming: false, isCompacting: false },
      setModel: async (provider, id) => { calls++; selected = { provider, id }; return { ok: true } } })
    await sleep(250)
    q('[data-testid="model-picker"]').click()
    if (!await until(() => q('[data-testid="model-menu"]'))) throw new Error('model menu not mounted')
    const r = q('[data-testid="model-menu"]').getBoundingClientRect()
    ok(r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1, '菜单完整位于窗口内')
    ok(!!q('[data-testid="model-option"][data-current="1"]'), '打开显示当前模型')
    q('[data-testid="models-provider"]').click()
    if (!await until(() => q('.ui-choice-menu [data-value=""]'))) throw new Error('provider choices not mounted')
    q('.ui-choice-menu [data-value=""]').click()
    await until(() => qa('[data-testid="model-option"]').length === 24)
    ok(qa('[data-testid="model-option"]').length === 24 && !q('[data-testid="models-next"]'), '全部供应商使用滚动列表，不依赖旧分页')
    const list = q('.model-rows')
    ok(list.scrollHeight > list.clientHeight && list.clientHeight > 0, '长模型列表有受限高度并可滚动')
    const input = q('[data-testid="model-search"]')
    const cursorBefore = q('.model-row[data-cursor="1"] [data-model-id]')?.dataset.modelId
    key(input, 'PageDown'); await sleep(100)
    ok(q('.model-row[data-cursor="1"] [data-model-id]')?.dataset.modelId !== cursorBefore && calls === 0, 'PageDown移动键盘落点，不切换模型')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Probe 23')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await until(() => qa('[data-testid="model-option"]').length === 1 && q('.model-row[data-cursor="1"] [data-model-id="probe-23"]'))
    ok(qa('[data-testid="model-option"]').length === 1 && q('.model-row[data-cursor="1"] [data-model-id="probe-23"]')?.dataset.provider === 'google', '搜索跨供应商且重置键盘落点')
    key(input, 'Enter')
    await until(() => !q('[data-testid="model-menu"]'))
    ok(calls === 1 && selected?.provider === 'google' && selected?.id === 'probe-23' && !q('[data-testid="model-menu"]'), 'Enter选择正确模型且关闭菜单')
    if (calls !== 1 || q('[data-testid="model-menu"]')) out.push('  calls=' + calls + ' selected=' + JSON.stringify(selected) + ' menu=' + !!q('[data-testid="model-menu"]'))
  } catch (error) { ok(false, 'Model menu: ' + String(error)) }
  finally {
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    if (before) store.setState(before)
  }
  return out.join('\n')
})()
