export async function runOpenGuardTests(ok, { openBlockedByName, openBlockReason }) {
  for (const ext of ['exe', 'ps1', 'lnk', 'bat', 'msi', 'py', 'js', 'sh']) {
    ok(openBlockedByName('C:/tmp/x.' + ext) === false, '放行 .' + ext)
  }
  ok(openBlockedByName('C:/tmp/report.pdf') === false, '放行普通文档')
  ok(openBlockedByName('C:/tmp/notes') === false, '放行没有扩展名的路径')
  ok(openBlockedByName('C:/tmp/folder/') === false, '放行目录路径')
  ok(openBlockReason('C:/tmp/notes.txt:evil.exe') === 'alternate-stream', '拦截备用数据流写法')
  ok(openBlockReason('C:/tmp/invoice' + String.fromCharCode(0x202e) + 'fdp.exe') === 'unsafe-name', '拦截带双向控制字符的文件名')
  ok(openBlockReason('C:/tmp/photo.png') === null, '放行图片')
}
