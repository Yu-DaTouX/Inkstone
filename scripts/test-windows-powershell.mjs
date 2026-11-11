import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasPwsh, findLegacyPowerShell, findPowerShellInBash, findPowerShellQuotingConflict as find, powerShellConflictReason, powerShellInBashReason } from '../resources/pi-extensions/windows-powershell.js'

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
  'powershell -NoProfile -Command "if (1 -eq 1) { \'ok\' }"',
  'command -v powershell || echo "no powershell"; powershell -NoProfile -Command \'$PSVersionTable.PSVersion.ToString()\' 2>&1 | head -5',
  'echo "run pwsh" && pwsh -NoProfile -Command \'$PSVersionTable\''
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
assert.match(powerShellConflictReason('`'), /backtick \(as command substitution\)/)

{
  const withPwsh = mkdtempSync(join(tmpdir(), 'yan-pwsh-a-'))
  const without = mkdtempSync(join(tmpdir(), 'yan-pwsh-b-'))
  try {
    writeFileSync(join(withPwsh, 'pwsh.exe'), '')
    assert.equal(hasPwsh({ PATH: withPwsh }), true, 'PATH 里有 pwsh.exe')
    unlinkSync(join(withPwsh, 'pwsh.exe'))
    assert.equal(hasPwsh({ PATH: withPwsh }), true, 'PATH 不变时沿用记忆结果，不再扫描')
    assert.equal(hasPwsh({ Path: withPwsh }), true, 'Path 与 PATH 同值同样命中记忆')
    assert.equal(hasPwsh({ PATH: without }), false, 'PATH 变化后重新探测')
    writeFileSync(join(without, 'pwsh.exe'), '')
    assert.equal(hasPwsh({ PATH: without }), false, 'PATH 不变时负结果同样沿用')
    let clock = 5_000_000
    const timed = { now: () => clock }
    assert.equal(hasPwsh({ PATH: without }, timed), true, '时钟早于缓存时间视为缓存失效，重新探测到刚放入的 pwsh.exe')
    unlinkSync(join(without, 'pwsh.exe'))
    clock += 30 * 1000
    assert.equal(hasPwsh({ PATH: without }, timed), true, 'TTL 内沿用缓存')
    clock += 31 * 1000
    assert.equal(hasPwsh({ PATH: without }, timed), false, 'TTL 过期后重新探测')
    writeFileSync(join(without, 'pwsh.exe'), '')
    assert.equal(hasPwsh({ PATH: without }, timed), false, '新结果重新计时')
    assert.equal(hasPwsh({ PATH: without }, { ...timed, fresh: true }), true, 'fresh 不走缓存')
    unlinkSync(join(without, 'pwsh.exe'))
    assert.equal(hasPwsh({ PATH: without }, timed), true, 'fresh 的结果写回缓存')
    clock -= 10 * 1000
    assert.equal(hasPwsh({ PATH: without }, timed), false, '时钟回退视为缓存失效')
  } finally {
    rmSync(withPwsh, { recursive: true, force: true })
    rmSync(without, { recursive: true, force: true })
  }
}

console.log('windows-powershell: ok')
