/**
 * L04 网络边界判定（`src/main/browser/network-boundary.ts`）。
 *
 * 为什么值得单独测：这段逻辑决定「远程页面能不能借道访问本机服务」。
 * 以前它写在 `webRequest.onBeforeRequest` 回调里，判错的代价是**安全边界漏了**
 * 或者**本地预览被误杀**，而两者都只能靠真窗口碰运气发现。
 *
 * 这里钉住的核心是那条**发起方**语义：拿已提交文档判，且只有
 * 「用户/agent 明确要求的顶层导航」才放行内网地址。
 *（2026-09-16 实测过反例：以前用导航**目标**当发起方，于是
 * 远程页面 → 127.0.0.1 的顶层导航被放过 —— 见 live 场景 `browserboundary`。）
 */
export function runNetworkBoundaryTests(ok, mod) {
  const { decideRequestBoundary, isPrivateHost, isLinkLocalHost: isLinkLocal } = mod

  /* ---- isPrivateHost：地址判断本身 ---- */
  ok(isPrivateHost('127.0.0.1'), '本机回环算内网')
  ok(isPrivateHost('localhost'), 'localhost 算内网')
  ok(isPrivateHost('app.localhost'), '*.localhost 算内网')
  ok(isPrivateHost('192.168.1.9'), 'RFC1918 算内网')
  ok(isPrivateHost('fd00::1'), 'IPv6 ULA 算内网')
  ok(!isPrivateHost('example.com'), '普通域名不算内网')
  ok(!isPrivateHost('127-0-0-1.sslip.io'), '域名里带 127 但形状是域名时**不算**内网（要交给 DNS 判定）')

  const decide = (o) => decideRequestBoundary(o)

  /* ---- 放行：拿不到已提交文档 / 发起方本来就是本地页面 ---- */
  ok(
    decide({ targetHost: '127.0.0.1', initiatorUrl: '', requestedByUs: false }) === 'allow',
    '新标签第一次导航（没有已提交文档）放行 —— 宁可少拦也不误杀'
  )
  ok(
    decide({ targetHost: '10.0.0.5', initiatorUrl: 'http://localhost:5173/', requestedByUs: false }) === 'allow',
    '本地页面访问内网地址放行（本地预览）'
  )

  /* ---- 明确要求的顶层导航：放行；其余一律拦 ---- */
  ok(
    decide({
      targetHost: '127.0.0.1',
      initiatorUrl: 'https://example.com/',
      requestedByUs: true,
      resourceType: 'mainFrame'
    }) === 'allow',
    '用户/agent 明确打开本机地址的顶层导航放行（本地预览从远程页面也能用）'
  )
  ok(
    decide({
      targetHost: '127.0.0.1',
      initiatorUrl: 'https://example.com/',
      requestedByUs: true,
      resourceType: 'subFrame'
    }) === 'block-private',
    '同一地址但只是子框架请求 → 拦（只有顶层导航才算“明确要求”）'
  )
  ok(
    decide({
      targetHost: '127.0.0.1',
      initiatorUrl: 'https://example.com/',
      requestedByUs: false,
      resourceType: 'mainFrame'
    }) === 'block-private',
    '远程页面自己发起的顶层导航到本机 → 拦（这正是借道攻击的形状）'
  )
  ok(
    decide({
      targetHost: '192.168.0.10',
      initiatorUrl: 'https://example.com/',
      requestedByUs: false,
      resourceType: 'xhr'
    }) === 'block-private',
    '远程页面的 XHR 打到内网 → 拦'
  )
  ok(
    decide({
      targetHost: '169.254.169.254',
      initiatorUrl: 'https://example.com/',
      requestedByUs: true,
      resourceType: 'mainFrame'
    }) === 'block-private',
    '明确要求也不放行云 metadata 地址（link-local 与“谁发起的”无关）'
  )
  ok(
    decide({
      targetHost: '169.254.169.254',
      initiatorUrl: 'http://localhost:5173/',
      requestedByUs: true,
      resourceType: 'mainFrame'
    }) === 'block-private',
    '连本地页面发起的 link-local 请求也拦（本地预览没有这种需求）'
  )
  ok(
    decide({
      targetHost: 'myapp.localhost',
      initiatorUrl: 'https://example.com/',
      requestedByUs: true,
      resourceType: 'mainFrame'
    }) === 'allow',
    '*.localhost 属于本地预览命名：明确要求时放行'
  )
  ok(
    decide({
      targetHost: 'myapp.localhost',
      initiatorUrl: 'https://example.com/',
      requestedByUs: false,
      resourceType: 'xhr'
    }) === 'block-private',
    '*.localhost 被页面自己拿去发请求时 → 拦'
  )
  ok(isLinkLocal('fe80::1'), 'IPv6 link-local 被识别')
  ok(!isLinkLocal('169.255.0.1'), '相邻的公网段不被误判为 link-local')

  /* ---- 公网目标：交给 DNS 判定，不在这一步拦 ---- */
  ok(
    decide({
      targetHost: 'example.com',
      initiatorUrl: 'https://other.example/',
      requestedByUs: false,
      resourceType: 'image'
    }) === 'check-dns',
    '公网目标进入 DNS 判定分支（域名可能解析到内网）'
  )
  ok(
    decide({
      targetHost: '127-0-0-1.sslip.io',
      initiatorUrl: 'https://example.com/',
      requestedByUs: false,
      resourceType: 'mainFrame'
    }) === 'check-dns',
    '「看起来是公网、实际解析到本机」的域名必须走 DNS 判定（DNS 重绑定）'
  )
  ok(
    decide({
      targetHost: '127-0-0-1.sslip.io',
      initiatorUrl: 'https://example.com/',
      requestedByUs: true,
      resourceType: 'mainFrame'
    }) === 'check-dns',
    'DNS 重绑定的判定**不看**“是不是我们发起的” —— 不能给 agent 留读本机服务的原语'
  )
}
