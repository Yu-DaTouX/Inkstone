const FIXTURE_PORT = 39331

function baseCandidate(overrides = {}) {
  return {
    candidateId: 'mcp-registry:acme/weather@1.2.3',
    kind: 'mcp-server',
    title: 'Acme 天气服务',
    summary: '目录里的一条远程 MCP 候选',
    discoveredAt: '2026-09-20T10:00:00.000Z',
    sourceUrls: ['https://registry.modelcontextprotocol.io/v0/servers?search=weather', 'https://mcp.acme.test/mcp'],
    requirements: [],
    auth: 'unknown',
    installKind: 'remote',
    transport: 'streamable-http',
    verification: 'metadata-only',
    ...overrides
  }
}

export async function runMcpRegistrationTests(ok, modules) {
  const { shared } = modules

  {
    const candidate = baseCandidate()
    ok(
      shared.remoteEndpointOf(candidate) === 'https://mcp.acme.test/mcp',
      '端点：从目录地址后面挑出真正的远程端点',
      String(shared.remoteEndpointOf(candidate))
    )
    ok(shared.looksLikeRegistryUrl('https://registry.npmjs.org/-/v1/search'), '端点：认得出 npm 目录地址')
    ok(
      shared.looksLikeRegistryUrl('https://registry.modelcontextprotocol.io/v0/servers'),
      '端点：认得出 MCP 目录地址'
    )
    ok(!shared.looksLikeRegistryUrl('https://mcp.acme.test/mcp'), '端点：真实端点不被当成目录地址')
    ok(
      shared.remoteEndpointOf(baseCandidate({ sourceUrls: ['https://registry.npmjs.org/-/v1/search?text=x'] })) === null,
      '端点：只有目录地址时如实返回空（不编造端点）'
    )
  }

  {
    const a = shared.mcpServerIdOf('mcp-registry:acme/weather@1.2.3', 'https://mcp.acme.test/mcp')
    const b = shared.mcpServerIdOf('mcp-registry:acme/weather@1.2.3', 'https://mcp.acme.test/mcp')
    ok(a === b, '服务 ID：同一候选 + 同一端点得到同一个 ID（幂等）', a)
    ok(a.startsWith('acme-weather-') || a.startsWith('acme-weather'), '服务 ID：保留可读的发布者 / 名字部分', a)
    const other = shared.mcpServerIdOf('mcp-registry:other/weather@1.0.0', 'https://mcp.acme.test/mcp')
    ok(a !== other, '服务 ID：同名不同来源不撞车', `${a} vs ${other}`)
    const evil = shared.mcpServerIdOf('mcp-registry:../../etc/passwd@1', 'https://x.test/mcp')
    ok(!/[\\/]/.test(evil) && !evil.includes('..'), '服务 ID：路径分隔与 `..` 被清洗掉', evil)
  }

  {
    const https = shared.draftRemoteMcpRegistration(baseCandidate())
    ok(https.ok, '草案：https 外部端点通过', https.ok ? '' : https.detail)
    if (https.ok) {
      ok(https.draft.config.transport === 'http', '草案：远程候选映射成 http 传输')
      ok(https.draft.config.effect === 'unknown', '草案：effect 不由目录自报（一律 unknown，最保守）')
      ok(https.draft.config.enabled === true, '草案：登记后默认启用')
      ok(https.draft.host === 'mcp.acme.test', '草案：host 不含 scheme', https.draft.host)
      ok(
        https.draft.warnings.some((w) => w.includes('metadata-only')),
        '草案：如实带上「目录只是线索」的边界说明'
      )
    }

    const insecure = shared.draftRemoteMcpRegistration(
      baseCandidate({ sourceUrls: ['https://registry.modelcontextprotocol.io/x', 'http://mcp.acme.test/mcp'] })
    )
    ok(!insecure.ok && insecure.code === 'insecure-transport', '草案：非 loopback 的明文 http 被拒', insecure.code)

    const loopback = shared.draftRemoteMcpRegistration(
      baseCandidate({ sourceUrls: ['https://registry.modelcontextprotocol.io/x', `http://127.0.0.1:${FIXTURE_PORT}/mcp`] })
    )
    ok(loopback.ok, '草案：loopback 上的明文 http 放行（本机 fixture / 本地服务）', loopback.ok ? '' : loopback.detail)
    if (loopback.ok) {
      ok(
        loopback.draft.warnings.some((w) => w.includes('明文')),
        '草案：loopback 明文也如实警告'
      )
    }

    const creds = shared.draftRemoteMcpRegistration(
      baseCandidate({ sourceUrls: ['https://registry.modelcontextprotocol.io/x', 'https://u:p@mcp.acme.test/mcp'] })
    )
    ok(!creds.ok && creds.code === 'credentials-in-url', '草案：URL 里带凭证被拒（凭证不进配置文件）', creds.code)

    const ftp = shared.draftRemoteMcpRegistration(
      baseCandidate({ sourceUrls: ['https://registry.modelcontextprotocol.io/x', 'ftp://mcp.acme.test/mcp'] })
    )
    ok(!ftp.ok && ftp.code === 'missing-url', '草案：非 http(s) 端点不算端点', ftp.code)

    const noUrl = shared.draftRemoteMcpRegistration(
      baseCandidate({ sourceUrls: ['https://registry.modelcontextprotocol.io/v0/servers?search=x'] })
    )
    ok(!noUrl.ok && noUrl.code === 'missing-url', '草案：没有端点时如实报 missing-url', noUrl.code)

    const localPkg = shared.draftRemoteMcpRegistration(baseCandidate({ installKind: 'mcp-package' }))
    ok(!localPkg.ok && localPkg.code === 'not-remote', '草案：本地包不走远程登记分支', localPkg.code)
  }

  {
    const auth = { host: 'mcp.acme.test', at: '2026-09-20T10:00:00.000Z', via: 'test' }
    ok(shared.authorizationCovers([auth], 'https://mcp.acme.test/mcp'), '授权：同 host 命中')
    ok(!shared.authorizationCovers([auth], 'https://mcp.acme.test:8443/mcp'), '授权：端口不同不算同一个 host')
    ok(!shared.authorizationCovers([auth], 'https://evil.test/mcp'), '授权：不同 host 不命中')
    ok(!shared.authorizationCovers([], 'https://mcp.acme.test/mcp'), '授权：没有授权记录时不放行')
    const scoped = { ...auth, projectId: 'p1' }
    ok(shared.authorizationCovers([scoped], 'https://mcp.acme.test/mcp', 'p1'), '授权：同项目命中')
    ok(!shared.authorizationCovers([scoped], 'https://mcp.acme.test/mcp', 'p2'), '授权：跨项目不命中（项目隔离）')
    ok(!shared.authorizationCovers([scoped], 'https://mcp.acme.test/mcp'), '授权：项目级授权不覆盖没有项目身份的请求')
    const added = shared.addAuthorization([auth], { ...auth, at: '2026-09-20T11:00:00.000Z' })
    ok(added.length === 1 && added[0].at === '2026-09-20T11:00:00.000Z', '授权：同 host 重复授权只保留最新一条')
    ok(shared.authorizationHostOf('https://mcp.acme.test/mcp') === 'mcp.acme.test', '授权：从 URL 取 host 做比对键')
    ok(shared.authorizationHostOf('not a url') === null, '授权：非法 URL 返回 null 而不是抛')
  }
}
