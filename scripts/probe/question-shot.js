/* 只摆出一条提问请求并停住，供 YAN_PROBE_SHOT 截图核对提问面板的外观（不断言）。 */
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore
  for (let i = 0; i < 60; i++) {
    if (document.querySelector('.rail') && store.getState().settings) break
    await sleep(200)
  }
  await sleep(1000)
  store.setState({
    uiRequests: [
      {
        id: 'shot-q1',
        method: 'select',
        title: '需要你选择',
        message: '这份表格里有 3 个重复的客户，要怎么处理？',
        options: ['保留最新的一条，删除其余', '全部保留，只做标记', '先导出重复项给我看'],
        deadline: Date.now() + 180000
      }
    ]
  })
  await sleep(30000)
  return 'shown'
})()
