/*
 * 自定义 API 服务（实施-23 M2）的 cost 0 覆盖。
 *
 * 只在隔离的 `YAN_PI_DIR` 下跑（test-live 已经隔离）：写入的是那个目录的
 * `models.json`，不碰用户真实配置。不发起任何模型请求。
 */
;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? '  ' + extra : ''))
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel) => document.querySelector(sel)
  const qa = (sel) => [...document.querySelectorAll(sel)]
  const store = window.__yanStore
  const st = () => store.getState()
  const setValue = (el, value) => {
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const click = (el) => el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const until = async (fn, ms = 6000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(100)
    }
    return false
  }

  try {
    for (let i = 0; i < 60; i++) {
      if (st().conn === 'ready' && st().settings) break
      await sleep(400)
    }
    st().openSettings?.()
    await sleep(500)

    /* 进入「接入」页 */
    const tab = q('[data-testid="settings-tab-auth"]') ?? [...document.querySelectorAll('button')].find((b) => /接入/.test(b.textContent ?? ''))
    click(tab)
    const ready = await until(() => q('[data-testid="custom-api"]'), 8000)
    ok(ready, '设置 → 接入里有「自定义 API 服务」')

    /* 协议下拉只给受支持集合 */
    click(q('[data-testid="custom-api-add"]'))
    await until(() => q('[data-testid="custom-api-form"]'), 3000)
    const protocol = q('[data-testid="custom-api-protocol"]')
    const options = protocol ? [...protocol.options].map((o) => o.value) : []
    ok(options.includes('openai-completions'), '协议里有 OpenAI Chat Completions', options.join(','))
    ok(!options.includes('google-vertex'), '需要项目/区域/凭证的协议不在下拉里')
    ok(!options.includes('bogus-api'), '没有自由输入 api 的入口')

    /* 非法 Base URL 要被拒 */
    setValue(q('[data-testid="custom-api-id"]'), 'yan-probe')
    setValue(q('[data-testid="custom-api-base-url"]'), '!curl evil')
    setValue(q('[data-testid="custom-api-model-id-0"]'), 'probe-model')
    click(q('[data-testid="custom-api-save"]'))
    await sleep(400)
    const badMsg = q('[data-testid="custom-api-msg"]')?.textContent ?? ''
    ok(/Base URL/.test(badMsg), '! 开头的 Base URL 被拒绝并说明原因', badMsg)
    ok(!q('[data-testid="custom-api-row-yan-probe"]'), '被拒时不产生条目')

    /* 正常保存 */
    setValue(q('[data-testid="custom-api-base-url"]'), 'https://api.example.invalid/v1')
    setValue(q('[data-testid="custom-api-key"]'), 'sk-probe-not-real')
    click(q('[data-testid="custom-api-save"]'))
    const saved = await until(() => q('[data-testid="custom-api-row-yan-probe"]'), 6000)
    ok(saved, '合法表单保存后出现在列表里')
    const rowText = q('[data-testid="custom-api-row-yan-probe"]')?.textContent ?? ''
    ok(/已设置密钥/.test(rowText), '列表只报告密钥状态', rowText.trim())
    ok(!/sk-probe-not-real/.test(document.body.innerText), '页面上没有密钥明文')

    /* 落盘位置与形状（真源是 pi 的 models.json） */
    const fromIpc = await window.yan.customProviders()
    const mine = fromIpc.find((item) => item.id === 'yan-probe')
    ok(!!mine && mine.api === 'openai-completions', 'IPC 读回同一个条目')
    ok(mine?.baseUrl === 'https://api.example.invalid/v1', 'Base URL 原样保存')
    ok(mine?.models?.[0]?.id === 'probe-model', '模型 ID 原样保存')
    ok(!JSON.stringify(fromIpc).includes('sk-probe-not-real'), 'IPC 结果里没有密钥明文')

    /* 连接测试（实施-23 M2）：两段分开，成本提示必须在按钮旁边 */
    click(q('[data-testid="custom-api-test-yan-probe"]'))
    const panel = await until(() => q('[data-testid="custom-api-test-panel-yan-probe"]'), 3000)
    ok(panel, '连接测试面板能展开')
    const panelText = q('[data-testid="custom-api-test-panel-yan-probe"]')?.textContent ?? ''
    ok(/计费/.test(panelText), '面板里写明了哪一段会计费', panelText.slice(0, 80))
    ok(!!q('[data-testid="custom-api-test-billable-yan-probe"]'), '存在「发真实请求」按钮（需用户主动点）')

    const beforeTest = qa('.custom-api-test .set-desc').length
    click(q('[data-testid="custom-api-test-endpoint-yan-probe"]'))
    const gotResult = await until(() => q('[data-testid="custom-api-test-result-yan-probe"]'), 20_000)
    ok(gotResult, '免费检查返回了结果（不是只转圈）')
    const resultText = q('[data-testid="custom-api-test-result-yan-probe"]')?.textContent ?? ''
    /* example.invalid 永远解析不到：这里要的正是「失败也给可读原因」 */
    ok(/✗/.test(resultText) && /(连不上|HTTP|超时)/.test(resultText), '不可达地址给出可读失败原因', resultText.replace(/✗/g, '失败').trim())
    ok(/ms/.test(resultText), '结果带耗时')
    ok(qa('.custom-api-test .set-desc').length >= beforeTest, '结果就地显示在按钮下方')

    /* 删除 */
    click(q('[data-testid="custom-api-remove-yan-probe"]'))
    const gone = await until(() => !q('[data-testid="custom-api-row-yan-probe"]'), 6000)
    ok(gone, '删除后条目消失')
    const after = await window.yan.customProviders()
    ok(!after.some((item) => item.id === 'yan-probe'), '删除真的落盘')
  } catch (e) {
    ok(false, '抛异常：' + (e && e.message ? e.message : String(e)))
  }

  const failed = out.filter((l) => l.startsWith('  ✗ ')).length
  out.push(failed === 0 ? '[custom-api] 全部通过' : '[custom-api] ' + failed + ' 条失败')
  return out.join('\n')
})()
