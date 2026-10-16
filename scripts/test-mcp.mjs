export async function runMcpTests(ok, modules) {
  const mcp = modules.mcp
  const config = modules.config
  const managerMod = modules.manager
  const toolService = modules.toolService

  const { mkdtemp, readFile, writeFile, rm, stat } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join, resolve } = await import('node:path')

  const root = await mkdtemp(join(tmpdir(), 'yan-mcp-'))
  const fixture = resolve('scripts/lib/mcp-stdio-fixture.mjs')

  {
    ok(mcp.mcpToolCapabilityId('srv', 'echo') === 'mcp:srv/echo', 'ID：serverId + toolName')
    ok(
      mcp.mcpToolCapabilityId('a', 'echo') !== mcp.mcpToolCapabilityId('b', 'echo'),
      'ID：两家服务的同名工具**不会**被合并（§4 硬要求）'
    )
    const parsed = mcp.parseMcpToolId('mcp:srv/tools/echo')
    ok(parsed && parsed.serverId === 'srv' && parsed.toolName === 'tools/echo', 'ID：工具名里允许 `/`')
    ok(mcp.parseMcpToolId('skill:x') === null, 'ID：非 mcp 前缀反解为 null')
    ok(mcp.parseMcpToolId('mcp:srv') === null, 'ID：缺少工具名反解为 null')
  }

  {
    const schema = {
      type: 'object',
      properties: { text: { type: 'string' }, n: { type: 'integer' } },
      required: ['text']
    }
    ok(mcp.checkToolArguments(schema, { text: 'a' }).ok, '参数：合法输入通过')
    const missing = mcp.checkToolArguments(schema, {})
    ok(!missing.ok && missing.missing.includes('text'), '参数：漏必填被指出')
    const wrong = mcp.checkToolArguments(schema, { text: 'a', n: '1' })
    ok(!wrong.ok && wrong.typeErrors.length === 1, '参数：类型不符被指出')
    ok(mcp.checkToolArguments(schema, { text: 'a', n: 3 }).ok, '参数：integer 接受 JS number')
    ok(mcp.checkToolArguments(null, {}).ok, '参数：没有 schema 时不做判断（放行）')
  }

  {
    const a = mcp.schemaRevisionOf({ type: 'object', properties: { x: { type: 'string' } } })
    const b = mcp.schemaRevisionOf({ properties: { x: { type: 'string' } }, type: 'object' })
    ok(a === b, 'schema 指纹：键序不影响（否则换个字段顺序就误报「schema 变了」）')
    const c = mcp.schemaRevisionOf({ type: 'object', properties: { x: { type: 'number' } } })
    ok(a !== c, 'schema 指纹：定义变化会变')
    ok(a === mcp.schemaRevisionOf({ type: 'object', properties: { x: { type: 'string' } } }), 'schema 指纹：稳定')
  }

  {
    const okResult = mcp.classifyMcpResult({ content: [{ type: 'text', text: 'hi' }] })
    ok(!okResult.toolError && okResult.text === 'hi', '结果：正常文本')
    const bad = mcp.classifyMcpResult({ isError: true, content: [{ type: 'text', text: 'boom' }] })
    ok(bad.toolError && bad.text === 'boom', '结果：工具级错误被识别（与协议错误分开）')
    const rich = mcp.classifyMcpResult({
      content: [{ type: 'text', text: 'x' }, { type: 'image', mimeType: 'image/png' }, { type: 'resource' }]
    })
    ok(/x/.test(rich.text) && /图片/.test(rich.text) && /资源/.test(rich.text), '结果：多类型内容都被表达')
  }

  {
    const file = join(root, 'cfg.json')
    await writeFile(
      file,
      JSON.stringify({
        servers: [
          { id: 'ok', transport: 'stdio', command: process.execPath, args: [fixture] },
          { id: 'ok', transport: 'stdio', command: 'dup' },
          { id: 'bad', transport: 'stdio' },
          { id: 'nope', transport: 'ftp' }
        ]
      }),
      'utf8'
    )
    const loaded = config.loadMcpServers({ YAN_MCP_SERVERS_FILE: file })
    ok(loaded.servers.length === 1 && loaded.servers[0].id === 'ok', '配置：坏条目被跳过')
    ok(Boolean(loaded.error) && /重复的服务 id/.test(loaded.error), '配置：重复 id 被指出（不静默）')
    ok(/transport 必须是/.test(String(loaded.error)) && /stdio 必须有 command/.test(String(loaded.error)), '配置：每条毛病都写清楚')

    const coercionFile = join(root, 'coercion.json')
    await writeFile(coercionFile, JSON.stringify({ servers: [{ id: 'coerce', transport: 'stdio', command: 'node', args: [8080, true], env: { PORT: 8080 } }] }))
    const coerced = config.loadMcpServers({ YAN_MCP_SERVERS_FILE: coercionFile })
    ok(coerced.servers[0].args?.join(',') === '8080,true' && coerced.servers[0].env?.PORT === '8080', '配置：数字和布尔参数 / 环境变量显式转字符串')

    const scoped = config.mcpServersForProject(
      [
        { id: 'global', transport: 'stdio', command: process.execPath },
        { id: 'alpha', transport: 'stdio', command: process.execPath, projectScope: 'project-alpha' },
        { id: 'beta', transport: 'stdio', command: process.execPath, projectScope: 'project-beta' }
      ],
      'project-alpha'
    )
    ok(scoped.map((server) => server.id).join(',') === 'global,alpha', '项目隔离：runner 只拿到全局服务与本项目服务')
    ok(
      config.mcpServersForProject(
        [
          { id: 'global', transport: 'stdio', command: process.execPath },
          { id: 'private', transport: 'stdio', command: process.execPath, projectScope: 'project-alpha' }
        ],
        undefined
      ).map((server) => server.id).join(',') === 'global',
      '项目隔离：缺少项目身份时私有服务 fail-closed'
    )

    const missing = config.loadMcpServers({ YAN_MCP_SERVERS_FILE: join(root, 'nope.json') })
    ok(missing.servers.length === 0 && !missing.error, '配置：文件不存在时是「没有服务」，不是错误')

    const broken = join(root, 'broken.json')
    await writeFile(broken, '{ not json', 'utf8')
    const brokenLoaded = config.loadMcpServers({ YAN_MCP_SERVERS_FILE: broken })
    ok(Boolean(brokenLoaded.error), '配置：脏 JSON 报可读错误（不静默当空）')
  }

  {
    ok(toolService.safeResultSlug('../../etc/passwd') === '.._.._etc_passwd', '落盘文件名：路径分隔被替换')
    ok(!toolService.safeResultSlug('a/b\\c').includes('/'), '落盘文件名：不含目录分隔符')
  }

  {
    const marker = join(root, 'sneaky-marker.txt')
    const manager = new managerMod.McpConnectionManager([
      {
        id: 'fx',
        transport: 'stdio',
        command: process.execPath,
        args: [fixture],
        env: { YAN_MCP_FIXTURE_MARKER: marker }
      }
    ])
    const resultsDir = join(root, 'results')

    try {
      const tools = await manager.listTools('fx')
      ok(tools.length === 7, '真连：listTools 拿到全部工具', tools.map((t) => t.name).join(','))
      ok(
        tools.some((t) => t.name === 'web_search'),
        '刚加的 web_search 也在列表里（来源搜索入口靠它）'
      )
      ok(manager.statusOf('fx').status === 'ready', '真连：握手成功后状态是 ready')

      const described = await toolService.describeMcpTool(manager, 'fx', 'add')
      ok(
        described.schemaRevision.length === 8 && described.selfReportedReadOnly === false,
        '真连：describe 给出 schemaRevision'
      )

      const echo = await toolService.callMcpTool(manager, 'fx', 'echo', { text: '你好' }, { resultsDir })
      ok(echo.text === '你好' && !echo.toolError, '真连：callTool 正常返回')

      const add = await toolService.callMcpTool(manager, 'fx', 'add', { a: 2, b: 3 }, { resultsDir })
      ok(add.text === '5', '真连：带必填参数的调用')

      let badArgs = null
      try {
        await toolService.callMcpTool(manager, 'fx', 'add', { a: 2 }, { resultsDir })
      } catch (error) {
        badArgs = error
      }
      ok(badArgs && badArgs.code === 'invalid_arguments', '真连：漏必填参数回 invalid_arguments（不发出请求）')

      const failed = await toolService.callMcpTool(manager, 'fx', 'fail', {}, { resultsDir })
      ok(failed.toolError === true, '真连：工具级错误是 toolError:true 的结果（与协议错误分开）')

      let stale = null
      try {
        await toolService.callMcpTool(manager, 'fx', 'add', { a: 1, b: 1 }, { resultsDir, expectedRevision: 'deadbeef' })
      } catch (error) {
        stale = error
      }
      ok(stale && stale.code === 'schema-changed', '真连：revision 过期回 schema-changed（可重试）')

      const big = await toolService.callMcpTool(manager, 'fx', 'big', { bytes: 100_000 }, { resultsDir })
      ok(Boolean(big.resultFile) && big.bytes >= 100_000, '真连：大结果落盘并回报字节数')
      if (big.resultFile) {
        const info = await stat(big.resultFile)
        ok(info.size >= 100_000, '真连：落盘文件真的有那么大')
      }

      const sneaky = await toolService.callMcpTool(manager, 'fx', 'sneaky', {}, { resultsDir })
      ok(sneaky.text === 'done', '真连：sneaky 调用成功')
      const markerText = await readFile(marker, 'utf8').catch(() => '')
      ok(markerText.includes('sneaky-wrote'), '边界：自报 readOnlyHint 的服务**真的写了盘** —— 所以不能当安全边界')

      let noTool = null
      try {
        await toolService.describeMcpTool(manager, 'fx', 'nope')
      } catch (error) {
        noTool = error
      }
      ok(noTool && noTool.code === 'tool_not_found', '真连：不存在的工具回 tool_not_found')
    } finally {
      await manager.close()
    }
    ok(manager.statusOf('fx').status === 'disconnected', '关闭：状态复位为 disconnected')
  }

  {
    const manager = new managerMod.McpConnectionManager([
      {
        id: 'blocked-env',
        transport: 'stdio',
        command: process.execPath,
        args: [fixture],
        env: { NODE_OPTIONS: '--require=not-a-real-module' }
      }
    ])
    let blocked = null
    try {
      await manager.listTools('blocked-env')
    } catch (error) {
      blocked = error
    }
    ok(blocked instanceof Error && blocked.message.includes('NODE_OPTIONS'), '环境变量：拒绝覆盖 NODE_OPTIONS')
    ok(manager.statusOf('blocked-env').status === 'error', '环境变量：拒绝后不启动 stdio 子进程')
    await manager.close()
  }

  {
    const manager = new managerMod.McpConnectionManager(
      [{
        id: 'timeout-cleanup',
        transport: 'stdio',
        command: process.execPath,
        args: [fixture],
        env: { YAN_MCP_FIXTURE_START_DELAY_MS: '5000' }
      }],
      100
    )
    let timedOut = null
    try {
      await manager.listTools('timeout-cleanup')
    } catch (error) {
      timedOut = error
    }
    ok(timedOut instanceof Error && timedOut.message.includes('超时'), '超时：握手超时如实返回')
    await new Promise((resolve) => setTimeout(resolve, 150))
    ok(manager.statusOf('timeout-cleanup').status === 'disconnected', '超时：底层连接清理后状态为 disconnected')
    await manager.close()
  }

  {
    const manager = new managerMod.McpConnectionManager(
      [
        {
          id: 'slow',
          transport: 'stdio',
          command: process.execPath,
          args: [fixture],
          env: { YAN_MCP_FIXTURE_START_DELAY_MS: '5000' }
        }
      ],
      8_000
    )
    const inFlight = manager.listTools('slow').then(
      () => null,
      (error) => error
    )
    ok(manager.statusOf('slow').status === 'connecting', '取消：握手中状态立即可见')
    ok(await manager.disconnect('slow'), '取消：可断开指定服务')
    const outcome = await Promise.race([
      inFlight,
      new Promise((resolve) => setTimeout(() => resolve(new Error('取消未能及时结束握手')), 2_000))
    ])
    ok(outcome instanceof Error, '取消：待处理的连接以错误结束')
    ok(manager.statusOf('slow').status === 'disconnected', '取消：迟到的握手结果不会覆盖 disconnected')
    await manager.close()
  }

  {
    const { spawn } = await import('node:child_process')
    const net = await import('node:net')
    const port = 39000 + Math.floor(Math.random() * 900)
    const child = spawn(process.execPath, [resolve('scripts/lib/mcp-http-fixture.mjs')], {
      stdio: 'ignore',
      env: { ...process.env, YAN_MCP_HTTP_PORT: String(port) }
    })

    let up = false
    for (let i = 0; i < 80; i++) {
      up = await new Promise((res) => {
        const socket = net.connect({ port, host: '127.0.0.1' })
        socket.once('connect', () => {
          socket.destroy()
          res(true)
        })
        socket.once('error', () => {
          socket.destroy()
          res(false)
        })
      })
      if (up) break
      await new Promise((r) => setTimeout(r, 100))
    }
    ok(up, 'HTTP：fixture 真监听上了（起了一个真的 HTTP 服务）')

    const manager = new managerMod.McpConnectionManager([
      { id: 'http', transport: 'http', url: `http://127.0.0.1:${port}/mcp` }
    ])
    const httpResults = join(root, 'http-results')
    try {
      const tools = await manager.listTools('http')
      ok(tools.length === 2, 'HTTP：listTools 拿到工具', tools.map((t) => t.name).join(','))
      const echo = await toolService.callMcpTool(manager, 'http', 'echo', { text: 'hi' }, { resultsDir: httpResults })
      ok(echo.text === 'http:hi', 'HTTP：callTool 正常返回')
      const boom = await toolService.callMcpTool(manager, 'http', 'boom', {}, { resultsDir: httpResults })
      ok(boom.toolError === true, 'HTTP：工具级错误一样可区分')
    } finally {
      await manager.close()
      child.kill('SIGTERM')
    }
  }

  await rm(root, { recursive: true, force: true })
}
