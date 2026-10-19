import { join } from 'node:path'

export async function runOpenGuardTests(ok, { openBlockedByExtension }) {
  ok(openBlockedByExtension('C:/tmp/setup.exe') === true, '拒绝用系统程序打开可执行文件')
  ok(openBlockedByExtension('C:/tmp/build.ps1') === true, '拒绝用系统程序打开 PowerShell 脚本')
  ok(openBlockedByExtension('C:/tmp/shortcut.lnk') === true, '拒绝用系统程序打开快捷方式')
  ok(openBlockedByExtension('C:/tmp/report.pdf') === false, '放行普通文档')
  ok(openBlockedByExtension('C:/tmp/notes') === false, '放行没有扩展名的路径')
  ok(openBlockedByExtension('C:/tmp/folder/') === false, '放行目录路径')
  ok(openBlockedByExtension(join('C:', 'tmp', 'SETUP.EXE')) === true, '扩展名判断不区分大小写')
}
