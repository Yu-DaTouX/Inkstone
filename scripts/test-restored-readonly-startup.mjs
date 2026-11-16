import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync('src/main/index.ts', 'utf8')
const calls = ['startDataMaintenance(', 'startSessionPurgeSweep(', 'sweepCredentialFiles(', 'startDailyCredentialSweep(', 'sweepStaleTemps(', 'moveLegacyState(']
for (const call of calls) {
  const count = source.split(call).length - 1
  assert.equal(count, 1, `index.ts 里 ${call} 只启动一处，便于核对只读判断（实际 ${count} 处）`)
}
assert.match(source, /if \(!isRestoredReadonly\(\)\) startDataMaintenance\(/, '只读恢复实例不启动数据维护（检查点清理、附件进回收站等）')
assert.match(source, /if \(!isRestoredReadonly\(\)\) startSessionPurgeSweep\(\)/, '只读恢复实例不清理回收站与会话旁路数据')
const block = /if \(!isRestoredReadonly\(\)\) \{\n([\s\S]*?)\n {2}\}/.exec(source.slice(source.indexOf('sweepCredentialFiles(') - 200))
assert.ok(block, '凭据扫描、过期临时文件清扫与旧状态迁移在同一个只读判断块里')
for (const call of ['sweepCredentialFiles(', 'startDailyCredentialSweep(', 'sweepStaleTemps(', 'moveLegacyState(']) {
  assert.ok(block[1].includes(call), `只读恢复实例不执行 ${call.slice(0, -1)}`)
}
console.log('restored-readonly-startup: 全部通过')
