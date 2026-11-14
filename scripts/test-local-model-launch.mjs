import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

function serve(port) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(req.url === '/v1/models' ? 200 : 404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'qwen' }] }))
    })
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

await runSuite(import.meta.url, async (ok, compile) => {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-local-launch-'))
  process.env.YAN_PI_DIR = dir
  process.env.YAN_DATA_DIR = join(dir, 'yan')
  const servers = []
  try {
    const port = await freePort()
    const idlePort = await freePort()
    await writeFile(join(dir, 'models.json'), JSON.stringify({
      providers: {
        ninfer: { name: '本地 NInfer', baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', models: [{ id: 'qwen' }] },
        idle: { baseUrl: `http://127.0.0.1:${idlePort}/v1`, api: 'openai-completions', models: [{ id: 'm' }] },
        cloud: { baseUrl: 'https://api.example.com/v1', api: 'openai-completions', models: [{ id: 'gpt' }] }
      }
    }))
    const api = await compile('src/main/local-model-launch.ts')
    await mkdir(join(dir, 'yan'), { recursive: true })
    await writeFile(join(dir, 'yan', 'local-models.json'), JSON.stringify({ urls: ['http://127.0.0.1:9999'] }))

    const listed = await api.listLocalLaunchers()
    ok(listed.map((item) => item.provider).join(',') === 'idle,ninfer', '只列出地址在本机或局域网的服务商')
    ok(listed.find((item) => item.provider === 'ninfer')?.name === '本地 NInfer', '显示 models.json 里的服务商名称')

    await api.saveLocalLauncher('ninfer', '  E:\\AI\\ninfer\\start.bat  ')
    await api.saveLocalLauncher('idle', 'serve-idle')
    const config = JSON.parse(await readFile(join(dir, 'yan', 'local-models.json'), 'utf8'))
    ok(config.launchers.ninfer.command === 'E:\\AI\\ninfer\\start.bat', '保存启动命令并去掉首尾空白')
    ok(config.urls?.[0] === 'http://127.0.0.1:9999', '保存时保留同一文件里的本地地址配置')
    let refused = false
    try {
      await api.saveLocalLauncher('cloud', 'evil.exe')
    } catch {
      refused = true
    }
    ok(refused, '云端服务商不能设置启动命令')

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
        ok(command === 'E:\\AI\\ninfer\\start.bat', '运行的是用户保存的启动命令')
        setTimeout(() => void serve(port).then((server) => servers.push(server)), 120)
      }
    }
    const [first, second] = await Promise.all([api.ensureLocalModelReady('ninfer', 'qwen', options), api.ensureLocalModelReady('ninfer', 'qwen', options)])
    ok(first.ok && second.ok && first.started, '服务未运行时启动并等到 /v1/models 就绪')
    ok(runs === 1 && notices === 1, '同时发两条消息只启动一次、只提示一次', `runs=${runs} notices=${notices}`)

    const again = await api.ensureLocalModelReady('ninfer', 'qwen', { run: () => { runs++ } })
    ok(again.ok && !again.started && runs === 1, '服务已在运行时不再启动')

    const stuck = await api.ensureLocalModelReady('idle', 'm', { pollMs: 20, timeoutMs: 150, run: () => {} })
    ok(!stuck.ok && /草稿已保留|draft kept/.test(stuck.error ?? ''), '超时没就绪时不发送并说明草稿保留')

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
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
    await rm(dir, { recursive: true, force: true })
  }
})
