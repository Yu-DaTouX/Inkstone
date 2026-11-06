export const meta = { description: '按内容比例表格的三种形态（序号加短列加长文本、全短列、宽列多）在宽窄视口、深浅主题下的截图与溢出检查，合成消息，不调用模型' }

const TABLES = {
  序号短列长文本: `| # | 状态 | 负责人 | 说明 |\n|---|---|---|---|\n| 1 | 完成 | 甲 | 把登录流程改成 PKCE，并且在令牌过期之前提前刷新，避免用户在长会话里被突然踢出登录，同时补上对应的回归测试和失败时的提示文案 |\n| 2 | 进行中 | 乙 | 迁移旧的会话存储到新的目录结构，保留原有文件并在首次启动时做一次校验，校验失败时回退到旧目录而不是直接报错退出 |\n| 3 | 待办 | 丙 | 补文档 |`,
  全短列: `| 名称 | 版本 | 许可 | 大小 |\n|---|---|---|---|\n| react | 19 | MIT | 2MB |\n| zustand | 5 | MIT | 1MB |\n| virtua | 0.4 | MIT | 3MB |`,
  宽列多: `| 列一 | 列二 | 列三 | 列四 | 列五 | 列六 | 列七 | 列八 | 列九 | 列十 |\n|---|---|---|---|---|---|---|---|---|---|\n| 一些中等长度的内容 | 另一些中等长度的内容 | 第三列也有不少文字 | 第四列的文字 | 第五列的文字内容 | 第六列 | 第七列的内容比较长一些 | 第八列 | 第九列的内容 | 第十列的内容也不算短 |\n| a | b | c | d | e | f | g | h | i | j |`
}

export default async function run({ cdp, newSession, check, sleep, runDir, shot }) {
  await newSession()
  const text = Object.entries(TABLES).map(([name, table]) => `**${name}**\n\n${table}`).join('\n\n')
  const messages = [
    { id: 'tb-user', role: 'user', text: '给我几张表', timestamp: Date.now() - 5000 },
    { id: 'tb-a', role: 'assistant', text, timestamp: Date.now() }
  ]
  await cdp.evaluate(`window.__yanStore.setState({ messages: ${JSON.stringify(messages)}, historyLoading: false, switchLoading: false })`)
  for (const [width, label] of [[1280, 'wide'], [720, 'narrow']]) {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 1400, deviceScaleFactor: 1, mobile: false })
    for (const theme of ['light', 'dark']) {
      await cdp.evaluate(`window.__yanStore.getState().patchSettings({ theme: ${JSON.stringify(theme)}, lang: 'zh-CN', rightPanelOpen: false })`)
      await sleep(900)
      const info = await cdp.evaluate(`(() => [...document.querySelectorAll('.v3-msg table')].map((t) => { const w = t.closest('[class*=table]') ?? t.parentElement; const r = t.getBoundingClientRect(); const pr = w.getBoundingClientRect(); return { width: Math.round(r.width), wrapper: Math.round(pr.width), cols: [...t.querySelectorAll('tr:first-child > *')].map((c) => Math.round(c.getBoundingClientRect().width)), clipped: t.scrollWidth > t.clientWidth + 1 || w.scrollWidth > w.clientWidth + 1 } }))()`)
      check(`${label} ${theme} 三张表都渲染`, info.length === 3, info)
      check(`${label} ${theme} 前两张表不超出容器、宽表在容器内横向滚动`, info[0].width <= info[0].wrapper + 1 && info[1].width <= info[1].wrapper + 1 && info[2].width > info[2].wrapper, info)
      await shot(`table-${label}-${theme}`)
    }
  }
}
