/** 真实桌面成果卡片；数据由隔离测试驱动提供，不调用模型。 */
;(async () => {
  const out = []
  const ok = (value, label) => out.push(`  ${value ? '✓' : '✗'} ${label}`)
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const wait = async (predicate) => {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return true
      await sleep(100)
    }
    return false
  }
  const fixture = window.__HTML_ARTIFACT_FIXTURE__
  const store = window.__yanStore
  const received = []
  const receive = (event) => {
    const frame = document.querySelector('[data-testid="artifact-html-frame"]')
    if (event.source === frame?.contentWindow && event.data?.htmlArtifactProbe) received.push(event.data)
  }
  window.addEventListener('message', receive)
  const show = (artifact, text = 'HTML 成果现在直接显示在这条消息中。') => {
    store.setState({
      messages: [{ id: 'html-preview-assistant', role: 'assistant', text, timestamp: Date.now(), artifacts: [artifact] }],
      streamingId: null,
      isStreaming: false,
      peekedPath: null,
      peekedSessionId: null,
      workspaceMode: 'coding'
    })
  }
  try {
    ok(await wait(() => !!store?.getState().settings), '桌面 store 已就绪')
    // 首次启动提示不是测试对象；只修改此隔离实例的展示状态。
    store.setState({ settings: { ...store.getState().settings, workspaceMode: 'coding', onboardingDone: true } })
    show(fixture.artifact)
    ok(await wait(() => document.querySelector('[data-testid="artifact-html-frame"]')), 'HTML 默认在消息内显示 iframe，而非源码')
    const frame = document.querySelector('[data-testid="artifact-html-frame"]')
    ok(frame?.getAttribute('sandbox') === 'allow-scripts', 'iframe 不授予同源、弹窗、下载或导航权限')
    ok(frame?.src.startsWith('inkstone-html://'), '独立协议承载页面，主窗口 CSP 没有放宽脚本权限')
    ok(await wait(() => received.some((item) => item.kind === 'ready')), '完整 HTML 末尾的内联脚本实际执行')
    const ready = received.find((item) => item.kind === 'ready')
    ok(ready?.hostBridge === 'undefined' && ready?.node === 'undefined', '子页面没有 window.yan 或 Node 接口')
    ok(ready?.parentBlocked === true && ready?.storageBlocked === true, '子页面无法读取父 DOM 与同源存储')
    ok(ready?.microphoneAllowed === false, '子页面的麦克风权限被禁用')
    ok(await wait(() => received.some((item) => item.kind === 'fetch-blocked')), '子页面网络请求被拒绝')
    frame?.contentWindow?.postMessage({ htmlArtifactCommand: 'increment' }, '*')
    ok(await wait(() => received.some((item) => item.kind === 'counter' && item.count === 1)), '页面脚本交互可用')
    const hostLocation = location.href
    frame?.contentWindow?.postMessage({ htmlArtifactCommand: 'navigate' }, '*')
    await sleep(400)
    ok(location.href === hostLocation && frame?.isConnected, '子页面外链尝试不能导航主窗口（网络回执另由测试驱动核验）')
    document.querySelectorAll('[data-testid="artifact-html-mode"] button')[1]?.click()
    ok(await wait(() => !document.querySelector('[data-testid="artifact-html-frame"]')), '切到源码时卸载页面')
    ok(await wait(() => document.querySelector('.artifact-code')?.textContent?.includes('<!doctype html>')), '源码模式显示文字，不执行代码')
    ok(await wait(() => document.querySelector('.artifact-binary')?.textContent?.includes('部分源码')), '源码截断有明确提示，不把残缺文件当页面')
    document.querySelectorAll('[data-testid="artifact-html-mode"] button')[0]?.click()
    ok(await wait(() => document.querySelector('[data-testid="artifact-html-frame"]')), '可切回网页预览')
    ok(document.querySelectorAll('.artifact-head .artifact-actions button').length === 3, '右侧预览、定位、复制入口收在标题行')
    const card = document.querySelector('.artifact-card')?.getBoundingClientRect()
    const iframe = document.querySelector('[data-testid="artifact-html-frame"]')?.getBoundingClientRect()
    ok(!!iframe && !!card && iframe.width <= card.width + 1 && iframe.height >= 200 && iframe.height <= 380, '预览尺寸受消息卡片约束')
    if (fixture.archify) {
      show(fixture.archify, 'Archify 交互式架构汇报：现在可以直接在消息里看图。')
      ok(await wait(() => document.querySelector('[data-testid="artifact-html-frame"]')?.title.includes(fixture.archify.filename)), '真实 Archify 成果使用同一预览入口')
      if (fixture.archifyInteraction) {
        ok(await wait(() => received.some((item) => item.kind === 'archify-interaction')), '实际 Archify 文件在隔离 iframe 中完成脚本初始化')
        const report = received.find((item) => item.kind === 'archify-interaction')
        ok(report?.themeChanged === true && report?.svgReady === true, 'Archify 图表已渲染，主题按钮的真实处理器可交互')
      }
    }
    document.querySelector('.artifact-card')?.scrollIntoView({ block: 'start' })
    await sleep(1200)
    out.push('截图保留当前网页预览状态。')
    // 留出时间让真实窗口 capturePage 完成，不截切换中的源码态。
    await sleep(6000)
  } catch (error) {
    out.push('  ✗ HTML 预览探针异常：' + String(error))
  } finally {
    window.removeEventListener('message', receive)
  }
  return out.join('\n')
})()
