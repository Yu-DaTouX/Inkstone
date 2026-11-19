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
        { id: 'sub-cd34', title: '已结束的任务', task: '跑完', status: 'done', startedAt: Date.now() - 9000, endedAt: Date.now() - 1000, summary: '完成' },
        { id: 'sub-ef56', title: '退出时中断', task: '中断', status: 'cancelled', endReason: 'interrupted', resumable: true, startedAt: Date.now() - 9000, endedAt: Date.now() - 2000 },
        { id: 'sub-gh78', title: '手动停止', task: '停止', status: 'cancelled', endReason: 'stopped', startedAt: Date.now() - 9000, endedAt: Date.now() - 3000 }
      ]
    } } })
    const { desk, h } = ctx
    await openSession(h, '第一个会话')
    await h.pressLabel(t('打开会话详情', 'Open session details'))
    await h.waitFor(() => h.has(t('子代理', 'Subagents')), `${tag} 详情里显示子代理`)
    const rowLabel = (title) => h.all('[aria-label]').map((n) => n.getAttribute('aria-label')).find((label) => label.startsWith(`${title}${t('，', ', ')}`)) ?? ''
    check(rowLabel('退出时中断').startsWith(`退出时中断${t('，已中断 · 可续接', ', Interrupted · can resume')}`), `${tag} 退出时中断的子代理显示为已中断、可续接`, rowLabel('退出时中断'))
    check(rowLabel('手动停止').startsWith(`手动停止${t('，已停止', ', Stopped')}`), `${tag} 手动停止的仍显示为已停止`, rowLabel('手动停止'))
    check(!h.byLabel(t('停止子代理 退出时中断', 'Stop subagent 退出时中断')).length, `${tag} 已中断的子代理不加操作按钮`)
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

  async function flowResync() {
    const tag = '[回连补齐]'
    let gate = null
    const ctx = await boot({ desktop: { tweak(handlers) {
      handlers.questions = async () => { if (gate) await gate.promise; return [] }
    } } })
    const { desk, h } = ctx
    try {
      await h.waitFor(() => h.matchLabel(/已连接/).length, `${tag} 已连接`)
      desk.state.running = true
      desk.state.queue = { 's-1': { steering: [], followUp: ['旧队列'] } }
      desk.state.subagents = [{ id: 'sub-resync', title: '旧子代理名', task: '夹具', status: 'running', startedAt: Date.now(), toolCalls: 1 }]
      await openSession(h, '第一个会话')
      desk.server.publish({ ch: 'state', payload: {}, runtime: { sessionId: 's-1' } })
      await h.waitFor(() => h.byLabel('停止当前运行').length, `${tag} 断线前已显示运行中`)
      await h.pressLabel('打开会话详情')
      await h.waitFor(() => h.has('旧子代理名') && h.has('旧队列'), `${tag} 初始会话资料`)

      const historyReads = () => desk.calls.filter(([op, id, limit]) => op === 'history' && id === 's-1' && limit > 12).length
      const before = historyReads()
      desk.server.publish({ ch: 'stats', payload: desk.state.stats, runtime: { sessionId: 's-2' } })
      await h.settle(150)
      desk.server.disconnectAll()
      desk.state.running = false
      desk.state.messages.push({ id: 'resync-reply', role: 'assistant', text: '断线期间的新正文', timestamp: Date.now() })
      desk.state.queue = {}
      desk.state.subagents = [{ ...desk.state.subagents[0], title: '更新后的子代理', status: 'done', endedAt: Date.now() }]
      let release
      gate = { promise: new Promise(resolve => { release = resolve }), release }
      for (let i = 0; i < 1001; i++) desk.server.publish({ ch: 'stats', payload: desk.state.stats, runtime: { sessionId: 's-2' } })
      try {
        await h.waitFor(() => !h.byLabel('停止当前运行').length, `${tag} 运行状态已更新`, 5000)
        await h.waitFor(() => h.has('断线期间的新正文') && h.has('更新后的子代理') && !h.has('旧队列'), `${tag} 待审批接口未返回时，当前页仍补齐正文、队列和子代理`, 3000)
        check(historyReads() > before && h.byLabel('消息内容').length === 1, `${tag} 仍在原会话且重新读取正文`)
      } finally {
        gate.release()
      }
    } finally {
      await ctx.close()
    }
  }

  async function flowStatusOrder() {
    let hold, captured = false, returned = false
    const ctx = await boot({ desktop: { tweak(handlers, state) {
      state.running = true
      const snapshot = handlers.snapshot
      handlers.snapshot = async () => {
        const result = await snapshot()
        if (hold) {
          const delay = hold
          hold = null
          captured = true
          await delay
          returned = true
        }
        return result
      }
    } } })
    const { desk, h } = ctx
    let release = () => {}
    try {
      await h.waitFor(() => h.matchLabel(/已连接/).length, '状态逆序：已连接')
      await openSession(h, '第一个会话')
      await h.waitFor(() => h.byLabel('停止当前运行').length, '状态逆序：初始运行中')
      const refresh = () => desk.server.publish({ ch: 'state', payload: {}, runtime: { sessionId: 's-1' } })
      hold = new Promise(resolve => { release = resolve })
      refresh()
      await h.waitFor(() => captured, '旧运行状态在途')
      desk.state.running = false
      refresh()
      await h.waitFor(() => !h.byLabel('停止当前运行').length, '较新的空闲状态先显示')
      release()
      await h.waitFor(() => returned, '旧快照返回')
      await h.settle(100)
      check(!h.byLabel('停止当前运行').length, '晚到的旧状态不再恢复停止按钮')
    } finally { release(); await ctx.close() }
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
    const pairingCode = desk.startPairing()
    const connectWithIdentity = async (answer) => {
      const before = env.alerts.length
      await h.pressLabel('连接电脑')
      await h.waitFor(() => env.alerts.length > before && env.alerts.at(-1).title === '核对电脑身份', `${tag} 手动地址配对先核对电脑身份`)
      check(/身份指纹/.test(env.alerts.at(-1).message ?? ''), `${tag} 身份核对弹窗写明指纹`, env.alerts.at(-1).message)
      await h.alertButton(answer)
    }
    await h.typeInto(h.inputs()[1], '000000')
    const devicesBefore = (await desk.devices.list()).length
    await connectWithIdentity('取消')
    await h.waitFor(() => h.has('没有确认电脑身份'), `${tag} 取消核对就停止配对`)
    check((await desk.devices.list()).length === devicesBefore, `${tag} 取消核对不登记设备`)
    await connectWithIdentity('一致，连接')
    await h.waitFor(() => h.has('配对码不正确'), `${tag} 错误配对码显示原文`)
    await h.typeInto(h.inputs()[1], pairingCode)
    await connectWithIdentity('一致，连接')
    await h.waitFor(() => h.byLabel('打开手机设置').length, `${tag} 配对成功进入首页`)
    check(await h.waitFor(() => h.has('第一个会话'), `${tag} 首页列出会话`).catch(() => false), `${tag} 首页列出会话`, h.text().slice(-200))
    check(!!globalThis.__keychain.entry, `${tag} 钥匙串保存了新连接`)
    await ctx.close()
  }

  return [
    ['断线重同步', flowResync],
    ['状态回包逆序', flowStatusOrder],
    ['归档与置顶', flowArchive],
    ['子代理 zh-CN', () => flowSubagents('zh-CN')],
    ['子代理 en-US', () => flowSubagents('en-US')],
    ['设置与配对', flowSettingsPair]
  ]
}
