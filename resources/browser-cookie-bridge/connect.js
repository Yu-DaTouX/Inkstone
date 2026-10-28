const code = location.hash.slice(1)
history.replaceState(null, '', location.pathname)
const statusNode = document.getElementById('status')
const frame = document.getElementById('bridge')
let installed = false
let connectionTimer
window.addEventListener('message', event => {
  if (event.origin !== 'chrome-extension://lbceoiahmfjmmlpmndopbliceoalblcc' || event.source !== frame.contentWindow || event.data?.type !== 'inkstone-import') return
  installed = true
  frame.hidden = false
  document.getElementById('setup').hidden = true
  statusNode.textContent = ''
  if (event.data.phase === 'failed' && ['connection_failed', 'pairing_expired', 'read_failed', 'invalid_payload', 'import_failed'].includes(event.data.reason)) {
    void request('/v1/failure', 'POST', { reason: event.data.reason }).catch(() => {
      statusNode.textContent = '未能同步导入结果，请回到砚确认状态后重试。'
    })
  }
})

async function request(path, method = 'GET', body) {
  const token = code.match(/^\d{1,5}\.([a-f0-9]{64})$/)?.[1]
  if (!token) throw new Error()
  const response = await fetch(path, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' })
  if (!response.ok) throw new Error()
  return response.json()
}

function connect() {
  installed = false
  frame.hidden = true
  statusNode.textContent = '正在连接导入扩展…'
  clearTimeout(connectionTimer)
  frame.src = `chrome-extension://lbceoiahmfjmmlpmndopbliceoalblcc/import.html?v=1.0.1#${code}`
  connectionTimer = setTimeout(() => {
    if (installed) return
    document.getElementById('setup').hidden = false
    statusNode.textContent = '尚未连接到扩展。请先安装或启用扩展，再点击「已安装，继续导入」。'
  }, 3000)
}

document.getElementById('folder').addEventListener('click', async () => {
  try { await request('/v1/show-extension', 'POST') } catch { statusNode.textContent = '配对已结束，请回到砚重试。' }
})
document.getElementById('retry').addEventListener('click', connect)

request('/v1/setup').then(info => {
  document.getElementById('path').textContent = info.extensionPath
  connect()
}).catch(() => { statusNode.textContent = '配对已结束，请回到砚点击「一键导入登录态」。' })
