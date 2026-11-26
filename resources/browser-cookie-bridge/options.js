const api = globalThis.browser ?? globalThis.chrome
const stateNode = document.getElementById('state')
const trusted = document.getElementById('trusted')
const grant = document.getElementById('grant')

async function refresh(reconnect = false) {
  let status
  try { status = await api.runtime.sendMessage({ type: 'yan-bridge-status', reconnect }) } catch { status = null }
  if (!status) {
    stateNode.textContent = '无法读取扩展状态，请重新加载扩展。'
    return
  }
  stateNode.textContent = status.connected
    ? '已连接砚。'
    : `未连接砚。请确认砚正在运行${status.lastError ? `（${status.lastError}）` : ''}。`
  trusted.hidden = !status.debuggerSupported
  grant.disabled = status.debugger
  grant.textContent = status.debugger ? '已授予调试权限' : '授予调试权限'
}

grant.addEventListener('click', async () => {
  try { await api.permissions.request({ permissions: ['debugger'] }) } catch {}
  await refresh()
})
document.getElementById('reconnect').addEventListener('click', async () => {
  await refresh(true)
  setTimeout(() => void refresh(), 1500)
})
void refresh()
