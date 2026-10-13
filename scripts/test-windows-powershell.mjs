/**
 * bash 双引号里交给 PowerShell 的脚本会被 bash 改写的写法（resources/pi-extensions/windows-powershell.js）。
 *
 * 拦截用例取自真实会话里出过错的命令形状；放行用例覆盖单引号、转义、bash 命令替换与
 * 不涉及 PowerShell 的命令，避免误拦。
 *
 * 用法：node scripts/test-windows-powershell.mjs
 */
import assert from 'node:assert/strict'
import { findPowerShellInBash, findPowerShellQuotingConflict as find, powerShellConflictReason, powerShellInBashReason } from '../resources/pi-extensions/windows-powershell.js'

const blocked = [
  ['powershell -NoProfile -Command "Get-Process | Where-Object { $_.ProcessName -match \'electron\' }"', '$_'],
  ['powershell -NoProfile -Command "$PSVersionTable.PSVersion.ToString()"', '$PSVersionTable'],
  ['pwsh -c "Write-Output $env:USERPROFILE"', '$env:U'],
  ['powershell.exe -NoProfile -Command "$s = netstat -s | Out-String; $s"', '$s'],
  ['powershell -Command "Get-Item x | % { $PSItem.Length }"', '$PSItem'],
  ['powershell -NoProfile -Command "Write-Output \\"a`tb\\""', '`'],
  ['cd /tmp && powershell -NoProfile -Command "Get-Date" ; powershell -Command "if ($true) { 1 }"', '$true']
]
for (const [command, token] of blocked) assert.equal(find(command), token, command)

const allowed = [
  "powershell -NoProfile -Command 'Get-Process | Where-Object { $_.Name -eq \"x\" }'",
  'powershell -NoProfile -Command "Get-Process | Where-Object { \\$_.ProcessName -match \'electron\' }"',
  'powershell -NoProfile -Command "Get-Item \\"$(cygpath -w ./a.txt)\\""',
  'powershell -NoProfile -Command "Get-Item $FILE"',
  'powershell -NoProfile -ExecutionPolicy Bypass -File "C:/tmp/a.ps1"',
  'powershell -NoProfile -File script.ps1 "$HOME"',
  'echo "$_ is fine here"; ls',
  'git commit -m "mention powershell" && echo "$PWD"',
  'powershell -NoProfile -Command "Get-Date" | grep "$x = 1"',
  'powershell -NoProfile -Command "if (1 -eq 1) { \'ok\' }"'
]
for (const command of allowed) assert.equal(find(command), null, command)
assert.equal(find(undefined), null)

/* bash 工具里直接写 PowerShell 命令：只拦引号外命令位置的 Verb-Noun */
const inBash = [
  ['rg -n "会话" docs/CODE_MAP.md; (Get-Content .local-docs/DECISIONS.md | Measure-Object -Line).Lines', 'Get-Content'],
  ['Get-ChildItem -Recurse src', 'Get-ChildItem'],
  ['cat a.txt | Select-String foo', 'Select-String'],
  ['cd x && Remove-Item -Recurse tmp', 'Remove-Item']
]
for (const [command, name] of inBash) assert.equal(findPowerShellInBash(command), name, command)

const notInBash = [
  'git commit -m "说明 Get-Content 的用法"',
  "echo 'Get-Content a | Measure-Object'",
  'rg -n "Get-Content" docs/ | head',
  'rg Get-Content docs/',
  'grep -rn Set-Location src',
  'echo Get-Content',
  '# Get-Content a',
  'ls -la # 对应 Get-ChildItem',
  'cat <<EOF\nGet-Content a\nEOF',
  'powershell -NoProfile -Command \'Get-Content a | Measure-Object -Line\'',
  'pwsh -File a.ps1; Get-Date',
  'npm run test-live; node scripts/foo-bar.mjs',
  'my-tool --flag; git-lfs pull',
  'x=1; Get_Foo-Bar',
  'cd Some-Dir && ls'
]
for (const command of notInBash) assert.equal(findPowerShellInBash(command), null, command)
assert.equal(findPowerShellInBash(undefined), null)
assert.match(powerShellInBashReason('Get-Content'), /Get-Content.*bash/)

assert.match(powerShellConflictReason('$_'), /`\$_`/)
assert.match(powerShellConflictReason('`'), /反引号/)

console.log('windows-powershell: ok')
