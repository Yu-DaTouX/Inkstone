import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const mod = await compile('src/main/agent-commands/install-command.ts')
  const acq = await compile('src/main/capabilities/acquisition-commands.ts')

  const service = (name, scope, extra = {}) => ({ key: `native:${scope}:${name}`, name, title: name, backend: 'native', owner: 'pi', scope, enabled: true, inherited: false, overridden: false, transport: 'stdio', source: '', connection: 'npx', ...extra })

  function setup({ answer = (req) => req.options[0], trusted = true, global = [], projectServices = [], plugins = [], packages = [] } = {}) {
    const calls = { approvals: [], mcp: [], plugin: [], pkg: [], refresh: 0 }
    const snapshot = () => ({ context: 'ctx', revision: 'rev', project: { id: 'p1', name: 'demo', cwd: 'E:/demo' }, projectTrusted: trusted, global, projectServices, errors: [], busy: false, nativeConfigChanged: null })
    const services = {
      project: async () => ({ name: 'demo', trusted }),
      mcpServices: async () => snapshot(),
      mcpChange: async (mutation) => { calls.mcp.push(mutation); return { ok: true, takesEffect: 'new-session' } },
      plugins: async () => plugins,
      pluginAction: async (id, action) => { calls.plugin.push([id, action]); return { ok: true, installed: action === 'install' } },
      packages: () => ({ ok: true, agentDir: '', userSettings: '', projectSettings: '', entries: packages }),
      packageAction: async (request) => { calls.pkg.push(request); return { ok: true, output: 'ok' } },
      refresh: () => { calls.refresh += 1 }
    }
    const host = {
      services: () => services,
      requestApproval: async (req) => {
        calls.approvals.push(req)
        const value = answer(req)
        if (value instanceof Error) throw value
        return value === undefined ? { cancelled: true } : { value }
      }
    }
    return { host, calls }
  }
  const run = (host, command, params) => mod.runInstallCommand(host, command, params)
  const rejects = async (promise, code) => { try { await promise; return false } catch (error) { return error?.code === code } }

  {
    const { host, calls } = setup()
    const res = await run(host, 'mcp.add', { name: 'github', command: 'npx', arg: ['-y', '@mcp/github'], env: ['GITHUB_TOKEN=secret-value-123'], reason: '读 issue' })
    const mutation = calls.mcp[0]
    ok(res.data.state === 'done' && calls.refresh === 1, 'mcp add：批准后写入并刷新运行实例')
    ok(mutation?.action === 'add' && mutation.scope === 'global' && mutation.owner === 'pi' && mutation.context === 'ctx' && mutation.revision === 'rev', 'mcp add：默认 pi 原生、全局，带上快照的 context 与 revision')
    ok(JSON.stringify(mutation.config) === JSON.stringify({ command: 'npx', args: ['-y', '@mcp/github'], env: { GITHUB_TOKEN: 'secret-value-123' } }), 'mcp add：启动命令、参数和环境变量原样写入')
    const shown = JSON.stringify([calls.approvals, res])
    ok(!shown.includes('secret-value-123') && calls.approvals[0].message.includes('GITHUB_TOKEN'), '环境变量的值不出现在批准面板和返回结果里，只显示名字')
    ok(calls.approvals[0].options.length === 2, '项目已信任时面板给出全局和当前项目两个选项')
  }

  {
    const { host, calls } = setup({ answer: (req) => req.options[1] })
    const res = await run(host, 'mcp.add', { name: 'docs', url: 'https://example.com/mcp', app: true })
    ok(calls.mcp[0]?.scope === 'project' && calls.mcp[0].owner === 'inkstone' && calls.mcp[0].config.url === 'https://example.com/mcp' && res.data.scope === 'project', 'mcp add：选当前项目写项目范围，--app 交给砚连接')
  }

  {
    const { host, calls } = setup({ trusted: false })
    await run(host, 'mcp.add', { name: 'docs', url: 'https://example.com/mcp', scope: 'project' })
    ok(calls.approvals[0].options.length === 1 && calls.mcp[0].scope === 'global', '项目未信任时只能加到全局')
  }

  {
    const { host, calls } = setup({ answer: () => undefined })
    const res = await run(host, 'mcp.add', { name: 'x', command: 'npx' })
    ok(res.data.state === 'skipped' && res.data.reason === 'declined' && calls.mcp.length === 0 && calls.refresh === 0, '用户关掉面板：不写入、不刷新')
  }

  {
    const { host, calls } = setup({ answer: () => '先别装，用网页版' })
    const res = await run(host, 'mcp.add', { name: 'x', command: 'npx' })
    ok(res.data.reason === 'user-reply' && res.data.userReply === '先别装，用网页版' && calls.mcp.length === 0, '用户回复别的话：带回 userReply，不写入')
  }

  {
    const { host, calls } = setup({ answer: () => Object.assign(new Error('timeout'), { code: 'question_timeout' }) })
    const res = await run(host, 'mcp.add', { name: 'x', command: 'npx' })
    ok(res.data.reason === 'timeout' && calls.mcp.length === 0, '面板超时：跳过且不写入')
  }

  {
    const { host } = setup({ global: [service('github', 'global')] })
    ok(await rejects(run(host, 'mcp.add', { name: 'github', command: 'npx' }), 'install_bad_request'), '同名服务已存在时直接拒绝，不弹面板')
    ok(await rejects(run(host, 'mcp.add', { name: 'a' }), 'install_bad_request'), '没给 --command 或 --url 时拒绝')
    ok(await rejects(run(host, 'mcp.add', { name: 'a', command: 'x', url: 'https://a' }), 'install_bad_request'), '--command 和 --url 同时给时拒绝')
    ok(await rejects(run(host, 'mcp.add', { name: 'a', command: 'x', env: ['NOVALUE'] }), 'install_bad_request'), 'env 不是 名字=值 时拒绝')
  }

  {
    const inherited = { ...service('github', 'global'), inherited: true }
    const { host, calls } = setup({ global: [service('github', 'global')], projectServices: [inherited, service('local', 'project')] })
    await run(host, 'mcp.disable', { name: 'github' })
    ok(calls.mcp[0]?.action === 'disable' && calls.mcp[0].scope === 'global' && calls.mcp[0].key === 'native:global:github', 'mcp disable：默认改全局条目')
    await run(host, 'mcp.disable', { name: 'github', scope: 'project' })
    ok(calls.mcp[1]?.scope === 'project', 'mcp disable --scope project：只在当前项目关掉继承的服务')
    await run(host, 'mcp.remove', { name: 'local' })
    ok(calls.mcp[2]?.action === 'remove' && calls.mcp[2].scope === 'project' && calls.mcp[2].key === 'native:project:local', 'mcp remove：项目自己的服务按项目范围删除')
    ok(await rejects(run(host, 'mcp.remove', { name: 'nope' }), 'install_bad_request'), 'mcp remove：没有这个服务时拒绝')
    const listed = await run(host, 'mcp.services', {})
    ok(listed.data.services.map((s) => s.name).join(',') === 'github,local', 'mcp services：列出全局和项目自己的服务，不重复列继承项')
  }

  {
    const plugins = [{ id: 'comfyui', name: 'ComfyUI', desc: '生成图片', installed: false }]
    const { host, calls } = setup({ plugins })
    ok(await rejects(run(host, 'plugin.install', { id: 'nope' }), 'install_bad_request'), 'plugin install：未知插件拒绝')
    const res = await run(host, 'plugin.install', { id: 'comfyui' })
    ok(res.data.state === 'done' && calls.plugin[0].join() === 'comfyui,install' && calls.refresh === 1, 'plugin install：批准后安装并刷新')
  }

  {
    const { host, calls } = setup({ answer: (req) => req.options[1] ?? req.options[0], packages: [{ source: 'npm:pi-foo@1.0.0', scope: 'project', name: 'pi-foo', version: '1.0.0', installed: true }] })
    ok(await rejects(run(host, 'package.install', { source: 'rm -rf' }), 'install_bad_request'), 'package install：非法来源直接拒绝')
    const res = await run(host, 'package.install', { source: 'git:github.com/a/b' })
    ok(calls.pkg[0]?.kind === 'install' && calls.pkg[0].local === true && res.data.scope === 'project', 'package install：选当前项目时按项目级安装 git 来源')
    await run(host, 'package.remove', { source: 'pi-foo' })
    ok(calls.pkg[1]?.kind === 'remove' && calls.pkg[1].source === 'npm:pi-foo@1.0.0' && calls.pkg[1].local === true, 'package remove：按包名找到登记来源和范围')
  }

  {
    const { host } = setup()
    const none = { ...host, services: () => undefined }
    ok(await rejects(run(none, 'mcp.services', {}), 'install_unavailable'), '没有安装服务的会话（如子代理）拒绝执行')
  }

  {
    const base = { candidateId: 'mcp-registry:io.github.acme/weather-mcp@1.2.0', kind: 'mcp-server', title: 'Weather', summary: '', discoveredAt: '', sourceUrls: [], requirements: [], auth: 'unknown', installKind: 'mcp-package', verification: 'metadata-only' }
    const npm = { ...base, localPackage: { registryType: 'npm', identifier: '@acme/weather-mcp', version: '1.2.0' } }
    ok(JSON.stringify(acq.mcpLaunchOf(npm)) === JSON.stringify({ command: 'npx', args: ['-y', '@acme/weather-mcp@1.2.0'] }), 'MCP 候选：npm 包用 npx 固定版本启动')
    ok(JSON.stringify(acq.mcpLaunchOf({ ...base, localPackage: { registryType: 'pypi', identifier: 'weather', version: '2.0' } })) === JSON.stringify({ command: 'uvx', args: ['weather==2.0'] }), 'MCP 候选：PyPI 包用 uvx 固定版本启动')
    ok(acq.mcpLaunchOf({ ...base, remoteUrl: 'https://w.example/mcp' })?.url === 'https://w.example/mcp', 'MCP 候选：远程服务用地址')
    ok(acq.mcpLaunchOf({ ...base, localPackage: { registryType: 'oci', identifier: 'x' } }) === null, 'MCP 候选：不支持的包类型不硬凑命令')
    ok(acq.mcpServiceNameOf(npm) === 'weather-mcp', 'MCP 候选：服务名取包名末段')
  }
})
