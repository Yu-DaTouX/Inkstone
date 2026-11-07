export const meta = { description: '单个可自填字段的表单提问：卡片里没有自填框，主输入框的文字和勾选项一起提交；分别验证输入框回车与卡片提交按钮' }

async function pressEnter(cdp) {
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
}

export default async function run({ cdp, box, waitFor, check, sleep, shot, autoApprove, newSession }) {
  const ev = (expr) => cdp.evaluate(expr)
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN' })`)
  await autoApprove()
  const answerOf = `(() => { const call = [...window.__yanStore.getState().messages].reverse().flatMap((m) => m.toolCalls ?? []).find((c) => c.name === 'question' && c.status !== 'running'); return call ? String(call.output ?? '') : '' })()`

  for (const via of ['enter', 'button']) {
    await newSession(box.project)
    await ev(`window.__yanStore.getState().send('MULTIASK ${via}')`)
    await waitFor(`!!document.querySelector('[data-testid="v3-question-form"]')`, 30000, 50)
    await sleep(300)
    check(`${via}：卡片里没有自填框`, await ev(`!document.querySelector('.v3-qother')`))
    check(`${via}：卡片头部没有多余的跳过按钮`, await ev(`document.querySelectorAll('[data-testid="v3-question-skip"]').length === 0`))
    if (via === 'enter') await shot('form-composer-dark')
    await ev(`document.querySelector('[data-testid="v3-question-form"] .v3-qoption').click()`)
    await ev(`window.__yanStore.getState().insertIntoComposer('分词键保留不动')`)
    await waitFor(`document.querySelector('[data-testid="composer-input"]').innerText.includes('分词键保留不动')`)
    if (via === 'enter') {
      await ev(`document.querySelector('[data-testid="composer-input"]').focus()`)
      await sleep(1200)
      await pressEnter(cdp)
    } else {
      await ev(`document.querySelector('[data-testid="v3-question-form-submit"]').click()`)
    }
    await waitFor(`${answerOf}.includes('分词键保留不动')`, 30000, 100)
    const answer = await ev(answerOf)
    check(`${via}：回答同时带勾选项与输入框文字`, answer.includes('第二行左右各缩进半个键') && answer.includes('分词键保留不动'), answer)
    await sleep(300)
    check(`${via}：提交后输入框清空`, await ev(`!document.querySelector('[data-testid="composer-input"]').innerText.trim()`))
    check(`${via}：没有另发一条用户消息`, await ev(`!window.__yanStore.getState().messages.some((m) => m.role === 'user' && (m.text ?? '').includes('分词键保留不动'))`))
  }
}
