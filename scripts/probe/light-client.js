/** 在真实 Electron 中检查旧设置兼容、精简入口和模型委派界面；不执行模型。 */
;(async () => {
  const out = []
  const ok = (value, label) => out.push(`  ${value ? '✓' : '✗'} ${label}`)
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const q = selector => document.querySelector(selector)
  const click = element => element?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  try {
    for (let i = 0; i < 60 && store.getState().conn !== 'ready'; i++) await sleep(250)
    ok(store.getState().conn === 'ready', 'pi RPC 实际就绪')
    const pi = await window.yan.piInfo()
    ok(pi.version === '1.1.0', '运行时版本为 pi 1.1.0')
    ok(Array.isArray(await window.yan.listCommands()), 'pi 命令列表 RPC 可用')
    if (/win-unpacked[\\/]/.test(pi.bin ?? '')) {
      ok(/win-unpacked[\\/]resources[\\/]pi-runtime[\\/]/.test(pi.bin), '目录包使用随包 pi，没有回退到开发目录')
      const availability = await window.yan.terminal.available()
      ok(availability.available, '目录包原生 PTY 可加载')
      if (availability.available) {
        let terminal, off
        try {
          terminal = await window.yan.terminal.start({ cols: 80, rows: 24 })
          let seen = ''
          off = window.yan.onPush(msg => { if (msg.ch === 'terminal' && msg.payload.kind === 'data' && msg.payload.id === terminal.id) seen += msg.payload.data })
          await window.yan.terminal.write(terminal.id, 'echo INKSTONE_LIGHT_PTY_OK\r\n')
          for (let i = 0; i < 48 && seen.split('INKSTONE_LIGHT_PTY_OK').length < 3; i++) await sleep(250)
          ok(seen.split('INKSTONE_LIGHT_PTY_OK').length >= 3, '目录包 PTY 真实输入输出往返')
          ok(await window.yan.terminal.resize(terminal.id, 100, 30), '目录包 PTY 可调整尺寸')
          const snapshot = await window.yan.terminal.attach(terminal.id)
          ok(snapshot.cols === 100 && snapshot.rows === 30 && snapshot.buffer.includes('INKSTONE_LIGHT_PTY_OK'), '目录包 PTY 重连快照保留输出与尺寸')
        } finally {
          off?.()
          if (terminal) ok(await window.yan.terminal.kill(terminal.id), '目录包 PTY 正常关闭')
        }
      }
    }
    localStorage.setItem('yan.onboarded', '1')
    store.setState({ settings: { ...store.getState().settings, workspaceMode: 'daily', showSpaces: true, defaultWorkMode: 'clarify', onboardingDone: true }, workspaceMode: 'daily', spaceOpen: true, inboxOpen: true, workMode: { mode: 'clarify', revision: 1 }, agentProfile: { profile: 'daily', activity: 'learn', revision: 1 } })
    await sleep(400)
    ok(!!q('.stream') && !!q('.composer-wrap'), '旧日常/空间/收件箱状态不会挡住会话')
    ok(!q('[data-testid="rail-inbox"]') && !q('[data-testid="view-space"]'), '没有收件箱与空间入口')
    ok(!q('[data-testid="learn-actions"]') && !q('[data-testid="work-mode-picker"]'), '没有学习操作与旧工作模式选择器')
    store.setState({ settingsOpen: true, settingsTab: 'workspace' })
    for (let n = 0; n < 40 && !q('[data-testid="set-auto-archive"]'); n++) await sleep(50)
    ok(!!q('[data-testid="set-auto-archive"]'), '保留会话归档设置')
    ok(!q('[data-testid="set-workspace-mode"]') && !q('[data-testid="set-show-spaces"]') && !q('[data-testid="set-space-new-name"]'), '移除工作区模式和空间管理')
    ok(!q('[data-testid="set-agent-profile"]') && !q('[data-testid="set-work-mode"]'), '移除活动与会话模式配置')
    store.setState({ settingsTab: 'appearance' }); await sleep(250)
    ok(!q('[data-testid="set-default-work-mode"]') && !q('[data-testid="set-work-mode-key"]'), '移除默认模式与模式快捷键')
    store.setState({ settingsTab: 'auth' });
    for (let n = 0; n < 40 && !q('[data-testid="cc-install-bridge"]'); n++) await sleep(50)
    ok(!!q('[data-testid="cc-install-bridge"]') && !q('[data-testid="auth-activity-models"]'), '模型页提供按需 CC 插件入口，无活动模型分配')
    store.setState({ settingsOpen: false, models: [{ id: 'child', provider: 'fixture', name: '子模型', contextWindow: 200000, reasoning: false }], session: { ...store.getState().session, sessionId: 'light-test-session', cwd: 'C:/fixture', model: { id: 'parent', provider: 'fixture', name: '主模型' } }, activeRunnerId: 'light-test-runner' })
    await sleep(250)
    window.dispatchEvent(new CustomEvent('inkstone-workspace-launch', { detail: 'agents' }))
    await sleep(500)
    ok(!!q('[data-testid="subagent-panel"]'), 'Agent 入口打开轻量子任务面板')
    q('[data-testid="delegate-model"]').click(); await sleep(200)
    ok(!!q('[data-testid="model-option"][data-model-id="child"]'), '子任务可指定不同模型')
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(100)
    ok(q('[data-testid="delegate-scope"]')?.value === 'shared-cwd', '默认当前文件夹，不强制 Git')
    ok(!q('[data-testid="agent-hub-home"]'), '默认入口不加载旧 Hub 管理首页')
    const controls = ['delegate-model', 'delegate-task', 'delegate-scope'].map(id => q(`[data-testid="${id}"]`).getBoundingClientRect())
    const panel = q('[data-testid="subagent-panel"]').getBoundingClientRect()
    ok(controls.every(rect => rect.width > 150 && rect.left >= panel.left && rect.right <= panel.right), '表单控件完整位于面板内')
    ok(controls[1].top > controls[0].bottom && controls[2].top > controls[1].bottom, '模型、任务、执行位置纵向排列且不重叠')
    // Leave the screenshot on the real delegation UI; no task or install button is pressed.
    await sleep(2600)
  } catch (error) { out.push('  ✗ light client probe: ' + String(error)) }
  return out.join('\n')
})()
