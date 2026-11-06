export function moreFlows({ boot, openSession, check, env }) {
  async function flowArchive() {
    const tag = '[归档与置顶]'
    const ctx = await boot()
    const { desk, h } = ctx
    await openSession(h, '第一个会话')
    await h.pressLabel('打开会话详情')
    await h.waitFor(() => h.byLabel('归档').length, `${tag} 详情`)
    desk.state.activeSessionId = null
    await h.pressLabel('归档')
    await h.waitFor(() => h.byLabel('取消归档').length, `${tag} 归档后按钮变为取消归档`)
    check(!!desk.state.sessions[0].archivedAt, `${tag} 电脑端已归档`)
    await h.pressLabel('取消归档')
    await h.waitFor(() => h.byLabel('归档').length, `${tag} 取消归档`)
    check(!desk.state.sessions[0].archivedAt, `${tag} 电脑端已取消归档`)
    await h.pressLabel('置顶')
    await h.waitFor(() => h.byLabel('取消置顶').length, `${tag} 置顶`)
    await h.pressLabel('取消置顶')
    await h.waitFor(() => h.byLabel('置顶').length, `${tag} 取消置顶`)
    check(desk.calls.filter((c) => c[0] === 'flags').map((c) => JSON.stringify(c[2])).join('') === '{"archived":true}{"archived":false}{"pinned":true}{"pinned":false}', `${tag} 请求序列`, desk.calls.filter((c) => c[0] === 'flags').map((c) => JSON.stringify(c[2])).join(''))
    desk.state.errors.flags = { status: 500, error: '电脑写入失败' }
    await h.pressLabel('置顶')
    await h.waitFor(() => h.has('电脑写入失败'), `${tag} 操作失败显示原文`)
    check(h.byLabel('置顶').length === 1, `${tag} 失败后按钮仍可再点`)
    await ctx.close()
  }

  async function flowSubagents(lang) {
    const tag = `[子代理 ${lang}]`
    const t = (zh, en) => (lang === 'zh-CN' ? zh : en)
    const ctx = await boot({ lang, desktop: { tweak: (_, state) => {
      state.subagents = [
        { id: 'sub-ab12', title: '审查代码', task: '审查', status: 'running', startedAt: Date.now() - 5000, toolCalls: 2, latestActivity: '读取文件' },
        { id: 'sub-cd34', title: '已结束的任务', task: '跑完', status: 'done', startedAt: Date.now() - 9000, endedAt: Date.now() - 1000, summary: '完成' }
      ]
    } } })
    const { desk, h } = ctx
    await openSession(h, '第一个会话')
    await h.pressLabel(t('打开会话详情', 'Open session details'))
    await h.waitFor(() => h.has(t('子代理', 'Subagents')), `${tag} 详情里显示子代理`)
    await h.pressText('已结束的任务')
    await h.waitFor(() => h.has('完成'), `${tag} 展开已结束子代理`)
    check(!h.byLabel(t('停止子代理 已结束的任务', 'Stop subagent 已结束的任务')).length, `${tag} 已结束的子代理没有停止按钮`)
    await h.pressText('审查代码')
    await h.waitFor(() => h.byLabel(t('停止子代理 审查代码', 'Stop subagent 审查代码')).length, `${tag} 展开运行中子代理出现停止按钮`)
    await h.pressLabel(t('停止子代理 审查代码', 'Stop subagent 审查代码'))
    await h.waitFor(() => desk.calls.some((c) => c[0] === 'stopSubagent'), `${tag} 停止发出请求`)
    check(desk.calls.find((c) => c[0] === 'stopSubagent')[2] === 'sub-ab12', `${tag} 停止请求针对正确的子代理`)
    desk.state.errors.stopSubagent = { status: 404, error: '子代理已结束' }
    await ctx.close()
  }

  async function flowSettingsPair() {
    const tag = '[设置与配对]'
    const ctx = await boot()
    const { desk, h } = ctx
    await h.pressLabel('打开手机设置')
    await h.waitFor(() => h.has('左手习惯'), `${tag} 设置页`)
    const sw = h.all('[data-rn="Switch"]').find((n) => n.getAttribute('aria-label') === '左手习惯')
    check(!!sw, `${tag} 左手习惯开关`)
    await h.act(async () => { sw.__props.onValueChange(true) })
    await h.settle(50)
    check(h.all('[data-rn="Switch"]').find((n) => n.getAttribute('aria-label') === '左手习惯').getAttribute('data-value') === 'true', `${tag} 左手习惯开关状态`)
    await h.pressText('English')
    await h.waitFor(() => h.has('Projects'), `${tag} 切换到英文（整个应用重建，回到首页）`)
    await h.pressLabel('Open phone settings')
    await h.waitFor(() => h.has('Left-handed') && h.has('Unpair'), `${tag} 英文设置页`)
    await h.pressText('中文')
    await h.waitFor(() => h.has('项目'), `${tag} 切回中文`)
    await h.pressLabel('打开手机设置')
    await h.waitFor(() => h.has('布局'), `${tag} 中文设置页`)
    await h.pressLabel('解除配对')
    check(env.alerts.at(-1)?.title === '解除配对？', `${tag} 解除配对先确认`)
    await h.alertButton('解除配对')
    await h.waitFor(() => h.has('配对电脑') || h.has('连接电脑'), `${tag} 解除后回到配对页`)
    check(globalThis.__keychain.entry === null, `${tag} 钥匙串已清除`)
    { const left = await desk.devices.list(); check(left.every((d) => d.revokedAt), `${tag} 电脑端设备已撤销`, JSON.stringify(left)) }

    const [address, code] = h.inputs()
    await h.typeInto(address, desk.baseUrl.replace('http://', ''))
    await h.typeInto(code, '123456')
    await h.pressLabel('连接电脑')
    await h.waitFor(() => h.has('没有正在进行的配对') || h.has('配对'), `${tag} 无配对码时报错`)
    check(h.has('电脑上没有正在进行的配对'), `${tag} 无配对时显示原文`, h.text().slice(-300))
    const pairing = desk.devices.startPairing()
    await h.typeInto(h.inputs()[1], '000000')
    await h.pressLabel('连接电脑')
    await h.waitFor(() => h.has('配对码不正确'), `${tag} 错误配对码显示原文`)
    await h.typeInto(h.inputs()[1], pairing.code)
    await h.pressLabel('连接电脑')
    await h.waitFor(() => h.byLabel('打开手机设置').length, `${tag} 配对成功进入首页`)
    check(h.has('第一个会话'), `${tag} 首页列出会话`)
    check(!!globalThis.__keychain.entry, `${tag} 钥匙串保存了新连接`)
    await ctx.close()
  }

  return [
    ['归档与置顶', flowArchive],
    ['子代理 zh-CN', () => flowSubagents('zh-CN')],
    ['子代理 en-US', () => flowSubagents('en-US')],
    ['设置与配对', flowSettingsPair]
  ]
}
