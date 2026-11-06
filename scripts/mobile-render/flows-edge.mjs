export function edgeFlows({ boot, openSession, check, env }) {
  async function flowOldDesktop() {
    const tag = '[旧电脑端]'
    const ctx = await boot({ desktop: { omit: ['insight', 'compact', 'branches', 'switchBranch', 'search', 'sessionFlags', 'deleteSession', 'models'] } })
    const { desk, h } = ctx
    await h.typeInto(h.inputs()[0], '关键词')
    await h.settle(600)
    check(!desk.calls.some((c) => c[0] === 'search'), `${tag} 没有 search 能力时不请求`)
    await h.typeInto(h.inputs()[0], '')
    await openSession(h, '第一个会话')
    await h.pressLabel('打开会话详情')
    await h.waitFor(() => h.has('环境'), `${tag} 详情可打开`)
    await h.settle(200)
    check(!h.has('用量') && !h.has('更改') && !h.has('操作'), `${tag} 不显示用量、更改、操作`)
    check(!desk.calls.some((c) => c[0] === 'insight'), `${tag} 不请求 insight`)
    await h.pressLabel(/^选择模型/)
    check(env.alerts.at(-1)?.title === '请更新电脑端', `${tag} 没有模型能力时提示更新电脑端`)
    await ctx.close()
  }

  async function flowInsightShapes() {
    const tag = '[用量与更改形态]'
    const files = Array.from({ length: 40 }, (_, i) => ({ path: `src/dir/file${i}.ts`, status: ['A', 'M', 'D', 'R', 'U', '?'][i % 6], ...(i % 3 ? { added: i, removed: 1 } : {}) }))
    const ctx = await boot({ desktop: { tweak: (_, state) => {
      state.stats = { tokens: 0, cost: 0, toolCalls: 0, messages: 0, context: { percent: 92, tokens: 92000, window: 100000 } }
      state.changes = { branch: null, added: 0, removed: 0, total: 52, files, truncated: true }
    } } })
    const { h } = ctx
    await openSession(h, '第一个会话')
    await h.pressLabel('打开会话详情')
    await h.waitFor(() => h.has('用量') && h.has('更改'), `${tag} 两段都显示`)
    const text = h.text()
    check(text.includes('92%') && text.includes('0 tokens'), `${tag} 满载上下文与零用量`)
    const fill = h.all('[data-style]').find((n) => /"width":"92%"/.test(n.getAttribute('data-style')))
    check(!!fill, `${tag} 超过 85% 的占用条存在`)
    check(text.includes('另有 12 个文件'), `${tag} 截断时显示剩余文件数`)
    check(!h.matchLabel(/^分支/).length, `${tag} 无分支名时没有分支行`)
    check(text.includes('src/dir/file39.ts') && text.includes('src/dir/file1.ts'), `${tag} 40 个文件都渲染`)
    await ctx.close()

    const none = await boot({ desktop: { tweak: (_, state) => { state.stats = null; state.changes = null } } })
    await openSession(none.h, '第一个会话')
    await none.h.pressLabel('打开会话详情')
    await none.h.waitFor(() => none.h.has('环境'), `${tag} 无统计也能开详情`)
    await none.h.settle(200)
    check(!none.h.has('用量') && !none.h.has('更改'), `${tag} 无统计无更改时整段不显示`)
    check(none.h.byLabel('压缩上下文').length === 1, `${tag} 操作区照常`)
    await none.close()

    const broken = await boot({ desktop: { tweak: (_, state) => { state.errors.insight = { status: 500, error: '读不了' } } } })
    await openSession(broken.h, '第一个会话')
    await broken.h.pressLabel('打开会话详情')
    await broken.h.settle(300)
    check(broken.h.has('环境') && !broken.h.has('读不了'), `${tag} insight 失败静默，不崩`)
    await broken.close()

    const unknown = await boot({ desktop: { tweak: (_, state) => {
      state.stats = { tokens: 5, cost: 0, toolCalls: 1, messages: 1, context: { percent: null, tokens: null, window: 200000 } }
      state.changes = { branch: 'main', added: 0, removed: 0, total: 2, files: [{ path: 'a', status: 'M' }, { path: 'b', status: 'U' }], truncated: false }
    } } })
    await openSession(unknown.h, '第一个会话')
    await unknown.h.pressLabel('打开会话详情')
    await unknown.h.waitFor(() => unknown.h.has('用量'), `${tag} 上下文未知时也显示用量`)
    check(!unknown.h.has('NaN') && !unknown.h.has('undefined'), `${tag} 上下文未知时没有 NaN`, unknown.h.text().replace(/[· ]{10,}/g, '…').slice(0, 300))
    await unknown.close()
  }

  async function flowBranchStates() {
    const tag = '[分支面板形态]'
    const ctx = await boot({ desktop: { tweak: (_, state) => { state.errors.branches = { status: 500, error: '不是 git 仓库' } } } })
    const { h } = ctx
    await openSession(h, '第一个会话')
    await h.pressLabel('打开会话详情')
    await h.waitFor(() => h.matchLabel(/^分支/).length, `${tag} 分支行`)
    await h.pressLabel(/^分支/)
    await h.waitFor(() => h.has('不是 git 仓库'), `${tag} 读取分支失败显示原文`)
    check(!h.has('没有本地分支'), `${tag} 失败时不误报没有本地分支`)
    await ctx.close()

    const empty = await boot({ desktop: { tweak: (_, state) => { state.branches = [] } } })
    await openSession(empty.h, '第一个会话')
    await empty.h.pressLabel('打开会话详情')
    await empty.h.waitFor(() => empty.h.matchLabel(/^分支/).length, '分支行')
    await empty.h.pressLabel(/^分支/)
    await empty.h.waitFor(() => empty.h.has('没有本地分支'), `${tag} 空分支列表`)
    await empty.close()

    const running = await boot()
    running.desk.state.running = true
    await running.h.pressLabel('刷新会话')
    await running.h.waitFor(() => running.h.matchLabel(/运行中/).length, '首页运行中')
    await openSession(running.h, '第一个会话')
    await running.h.pressLabel('打开会话详情')
    await running.h.waitFor(() => running.h.matchLabel(/^分支/).length, '分支行')
    await running.h.pressLabel(/^分支/)
    await running.h.waitFor(() => running.h.has('运行中不能切换'), `${tag} 运行中提示不能切换`)
    check(running.h.byLabel('切换到 dev')[0]?.__props.disabled === true, `${tag} 运行中其他分支不可点`)
    check(running.h.byLabel('压缩上下文')[0].__props.disabled === true, `${tag} 运行中压缩按钮禁用`)
    check(running.h.byLabel('归档')[0].__props.disabled === true, `${tag} 运行中归档按钮禁用`)
    await running.close()
  }

  async function flowLongText(lang) {
    const tag = `[长文本 ${lang}]`
    const longTitle = '很长的会话标题'.repeat(30)
    const longBranch = 'feature/' + 'very-long-branch-name-'.repeat(5)
    const longPath = 'src/' + 'deeply/nested/directory/'.repeat(8) + 'file.ts'
    const longModel = 'Provider Model With An Extremely Long Display Name '.repeat(3)
    const ctx = await boot({ lang, desktop: { tweak: (_, state) => {
      state.sessions[0].title = longTitle
      state.sessions[0].model = longModel
      state.branch = longBranch
      state.branches.push({ name: longBranch, current: false })
      state.changes = { branch: longBranch, added: 1, removed: 1, total: 1, files: [{ path: longPath, status: 'M', added: 1, removed: 1 }], truncated: false }
      state.messages.push({ id: 'a2', role: 'assistant', text: '很长的一行'.repeat(200), timestamp: Date.now() })
    } } })
    const { h } = ctx
    const limited = (needle) => h.all('[data-rn="Text"]').filter((n) => n.textContent.includes(needle) && !n.parentElement.closest('[data-rn="Text"]'))
    check(limited(longTitle.slice(0, 20)).length > 0 && limited(longTitle.slice(0, 20)).every((n) => n.getAttribute('data-lines')), `${tag} 首页长标题单行截断`)
    await openSession(h, longTitle.slice(0, 10))
    check(limited(longTitle.slice(0, 20)).every((n) => n.getAttribute('data-lines')), `${tag} 会话标题单行截断`)
    await h.pressLabel(/^(打开会话详情|Open session details)/)
    await h.waitFor(() => h.has(longPath), `${tag} 详情出现长路径`)
    check(limited(longPath).every((n) => n.getAttribute('data-lines') === '1'), `${tag} 文件路径单行截断`)
    check(limited(longBranch).every((n) => n.getAttribute('data-lines') === '1'), `${tag} 分支名单行截断`)
    await h.pressLabel(/^(分支|Branch) /)
    await h.waitFor(() => h.all('[data-rn="Modal"]').length, `${tag} 分支面板打开`)
    await h.waitFor(() => h.all('[data-rn="Modal"] [data-rn="Text"]').some((n) => n.textContent === longBranch), `${tag} 分支面板列出长分支`)
    const modalBranch = h.all('[data-rn="Modal"] [data-rn="Text"]').filter((n) => n.textContent === longBranch)
    check(modalBranch.length > 0 && modalBranch.every((n) => n.getAttribute('data-lines') === '1'), `${tag} 分支面板里的长分支名单行`)
    await ctx.close()
  }

  async function flowLayouts() {
    const tag = '[窗口形态]'
    const triple = await boot({ width: 1200, height: 800 })
    await openSession(triple.h, '第一个会话')
    await triple.h.waitFor(() => triple.h.has('环境'), `${tag} 三栏：详情常驻`)
    check(triple.h.matchLabel(/^第一个会话/).length >= 1 && triple.h.has('你好，我能帮你做什么？'), `${tag} 三栏：列表、会话、详情同屏`)
    check(triple.h.byLabel('压缩上下文').length === 1, `${tag} 三栏：详情里有操作`)
    await triple.close()

    const split = await boot({ width: 700, height: 900 })
    await openSession(split.h, '第一个会话')
    check(split.h.has('你好，我能帮你做什么？'), `${tag} 分栏：会话显示`)
    await split.h.pressLabel('打开会话详情')
    await split.h.waitFor(() => split.h.has('环境'), `${tag} 分栏：打开详情`)
    await split.h.pressLabel('压缩上下文')
    await split.h.waitFor(() => split.desk.calls.some((c) => c[0] === 'compact'), `${tag} 分栏详情里压缩可用`)
    await split.close()

    const left = await boot({ width: 700, height: 900, left: true })
    await openSession(left.h, '第一个会话')
    check(left.h.all('[data-style]').some((n) => /"flexDirection":"row-reverse"/.test(n.getAttribute('data-style'))), `${tag} 左手习惯：分栏镜像`)
    await left.h.pressLabel('打开会话详情')
    await left.h.waitFor(() => left.h.has('环境'), `${tag} 左手：详情`)
    await left.close()

    const fold = await boot({ width: 812, height: 700, fold: { separating: true, orientation: 'vertical', left: 400, right: 412 } })
    await openSession(fold.h, '第一个会话')
    check(fold.h.has('你好，我能帮你做什么？') && fold.h.matchLabel(/^第一个会话/).length >= 1, `${tag} 折叠屏书本：列表与会话同屏`)
    await fold.h.pressLabel('打开会话详情')
    await fold.h.waitFor(() => fold.h.has('环境'), `${tag} 书本模式：详情`)
    await fold.h.pressLabel('压缩上下文')
    await fold.h.waitFor(() => fold.desk.calls.some((c) => c[0] === 'compact'), `${tag} 书本模式压缩可用`)
    await fold.close()

    const foldLeft = await boot({ width: 812, height: 700, left: true, fold: { separating: true, orientation: 'vertical', left: 400, right: 412 } })
    await openSession(foldLeft.h, '第一个会话')
    await foldLeft.h.pressLabel('打开会话详情')
    await foldLeft.h.waitFor(() => foldLeft.h.has('环境'), `${tag} 书本左手：详情`)
    await foldLeft.close()

    const table = await boot({ width: 700, height: 900, fold: { separating: true, orientation: 'horizontal', top: 450, bottom: 462 } })
    await openSession(table.h, '第一个会话')
    check(table.h.has('你好，我能帮你做什么？'), `${tag} 桌面架设：会话显示`)
    await table.close()

    const dark = await boot({ scheme: 'dark', lang: 'en-US' })
    await openSession(dark.h, '第一个会话')
    await dark.h.pressLabel('Open session details')
    await dark.h.waitFor(() => dark.h.has('Usage'), `${tag} 深色英文：详情`)
    await dark.close()
  }

  async function flowEmptyHome() {
    const tag = '[空首页]'
    const ctx = await boot({ desktop: { tweak: (_, state) => { state.sessions = []; state.projects = [] } } })
    await ctx.h.settle(300)
    check(ctx.h.has('还没有会话'), `${tag} 没有会话时的提示`)
    await ctx.close()
  }

  return [
    ['旧电脑端', flowOldDesktop],
    ['用量与更改形态', flowInsightShapes],
    ['分支面板形态', flowBranchStates],
    ['长文本 zh-CN', () => flowLongText('zh-CN')],
    ['长文本 en-US', () => flowLongText('en-US')],
    ['窗口形态', flowLayouts],
    ['空首页', flowEmptyHome]
  ]
}
