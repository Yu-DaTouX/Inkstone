;(async () => {
  const store = window.__yanStore
  const before = store.getState()
  const out = []
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  const check = (value, label) => out.push(`  ${value ? '✓' : '✗'} ${label}`)
  const diagnostics = label => out.push('  ' + label + '=' + JSON.stringify([...document.querySelectorAll('.msg.assistant .md')].map(el => ({text: el.textContent, html: el.innerHTML}))))
  const user = {id: 'arrival-user', role: 'user', text: 'Arrival fixture'}
  let text = 'First paragraph.'
  const seed = running => store.setState({
    messages: [user, {id: 'arrival-assistant', role: 'assistant', text}],
    session: {...before.session, isStreaming: running, isAgentRunning: running},
    runTail: null
  })
  try {
    seed(true)
    await pause(400)
    diagnostics('initial')
    check(!document.querySelector('.md-arrive'), '初挂已有正文不补播')
    text += '\n\nSecond paragraph begins.'
    seed(true)
    await pause(300)
    diagnostics('appended')
    check([...document.querySelectorAll('.md p')].some(el => el.textContent === 'Second paragraph begins.'), '真实增量立即进入正文，不人为逐字延迟')
    check(!!document.querySelector('.md-arrive'), '原生结构新增的顶层块挂入场类')
    check(!document.querySelector('.md-arrive .md-arrive'), '根级标记避免嵌套动画')
    const paragraph = [...document.querySelectorAll('.md p')].find(el => el.textContent === 'Second paragraph begins.')
    text += ' Further tokens.'
    seed(true)
    await pause(200)
    check(!!paragraph && paragraph === [...document.querySelectorAll('.md p')].find(el => el.textContent?.includes('Second paragraph')), '同一块 token 更新保留 DOM 身份')
    seed(false)
    await pause(100)
    check(!document.querySelector('.md-arrive'), '输出结束的历史正文不动画')
  } catch (error) { out.push('  ✗ ' + String(error)) }
  finally { store.setState({messages: before.messages, session: before.session, runTail: before.runTail}) }
  return out.join('\n')
})()
