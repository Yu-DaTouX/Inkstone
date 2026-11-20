import './lib/test-isolate.mjs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

function freePort() {
  return new Promise((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function serve(port, modelId = 'qwen') {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(req.url === '/v1/models' ? 200 : 404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: modelId }] }))
    })
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

const close = (server) => new Promise((resolve) => server.close(resolve))

await runSuite(import.meta.url, async (ok, compile) => {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-local-launch-'))
  process.env.YAN_PI_DIR = dir
  process.env.YAN_DATA_DIR = join(dir, 'yan')
  const servers = []
  try {
    const port = await freePort()
    const idlePort = await freePort()
    const failPort = await freePort()
    await writeFile(join(dir, 'models.json'), JSON.stringify({
      providers: {
        ninfer: { name: '本地 NInfer', baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', models: [{ id: 'qwen' }] },
        idle: { baseUrl: `http://127.0.0.1:${idlePort}/v1`, api: 'openai-completions', models: [{ id: 'm' }] },
        broken: { baseUrl: `http://127.0.0.1:${failPort}/v1`, api: 'openai-completions', models: [{ id: 'b' }] },
        cloud: { baseUrl: 'https://api.example.com/v1', api: 'openai-completions', models: [{ id: 'gpt' }] }
      }
    }))
    const api = await compile('src/main/local-model-launch.ts')
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
        setTimeout(() => void serve(port).then((server) => servers.push(server)), 120)
      }
    }
    const [first, second] = await Promise.all([api.ensureLocalModelReady('ninfer', 'qwen', options), api.ensureLocalModelReady('ninfer', 'qwen', options)])
    ok(first.ok && second.ok && first.started, '服务未运行时启动并等到 /v1/models 就绪')
    ok(runs === 1 && notices === 1, '同时发两条消息只启动一次、只提示一次', `runs=${runs} notices=${notices}`)

    const again = await api.ensureLocalModelReady('ninfer', 'qwen', { run: () => { runs++ } })
    ok(again.ok && !again.started && runs === 1, '服务已在运行时不再启动')

    const failing = new EventEmitter()
    const startedAt = Date.now()
    const broken = await api.ensureLocalModelReady('broken', 'b', { pollMs: 20, timeoutMs: 5_000, run: () => { setTimeout(() => failing.emit('exit', 1), 30); return failing } })
    ok(!broken.ok && /代码 1|code 1/.test(broken.error ?? '') && Date.now() - startedAt < 2_000, '启动命令出错退出时立即失败，不等到超时')

    const stuck = await api.ensureLocalModelReady('idle', 'm', { pollMs: 20, timeoutMs: 150, run: () => {} })
    ok(!stuck.ok && /草稿已保留|draft kept/.test(stuck.error ?? ''), '超时没就绪时不发送并说明草稿保留')

    let busy = true
    const unloadCalls = []
    let clock = 1_000_000
    const scan = (extra = {}) => api.scanIdleLocalModels({
      busy: () => busy,
      now: () => clock,
      unload: async (provider) => {
        unloadCalls.push(provider)
        return true
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
    const killed = []
    const result = await api.unloadLocalModel('ninfer', {
      stop: async (command) => {
        stops.push(command)
        await Promise.all(servers.splice(0).map(close))
      },
      kill: async (pid) => { killed.push(pid) },
      closeWaitMs: 2_000
    })
    ok(result && stops[0] === stopBat && killed.length === 0, '有停止命令时运行停止命令并确认端口已关闭')

    const killServer = await serve(port)
    await api.saveLocalLauncher('ninfer', { command: startBat })
    const killResult = await api.unloadLocalModel('ninfer', {
      listener: async (value) => (value === port ? 4242 : null),
      kill: async (pid) => {
        killed.push(pid)
        await close(killServer)
      },
      closeWaitMs: 2_000
    })
    ok(killResult && killed[0] === 4242, '没有停止命令时结束占用端口的进程')

    ok(api.launcherFromProcess({ command: '"E:\\AI\\ninfer\\engine\\ninfer-serve.exe" model --vision', parent: 'C:\\Windows\\system32\\cmd.exe /c ""E:\\AI\\ninfer\\启动-NInfer.bat" "' }) === 'E:\\AI\\ninfer\\启动-NInfer.bat', '由 bat 拉起时识别出 bat 路径')
    ok(api.launcherFromProcess({ command: 'C:\\ollama\\ollama.exe serve', parent: 'C:\\Windows\\explorer.exe' }) === 'C:\\ollama\\ollama.exe serve', '没有启动脚本时用进程本身的命令行')
    ok(api.launcherFromProcess({ command: null, parent: null }) === null, '读不到进程信息时不猜')

    const netstat = '  TCP    0.0.0.0:135     0.0.0.0:0   LISTENING   1100\r\n  TCP    127.0.0.1:8080  0.0.0.0:0   LISTENING   29872\r\n  TCP    127.0.0.1:8080  127.0.0.1:5000  ESTABLISHED  29872'
    ok(api.listeningPid(netstat, 8080) === 29872 && api.listeningPid(netstat, 80) === null, '从 netstat 输出找监听端口的进程')

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

    const qwenRunning = await serve(port, 'qwen')
    servers.push(qwenRunning)

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
      unload: async () => {
        unloadedOld = true
        await Promise.all(servers.splice(0).map(close))
        return true
      },
      run: (cmd) => {
        launchedCmd = cmd
        setTimeout(() => void serve(port, 'scarletkc-2.0').then((s) => servers.push(s)), 80)
      }
    })
    ok(switched.ok && switched.started && unloadedOld && launchedCmd === scarletBat && switchedNotice === 'ScarletKc2', '同端口跑着旧模型时自动卸载旧模型并启动新模型脚本', `ok=${switched.ok} unloaded=${unloadedOld} cmd=${launchedCmd} notice=${switchedNotice}`)

    const alreadyScarlet = await api.ensureLocalModelReady('ninfer', 'scarletkc-2.0', {
      run: () => { throw new Error('已经在跑目标模型不该重启') }
    })
    ok(alreadyScarlet.ok && !alreadyScarlet.started, '端口已提供目标模型时直接放行不重启')

    const mismatch = await api.ensureLocalModelReady('ninfer', 'qwen', {
      pollMs: 25,
      timeoutMs: 5_000,
      mismatchLimit: 2,
      busy: () => false,
      unload: async () => {
        await Promise.all(servers.splice(0).map(close))
        return true
      },
      run: () => {
        setTimeout(() => void serve(port, 'scarletkc-2.0').then((s) => servers.push(s)), 40)
      }
    })
    ok(!mismatch.ok && /scarletkc-2\.0/.test(mismatch.error ?? '') && /qwen/.test(mismatch.error ?? ''), '启动后服务返回的模型 ID 与配置不匹配时立即报错提示')

    const onlyModelIdleUnloaded = []
    let idleClock = Date.now() + 1_000
    await api.scanIdleLocalModels({ busy: () => false, now: () => idleClock, unload: async (p) => { onlyModelIdleUnloaded.push(p); return true } })
    idleClock += 11 * 60_000
    await api.scanIdleLocalModels({ busy: () => false, now: () => idleClock, unload: async (p) => { onlyModelIdleUnloaded.push(p); return true } })
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
  } finally {
    await Promise.all(servers.map(close))
    await rm(dir, { recursive: true, force: true })
  }
})
