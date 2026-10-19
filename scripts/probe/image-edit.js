;(async () => {
  const out = []
  const ok = (condition, text) => {
    out.push((condition ? '  ✓ ' : '  ✗ ') + text)
    return !!condition
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const q = (selector) => document.querySelector(selector)
  const qa = (selector) => [...document.querySelectorAll(selector)]
  const store = window.__yanStore

  const prompt = [
    '请验证砚的图生图。先用 bash 执行 yan image --help 读用法，',
    '然后在项目根写一个 image.json，内容为',
    '{"mode":"edit","sourcePaths":["imgsrc.png"],"prompt":"把这张蓝色方块改成日落时分的橙红色，保持方形构图"}，',
    '再执行 yan image generate --request-file image.json。',
    '不要编造结果；如果命令报错，原样报告错误码和信息。成功就报告输出图片的路径。'
  ].join('')

  try {
    for (let i = 0; i < 60; i++) {
      if (store?.getState().settings && q('[data-testid="composer-input"]')) break
      await sleep(250)
    }
    const ta = q('[data-testid="composer-input"]')
    if (!ta) return '✗ 找不到输入框'

    out.push('=== DeepSeek 驱动图生图 ===')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, prompt)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(200)
    const send = q('[data-testid="composer-send"]')
    if (!send || send.disabled) return '✗ 发送键不可用'
    send.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    await sleep(3000)
    const deadline = Date.now() + 330_000
    let idleSince = 0
    while (Date.now() < deadline) {
      const busy = store.getState().session?.isAgentRunning || store.getState().session?.isStreaming || !!q('.v3-caret')
      if (busy) idleSince = 0
      else if (!idleSince) idleSince = Date.now()
      else if (Date.now() - idleSince > 12_000) break
      await sleep(1000)
    }
    await sleep(1500)

    const text = document.body.innerText || ''
    const answers = qa('.v3-msg.assistant .v3-prose').map((e) => e.textContent.trim()).filter(Boolean)
    const last = answers[answers.length - 1] ?? ''
    out.push('  模型最终回答: ' + JSON.stringify(last.slice(0, 400)))
    ok(!/不是内部或外部命令|command not found|is not recognized|宿主能力服务不可用|YAN_CLI_URL/i.test(text), '没有 yan 不可用错误')
    ok(/edit/.test(text) && /imgsrc\.png/.test(text), '模型确实用了 edit 模式 + imgsrc.png')
    const provider = text.match(/image_provider_unavailable|local_workflow_missing|quota|额度|401|403|429/i)
    if (provider) out.push('  注意: 页面出现 ' + provider[0])
    ok(/\.(png|jpe?g|webp)/i.test(last) && !/错误|失败|error/i.test(last), '回答里给出了输出图片路径且无失败字样')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
