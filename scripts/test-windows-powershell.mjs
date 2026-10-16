import assert from 'node:assert/strict'
import { findLegacyPowerShell, findPowerShellInBash, findPowerShellQuotingConflict as find, powerShellConflictReason, powerShellInBashReason } from '../resources/pi-extensions/windows-powershell.js'

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

for (const command of ['powershell -NoProfile -File a.ps1', 'cd x && powershell.exe -File a.ps1', 'ls | powershell -Command -', '/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -File a.ps1']) assert.equal(findLegacyPowerShell(command), true, command)
for (const command of ['pwsh -File a.ps1', 'echo "powershell"', "git commit -m 'powershell.exe'", 'cat <<EOF\npowershell -File a\nEOF', 'ls powershell-notes', undefined]) assert.equal(findLegacyPowerShell(command), false, String(command))

assert.match(powerShellConflictReason('$_'), /`\$_`/)
assert.match(powerShellConflictReason('`'), /反引号/)

console.log('windows-powershell: ok')
