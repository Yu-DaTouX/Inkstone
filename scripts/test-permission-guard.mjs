/** 两档权限退休了旧日常删除重定向；危险判断由 danger-guard 单独验证。 */
import assert from 'node:assert/strict'
import { hasDelete, trashVerdict } from '../resources/pi-extensions/permission-guard.js'
assert.equal(hasDelete('rm a.txt'), true)
assert.equal(hasDelete('git status'), false)
for (const mode of ['danger', 'all']) for (const daily of [true, false]) {
  for (const command of ['rm old.xlsx', 'rm -rf /', 'Get-ChildItem *.log | Remove-Item']) {
    assert.equal(trashVerdict('bash', { command }, process.cwd(), { mode, daily }), null)
  }
}
console.log('permission guard: retired deletion redirection does not override either mode')
