import { join } from 'node:path'

export async function runOpenGuardTests(ok, { openBlockedByExtension, openBlockReason }) {
  ok(openBlockedByExtension('C:/tmp/setup.exe') === true, '拒绝用系统程序打开可执行文件')
  ok(openBlockedByExtension('C:/tmp/build.ps1') === true, '拒绝用系统程序打开 PowerShell 脚本')
  ok(openBlockedByExtension('C:/tmp/shortcut.lnk') === true, '拒绝用系统程序打开快捷方式')
  ok(openBlockedByExtension('C:/tmp/report.pdf') === false, '放行普通文档')
  ok(openBlockedByExtension('C:/tmp/notes') === false, '放行没有扩展名的路径')
  ok(openBlockedByExtension('C:/tmp/folder/') === false, '放行目录路径')
  ok(openBlockedByExtension(join('C:', 'tmp', 'SETUP.EXE')) === true, '扩展名判断不区分大小写')
  for (const ext of ['url', 'bat', 'cmd', 'msi', 'scr', 'appref-ms', 'library-ms', 'settingcontent-ms', 'hta', 'chm', 'py', 'vhdx']) {
    ok(openBlockedByExtension('C:/tmp/x.' + ext) === true, '拦截 .' + ext)
  }
  ok(openBlockedByExtension('C:/tmp/setup.exe.') === true, '去掉结尾的点后仍按可执行文件拦截')
  ok(openBlockedByExtension('C:/tmp/setup.exe  ') === true, '去掉结尾空格后仍按可执行文件拦截')
  ok(openBlockReason('C:/tmp/notes.txt:evil.exe') === 'alternate-stream', '拦截备用数据流写法')
  ok(openBlockReason('C:/tmp/invoice' + String.fromCharCode(0x202e) + 'fdp.exe') !== null, '拦截带双向控制字符的文件名')
  ok(openBlockReason('C:/tmp/photo.png') === null, '放行图片')
  ok(openBlockReason('C:/tmp/data.xlsx') === null, '放行表格')
}
