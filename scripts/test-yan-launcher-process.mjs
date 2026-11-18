import './lib/test-isolate.mjs'
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { runSuite } from './lib/test-suite.mjs'

const win = process.platform === 'win32'
const nonAscii = /[^\x00-\x7f]/

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitFor = async (check, ms) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((done) => setTimeout(done, 40))
  }
  return check()
}

const inner = (launcher, args) => [launcher, ...args].map((part) => `"${part}"`).join(' ')

const cmdLine = (launcher, args) => `"${inner(launcher, args)}"`

const viaCmd = (launcher, args) =>
  spawnSync('cmd.exe', ['/d', '/s', '/c', cmdLine(launcher, args)], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 30_000 })

await runSuite(import.meta.url, async (ok, compile) => {
  const cli = await compile('src/main/yan-cli.ts')

  const asciiText = cli.cmdLauncherText('C:/fake/electron.exe', 'C:/fake/yan.mjs')
  const asciiLines = asciiText.split('\r\n')
  ok(!asciiText.includes('chcp 65001') && asciiLines.includes('set YAN_CMD="C:/fake/electron.exe" "C:/fake/yan.mjs"') && asciiLines.includes('%YAN_CMD% %*') && asciiLines.includes('exit /b %YAN_EC%'), '纯 ASCII 路径的 cmd 启动器不切代码页，调用 exe 的那一行只到 %* 为止，exit /b 另起一行')
  const wideText = cli.cmdLauncherText('C:/Program Files/砚/砚.exe')
  const lines = wideText.split('\r\n')
  ok(wideText.endsWith('\r\n') && !wideText.includes('\n\n') && lines.findIndex((line) => line.startsWith('chcp 65001')) < lines.findIndex((line) => line.includes('砚.exe')), '含中文的路径只出现在 chcp 65001 之后的行里')
  const headOf = (text) => text.slice(0, text.indexOf(':cfg\r\n') + 6)
  const headBytes = (text) => Buffer.byteLength(headOf(text))
  ok(headOf(asciiText).length > 20 && headOf(asciiText) === headOf(wideText) && headOf(asciiText) === headOf(cli.cmdLauncherText('D:/一/二 三/node.exe')) && headBytes(asciiText) === headBytes(cli.cmdLauncherText('C:/a/very/long/path/'.repeat(20) + 'x.exe')), '各版本启动器在 :cfg 之前的内容与字节偏移完全相同，与路径长短、有无中文无关')
  ok(!/[^\x00-\x7f]/.test(headOf(wideText)) && !/%\*[^\r]*&/.test(wideText), '启动器头部是纯 ASCII，且 %* 行后面没有 & 拼接')
  const cpLines = wideText.split('\r\n').filter((line) => /chcp/.test(line))
  ok(cpLines.some((line) => line.includes('/d /c chcp')) && wideText.includes('delims=0123456789') && wideText.includes('YAN_CP:.='), '取代码页的子 cmd 带 /d，去掉句点并校验为纯数字')
  ok(cli.cmdLauncherText('C:/100%/electron.exe').includes('"C:/100%%/electron.exe"'), '路径里的百分号按批处理转义')

  const failDir = join(tmpdir(), `yan-launcher-fail-${process.pid}`)
  rmSync(failDir, { recursive: true, force: true })
  try {
    const failBin = join(failDir, 'bin')
    mkdirSync(join(failBin, 'yan-node.cmd'), { recursive: true })
    const reported = []
    const result = cli.ensureYanLauncher({ devResourcesDir: resolve('resources'), execPath: 'C:/fake/electron.exe', binDir: failBin, onNodeLauncherError: (error) => reported.push(error) })
    ok(!!result && readFileSync(result.launcher, 'utf8').includes('C:/fake/electron.exe') && existsSync(join(failBin, 'yan')), 'yan-node 启动器写不进去时 yan 启动器照常生成并返回，能力服务不受牵连')
    ok(reported.length === 1, 'yan-node 写失败只通知日志回调一次', String(reported.length))
    ok(!readdirSync(failBin).some((name) => name.endsWith('.tmp')), '写失败不留临时文件')
    let direct = false
    try {
      cli.ensureNodeLauncher({ execPath: 'C:/fake/electron.exe', binDir: failBin })
    } catch {
      direct = true
    }
    ok(direct, '直接生成 yan-node 入口失败时仍抛错，供 Minecraft 插件安装与刷新报告')

    if (win) {
      const lockBin = join(failDir, 'lock')
      cli.ensureNodeLauncher({ execPath: 'C:/old/electron.exe', binDir: lockBin })
      const target = join(lockBin, 'yan-node.cmd')
      const holder = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `$f = [IO.File]::Open('${target}', 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); Start-Sleep -Milliseconds 150; $f.Close()`], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      const closed = new Promise((done) => holder.once('close', done))
      try {
        const held = await new Promise((done) => {
          const timer = setTimeout(() => done('timeout'), 20_000)
          const finish = (status) => {
            clearTimeout(timer)
            done(status)
          }
          holder.stdout.on('data', (data) => {
            if (String(data).includes('locked')) finish('locked')
          })
          holder.on('error', (error) => finish(error.code === 'ENOENT' ? 'missing' : error.code))
          void closed.then(() => finish('closed'))
        })
        if (held === 'missing') {
          ok(true, '本机没有 pwsh，跳过占用重试用例')
        } else {
          ok(held === 'locked', 'pwsh 确实取得了文件锁', String(held))
          cli.ensureNodeLauncher({ execPath: 'C:/new/electron.exe', binDir: lockBin })
          ok(readFileSync(target, 'utf8').includes('C:/new/electron.exe'), '目标文件被短暂占用（杀毒、另一实例）时改名重试后成功')
        }
      } finally {
        holder.kill()
        await closed
      }
    }
  } finally {
    rmSync(failDir, { recursive: true, force: true })
  }

  if (!win) return

  const root = join(tmpdir(), `砚 中文用户-${process.pid}`)
  rmSync(root, { recursive: true, force: true })
  const pending = []
  try {
    const installDir = join(root, '安装 目录')
    const binDir = join(root, 'yan', 'bin')
    mkdirSync(installDir, { recursive: true })
    const wideExe = join(installDir, '砚.exe')
    copyFileSync(process.execPath, wideExe)
    const probe = join(root, 'probe.mjs')
    writeFileSync(probe, 'const args = process.argv.slice(2)\nprocess.stdout.write(JSON.stringify(args))\nprocess.exit(args[0] === "fail" ? 7 : 0)\n')

    const made = cli.ensureYanLauncher({ devResourcesDir: resolve('resources'), execPath: wideExe, binDir })
    ok(!!made && nonAscii.test(made.launcher + wideExe), '中文用户目录与中文 exe 名下生成启动器')
    const nodeCmd = cli.nodeLauncherPath(binDir)

    const plain = viaCmd(nodeCmd, [probe, 'x'])
    ok(plain.status === 0 && plain.stdout === '["x"]', 'yan-node.cmd 在中文路径下用 cmd.exe 能真正启动 exe', `${plain.status} ${plain.stdout} ${plain.stderr}`)
    const special = viaCmd(nodeCmd, [probe, 'a b', '50%', 'x&y', 'hi!'])
    ok(special.status === 0 && special.stdout === JSON.stringify(['a b', '50%', 'x&y', 'hi!']), '含空格、百分号、&、! 的参数原样传到', `${special.stdout} ${special.stderr}`)
    const failing = viaCmd(nodeCmd, [probe, 'fail'])
    ok(failing.status === 7 && failing.stdout === '["fail"]', 'exe 的退出码原样传给调用方', `${failing.status}`)

    const oddRaw = (launcher, rest) => spawnSync('cmd.exe', ['/d', '/s', '/c', `""${launcher}" ${rest}"`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 30_000 })
    const odd = oddRaw(nodeCmd, `"${probe}" "a\\"b" c`)
    ok(odd.status === 0 && odd.stdout === JSON.stringify(['a"b', 'c']) && odd.stderr === '', '参数含奇数个字面双引号时原样传到，exe 不会多收到 &、call、exit 之类的参数（中文路径）', `${odd.status} ${odd.stdout} ${odd.stderr}`)
    const oddFail = oddRaw(nodeCmd, `"${probe}" fail "x\\"y"`)
    ok(oddFail.status === 7 && oddFail.stdout === JSON.stringify(['fail', 'x"y']), '奇数引号参数下退出码照样带回', `${oddFail.status} ${oddFail.stdout}`)

    const help = viaCmd(made.launcher, ['--help'])
    ok(help.status === 0 && help.stdout.length > 100, 'yan.cmd 在中文路径下也能启动并跑起 yan CLI', `${help.status} ${help.stderr}`)

    const probeCp = join(root, 'cp.cmd')
    writeFileSync(probeCp, '@echo off\r\nchcp\r\n')
    const cpNumber = (text) => text.split(/\r?\n/).filter(Boolean).map((line) => /(\d+)\s*$/.exec(line)?.[1])
    const cp = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${probeCp}" & ${inner(nodeCmd, [probe, 'x'])} & "${probeCp}""`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true })
    const seen = cpNumber(cp.stdout.replace('["x"]', '\n'))
    ok(seen.length === 2 && seen[0] === seen[1], '启动器结束后控制台代码页恢复原值，不留给用户终端', JSON.stringify(seen))

    const driver = join(root, 'driver.cmd')
    writeFileSync(driver, `@echo off\r\nchcp\r\ncall "%YAN_L%" "%YAN_P%" "a\\"b" fail\r\necho EC=%ERRORLEVEL%\r\nchcp\r\n`)
    const drv = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${driver}""`], { env: { ...process.env, YAN_L: nodeCmd, YAN_P: probe }, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 30_000 })
    const drvCps = drv.stdout.split(/\r?\n/).map((line) => /: *(\d+)$/.exec(line)?.[1]).filter(Boolean)
    ok(drvCps.length === 2 && drvCps[0] === drvCps[1] && /EC=0/.test(drv.stdout) && drv.stdout.includes('["a\\"b","fail"]'), '奇数引号参数下中文分支仍恢复代码页，并回到 call 它的批处理继续往下跑', JSON.stringify(drv.stdout))

    const realCp = /(\d+)\D*$/m.exec(spawnSync('cmd.exe', ['/d', '/c', 'chcp'], { encoding: 'utf8', windowsHide: true }).stdout.trim())?.[1]
    const germanFile = join(root, 'german.txt')
    writeFileSync(germanFile, `Aktive Codepage: ${realCp}.\r\n`)
    const germanLauncher = join(root, 'german.cmd')
    const wideLauncherText = readFileSync(nodeCmd, 'utf8')
    const germanText = wideLauncherText.replace('"%ComSpec%" /d /c chcp', 'type "%YAN_G%"')
    writeFileSync(germanLauncher, germanText)
    const germanDriver = join(root, 'german-driver.cmd')
    writeFileSync(germanDriver, '@echo off\r\ncall "%YAN_L%" "%YAN_P%" x\r\nchcp\r\n')
    const german = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${germanDriver}""`], { env: { ...process.env, YAN_L: germanLauncher, YAN_P: probe, YAN_G: germanFile }, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 30_000 })
    const germanCp = german.stdout.split(/\r?\n/).map((line) => /: *(\d+)$/.exec(line)?.[1]).filter(Boolean)
    ok(germanText !== wideLauncherText && german.stdout.includes('["x"]') && JSON.stringify(germanCp) === JSON.stringify([realCp]), 'chcp 输出带句点（Aktive Codepage: 936.）时仍恢复成纯数字的原代码页', `${JSON.stringify(german.stdout)} ${realCp}`)
    spawnSync('cmd.exe', ['/d', '/c', `chcp ${realCp} >nul`], { windowsHide: true })

    const oddDir = join(root, 'a&b^c 100%')
    mkdirSync(oddDir, { recursive: true })
    const oddExe = join(oddDir, '砚&^.exe')
    copyFileSync(process.execPath, oddExe)
    const oddBin = join(root, 'oddbin')
    cli.ensureNodeLauncher({ execPath: oddExe, binDir: oddBin })
    const oddRun = viaCmd(cli.nodeLauncherPath(oddBin), [probe, 'fail'])
    ok(oddRun.status === 7 && oddRun.stdout === '["fail"]', 'exe 路径含 & ^ % 空格与中文时照样启动，退出码带回', `${oddRun.status} ${oddRun.stdout} ${oddRun.stderr}`)

    const scratch = join(root, 'asciicheck')
    mkdirSync(scratch, { recursive: true })
    const slow = join(root, 'slow.mjs')
    writeFileSync(slow, 'import { writeFileSync } from "node:fs"\nwriteFileSync(process.argv[2], String(process.pid))\nsetTimeout(() => { process.stdout.write("done\\n"); process.exit(3) }, 1500)\n')
    const runSlow = async (launcher, rewrite) => {
      const mark = join(scratch, `slow-${Math.random().toString(16).slice(2)}.pid`)
      const child = spawn('cmd.exe', ['/d', '/s', '/c', cmdLine(launcher, [slow, mark])], { windowsHide: true, windowsVerbatimArguments: true })
      let out = ''
      let err = ''
      child.stdout.on('data', (data) => (out += data))
      child.stderr.on('data', (data) => (err += data))
      const closed = new Promise((done) => child.on('close', done))
      pending.push(child)
      await waitFor(() => existsSync(mark), 15_000)
      rewrite()
      const code = await closed
      return { code, out, err }
    }
    const longer = join(root, 'x& echo LEAKED &', `${'z'.repeat(60)}.exe`)
    const during = await runSlow(nodeCmd, () => cli.ensureNodeLauncher({ execPath: longer, binDir }))
    ok(during.code === 3 && during.out === 'done\n' && during.err === '', '另一个实例在 exe 运行期间改写 yan-node.cmd，当前这次调用结束后不会执行到新文件的残段', `${during.code} ${JSON.stringify(during.out)} ${JSON.stringify(during.err)}`)
    ok(readFileSync(nodeCmd, 'utf8').includes('zzzz') && !readdirSync(binDir).some((name) => name.endsWith('.tmp')), '改写走临时文件加改名，不留临时文件')
    cli.ensureNodeLauncher({ execPath: wideExe, binDir })
    const toAscii = await runSlow(nodeCmd, () => cli.ensureNodeLauncher({ execPath: 'C:/a/b.exe', binDir }))
    ok(toAscii.code === 3 && toAscii.out === 'done\n' && toAscii.err === '', '中文启动器运行期间被改写成纯 ASCII 版本，也不会执行到残段', `${toAscii.code} ${JSON.stringify(toAscii.out)} ${JSON.stringify(toAscii.err)}`)
    cli.ensureNodeLauncher({ execPath: wideExe, binDir })

    if (!nonAscii.test(tmpdir())) {
      const asciiRoot = join(tmpdir(), `yan-launcher-ascii-${process.pid}`)
      try {
        const asciiBin = join(asciiRoot, 'bin')
        mkdirSync(join(asciiRoot, 'app'), { recursive: true })
        const asciiExe = join(asciiRoot, 'app', 'node.exe')
        copyFileSync(process.execPath, asciiExe)
        cli.ensureNodeLauncher({ execPath: asciiExe, binDir: asciiBin })
        const asciiCmd = cli.nodeLauncherPath(asciiBin)
        const asciiRun = viaCmd(asciiCmd, [probe, 'fail'])
        ok(!readFileSync(asciiCmd, 'utf8').includes('chcp 65001') && asciiRun.status === 7 && asciiRun.stdout === '["fail"]', 'ASCII 路径的启动器直接运行，退出码原样传出')
        const asciiOdd = oddRaw(asciiCmd, `"${probe}" "a\\"b" c`)
        ok(asciiOdd.status === 0 && asciiOdd.stdout === JSON.stringify(['a"b', 'c']) && asciiOdd.stderr === '', 'ASCII 启动器同样原样传奇数个双引号的参数', `${asciiOdd.status} ${asciiOdd.stdout} ${asciiOdd.stderr}`)
        const asciiToWide = await runSlow(asciiCmd, () => cli.ensureNodeLauncher({ execPath: join(root, '砚', `${'q'.repeat(50)}.exe`), binDir: asciiBin }))
        ok(asciiToWide.code === 3 && asciiToWide.out === 'done\n' && asciiToWide.err === '', 'ASCII 启动器运行期间被改写成中文版本，也不会执行到残段', `${asciiToWide.code} ${JSON.stringify(asciiToWide.out)} ${JSON.stringify(asciiToWide.err)}`)
        cli.ensureNodeLauncher({ execPath: asciiExe, binDir: asciiBin })
        const asciiDuring = await runSlow(asciiCmd, () => cli.ensureNodeLauncher({ execPath: longer.replace(root, asciiRoot).replace(/[^\x00-\x7f]/g, 'x'), binDir: asciiBin }))
        ok(asciiDuring.code === 3 && asciiDuring.out === 'done\n' && asciiDuring.err === '', 'ASCII 启动器运行期间被改写同样不会执行到残段', `${asciiDuring.code} ${JSON.stringify(asciiDuring.err)}`)
      } finally {
        rmSync(asciiRoot, { recursive: true, force: true })
      }
    }

    cli.ensureNodeLauncher({ execPath: wideExe, binDir })
    const server = join(root, 'server.mjs')
    const serverSource = (exitOnEof) => [
      'import { writeFileSync } from "node:fs"',
      `writeFileSync(${JSON.stringify(join(root, 'server.pid'))}, String(process.pid))`,
      'process.stdin.on("data", () => {})',
      exitOnEof ? 'process.stdin.on("end", () => process.exit(0))' : '',
      'setInterval(() => {}, 1000)'
    ].join('\n')
    const startServer = async (exitOnEof) => {
      const pidFile = join(root, 'server.pid')
      rmSync(pidFile, { force: true })
      writeFileSync(server, serverSource(exitOnEof))
      const transport = new StdioClientTransport({ command: nodeCmd, args: ['--no-warnings', server], env: { ELECTRON_RUN_AS_NODE: '1', SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', PATH: process.env.PATH ?? '' }, stderr: 'ignore' })
      await transport.start()
      await waitFor(() => existsSync(pidFile), 15_000)
      return { transport, pid: Number(readFileSync(pidFile, 'utf8')) }
    }
    const polite = await startServer(true)
    pending.push({ kill: () => { try { process.kill(polite.pid) } catch {} } })
    ok(alive(polite.pid) && polite.pid !== polite.transport.pid, '经 yan-node.cmd 启动的服务进程在 cmd.exe 之下运行')
    await polite.transport.close()
    ok(await waitFor(() => !alive(polite.pid), 4000), '客户端关闭 stdin 后按 stdin 结束退出的服务（Minecraft MCP 的写法）不会成为孤儿')
  } finally {
    for (const child of pending) {
      try {
        child.kill()
      } catch {
      }
    }
    await new Promise((done) => setTimeout(done, 200))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
