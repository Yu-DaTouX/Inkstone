import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from '../node_modules/esbuild/lib/main.js'

const source = await readFile('src/main/agent.ts', 'utf8')
const compiled = await build({
  entryPoints: ['src/main/agent.ts'],
  bundle: true,
  write: false,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  plugins: [{ name: 'electron-stub', setup(api) {
    api.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
    api.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const app={}; export class BrowserWindow{}; export const session={};', loader: 'js' }))
  } }]
})
assert.ok(compiled.outputFiles[0].text.length > 0, 'agent.ts现场编译成功')

const checks = [
  [/const messageId = this\.latestAssistantMessageId\(\)[\s\S]*?await this\.attachArtifact\(artifact, messageId, sessionFile\)/, 'attach 固定消息归属并向下传递'],
  [/const sessionFile = this\.state\?\.sessionFile\n\s*if \(!sessionFile\) throw new CapabilityCommandError\('session_not_saved'/, '未保存会话不写产物 manifest'],
  [/if \(sessionFile && this\.state\?\.sessionFile !== sessionFile\) return/, '旧会话产物不能挂入未保存的新会话'],
  [/this\.bash\?\.reqId === reqId[\s\S]{0,180}if \(!b\) \{\n\s*endTreeSnapshot\(msgId\)/, 'bash 旧请求只按自身 reqId 收尾'],
  [/for \(const c of msg\.toolCalls \?\? \[\]\) \{\n\s*this\.pushedOut\.set\(c\.id, c\.output\?\.length \?\? 0\)\n\s*this\.dirtyTools\.delete\(c\.id\)/, 'abort 全量工具快照推进增量游标'],
  [/private resetSessionScope\(\): void \{[\s\S]*?this\.bash = null[\s\S]*?this\.streaming = null[\s\S]*?this\.resetQueue\(\)[\s\S]*?this\.compactionState = EMPTY_COMPACTION_STATE/, '共用会话作用域清理 streaming/bash/队列/压缩'],
  [/async fork\([\s\S]*?this\.suppressPush = true[\s\S]*?this\.resetSessionScope\(\)[\s\S]*?finally \{\n\s*this\.suppressPush = false/, 'fork 共用清理并抑制切换推送'],
  [/async clone\([\s\S]*?this\.suppressPush = true[\s\S]*?this\.resetSessionScope\(\)[\s\S]*?finally \{\n\s*this\.suppressPush = false/, 'clone 共用清理并抑制切换推送'],
  [/if \(res\?\.success\) this\.resetQueue\(true\)/, 'clear_queue 失败不清本地队列']
]
for (const [pattern, label] of checks) assert.match(source, pattern, label)
assert.doesNotMatch(source, /this\.resetQueue\(true\)[\s\S]{0,100}catch \{[\s\S]{0,100}this\.resetQueue\(true\)/, 'abort 不在失败路径盲清队列')
console.log(`review-agent: ${checks.length + 1} checks passed (现场 esbuild compile + focused source assertions)`)
