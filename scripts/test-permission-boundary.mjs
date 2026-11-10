import assert from 'node:assert/strict'
import { build } from 'esbuild'

let checks = 0
const ok = (condition, message, detail) => {
  assert.ok(condition, `${message}${detail === undefined ? '' : `: ${detail}`}`)
  checks++
}

const built = await build({
  entryPoints: ['src/main/browser/permission-boundary.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  logLevel: 'silent'
})
const mod = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const { installSessionPermissionBoundary, trustedFrameTrust, mainFrameOnly, permissionOriginKey } = mod

const session = () => {
  const handlers = {}
  return {
    handlers,
    setPermissionRequestHandler(handler) { handlers.request = handler },
    setPermissionCheckHandler(handler) { handlers.check = handler }
  }
}
const contents = (id = 7, url = 'https://app.example/index.html') => ({ id, isDestroyed: () => false, getURL: () => url })
const request = (ses, permission, options) => {
  let granted = null
  ses.handlers.request(options.contents ?? contents(), permission, (value) => { granted = value }, { requestingUrl: options.requestingUrl ?? 'https://app.example/index.html', isMainFrame: options.isMainFrame === true, ...(options.securityOrigin ? { securityOrigin: options.securityOrigin } : {}) })
  return granted
}
const check = (ses, permission, options) => {
  const details = { isMainFrame: options.isMainFrame === true, requestingUrl: options.requestingUrl ?? 'https://app.example/index.html', ...(options.securityOrigin ? { securityOrigin: options.securityOrigin } : {}) }
  return ses.handlers.check(options.contents === undefined ? contents(options.webContentsId) : options.contents, permission, options.requestingOrigin ?? 'https://app.example', details)
}

{
  const ses = session()
  installSessionPermissionBoundary(ses)
  for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-sanitized-write', 'fullscreen']) {
    ok(request(ses, permission, { isMainFrame: true }) === false, `无规则的会话默认拒绝请求：${permission}`)
    ok(check(ses, permission, { isMainFrame: true }) === false, `无规则的会话默认拒绝检查：${permission}`)
  }
}

{
  const ses = session()
  installSessionPermissionBoundary(ses, {
    allow: ['media', 'clipboard-sanitized-write'],
    trust: trustedFrameTrust({ isTrustedContents: (id) => id === 7, origins: ['https://app.example'] })
  })
  ok(request(ses, 'media', { isMainFrame: true }) === true, '可信主窗口主框架的录音请求放行')
  ok(request(ses, 'clipboard-sanitized-write', { isMainFrame: true }) === true, '可信主窗口主框架的剪贴板写入放行')
  ok(request(ses, 'media', { isMainFrame: false }) === false, '可信窗口里的不可信 iframe 录音请求被拒绝')
  ok(request(ses, 'media', { isMainFrame: true, contents: contents(8) }) === false, '其他窗口即使主框架也拒绝')
  ok(request(ses, 'media', { isMainFrame: true, requestingUrl: 'https://evil.example/index.html' }) === false, '非可信来源的主框架请求被拒绝')
  ok(request(ses, 'geolocation', { isMainFrame: true }) === false, '未列入允许清单的权限仍拒绝')
  ok(request(ses, 'media', { isMainFrame: false, contents: contents(8) }) === false, '不可信窗口的 iframe 请求被拒绝')
}

{
  const ses = session()
  installSessionPermissionBoundary(ses, {
    allow: ['media'],
    trust: trustedFrameTrust({ isTrustedContents: (id) => id === 7, origins: ['https://app.example'] })
  })
  ok(check(ses, 'media', { isMainFrame: true }) === true, '权限检查同样认可可信主框架')
  ok(check(ses, 'media', { isMainFrame: false }) === false, '权限检查拒绝不可信 iframe')
  ok(check(ses, 'media', { isMainFrame: false, contents: null }) === false, '没有 webContents 的 iframe 检查被拒绝')
  ok(check(ses, 'media', { isMainFrame: true, contents: null }) === false, '没有 webContents 的主框架检查也被拒绝')
  ok(check(ses, 'media', { isMainFrame: true, requestingOrigin: 'https://evil.example' }) === false, '不可信来源的检查被拒绝')
  ok(check(ses, 'media', { isMainFrame: true, requestingUrl: 'https://evil.example/index.html' }) === false, '请求 URL 与声明来源不一致时拒绝')
  ok(check(ses, 'media', { isMainFrame: true, securityOrigin: 'https://app.example' }) === true, 'securityOrigin 与声明一致时仍放行')
}

{
  const ses = session()
  installSessionPermissionBoundary(ses, { allow: ['media'], trust: mainFrameOnly })
  ok(request(ses, 'media', { isMainFrame: true }) === true, '只要求主框架时，可信主框架放行')
  ok(request(ses, 'media', { isMainFrame: false }) === false, '只要求主框架时，iframe 仍被拒绝')
}

{
  const ses = session()
  installSessionPermissionBoundary(ses, { allow: ['media'], trust: trustedFrameTrust({ origins: ['file://'], isTrustedContents: () => true }) })
  ok(request(ses, 'media', { isMainFrame: true, requestingUrl: 'file:///C:/app/index.html', contents: contents(9, 'file:///C:/app/index.html') }) === true, 'file:// 主窗口页面可以保留录音')
  ok(permissionOriginKey('https://App.Example:443/x') === 'https://app.example', '来源比较规范化主机与默认端口')
  ok(permissionOriginKey('file:///C:/app/index.html') === 'file://', 'file:// 页面归为同一个来源键')
  ok(permissionOriginKey('about:blank') === undefined, '非 http(s)/file 来源不参与允许清单')
}

console.log(`permission-boundary: ${checks} assertions passed (fake session, no Electron)`)
