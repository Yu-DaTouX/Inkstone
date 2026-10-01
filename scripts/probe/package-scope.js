(async () => {
  const store = window.__yanStore
  const out = []
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const check = (value, message) => {
    out.push(`${value ? '✓' : '✗'} ${message}`)
    if (!value) throw new Error(message)
  }
  const until = async predicate => {
    for (let i = 0; i < 450; i++) {
      if (await predicate()) return true
      await sleep(100)
    }
    return false
  }
  const q = id => document.querySelector(`[data-testid="${id}"]`)
  const rows = () => [...document.querySelectorAll('[data-testid="pkg-item"]')]
    .filter(row => row.querySelector('[data-testid="pkg-name"]')?.textContent === 'yan-probe-ext')
  const row = scope => rows().find(row => row.querySelector(`.pkg-scope.${scope}`))
  const setLocal = async value => {
    if (q('pkg-local').checked !== value) q('pkg-local').click()
    await sleep(100)
    check(q('pkg-local').checked === value, `安装表单作用域 ${value ? '项目级' : '用户级'}`)
  }
  const setSource = async value => {
    const input = q('pkg-source')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    check(await until(() => !q('pkg-install-btn').disabled), '来源输入可安装')
  }
  const action = async (scope, kind) => {
    row(scope).querySelector(`[data-testid="pkg-${kind}"]`).click()
    check(await until(() => row(scope)?.querySelector(`[data-testid="pkg-${kind}"]`)?.disabled), `${scope} ${kind} 已开始`)
    check(await until(() => !q('pkg-install-btn').disabled && !!q('pkg-result')), `${scope} ${kind} 返回`)
    check(q('pkg-result').classList.contains('pkg-ok'), `${scope} ${kind} 成功：${q('pkg-result').textContent}`)
  }
  try {
    const cwd = store.getState().session?.cwd ?? store.getState().settings?.cwd
    store.getState().openSettings('packages')
    check(await until(() => !!q('pkg-source')), '真实设置页已加载')
    const listing = await window.yan.packages.list(cwd)
    check(listing.agentDir.includes('yan-test-') && cwd.includes('fixture-project') && cwd.endsWith('pkgs'), '仅操作隔离插件目录')
    check((await window.yan.trust.allow(cwd)).ok === true, '隔离项目显式信任')
    const source = cwd.replace(/\\/g, '/') + '/probe-ext'
    await setLocal(false)
    await setSource(source)
    q('pkg-install-btn').click()
    check(await until(() => !!row('user')), 'UI 安装用户级本地插件')
    await setLocal(true)
    await setSource(source)
    q('pkg-install-btn').click()
    check(await until(() => !!row('project') && rows().length === 2), 'UI 安装项目级；两级均可见')
    const both = await window.yan.packages.list(cwd)
    check(both.entries.filter(e => e.name === 'yan-probe-ext').length === 2, '主进程回读两级登记')
    await setSource(source) // Keep the install button enabled for the action completion check.
    await setLocal(false)
    await action('project', 'update')
    await action('project', 'remove')
    check(!row('project') && !!row('user'), '未勾仅本项目：卸载项目级，保留用户级')
    check((await window.yan.packages.list(cwd)).entries.filter(e => e.name === 'yan-probe-ext').every(e => e.scope === 'user'), '回读确认只移除项目声明')
    await setLocal(true)
    await action('user', 'update')
    await action('user', 'remove')
    check(rows().length === 0, '勾选仅本项目：仍能卸载用户级')
    check(!(await window.yan.packages.list(cwd)).entries.some(e => e.name === 'yan-probe-ext'), '回读确认两级均已移除')
    store.getState().closeSettings()
  } catch (error) {
    out.push('✗ ' + (error?.message ?? String(error)))
    const toggle = q('pkg-detail-toggle')
    if (toggle) { toggle.click(); await sleep(150) }
    out.push(document.querySelector('.gwrite-fail-raw')?.textContent ?? '')
  }
  out.push(out.some(line => line.startsWith('✗')) ? '[packagescope] 失败' : '[packagescope] 全部通过')
  return out.join('\n')
})()
