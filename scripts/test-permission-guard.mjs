/**
 * 权限档位薄层（resources/pi-extensions/permission-guard.js）的判定：
 * 日常模式下没经确认的删除改走回收站；高危删除在「危险批准」档交给 danger-guard 先问；
 * 临时目录里的删除照常放行；编码模式不拦普通删除。
 */
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasDelete, trashVerdict } from '../resources/pi-extensions/permission-guard.js'

const cwd = process.cwd()
const dailyDanger = { mode: 'danger', daily: true }
const dailyAll = { mode: 'all', daily: true }
const codingDanger = { mode: 'danger', daily: false }
const trash = (command, prefs = dailyDanger, tool = 'bash') => trashVerdict(tool, { command }, cwd, prefs)

assert.equal(hasDelete('rm a.txt'), true)
assert.equal(hasDelete('cd x && Remove-Item a.txt'), true)
assert.equal(hasDelete('grep rm file.txt'), false)

assert.ok(trash('rm old.xlsx'), '日常 + 危险批准：普通删除改走回收站')
assert.ok(trash('Remove-Item old.xlsx', dailyAll, 'powershell'), '日常 + 全部允许：普通删除改走回收站')
assert.deepEqual(trash('rm old.xlsx').targets, [join(cwd, 'old.xlsx').replace(/\\/g, '/').toLowerCase()], '告诉模型删的是哪个文件')
assert.equal(trash('rm old.xlsx', codingDanger), null, '编码模式不拦普通删除')
assert.equal(trash('ls -la'), null, '不是删除的命令不管')
assert.equal(trashVerdict('write', { path: `${cwd}/a.txt` }, cwd, dailyDanger), null, '写文件不是删除')
assert.equal(trash('rm -rf /'), null, '危险批准档：大范围递归删除交给 danger-guard 先问')
assert.ok(trash('rm -rf /', dailyAll), '全部允许档：大范围递归删除也改走回收站')
assert.equal(trash(`rm -rf "${join(tmpdir(), 'junk')}"`), null, '系统临时目录里的删除照常执行')
assert.equal(trash('Remove-Item "$env:TEMP\\junk" -Recurse -Force', dailyDanger, 'powershell'), null, '$env:TEMP 开头的路径按临时目录认')
assert.ok(trash(`rm "${join(tmpdir(), 'a')}" old.xlsx`), '临时目录之外还有别的目标时仍然改走回收站')
assert.ok(trash('Get-ChildItem *.log | Remove-Item', dailyDanger, 'powershell'), '目标看不出来（管道喂入）时按要回收处理')
console.log('permission-guard trash: ok')
