import assert from 'node:assert/strict'
import { detectDanger, outsideWrites } from '../resources/pi-extensions/danger-guard.js'
import { findPowerShellQuotingConflict } from '../resources/pi-extensions/windows-powershell.js'

assert.ok(detectDanger('bash', { command: 'echo ok & rm -rf /' }, process.cwd()).some(x => x.includes('递归删除')))
assert.equal(detectDanger('bash', { command: 'rm -rf ~/projects/demo' }, process.cwd()).length, 0)
assert.deepEqual(findPowerShellQuotingConflict('powershell -Command "Write-Output $name"'), '$name')
assert.deepEqual(findPowerShellQuotingConflict('powershell -Command "Write-Output \\$name"'), null)
assert.ok(outsideWrites('bash', { command: 'yan artifact export --output C:/outside/result.txt' }, process.cwd(), { outsideWrites: true }).some(x => x.includes('outside')))
console.log('review2 extensions-mobile targeted behavior checks: 5 passed')
