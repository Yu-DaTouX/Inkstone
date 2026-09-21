/**
 * 远程 MCP 登记（`src/shared/mcp-registration.ts` + `src/main/capabilities/registration-service.ts`，实施-04 S6b-1）。
 *
 * 这一片能验的是三件事：
 *   ① **判断**（端点是不是安全、ID 会不会撞、授权覆盖了没有）—— 纯逻辑，直接构造候选；
 *   ② **真文件**（核验失败时配置一个字节都不写、登记后受管记录与授权落盘、原始条目不被改写）；
 *   ③ **真协议**（起一个真的 Streamable HTTP MCP fixture，让默认 probe 走一次官方 SDK 握手 + tools/list）。
 * 下载器 / `pi install` 是 S6b 后续片，这里一行都不碰。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 与 `mcp-http-fixture.mjs` 的默认端口区分开：单测和 live 可能同时跑。 */
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

function startFixture(port) {
  const child = spawn(process.execPath, ['scripts/lib/mcp-http-fixture.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, YAN_MCP_HTTP_PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe']
  })
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      rejectPromise(new Error('MCP HTTP fixture 10s 内没起来'))
    }, 10_000)
    child.stderr.on('data', (chunk) => {
      if (settled) return
      if (String(chunk).includes('listening')) {
        settled = true
        clearTimeout(timer)
        resolvePromise(child)
      }
    })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectPromise(new Error(`MCP HTTP fixture 提前退出（code=${code}）`))
    })
  })
}

export async function runMcpRegistrationTests(ok, modules) {
  const { shared, service } = modules
  const { McpRegistrationService } = service

  /* ------------------------------------------------- 1. 端点选取（纯逻辑） */

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

  /* ------------------------------------------------------ 2. 服务 ID（纯逻辑） */

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

  /* ------------------------------------------------ 3. 配置草案边界（纯逻辑） */

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

  /* ---------------------------------------------------- 4. 授权匹配（纯逻辑） */

  {
    const auth = { host: 'mcp.acme.test', at: '2026-09-20T10:00:00.000Z', via: 'test' }
    ok(shared.authorizationCovers([auth], 'https://mcp.acme.test/mcp'), '授权：同 host 命中')
    ok(!shared.authorizationCovers([auth], 'https://mcp.acme.test:8443/mcp'), '授权：端口不同不算同一个 host')
    ok(!shared.authorizationCovers([auth], 'https://evil.test/mcp'), '授权：不同 host 不命中')
    ok(!shared.authorizationCovers([], 'https://mcp.acme.test/mcp'), '授权：没有授权记录时不放行')
    const scoped = { ...auth, projectId: 'p1' }
    ok(shared.authorizationCovers([scoped], 'https://mcp.acme.test/mcp', 'p1'), '授权：同项目命中')
    ok(!shared.authorizationCovers([scoped], 'https://mcp.acme.test/mcp', 'p2'), '授权：跨项目不命中（项目隔离）')
    const added = shared.addAuthorization([auth], { ...auth, at: '2026-09-20T11:00:00.000Z' })
    ok(added.length === 1 && added[0].at === '2026-09-20T11:00:00.000Z', '授权：同 host 重复授权只保留最新一条')
    ok(shared.authorizationHostOf('https://mcp.acme.test/mcp') === 'mcp.acme.test', '授权：从 URL 取 host 做比对键')
    ok(shared.authorizationHostOf('not a url') === null, '授权：非法 URL 返回 null 而不是抛')
  }

  /* ------------------------------------------- 5. 真文件：登记 / 核验 / 复核 */

  {
    const root = await mkdtemp(join(tmpdir(), 'yan-mcpreg-'))
    const configFile = join(root, 'mcp-servers.json')
    const env = { ...process.env, YAN_MCP_SERVERS_FILE: configFile }
    const draft = shared.draftRemoteMcpRegistration(baseCandidate({ sourceUrls: ['https://registry.modelcontextprotocol.io/x', 'https://mcp.acme.test/mcp'] }))
    ok(draft.ok, '真文件：准备一份 https 草案')

    /* 5.1 核验失败 → 一个字节都不写 */
    {
      const failing = new McpRegistrationService({
        root,
        env,
        probe: async () => {
          throw new Error('ECONNREFUSED 连不上')
        }
      })
      let failed = false
      let code = ''
      try {
        await failing.registerRemote({ draft: draft.draft, projectId: 'p1', operationId: 'op-fail' })
      } catch (error) {
        failed = true
        code = error.code
      }
      ok(failed && code === 'endpoint-unreachable', '真文件：核验失败报 endpoint-unreachable', code)
      ok(!existsSync(configFile), '真文件：核验失败时配置文件没有被创建（登记不是「写了再说」）')
    }

    /* 5.2 成功路径：核验 → 写配置 → 写受管记录 */
    {
      const svc = new McpRegistrationService({
        root,
        env,
        probe: async (config) => {
          ok(config.url === 'https://mcp.acme.test/mcp', '真文件：probe 拿到的就是待登记端点', String(config.url))
          return { tools: ['weather.now', 'weather.forecast'] }
        }
      })
      const outcome = await svc.registerRemote({
        draft: draft.draft,
        projectId: 'p1',
        operationId: 'op-1',
        at: '2026-09-20T10:00:00.000Z'
      })
      ok(outcome.tools.length === 2, '真文件：登记结果带回 probe 真的列到的工具')
      const written = JSON.parse(await readFile(configFile, 'utf8'))
      ok(Array.isArray(written) && written.length === 1, '真文件：配置写成了数组且只有一条')
      ok(written[0].url === 'https://mcp.acme.test/mcp', '真文件：配置里的端点是草案那个')
      ok(written[0].effect === 'unknown', '真文件：配置里 effect 是 unknown（不采信目录自报）')

      const managed = await svc.listManaged()
      ok(managed.length === 1 && managed[0].serverId === outcome.serverId, '真文件：受管登记记录写下 serverId')
      ok(managed[0].operationId === 'op-1', '真文件：受管记录带着 operationId（卸载只删本次）')
      ok(managed[0].tools.join(',') === 'weather.now,weather.forecast', '真文件：受管记录留下登记时的工具表')

      /* 5.3 授权存储：写读一致 + 幂等 */
      await svc.authorize({ url: 'https://mcp.acme.test/mcp', via: 'test', projectId: 'p1', at: '2026-09-20T10:00:00.000Z' })
      await svc.authorize({ url: 'https://mcp.acme.test/mcp', via: 'test', projectId: 'p1', at: '2026-09-20T11:00:00.000Z' })
      const auths = await svc.listAuthorizations()
      ok(auths.length === 1, '真文件：同 host 授权幂等（不堆重复记录）')
      ok(await svc.isAuthorized('https://mcp.acme.test/mcp', 'p1'), '真文件：授权写盘后能读回命中')
      ok(!(await svc.isAuthorized('https://mcp.acme.test/mcp', 'p2')), '真文件：授权按项目隔离')

      /* 5.4 复核：端点被换 / 工具变少都要能被发现 */
      ok((await svc.reverify(managed[0])).ok, '真文件：复核通过（端点一致 + 工具仍在）')
      const fewer = new McpRegistrationService({ root, env, probe: async () => ({ tools: ['weather.now'] }) })
      const fewerCheck = await fewer.reverify(managed[0])
      ok(!fewerCheck.ok && fewerCheck.reasons.join('；').includes('weather.forecast'), '真文件：工具变少时复核不放行', fewerCheck.reasons.join('；'))
      await writeFile(
        configFile,
        JSON.stringify([{ ...written[0], url: 'https://evil.test/mcp' }], null, 2),
        'utf8'
      )
      const swapped = await svc.reverify(managed[0])
      ok(!swapped.ok && swapped.reasons.join('；').includes('端点已被改'), '真文件：端点在配置里被换掉时复核不放行', swapped.reasons.join('；'))
    }

    /* 5.5 手写条目与 { servers: [...] } 形态都不能被改写 */
    {
      const root2 = await mkdtemp(join(tmpdir(), 'yan-mcpreg2-'))
      const configFile2 = join(root2, 'mcp-servers.json')
      const env2 = { ...process.env, YAN_MCP_SERVERS_FILE: configFile2 }
      await writeFile(
        configFile2,
        JSON.stringify(
          { servers: [{ id: 'handwritten', transport: 'http', url: 'https://hand.test/mcp', note: '用户手写' }] },
          null,
          2
        ),
        'utf8'
      )
      const svc = new McpRegistrationService({ root: root2, env: env2, probe: async () => ({ tools: ['x'] }) })
      const draft2 = shared.draftRemoteMcpRegistration(baseCandidate())
      await svc.registerRemote({ draft: draft2.draft, projectId: 'p1', operationId: 'op-2' })
      const after = JSON.parse(await readFile(configFile2, 'utf8'))
      ok(Array.isArray(after.servers) && after.servers.length === 2, '真文件：{ servers: [...] } 形态被保留（不改成裸数组）')
      ok(
        after.servers[0].id === 'handwritten' && after.servers[0].note === '用户手写',
        '真文件：用户手写条目原样保留（不因为解析就丢掉未知字段）'
      )
      ok(after.servers[1].id === draft2.draft.serverId, '真文件：新条目追加在后面')
    }

    /* 5.6 同名不同端点：拒绝覆盖 */
    {
      const root3 = await mkdtemp(join(tmpdir(), 'yan-mcpreg3-'))
      const configFile3 = join(root3, 'mcp-servers.json')
      const env3 = { ...process.env, YAN_MCP_SERVERS_FILE: configFile3 }
      const draft3 = shared.draftRemoteMcpRegistration(baseCandidate())
      await writeFile(
        configFile3,
        JSON.stringify([{ id: draft3.draft.serverId, transport: 'http', url: 'https://other.test/mcp' }], null, 2),
        'utf8'
      )
      const svc = new McpRegistrationService({ root: root3, env: env3, probe: async () => ({ tools: ['x'] }) })
      let conflict = ''
      try {
        await svc.registerRemote({ draft: draft3.draft, projectId: 'p1', operationId: 'op-3' })
      } catch (error) {
        conflict = error.code
      }
      ok(conflict === 'server-id-conflict', '真文件：同名服务端点不同时拒绝覆盖', conflict)
      const kept = JSON.parse(await readFile(configFile3, 'utf8'))
      ok(kept[0].url === 'https://other.test/mcp', '真文件：拒绝后原有配置一个字没变')
    }

    await rm(root, { recursive: true, force: true })
    await rm(join(tmpdir(), 'yan-mcpreg2-'), { recursive: true, force: true })
    await rm(join(tmpdir(), 'yan-mcpreg3-'), { recursive: true, force: true })
  }

  /* -------------------------------- 6. 本地 stdio：项目范围登记 / 复核 / 冲突 */

  {
    const root = await mkdtemp(join(tmpdir(), 'yan-mcpreg-stdio-'))
    const configFile = join(root, 'mcp-servers.json')
    const env = { ...process.env, YAN_MCP_SERVERS_FILE: configFile }
    const config = {
      id: 'local-fixture',
      transport: 'stdio',
      command: process.execPath,
      args: ['fixture.mjs'],
      projectScope: 'project-a',
      effect: 'network',
      enabled: false
    }
    let probeCalls = 0
    const svc = new McpRegistrationService({
      root,
      env,
      probe: async (received) => {
        const isRegistrationProbe = probeCalls++ === 0
        ok(received.transport === 'stdio', 'stdio：登记前强制使用 stdio 传输')
        ok(received.projectScope === 'project-a', 'stdio：登记前强制绑定当前项目')
        if (isRegistrationProbe) {
          ok(received.effect === 'unknown', 'stdio：登记前覆盖 effect 安全默认值', String(received.effect))
          ok(received.enabled === true, 'stdio：登记前覆盖 enabled 安全默认值', String(received.enabled))
        }
        return { tools: ['local.echo'] }
      }
    })
    const outcome = await svc.registerStdio({ config, projectId: 'project-a', operationId: 'op-stdio' })
    ok(outcome.serverId === 'local-fixture', 'stdio：登记结果保留稳定 serverId')
    const written = JSON.parse(await readFile(configFile, 'utf8'))
    ok(written[0].transport === 'stdio' && written[0].projectScope === 'project-a', 'stdio：配置按项目范围写入')
    ok(written[0].effect === 'unknown' && written[0].enabled === true, 'stdio：配置不采信调用方的 effect / enabled')
    const managed = await svc.listManaged()
    ok(managed[0].transport === 'stdio' && managed[0].endpoint === 'stdio://local-fixture', 'stdio：受管记录标明本地传输与端点')
    ok((await svc.reverify(managed[0])).ok, 'stdio：复核会重新读取项目范围配置并通过 probe')

    const same = await svc.registerStdio({ config, projectId: 'project-a', operationId: 'op-stdio-replay' })
    ok(same.serverId === 'local-fixture', 'stdio：同配置重放保持幂等')

    let conflict = ''
    try {
      await svc.registerStdio({
        config: { ...config, args: ['different-fixture.mjs'] },
        projectId: 'project-a',
        operationId: 'op-stdio-conflict'
      })
    } catch (error) {
      conflict = error.code
    }
    ok(conflict === 'server-id-conflict', 'stdio：同名不同命令拒绝覆盖', conflict)
    await rm(root, { recursive: true, force: true })
  }

  /* ------------------------------- 7. 真协议：默认 probe 真的握手 + tools/list */

  {
    let fixture
    try {
      fixture = await startFixture(FIXTURE_PORT)
      const root = await mkdtemp(join(tmpdir(), 'yan-mcpreg-http-'))
      const configFile = join(root, 'mcp-servers.json')
      const env = { ...process.env, YAN_MCP_SERVERS_FILE: configFile }
      const candidate = baseCandidate({
        candidateId: `mcp-registry:yan/fixture@1.0.0`,
        sourceUrls: ['https://registry.modelcontextprotocol.io/v0/servers?search=fixture', `http://127.0.0.1:${FIXTURE_PORT}/mcp`]
      })
      const draft = shared.draftRemoteMcpRegistration(candidate)
      ok(draft.ok, '真协议：loopback fixture 草案通过', draft.ok ? '' : draft.detail)
      const svc = new McpRegistrationService({ root, env })
      const outcome = await svc.registerRemote({ draft: draft.draft, projectId: 'p1', operationId: 'op-http' })
      ok(
        outcome.tools.includes('echo') && outcome.tools.includes('boom'),
        '真协议：默认 probe 真的连上并列出 fixture 的工具',
        outcome.tools.join(', ')
      )
      const managed = await svc.listManaged()
      ok((await svc.reverify(managed[0])).ok, '真协议：复核再连一次仍然通过')
      await rm(root, { recursive: true, force: true })
    } catch (error) {
      ok(false, '真协议：HTTP fixture 路径跑通', error instanceof Error ? error.message : String(error))
    } finally {
      fixture?.kill()
    }
  }
}
