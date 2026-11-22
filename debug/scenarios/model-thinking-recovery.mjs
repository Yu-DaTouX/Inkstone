export const meta = { description: '模型面板在本地档位暂缺时从当前 pi 会话恢复选项，不更改所选档位' }

export default async function run({ cdp, waitFor, check, shot }) {
  const selected = await cdp.evaluate(`window.__yanStore.getState().setModel('fake', 'fake-reasoning')`)
  if (!selected?.ok) throw new Error('未切换到隔离推理模型')
  await waitFor(`s.session?.model?.id === 'fake-reasoning' && s.session.availableThinkingLevels?.includes('high')`)
  await cdp.evaluate(`window.__yanStore.getState().setThinking('high')`)
  await waitFor(`s.session?.thinkingLevel === 'high'`)
  await cdp.evaluate(`window.__yanStore.setState(s => ({ session: { ...s.session, availableThinkingLevels: [], thinkingLevelsStatus: 'unknown' }, thinkingLevels: [] }))`)
  await cdp.evaluate(`document.querySelector('[data-chat-provider-model-picker]').click()`)
  await waitFor(`!!document.querySelector('[data-composer-effort-panel] input:not(:disabled)') && s.session?.thinkingLevelsStatus === 'known'`)
  const state = await cdp.evaluate(`(() => {const s=window.__yanStore.getState().session; return { model:s.model.id, level:s.thinkingLevel, levels:s.availableThinkingLevels }})()`)
  check('打开面板补回当前模型的真实档位，保留 high', state.model === 'fake-reasoning' && state.level === 'high' && state.levels.length > 1, state)
  await shot('thinking-recovered')
}
