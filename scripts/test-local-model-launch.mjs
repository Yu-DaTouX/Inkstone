import './lib/test-isolate.mjs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const fixtures = Symbol.for('inkstone.local-model-tests')
const origin = (port, host = '127.0.0.1') => `http://${host}:${port}`
const modelsResponse = (...ids) => Response.json({ data: ids.map((id) => ({ id })) })
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const child = (pid) => Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null, killed: false })
const fixturePlugin = {
  name: 'local-model-fixtures',
  setup(build) {
    build.onResolve({ filter: /^(node:net|\.\/atomic-write)$/ }, ({ path, importer }) =>
      /local-model-launch\.ts$/.test(importer) ? { path, namespace: 'fixtures' } : undefined)
    build.onLoad({ filter: /.*/, namespace: 'fixtures' }, ({ path }) => ({
      resolveDir: resolve('src/main'),
      contents: path === 'node:net'
        ? "export const connect = (target) => globalThis[Symbol.for('inkstone.local-model-tests')].connect(target)"
        : "import { atomicWriteFile as write } from './atomic-write.ts'; export const atomicWriteFile = async (...args) => { await globalThis[Symbol.for('inkstone.local-model-tests')].beforeLauncherWrite?.(); return write(...args) }"
    }))
  }
}

await runSuite(import.meta.url, async (ok, compile) => {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-local-launch-'))
  process.env.YAN_PI_DIR = dir
  process.env.YAN_DATA_DIR = join(dir, 'yan')
  const port = 19001
  const idlePort = 19002
  const failPort = 19003
  const otherPort = 19004
  const authPort = 19005
  const hosts = new Map()
  const serve = (port, modelId, host = '127.0.0.1') => hosts.set(origin(port, host), () => modelsResponse(modelId))
  const close = (port, host = '127.0.0.1') => hosts.delete(origin(port, host))
  const modelFile = join(dir, 'models.json')
  const launcherFile = join(dir, 'yan', 'local-models.json')
  const oldFetch = globalThis.fetch
  const envName = 'YAN_TEST_LOCAL_INFERENCE_KEY'
  const oldKey = process.env[envName]
  process.env[envName] = 'fixture-inference-key'
  globalThis[fixtures] = {
    connect({ host, port }) {
      const socket = Object.assign(new EventEmitter(), { destroy() {}, setTimeout() {} })
      queueMicrotask(() => hosts.has(origin(port, host))
        ? socket.emit('connect')
        : socket.emit('error', Object.assign(new Error('closed'), { code: 'ECONNREFUSED' })))
      return socket
    }
  }
  globalThis.fetch = async (address, init) => {
    const url = new URL(address)
    const handler = hosts.get(url.origin)
    if (!handler) throw Object.assign(new Error('closed'), { code: 'ECONNREFUSED' })
    return handler(url, init)
  }
  try {
    await writeFile(modelFile, JSON.stringify({
      providers: {
        ninfer: { name: '本地 NInfer', baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', models: [{ id: 'qwen' }] },
        idle: { baseUrl: `http://127.0.0.1:${idlePort}/v1`, api: 'openai-completions', models: [{ id: 'm' }] },
        broken: { baseUrl: `http://127.0.0.1:${failPort}/v1`, api: 'openai-completions', models: [{ id: 'b' }] },
        cloud: { baseUrl: 'https://api.example.com/v1', api: 'openai-completions', models: [{ id: 'gpt' }] }
      }
    }))
    const api = await compile('src/main/local-model-launch.ts', {
      plugins: [fixturePlugin],
      stdin: {
        resolveDir: resolve('src/main'),
        contents: "export * from './local-model-launch.ts'; export { saveCustomProvider, testCustomProviderEndpoint, discoverCustomProviderModels } from './custom-providers.ts'; export { isLoopbackBaseUrl, isLocalBaseUrl } from '../shared/model-capabilities.ts'"
      }
    })
    await mkdir(join(dir, 'yan'), { recursive: true })
    await writeFile(join(dir, 'yan', 'local-models.json'), JSON.stringify({ urls: ['http://127.0.0.1:9999'] }))
    const startBat = join(dir, '启动-NInfer.bat')
    const stopBat = join(dir, '停止-NInfer.bat')
    await writeFile(startBat, '@echo off\r\n')
    await writeFile(stopBat, '@echo off\r\n')

    const listed = await api.listLocalLaunchers()
    ok(listed.map((item) => item.provider).join(',') === 'broken,idle,ninfer', '只列出地址在本机或局域网的服务商')
    ok(listed.find((item) => item.provider === 'ninfer')?.name === '本地 NInfer', '显示 models.json 里的服务商名称')
    ok(listed.every((item) => item.idleUnload === true && item.stopCommand === ''), '闲置卸载默认开启，停止命令默认为空')

    const saved = await api.saveLocalLauncher('ninfer', { command: `  ${startBat}  `, stopCommand: stopBat })
    await api.saveLocalLauncher('idle', { command: 'serve-idle', idleUnload: false })
    await api.saveLocalLauncher('broken', { command: 'broken-cmd' })
    const config = JSON.parse(await readFile(join(dir, 'yan', 'local-models.json'), 'utf8'))
    ok(config.launchers.ninfer.command === startBat && config.launchers.ninfer.stopCommand === stopBat, '保存启动与停止命令并去掉首尾空白')
    ok(config.launchers.idle.idleUnload === false && !('idleUnload' in config.launchers.ninfer), '只在关闭时记录闲置卸载开关')
    ok(config.urls?.[0] === 'http://127.0.0.1:9999', '保存时保留同一文件里的本地地址配置')
    ok(!saved.warning, '正常的启动脚本没有警告')

    const warned = await api.saveLocalLauncher('ninfer', { command: stopBat, stopCommand: stopBat })
    ok(/停止脚本|stop script/.test(warned.warning ?? ''), '启动命令选成停止脚本时给出警告')
    await api.saveLocalLauncher('ninfer', { command: startBat, stopCommand: stopBat })

    const rejects = async (provider, input) => {
      try {
        await api.saveLocalLauncher(provider, input)
        return false
      } catch (error) {
        return error.message
      }
    }
    ok(/不存在|does not exist/.test(await rejects('ninfer', { command: join(dir, '没有这个.bat') })), '启动脚本文件不存在时拒绝保存')
    ok(/不存在|does not exist/.test(await rejects('ninfer', { command: startBat, stopCommand: `"${join(dir, 'missing stop.bat')}" now` })), '停止命令文件不存在时拒绝保存')
    ok(!!(await rejects('cloud', { command: 'evil.exe' })), '云端服务商不能设置启动命令')
    ok(api.commandFile('ollama serve') === null && api.commandFile('"C:\\a b\\x.bat" 1') === 'C:\\a b\\x.bat', '只把像路径的命令当文件检查')

    const renamed = await api.renameLocalModel('ninfer', 'qwen', '  Qwen   本地  ')
    let models = JSON.parse(await readFile(join(dir, 'models.json'), 'utf8'))
    ok(models.providers.ninfer.models[0].name === 'Qwen 本地', '改名写回 models.json 并压缩空白')
    ok(models.providers.ninfer.api === 'openai-completions' && models.providers.cloud.models[0].id === 'gpt', '改名不动其他字段和其他服务商')
    ok(renamed.find((item) => item.provider === 'ninfer')?.models[0]?.name === 'Qwen 本地', '改名后返回的列表带新名称')
    await api.renameLocalModel('ninfer', 'qwen', '')
    models = JSON.parse(await readFile(join(dir, 'models.json'), 'utf8'))
    ok(!('name' in models.providers.ninfer.models[0]), '名称留空时去掉 name，恢复显示模型 ID')
    let renameRefused = 0
    for (const args of [['cloud', 'gpt', 'x'], ['ninfer', 'missing', 'x'], ['ninfer', 'qwen', 'x'.repeat(121)]]) {
      try {
        await api.renameLocalModel(...args)
      } catch {
        renameRefused++
      }
    }
    ok(renameRefused === 3, '云端服务商、不存在的模型、超长名称都拒绝改名')

    const none = await api.ensureLocalModelReady('cloud', 'gpt', { run: () => { throw new Error('不该运行') } })
    ok(none.ok && !none.started, '没配启动命令的服务商直接放行')

    let runs = 0
    let notices = 0
    const options = {
      pollMs: 30,
      timeoutMs: 5_000,
      onStarting: () => { notices++ },
      run: (command) => {
        runs++
        ok(command === startBat, '运行的是用户保存的启动命令')
        serve(port, 'qwen')
      }
    }
    const [first, second] = await Promise.all([api.ensureLocalModelReady('ninfer', 'qwen', options), api.ensureLocalModelReady('ninfer', 'qwen', options)])
    ok(first.ok && second.ok && first.started, '服务未运行时启动并等到 /v1/models 就绪')
    ok(runs === 1 && notices === 1, '同时发两条消息只启动一次、只提示一次', `runs=${runs} notices=${notices}`)

    const again = await api.ensureLocalModelReady('ninfer', 'qwen', { run: () => { runs++ } })
    ok(again.ok && !again.started && runs === 1, '服务已在运行时不再启动')

    const failing = child(1001)
    failing.exitCode = 1
    const killed = []
    const kill = async (pid) => { killed.push(pid) }
    const broken = await api.ensureLocalModelReady('broken', 'b', { pollMs: 1, timeoutMs: 5_000, run: () => failing, kill })
    ok(!broken.ok && /代码 1|code 1/.test(broken.error ?? '') && killed.length === 0 && failing.eventNames().length === 0, '非零退出立即失败，不再终止已退出的 PID 或保留事件监听')

    const hanging = child(1002)
    const stuck = await api.ensureLocalModelReady('idle', 'm', { pollMs: 5, timeoutMs: 30, run: () => hanging, kill })
    ok(!stuck.ok && /草稿已保留|draft kept/.test(stuck.error ?? '') && killed.join() === '1002' && hanging.eventNames().length === 0, '超时仅清理本次启动的进程并保留草稿')
    killed.length = 0

    let busy = true
    const unloadCalls = []
    let clock = Date.now() + 1_000
    const scan = (extra = {}) => api.scanIdleLocalModels({
      busy: () => busy,
      now: () => clock,
      stop: async (_command, target) => {
        unloadCalls.push(target.provider)
        close(port)
      },
      ...extra
    })
    await scan()
    clock += 11 * 60_000
    ok((await scan()).length === 0, '有会话正在用时不卸载')
    busy = false
    clock += 9 * 60_000
    ok((await scan()).length === 0, '空闲不到 10 分钟不卸载')
    clock += 2 * 60_000
    const named = []
    const unloaded = await scan({ onUnloaded: (name) => named.push(name) })
    ok(unloaded.join(',') === 'ninfer' && named[0] === '本地 NInfer', '空闲满 10 分钟卸载并通知服务商名称')
    ok(!unloadCalls.includes('idle'), '关闭了闲置卸载的服务商不卸载')

    const stops = []
    serve(port, 'qwen')
    const result = await api.unloadLocalModel('ninfer', {
      stop: async (command) => {
        stops.push(command)
        close(port)
      },
      kill: async (pid) => { killed.push(pid) },
      closeWaitMs: 2_000
    })
    ok(result && stops[0] === stopBat && killed.length === 0, '有停止命令时运行停止命令并确认端口已关闭')

    serve(port, 'qwen')
    await api.saveLocalLauncher('ninfer', { command: startBat })
    let ownershipChecks = 0
    const unmanaged = await api.unloadLocalModel('ninfer', {
      ownsListener: async () => { ownershipChecks++; return true },
      kill
    })
    ok(!unmanaged && killed.length === 0 && ownershipChecks === 0 && hosts.has(origin(port)), '未托管的监听即便在环回地址也不按端口终止')
    close(port)
    const managed = child(4242)
    await api.ensureLocalModelReady('ninfer', 'qwen', { pollMs: 1, run: () => { serve(port, 'qwen'); return managed } })
    ok(!await api.unloadLocalModel('ninfer', { ownsListener: async () => false, kill }) && killed.length === 0, '无法验证监听归属时拒绝终止已登记进程')
    const owned = await api.unloadLocalModel('ninfer', {
      ownsListener: async (url, pid) => url === `${origin(port)}/v1` && pid === managed.pid,
      kill: async (pid) => { killed.push(pid); close(port) }
    })
    ok(owned && killed.join() === '4242', '验证环回端点后只终止登记的子进程')
    killed.length = 0

    ok(api.launcherFromProcess({ command: '"E:\\AI\\ninfer\\engine\\ninfer-serve.exe" model --vision', parent: 'C:\\Windows\\system32\\cmd.exe /c ""E:\\AI\\ninfer\\启动-NInfer.bat" "' }) === 'E:\\AI\\ninfer\\启动-NInfer.bat', '由 bat 拉起时识别出 bat 路径')
    ok(api.launcherFromProcess({ command: 'C:\\ollama\\ollama.exe serve', parent: 'C:\\Windows\\explorer.exe' }) === 'C:\\ollama\\ollama.exe serve', '没有启动脚本时用进程本身的命令行')
    ok(api.launcherFromProcess({ command: null, parent: null }) === null, '读不到进程信息时不猜')

    const netstat = '  TCP    0.0.0.0:135     0.0.0.0:0   LISTENING   1100\r\n  TCP    127.0.0.1:8080  0.0.0.0:0   LISTENING   29872\r\n  TCP    127.0.0.1:8080  127.0.0.1:5000  ESTABLISHED  29872'
    ok(api.listeningPid(netstat, '127.0.0.1', 8080) === 29872 && api.listeningPid(netstat, '127.0.0.2', 8080) === null, 'netstat 按监听地址和端口匹配，拒绝其他 IP')
    ok(api.listeningPid(netstat + '\n TCP [::]:8080 [::]:0 LISTENING 9999', '127.0.0.1', 8080) === null, '同端口存在多个可能的监听进程时不猜归属')

    const script = join(dir, '启动 服务.bat')
    await writeFile(script, '@echo off\r\n')
    const line = api.launchLine(`"${script}"`)
    ok(line.line === `"${script}"` && line.cwd === dir, '脚本路径带空格时加引号并在脚本目录运行')
    ok(api.launchLine('ollama serve').line === 'ollama serve' && !api.launchLine('ollama serve').cwd, '完整命令原样运行')

    const scarletBat = join(dir, '启动-ScarletKc2.bat')
    await writeFile(scarletBat, '@echo off\r\n')
    const added = await api.addLocalModel('ninfer', {
      id: 'scarletkc-2.0',
      name: 'ScarletKc2',
      contextWindow: 49152,
      maxTokens: 8192,
      reasoning: true,
      input: ['text', 'image'],
      command: scarletBat
    })
    const ninferAfterAdd = added.launchers.find((item) => item.provider === 'ninfer')
    ok(ninferAfterAdd?.models.length === 2, '添加第二个本地模型后返回两个模型')
    const scarletView = ninferAfterAdd?.models.find((m) => m.id === 'scarletkc-2.0')
    ok(scarletView?.name === 'ScarletKc2' && scarletView?.command === scarletBat && scarletView?.contextWindow === 49152 && scarletView?.reasoning === true, '新模型的名称、上下文、思考能力与独立启动命令均保存')

    await api.saveLocalLauncher('ninfer', { modelId: 'qwen', modelCommand: startBat })
    await api.saveLocalLauncher('ninfer', { command: '', stopCommand: stopBat })
    const multiConfig = JSON.parse(await readFile(join(dir, 'yan', 'local-models.json'), 'utf8'))
    ok(!multiConfig.launchers.ninfer.command && multiConfig.launchers.ninfer.stopCommand === stopBat, '清空服务默认启动命令时保留停止命令与模型独立命令')
    ok(multiConfig.launchers.ninfer.models?.qwen?.command === startBat && multiConfig.launchers.ninfer.models?.['scarletkc-2.0']?.command === scarletBat, '两个模型各自保存独立启动命令')

    await api.saveLocalLauncher('ninfer', { idleUnload: false })
    await api.saveLocalLauncher('ninfer', { idleUnload: true })
    const afterToggle = JSON.parse(await readFile(join(dir, 'yan', 'local-models.json'), 'utf8'))
    ok(afterToggle.launchers.ninfer.stopCommand === stopBat && afterToggle.launchers.ninfer.models?.['scarletkc-2.0']?.command === scarletBat, '仅切换闲置卸载开关时不覆盖停止命令和模型启动命令')

    let addRejected = 0
    for (const bad of [
      { id: 'scarletkc-2.0' },
      { id: '!evil' },
      { id: 'new-one', command: join(dir, 'nope.bat') }
    ]) {
      try {
        await api.addLocalModel('ninfer', bad)
      } catch {
        addRejected++
      }
    }
    ok(addRejected === 3, '重复模型 ID、! 开头、不存在的启动脚本均拒绝添加')

    serve(port, 'qwen')

    const blockedByBusy = await api.ensureLocalModelReady('ninfer', 'scarletkc-2.0', {
      busy: () => true,
      run: () => { throw new Error('繁忙时不该启动') }
    })
    ok(!blockedByBusy.ok && /草稿已保留|draft kept/.test(blockedByBusy.error ?? ''), '同端口有其他会话正在生成时不强行切换模型')

    let switchedNotice = ''
    let unloadedOld = false
    let launchedCmd = ''
    const switched = await api.ensureLocalModelReady('ninfer', 'scarletkc-2.0', {
      pollMs: 30,
      timeoutMs: 5_000,
      busy: () => false,
      onSwitching: (name) => { switchedNotice = name },
      stop: async () => {
        unloadedOld = true
        close(port)
      },
      run: (cmd) => {
        launchedCmd = cmd
        serve(port, 'scarletkc-2.0')
      }
    })
    ok(switched.ok && switched.started && unloadedOld && launchedCmd === scarletBat && switchedNotice === 'ScarletKc2', '同端口跑着旧模型时自动卸载旧模型并启动新模型脚本', `ok=${switched.ok} unloaded=${unloadedOld} cmd=${launchedCmd} notice=${switchedNotice}`)

    const alreadyScarlet = await api.ensureLocalModelReady('ninfer', 'scarletkc-2.0', {
      run: () => { throw new Error('已经在跑目标模型不该重启') }
    })
    ok(alreadyScarlet.ok && !alreadyScarlet.started, '端口已提供目标模型时直接放行不重启')

    const wrong = child(1003)
    const recovery = []
    const mismatch = await api.ensureLocalModelReady('ninfer', 'qwen', {
      pollMs: 1,
      timeoutMs: 500,
      mismatchLimit: 1,
      closeWaitMs: 0,
      stop: async () => { close(port) },
      kill: async (pid) => { killed.push(pid); close(port) },
      run: (command) => {
        recovery.push(command)
        serve(port, 'scarletkc-2.0')
        if (command === startBat) return wrong
      }
    })
    ok(!mismatch.ok && /scarletkc-2\.0/.test(mismatch.error ?? '') && /qwen/.test(mismatch.error ?? ''), '启动后服务返回的模型 ID 与配置不匹配时明确报错')
    ok(killed.join() === '1003' && recovery.join() === [startBat, scarletBat].join() && /旧服务已恢复|previous service was restored/.test(mismatch.error ?? ''), '仅清理新进程并尝试通过旧模型命令恢复')
    killed.length = 0

    const onlyModelIdleUnloaded = []
    let idleClock = Date.now() + 1_000
    await api.scanIdleLocalModels({ busy: () => false, now: () => idleClock, stop: async (_command, target) => { onlyModelIdleUnloaded.push(target.provider); close(port) } })
    idleClock += 11 * 60_000
    await api.scanIdleLocalModels({ busy: () => false, now: () => idleClock, stop: async (_command, target) => { onlyModelIdleUnloaded.push(target.provider); close(port) } })
    ok(onlyModelIdleUnloaded.includes('ninfer'), '仅配置模型级启动命令时同样支持闲置自动卸载')

    const afterRemove = await api.removeLocalModel('ninfer', 'scarletkc-2.0')
    ok(afterRemove.find((item) => item.provider === 'ninfer')?.models.length === 1, '移除本地模型后列表更新')
    const afterRemoveCfg = JSON.parse(await readFile(join(dir, 'yan', 'local-models.json'), 'utf8'))
    ok(!afterRemoveCfg.launchers.ninfer.models?.['scarletkc-2.0'], '移除本地模型时同步清理对应启动命令')

    let lastRemoveFailed = false
    try {
      await api.removeLocalModel('ninfer', 'qwen')
    } catch {
      lastRemoveFailed = true
    }
    ok(lastRemoveFailed, '最后一个模型不允许移除')

    const addedProviders = JSON.parse(await readFile(modelFile, 'utf8'))
    const lan = '192.168.42.17'
    const multiUrl = `${origin(otherPort)}/v1`
    const authUrl = `${origin(authPort)}/gateway/?tenant=a%2Fb#ignored`
    Object.assign(addedProviders.providers, {
      lan: { baseUrl: `${origin(port, lan)}/v1`, models: [{ id: 'old' }, { id: 'new' }] },
      multi: { baseUrl: `${origin(port)}/v1`, models: [{ id: 'main' }, { id: 'old', baseUrl: multiUrl }, { id: 'next', baseUrl: multiUrl }] },
      alias: { baseUrl: `${origin(otherPort)}/v1`, models: [{ id: 'alias' }] },
      auth: { baseUrl: authUrl, api: 'anthropic-messages', apiKey: '$' + envName,
        headers: { 'x-fixture': 'preset' }, models: [{ id: 'auth' }, { id: 'redirected', baseUrl: `${origin(idlePort)}/v1` }] }
    })
    await writeFile(modelFile, JSON.stringify(addedProviders))
    await Promise.all([
      api.saveLocalLauncher('lan', { command: 'serve-lan' }),
      api.saveLocalLauncher('multi', { command: 'serve-multi', stopCommand: 'stop-multi' }),
      api.saveLocalLauncher('alias', { command: 'serve-alias', stopCommand: 'stop-alias' }),
      api.saveLocalLauncher('auth', { command: 'serve-auth', stopCommand: 'stop-auth' })
    ])

    ok(api.isLocalBaseUrl(origin(port, lan)) && !api.isLoopbackBaseUrl(origin(port, lan)) && !api.isLoopbackBaseUrl('http://0.0.0.0') &&
      api.isLoopbackBaseUrl('http://[::1]') && !api.isLocalBaseUrl('ftp://127.0.0.1'), '区分局域网、通配监听、本机环回和非 HTTP 地址')
    serve(port, 'main')
    serve(port, 'old', lan)
    const deniedLan = await api.ensureLocalModelReady('lan', 'new', { kill, run: () => { throw new Error('未授权启动') } })
    ok(!deniedLan.ok && /停止命令|stop command/.test(deniedLan.error ?? '') && killed.length === 0 &&
      hosts.has(origin(port)) && hosts.has(origin(port, lan)), '局域网与本机同端口时，未配置停止命令不终止任何进程')
    await api.saveLocalLauncher('lan', { stopCommand: 'stop-lan', idleUnload: false })
    const lanTarget = []
    ok(await api.unloadLocalModel('lan', { kill, stop: async (command, target) => { lanTarget.push(command, target.baseUrl); close(port, lan) } }) &&
      lanTarget.join() === ['stop-lan', `${origin(port, lan)}/v1`].join() && hosts.has(origin(port)) && killed.length === 0,
      '显式局域网停止命令只按目标地址确认端口关闭')

    serve(otherPort, 'old')
    const detection = await api.detectLocalLauncher('multi', 'old')
    ok(detection.models?.map(({ id }) => id).join() === 'old', '模型级启动器识别使用模型自己的端点')
    const actions = []
    const multiActions = {
      pollMs: 1, timeoutMs: 500, closeWaitMs: 0,
      stop: async (command, target) => { actions.push(['stop', command, target.baseUrl, target.modelId]); close(otherPort) },
      run: (command, target) => { actions.push(['run', command, target.baseUrl, target.modelId]); serve(otherPort, target.modelId) }
    }
    const isolatedSwitch = await api.ensureLocalModelReady('multi', 'next', {
      ...multiActions, busy: (endpoint) => endpoint.matchesModel('multi', 'main')
    })
    ok(isolatedSwitch.ok && JSON.stringify(actions) === JSON.stringify([['stop', 'stop-multi', multiUrl, 'old'], ['run', 'serve-multi', multiUrl, 'next']]) &&
      hosts.has(origin(port)), '切换模型级端点不卸载服务商默认端点，其他端点忙碌也不误阻断')
    const removedTarget = await api.unloadLocalModel('multi', { modelId: 'next', stop: multiActions.stop })
    ok(removedTarget && !hosts.has(origin(otherPort)) && hosts.has(origin(port)), '指定模型卸载只等待该模型的端口关闭')

    actions.length = 0
    const inHandoff = deferred()
    const finishHandoff = deferred()
    let generationActive = false
    api.setLocalModelBusyChecker((endpoint) => generationActive && endpoint.matchesModel('multi', 'old'))
    const starting = api.ensureLocalModelReady('multi', 'old', {
      ...multiActions,
      async onReady() { inHandoff.resolve(); await finishHandoff.promise; generationActive = true; return { ok: true } }
    })
    await inHandoff.promise
    const queued = [
      api.ensureLocalModelReady('alias', 'alias', multiActions),
      api.ensureLocalModelReady('multi', 'next', multiActions),
      api.unloadLocalModel('multi', { modelId: 'old', stop: multiActions.stop })
    ]
    finishHandoff.resolve()
    const [running, blockedAlias, blockedNext, blockedUnload] = await Promise.all([starting, ...queued])
    ok(running.ok && !blockedAlias.ok && !blockedNext.ok && blockedUnload === false && actions.length === 1 &&
      /正在生成|is busy/.test(blockedAlias.error ?? ''), '多个排队请求在发送交接后重检模型和忙碌，跨服务商切换及卸载均被拦截')
    generationActive = false
    api.setLocalModelBusyChecker(null)
    const ordered = await Promise.all([api.ensureLocalModelReady('alias', 'alias', multiActions), api.ensureLocalModelReady('alias', 'alias', multiActions)])
    ok(ordered.every(({ ok }) => ok) && actions.length === 3 && actions[1][1] === 'stop-multi', '同端口切换只执行一次，使用已识别旧服务商的停止命令')
    close(otherPort)
    serve(otherPort, 'old')
    await api.ensureLocalModelReady('multi', 'old')
    actions.length = 0
    const idleClock2 = Date.now() + 1_000
    const idleOptions = { busy: (endpoint) => endpoint.matchesModel('multi', 'main'), now: () => idleClock2, idleMs: 0, stop: multiActions.stop }
    const idleAtModelEndpoint = await api.scanIdleLocalModels(idleOptions)
    ok(idleAtModelEndpoint.includes('multi') && actions[0]?.[2] === multiUrl && hosts.has(origin(port)),
      '闲置卸载使用模型级端点，保留同服务商仍在忙的默认端点')

    serve(otherPort, 'old')
    const noRecovery = await api.ensureLocalModelReady('multi', 'next', {
      ...multiActions, run: () => failing
    })
    ok(!noRecovery.ok && /已停止旧服务|previous service was stopped/.test(noRecovery.error ?? '') && !hosts.has(origin(otherPort)),
      '旧服务恢复失败时明确告知旧服务已停止')

    const authCalls = []
    const authHandler = (result) => (url, init) => {
      authCalls.push([url.pathname, url.search, init.headers.get('x-api-key'), init.headers.get('x-fixture'), init.redirect, url.hash])
      return result(url, init)
    }
    for (const invalid of [
      () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
      () => new Response('{bad', { headers: { 'content-type': 'application/json' } }),
      () => modelsResponse()
    ]) {
      authCalls.length = 0
      hosts.set(origin(authPort), authHandler((url) => url.pathname.endsWith('/v1/models') ? modelsResponse('auth') : invalid()))
      const ready = await api.ensureLocalModelReady('auth', 'auth')
      ok(ready.ok && authCalls.length === 2 &&
        authCalls.every(([, query, key, preset, redirect, hash]) => query === '?tenant=a%2Fb' && key === 'fixture-inference-key' && preset === 'preset' && redirect === 'manual' && !hash),
        '无效/空响应继续探测同源候选路径，保留查询参数并给两条路径带认证头')
    }

    close(authPort)
    ok((await api.localServingModels(authUrl)).state === 'down', '只有确认拒绝连接才标记为服务未运行')
    hosts.set(origin(authPort), () => new Response(null, { status: 401 }))
    ok((await api.localServingModels(authUrl)).state === 'unknown', 'HTTP 认证失败与拒绝连接是不同的探测状态')

    let unsafeActions = 0
    const wouldMutate = { run: () => { unsafeActions++ }, stop: async () => { unsafeActions++ }, kill: async () => { unsafeActions++ } }
    for (const handler of [
      () => new Response(null, { status: 401 }),
      () => modelsResponse(),
      () => new Response(null, { status: 302, headers: { location: `${origin(idlePort)}/v1/models` } }),
      (_url, { signal }) => new Promise((_resolve, reject) => {
        const ref = setTimeout(() => reject(new Error('fixture abort did not fire')), 2_000)
        signal.addEventListener('abort', () => { clearTimeout(ref); reject(signal.reason) }, { once: true })
      })
    ]) {
      hosts.set(origin(authPort), authHandler(handler))
      const unknown = await api.ensureLocalModelReady('auth', 'auth', wouldMutate)
      ok(!unknown.ok && !unknown.started && unsafeActions === 0, '已有 TCP 监听时认证失败、空列表、重定向及超时均不放行且不启停')
    }

    hosts.set(origin(idlePort), (_url, { headers }) =>
      !headers.has('x-api-key') && !headers.has('x-fixture') ? modelsResponse('redirected') : new Response(null, { status: 401 }))
    ok((await api.ensureLocalModelReady('auth', 'redirected', wouldMutate)).ok, '跨源模型级地址不继承服务商凭据和自定义请求头')
    hosts.set(origin(authPort), authHandler((url) =>
      url.pathname === '/gateway/v1/models' ? modelsResponse('auth') : new Response(null, { status: 404 })))
    ok((await api.testCustomProviderEndpoint('auth')).ok &&
      (await api.discoverCustomProviderModels({ id: 'auth', baseUrl: authUrl, api: 'anthropic-messages' })).models.join() === 'auth',
      '自定义服务商探测与发现复用结构化地址及安全认证')
    hosts.set(origin(authPort), () => new Response('<html></html>'))
    ok(!(await api.testCustomProviderEndpoint('auth')).ok, '自定义服务商不会把 HTML 200 判为模型列表可用')

    const fixture = globalThis[fixtures]
    const failure = async (task) => task().then(() => '', (error) => error.message)
    const initialModels = await readFile(modelFile, 'utf8')
    const initialLaunchers = await readFile(launcherFile, 'utf8')
    fixture.beforeLauncherWrite = async () => { throw new Error('fixture launcher write failed') }
    const rejectedAdd = await failure(() => api.addLocalModel('ninfer', { id: 'rollback', command: 'serve-rollback' }))
    ok(rejectedAdd.includes('fixture launcher write failed') && await readFile(modelFile, 'utf8') === initialModels &&
      await readFile(launcherFile, 'utf8') === initialLaunchers, '新增第二步失败后按原始内容回滚两份配置')
    delete fixture.beforeLauncherWrite
    const retried = await api.addLocalModel('ninfer', { id: 'rollback', command: 'serve-rollback' })
    ok(retried.launchers.some((entry) => entry.provider === 'ninfer' && entry.models.some((model) => model.id === 'rollback' && model.command === 'serve-rollback')),
      '回滚后可重试新增同一个 ID')

    const beforeRemove = await readFile(modelFile, 'utf8')
    const beforeRemoveLaunchers = await readFile(launcherFile, 'utf8')
    const wroteModels = deferred()
    const releaseFailure = deferred()
    fixture.beforeLauncherWrite = async () => {
      delete fixture.beforeLauncherWrite
      wroteModels.resolve()
      await releaseFailure.promise
      throw new Error('fixture launcher write failed')
    }
    const removing = failure(() => api.removeLocalModel('ninfer', 'rollback'))
    await wroteModels.promise
    ok(!JSON.parse(await readFile(modelFile, 'utf8')).providers.ninfer.models.some(({ id }) => id === 'rollback'), '故障注入发生在删除已写 models.json 而未写启动器之间')
    const concurrent = [
      api.saveCustomProvider({ id: 'yan-concurrent', api: 'openai-completions', baseUrl: 'https://api.example.com/v1', models: [{ id: 'other' }] }),
      api.saveLocalLauncher('multi', { modelId: 'old', modelCommand: 'serve-old' }),
      api.addLocalModel('ninfer', { id: 'parallel', command: 'serve-parallel' })
    ]
    releaseFailure.resolve()
    const [removeError, customSaved] = await Promise.all([removing, ...concurrent])
    const afterConcurrent = JSON.parse(await readFile(modelFile, 'utf8'))
    const launchersConcurrent = JSON.parse(await readFile(launcherFile, 'utf8'))
    ok(removeError.includes('fixture launcher write failed') && customSaved.ok && afterConcurrent.providers['yan-concurrent'] &&
      afterConcurrent.providers.ninfer.models.some(({ id }) => id === 'rollback') && afterConcurrent.providers.ninfer.models.some(({ id }) => id === 'parallel') &&
      launchersConcurrent.launchers.multi.models.old.command === 'serve-old' && launchersConcurrent.launchers.ninfer.models.parallel.command === 'serve-parallel' &&
      launchersConcurrent.launchers.ninfer.models.rollback.command === JSON.parse(beforeRemoveLaunchers).launchers.ninfer.models.rollback.command &&
      JSON.parse(beforeRemove).providers.ninfer.models.some(({ id }) => id === 'rollback'),
      '删除补偿与自定义服务商保存、另一个启动器保存及新增共享队列，不互相覆盖')

    fixture.beforeLauncherWrite = async () => {
      const external = JSON.parse(await readFile(modelFile, 'utf8'))
      await writeFile(modelFile, JSON.stringify({ ...external, externalChange: true }))
      throw new Error('fixture launcher write failed')
    }
    const conflict = await failure(() => api.removeLocalModel('ninfer', 'rollback'))
    ok(/部分提交|Partial commit/.test(conflict) && JSON.parse(await readFile(modelFile, 'utf8')).externalChange === true,
      '补偿前发现外部改写，不覆盖外部改动并返回部分提交错误')
  } finally {
    delete globalThis[fixtures]
    globalThis.fetch = oldFetch
    if (oldKey === undefined) delete process.env[envName]
    else process.env[envName] = oldKey
    await rm(dir, { recursive: true, force: true })
  }
})
