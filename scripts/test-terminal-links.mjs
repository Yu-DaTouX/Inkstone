import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

async function load(relative) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(relative, import.meta.url))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const links = await load('../src/renderer/src/features/terminal/terminal-links.ts')
const { findTerminalLinks, findTerminalUrls, findTerminalFiles, resolveTerminalPath, isTerminalLinkGesture, terminalSelectionBlock } = links

const pick = (text) => findTerminalLinks(text).map((link) => (link.kind === 'url' ? ['url', link.url] : ['file', link.path, link.line, link.column, text.slice(link.start, link.end)]))

assert.deepEqual(pick('  Local:   http://localhost:5173/'), [['url', 'http://localhost:5173/']], 'Vite 地址')
assert.deepEqual(pick('see https://example.com/a_(b)).'), [['url', 'https://example.com/a_(b)']], '去掉不成对右括号与句号')
assert.deepEqual(pick('(https://example.com/x?y=1,)'), [['url', 'https://example.com/x?y=1']], '括号包裹的链接')
assert.deepEqual(pick('打开 https://example.com/路径'), [['url', 'https://example.com/']], '遇到非 ASCII 停止')
assert.deepEqual(findTerminalUrls('http://'), [], '空主机不算链接')
assert.deepEqual(pick('https://example.com/src/a.ts:12'), [['url', 'https://example.com/src/a.ts:12']], 'URL 里的路径不再识别为文件')

assert.deepEqual(
  pick('src/main/index.ts:120:7 - error TS2304'),
  [['file', 'src/main/index.ts', 120, 7, 'src/main/index.ts:120:7']],
  'tsc 相对路径带行列'
)
assert.deepEqual(
  pick('C:\\Users\\me\\proj\\src\\a.tsx:3:14'),
  [['file', 'C:\\Users\\me\\proj\\src\\a.tsx', 3, 14, 'C:\\Users\\me\\proj\\src\\a.tsx:3:14']],
  'Windows 绝对路径'
)
assert.deepEqual(pick('at D:/work/app.js:9'), [['file', 'D:/work/app.js', 9, undefined, 'D:/work/app.js:9']], 'Windows 正斜杠')
assert.deepEqual(pick('/home/me/proj/lib/x.py:42:1'), [['file', '/home/me/proj/lib/x.py', 42, 1, '/home/me/proj/lib/x.py:42:1']], 'POSIX 绝对路径')
assert.deepEqual(pick('./scripts/run.sh'), [['file', './scripts/run.sh', undefined, undefined, './scripts/run.sh']], '点开头相对路径')
assert.deepEqual(pick('src/a.ts(12,5): error'), [['file', 'src/a.ts', 12, 5, 'src/a.ts(12,5)']], 'MSBuild 风格')
assert.deepEqual(pick('  File "app/main.py", line 7, in <module>'), [['file', 'app/main.py', 7, undefined, 'app/main.py", line 7']], 'Python 回溯')
assert.deepEqual(pick('edit README.md.'), [['file', 'README.md', undefined, undefined, 'README.md']], '句末句号不进路径')
assert.deepEqual(pick('/usr/bin/env'), [['file', '/usr/bin/env', undefined, undefined, '/usr/bin/env']], '无扩展名的绝对路径')
assert.deepEqual(pick('bin/tool:3'), [['file', 'bin/tool', 3, undefined, 'bin/tool:3']], '无扩展名但有目录和行号')
assert.deepEqual(pick('报错见 src/组件/表单.tsx:8'), [['file', 'src/组件/表单.tsx', 8, undefined, 'src/组件/表单.tsx:8']], '中文路径')

assert.deepEqual(pick('version 1.2.3 at 10:30'), [], '版本号与时间不算路径')
assert.deepEqual(pick('and/or either'), [], '无扩展名的普通斜杠词不算路径')
assert.deepEqual(pick('foo:bar'), [], '冒号词不算路径')
assert.deepEqual(findTerminalFiles('a.ts:0'), [{ kind: 'file', start: 0, end: 6, text: 'a.ts:0', path: 'a.ts' }], '行号 0 不记行')

const two = findTerminalLinks('x https://a.dev y src/b.ts:2')
assert.equal(two.length, 2, '同行两个链接')
assert.ok(two[0].start < two[1].start, '按位置排序')

assert.equal(resolveTerminalPath('C:\\proj', 'src/a.ts'), 'C:\\proj\\src\\a.ts', 'Windows cwd 相对')
assert.equal(resolveTerminalPath('C:\\proj\\', './src/a.ts'), 'C:\\proj\\src\\a.ts', '去掉 ./ 与尾斜杠')
assert.equal(resolveTerminalPath('C:\\proj', '..\\other\\b.ts'), 'C:\\proj\\..\\other\\b.ts', '上级目录交给主进程规范化')
assert.equal(resolveTerminalPath('C:\\proj', 'D:\\x\\y.ts'), 'D:\\x\\y.ts', 'Windows 绝对路径原样')
assert.equal(resolveTerminalPath('C:\\proj', '/c/Users/me/a.ts'), 'C:\\Users\\me\\a.ts', 'Git Bash 盘符路径')
assert.equal(resolveTerminalPath('/home/me/proj', 'lib/x.py'), '/home/me/proj/lib/x.py', 'POSIX 相对')
assert.equal(resolveTerminalPath('/home/me/proj', '/etc/hosts'), '/etc/hosts', 'POSIX 绝对')
assert.equal(resolveTerminalPath('', 'a.ts'), null, '没有 cwd 时不解析相对路径')
assert.equal(resolveTerminalPath('/p', 'a\0b'), null, '拒绝空字符')

assert.equal(isTerminalLinkGesture({ ctrlKey: true, metaKey: false }, false), true, 'Windows Ctrl')
assert.equal(isTerminalLinkGesture({ ctrlKey: false, metaKey: true }, false), false, 'Windows 不认 Meta')
assert.equal(isTerminalLinkGesture({ ctrlKey: false, metaKey: true }, true), true, 'mac Cmd')
assert.equal(isTerminalLinkGesture({ ctrlKey: true, metaKey: false }, true), false, 'mac 不认 Ctrl')

assert.equal(terminalSelectionBlock('  \n', 'src'), '', '空选区不插入')
assert.equal(terminalSelectionBlock('a  \r\nb\n\n', '终端「终端」输出：'), '终端「终端」输出：\n```text\na\nb\n```', '去尾空白并包代码块')
assert.equal(terminalSelectionBlock('x\n```\ny', 's'), 's\n````text\nx\n```\ny\n````', '内容含围栏时加长围栏')

const processes = await load('../src/main/terminal-processes.ts')
const { parseWindowsProcessCsv, parsePsOutput, descendantProcesses } = processes
const csv = '"ProcessId","ParentProcessId","Name"\r\n"10","1","pwsh.exe"\r\n"11","10","conhost.exe"\r\n"12","10","node.exe"\r\n"13","12","esbuild.exe"\r\n"14","1","other.exe"\r\n'
const rows = parseWindowsProcessCsv(csv)
assert.equal(rows.length, 5, '解析 CSV 行')
assert.deepEqual(descendantProcesses(rows, 10, 'win32'), [{ pid: 12, name: 'node.exe' }, { pid: 13, name: 'esbuild.exe' }], 'Windows 子孙进程并略过 conhost')
assert.deepEqual(descendantProcesses(rows, 14, 'win32'), [], '没有子进程')
const ps = parsePsOutput('  100     1 /bin/zsh\n  101   100 /usr/local/bin/node\n  102   101 vite\n')
assert.deepEqual(descendantProcesses(ps, 100, 'darwin'), [{ pid: 101, name: 'node' }, { pid: 102, name: 'vite' }], 'POSIX 子孙进程')
assert.deepEqual(descendantProcesses([{ pid: 5, ppid: 5, name: 'loop' }], 5, 'linux'), [], '自指进程不死循环')

console.log('terminal links ok')
