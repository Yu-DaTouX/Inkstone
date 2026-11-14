#!/usr/bin/env node
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok) => {
  for (const name of ['PI_CODING_AGENT_DIR', 'YAN_DATA_DIR', 'TMPDIR', 'DIR', 'D', 'X', 'name']) delete process.env[name]
  const root = await mkdtemp(join(tmpdir(), 'inkstone-danger-critical-'))
  const project = join(root, 'project')
  await mkdir(project, { recursive: true })
  try {
    const guard = await import(pathToFileURL(join(process.cwd(), 'resources/pi-extensions/danger-guard.js')).href)
    const check = (tool, command) => guard.criticalDanger(tool, { command }, project)
    const encode = (text) => Buffer.from(text, 'utf16le').toString('base64')
    const home = homedir()

    const hits = [
      ['bash', 'rm -rf /', '文件系统根'],
      ['bash', 'rm -rf C:\\', 'C:\\'],
      ['bash', 'rm -rf C:', '只写盘符'],
      ['bash', 'rm -rf /c/', 'MSYS 盘根'],
      ['powershell', 'Remove-Item -Recurse -Force \\\\?\\C:\\', '长路径前缀盘根'],
      ['bash', 'pwsh -Command "Remove-Item -Recurse -Force \'\\\\\\\\?\\\\C:\\\\\'"', '双层反斜杠写法的长路径前缀盘根'],
      ['bash', 'pwsh -Command "Remove-Item -Recurse \'\\\\\\\\?\\\\Volume{0b2d6c8e-0000-0000-0000-100000000000}\\\\\'"', '双层反斜杠写法的卷 GUID'],
      ['bash', 'rm -rf \\\\localhost\\C$', '管理共享盘根'],
      ['bash', 'rm -rf ~', '~'],
      ['bash', 'rm -rf $HOME', '$HOME'],
      ['bash', 'rm -rf "$HOME"', '带引号的 $HOME'],
      ['bash', `rm -rf "${home}"`, '用户目录绝对路径'],
      ['bash', 'rm -rf C:\\Users\\YUDATO~1', '8.3 短名用户目录'],
      ['bash', 'rm -rf .', '当前目录'],
      ['bash', 'rm -rf *', '当前目录通配'],
      ['bash', 'rm -rf ..', '上级目录'],
      ['bash', 'cd .. && rm -rf *', '切到上级后通配'],
      ['bash', 'rm -rf "$DIR"/*', '未赋值变量加通配'],
      ['bash', 'rm -rf $1/*', '位置参数加通配'],
      ['bash', 'rm -rf $TMPDIR/mnt', '未赋值变量拼出顶层目录'],
      ['bash', 'D=$(pwd); rm -rf "$D"', '变量取自 pwd'],
      ['bash', 'rm -rf "$(pwd)"', '命令替换 pwd'],
      ['bash', 'rm -rf ~/$(cmd)', '用户目录下接命令替换'],
      ['bash', 'rm -rf "$(cat list.txt)"', '目标只来自命令替换'],
      ['bash', 'rm -rf "\\\\"', '只有反斜杠'],
      ['powershell', 'Remove-Item -Recurse \\\\?\\Volume{0b2d6c8e-0000-0000-0000-100000000000}\\', '卷 GUID'],
      ['bash', 'bash -c "rm -rf /"', 'bash -c 包装'],
      ['bash', 'cmd /c rd /s /q C:\\Users', 'cmd rd /s 顶层目录'],
      ['bash', 'powershell -c "Remove-Item -Recurse -Force C:\\"', 'powershell -c 包装'],
      ['powershell', `powershell -EncodedCommand ${encode('Remove-Item -Recurse -Force C:\\')}`, '编码命令解码后删盘根'],
      ['powershell', 'powershell -enc !!!', '无法解读的编码命令'],
      ['powershell', 'Remove-Item -Recurse C:\\$name', '盘根下接未赋值变量'],
      ['bash', 'find . -name x | xargs rm -rf', '管道输入递归删除'],
      ['bash', `del /q "${home}"`, '非递归 del 删用户目录'],
      ['bash', 'rm -rf /usr', '顶层系统目录'],
      ['bash', 'rm -rf ~/.pi/agent', 'pi 数据目录'],
      ['bash', 'format C:', 'format'],
      ['bash', 'diskpart /s wipe.txt', 'diskpart'],
      ['powershell', 'Format-Volume -DriveLetter D', 'Format-Volume'],
      ['powershell', 'Clear-Disk -Number 1 -RemoveData', 'Clear-Disk']
    ]
    for (const [tool, command, label] of hits) {
      const reasons = check(tool, command)
      ok(reasons.length > 0, `命中：${label}`, `${command} -> ${JSON.stringify(reasons)}`)
    }

    const misses = [
      ['bash', 'rm -rf dist', '项目内目录'],
      ['powershell', 'Remove-Item -Recurse -Force \'\\\\?\\C:\\work\\build\\old\'', '长路径前缀下的深层子目录'],
      ['bash', 'pwsh -Command "Remove-Item -Recurse -Force \'\\\\\\\\?\\\\C:\\\\work\\\\build\\\\old\'"', '双层反斜杠写法的长路径前缀深层子目录'],
      ['bash', 'rm -rf "$DIR/build"', '未赋值变量拼出非系统顶层名'],
      ['powershell', 'Remove-Item dist\\*', '项目内通配'],
      ['bash', 'rm -rf ${DIR:?}/*', '带 :? 保护的变量'],
      ['bash', 'rm -rf node_modules/.cache', '项目内缓存'],
      ['bash', 'rm file.txt', '删单个文件'],
      ['bash', 'rm C:\\foo.txt', '非递归删盘根下的文件'],
      ['bash', 'del C:\\foo.txt', '非递归 del 盘根下的文件'],
      ['bash', 'rm -rf ~/.pi/agent/sessions/old', 'pi 数据目录里的子目录'],
      ['bash', 'rm -rf /tmp/build-123', '临时目录里的子目录'],
      ['bash', 'git rm -r --cached .', 'git rm'],
      ['bash', 'grep -r "rm -rf /" .', '搜索文本'],
      ['bash', 'D=$(mktemp -d); rm -rf "$D"', '变量取自 mktemp'],
      ['bash', 'X=build; rm -rf "$X"/*', '已赋值变量加通配'],
      ['bash', 'yan terminal run --command "rm -rf /"', '交给宿主检查的终端输入']
    ]
    for (const [tool, command, label] of misses) {
      const reasons = check(tool, command)
      ok(reasons.length === 0, `不命中：${label}`, `${command} -> ${JSON.stringify(reasons)}`)
    }

    ok(guard.criticalDanger('read', { path: '/' }, project).length === 0, '非命令工具不检查')

    const authFile = join(home, '.pi', 'agent', 'auth.json')
    const secret = (reasons) => reasons.length === 1 && reasons[0].includes('模型凭据')
    ok(secret(check('bash', 'cat ~/.pi/agent/auth.json')), '命中：读取模型凭据文件')
    ok(secret(check('powershell', `Get-Content "${authFile}"`)), '命中：绝对路径读取模型凭据文件')
    ok(secret(check('bash', 'cd ~/.pi/agent && cat auth.json')), '命中：切到 pi 目录后读取模型凭据文件')
    ok(secret(guard.criticalDanger('read', { path: authFile }, project)), '命中：read 工具读取模型凭据文件')
    ok(check('bash', 'cat auth.json').length === 0, '不命中：项目里的同名文件')
    ok(check('bash', 'cat ~/.pi/agent/settings.json').length === 0, '不命中：pi 目录里的其他文件')
    ok(guard.criticalDanger('read', { path: join(project, 'auth.json') }, project).length === 0, '不命中：read 工具读项目里的同名文件')
    ok(secret(guard.detectDanger('bash', { command: 'cat ~/.pi/agent/auth.json' }, project)), '自动批准档同样要问')
    const secretText = guard.criticalBlockReason(check('bash', 'cat ~/.pi/agent/auth.json'), 'The user did not answer within 1 minute')
    ok(/credentials/.test(secretText) && !/deletes a critical location/.test(secretText) && /Do not retry/.test(secretText), '凭据拦截说明不套用删除的措辞')
    const text = guard.criticalBlockReason(['删除关键位置（盘根或文件系统根）：/'], 'The user did not answer within 1 minute')
    ok(text.includes('盘根') && text.includes('1 minute') && /Do not retry/.test(text), '拦截说明带原因和不许重试')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
