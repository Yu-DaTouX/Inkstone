/**
 * 权限档位薄层（resources/pi-extensions/permission-guard.js）的判定：
 * 只读命令白名单不能漏放写入；高危 / 越界写入交给 danger-guard，不重复问。
 */
import assert from 'node:assert/strict'
import { hasDelete, isReadOnlyShell, permissionReasons } from '../resources/pi-extensions/permission-guard.js'

const readOnly = ['ls -la', 'git status', 'git diff HEAD~1 | head -20', 'cd src && grep -rn foo .', 'git branch', 'git log --oneline', 'find . -name "*.ts"', 'yan goal status', 'cat package.json | wc -l', 'Get-ChildItem -Recurse']
const writes = ['rm -rf build', 'echo hi > a.txt', 'git commit -am x', 'git branch -D x', 'npm install', 'find . -delete', 'sed -i s/a/b/ f', 'ls; rm x', 'cat a | tee b', 'git push', 'echo $(rm x)', 'sort -o out in', 'env FOO=1 node x.js']
for (const command of readOnly) assert.equal(isReadOnlyShell(command), true, `应当只读：${command}`)
for (const command of writes) assert.equal(isReadOnlyShell(command), false, `应当会写：${command}`)

const ask = { mode: 'ask', daily: false, outsideWrites: true, allowRoots: [] }
const cwd = process.cwd()
const asks = (name, input, prefs = ask) => permissionReasons(name, input, cwd, prefs) !== null
assert.equal(asks('write', { path: `${cwd}/a.txt` }), true)
assert.equal(asks('edit', { path: `${cwd}/a.txt` }), true)
assert.equal(asks('read', { path: `${cwd}/a.txt` }), false)
assert.equal(asks('bash', { command: 'ls' }), false)
assert.equal(asks('bash', { command: 'npm test' }), true)
assert.equal(asks('bash', { command: 'rm -rf /' }), false, '高危交给 danger-guard')
assert.equal(asks('write', { path: 'C:/Windows/x.txt' }), false, '越界写入交给 danger-guard')
assert.equal(asks('write', { path: `${cwd}/a.txt` }, { ...ask, mode: 'full' }), false, 'full 档不问')
console.log('permission-guard: ok')

/* 删除：日常模式下任何档位都问且不可记住；编码模式的 full 档不问；询问档下也是 delete 种类 */
assert.equal(hasDelete('rm a.txt'), true)
assert.equal(hasDelete('cd x && Remove-Item a.txt'), true)
assert.equal(hasDelete('grep rm file.txt'), false)
const dailyFull = { mode: 'full', daily: true, outsideWrites: true, allowRoots: [] }
const codingFull = { mode: 'full', daily: false, outsideWrites: true, allowRoots: [] }
assert.equal(permissionReasons('bash', { command: 'rm old.xlsx' }, cwd, dailyFull)?.kind, 'delete')
assert.equal(permissionReasons('bash', { command: 'rm old.xlsx' }, cwd, codingFull), null)
assert.equal(permissionReasons('bash', { command: 'rm old.xlsx' }, cwd, { ...ask })?.kind, 'delete')
assert.equal(permissionReasons('bash', { command: 'ls' }, cwd, dailyFull), null)
assert.equal(permissionReasons('write', { path: cwd + '/a.txt' }, cwd, dailyFull), null)
assert.equal(permissionReasons('bash', { command: 'rm -rf /' }, cwd, dailyFull), null, '大范围递归删除交给 danger-guard')
console.log('permission-guard delete: ok')

/* PowerShell：只读查询放行；写入藏在脚本块 / 别名里也要问 */
const psReadOnly = ['Get-Process | Sort-Object CPU -Descending | Select-Object -First 10', 'Get-Volume | Format-Table', 'Get-CimInstance Win32_OperatingSystem | Select-Object Caption', 'Get-ChildItem C:/Users -Recurse | Measure-Object', 'Get-Service | Where-Object { $_.Status -eq "Running" }']
const psWrites = ['Remove-Item a.txt', 'Get-Process | Where-Object { Stop-Process -Id $_.Id }', 'Get-ChildItem | ForEach-Object { sc x }', 'Set-ItemProperty HKCU:/x y 1', 'Start-Process notepad', 'iex "dir"', 'Get-ChildItem | Out-File a.txt']
for (const command of psReadOnly) assert.equal(isReadOnlyShell(command), true, `PowerShell 应当只读：${command}`)
for (const command of psWrites) assert.equal(isReadOnlyShell(command), false, `PowerShell 应当会写：${command}`)
console.log('permission-guard powershell: ok')
