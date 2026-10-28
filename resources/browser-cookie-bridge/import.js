const code = location.hash.slice(1).match(/^(\d{1,5})\.([a-f0-9]{64})$/)
history.replaceState(null, '', location.pathname)
const syncBrowser = navigator.userAgent.includes('Edg/') ? 'edge' : 'chrome'
const statusNode = document.getElementById('status')
const failureText = {
  connection_failed: '与砚的连接中断或未收到结果，请回砚确认后重新发起导入。',
  pairing_expired: '本次配对已结束，请回砚重新发起导入。',
  read_failed: '读取 Cookie 失败，请确认扩展已获得全部网站访问权限。',
  invalid_payload: 'Cookie 数据无法解析，请更新砚和导入扩展后重试。',
  import_failed: '砚未能完成 Cookie 写入，请回砚查看结果。'
}

async function request(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${Number(code[1])}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${code[2]}`,
      'Content-Type': 'application/json',
      'X-Sync-Browser': syncBrowser,
      'X-Sync-Role': 'browser'
    },
    cache: 'no-store',
    signal: options.signal ?? AbortSignal.timeout(180_000)
  })
  if (!response.ok) throw Object.assign(new Error('Import failed'), {
    code: response.status === 409 ? 'pairing_expired' : response.status === 400 ? 'invalid_payload' : response.status >= 500 ? 'import_failed' : 'connection_failed'
  })
  return response.json()
}

async function sendSourceData() {
  let allCookies
  try { allCookies = [...await chrome.cookies.getAll({}), ...await chrome.cookies.getAll({ partitionKey: {} })] }
  catch { throw Object.assign(new Error('Cookie read failed'), { code: 'read_failed' }) }
  const cookies = [...new Map(allCookies.map(cookie => [
    JSON.stringify([cookie.name, cookie.domain, cookie.path, cookie.storeId, cookie.partitionKey?.topLevelSite, cookie.partitionKey?.hasCrossSiteAncestor]), cookie
  ])).values()]
  const transferableCookies = cookies
    .filter(cookie => !cookie.expirationDate || cookie.expirationDate > Date.now() / 1000)
    .map(cookie => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      hostOnly: cookie.hostOnly,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      session: cookie.session,
      expirationDate: cookie.expirationDate,
      partitionKey: cookie.partitionKey
    }))
  return request('/v1/source', {
    method: 'POST',
    body: JSON.stringify({ cookies: transferableCookies, history: [] })
  })
}

async function runSync() {
  if (!code || Number(code[1]) < 1 || Number(code[1]) > 65535) return
  if (parent !== window) parent.postMessage({ type: 'inkstone-import', phase: 'started' }, `http://127.0.0.1:${Number(code[1])}`)
  statusNode.textContent = '正在导入当前档案的登录 Cookie…'
  try {
    await request('/v1/status')
    const result = await sendSourceData()
    statusNode.textContent = `已导入 ${result.copied} 条 Cookie，失败 ${result.failed} 条，跳过 ${result.skipped} 条。请回到砚刷新网页；部分网站仍可能要求重新登录。`
    code[2] = ''
  } catch (error) {
    const reason = Object.hasOwn(failureText, error?.code) ? error.code : 'connection_failed'
    statusNode.textContent = failureText[reason]
    if (parent !== window) parent.postMessage({ type: 'inkstone-import', phase: 'failed', reason }, `http://127.0.0.1:${Number(code[1])}`)
    else {
      try { await request('/v1/failure', { method: 'POST', body: JSON.stringify({ reason }), signal: AbortSignal.timeout(3000) }) } catch {}
    }
  }
}

void runSync()
