#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const workDir = join(root, '.tmp', 'browser-session-scope', 'unit')
await rm(workDir, { recursive: true, force: true })
await mkdir(workDir, { recursive: true })
await build({
  entryPoints: ['src/main/browser/session-scope.ts'],
  outdir: join(workDir, 'out'),
  outbase: 'src',
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const { SessionScope } = await import(pathToFileURL(join(workDir, 'out', 'main', 'browser', 'session-scope.js')).href)

let checks = 0
const ok = (condition, label) => {
  assert.ok(condition, label)
  checks++
}
const eq = (actual, expected, label) => {
  assert.deepEqual(actual, expected, label)
  checks++
}
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class FakeBrowser {
  constructor(scope) {
    this.scope = scope
    this.ambient = 'workspace'
    this.tabs = []
  }
  get focus() {
    return this.scope.current() ?? this.ambient
  }
  async open(url) {
    const before = this.focus
    await tick(5)
    await tick(5)
    this.tabs.push({ session: this.focus, url, before })
    return this.focus
  }
  forSession(id) {
    this.ambient = id
    return this.scope.bind(this, id)
  }
}

const scope = new SessionScope()
ok(scope.current() === undefined, '作用域外没有会话')
eq(scope.run('a', () => scope.current()), 'a', 'run 内能读到会话')

const browser = new FakeBrowser(scope)
const agent = browser.forSession('A')
const agentWork = agent.open('https://agent.example/1')
const user = browser.forSession('B')
const userWork = user.open('https://user.example/1')
const [agentSession, userSession] = await Promise.all([agentWork, userWork])
eq(agentSession, 'A', '交错执行：agent 的操作跨过多个 await 仍落在自己的会话')
eq(userSession, 'B', '交错执行：用户的操作落在用户的会话')
eq(browser.tabs.map((tab) => `${tab.session}|${tab.url}`).sort(), ['A|https://agent.example/1', 'B|https://user.example/1'], '两个会话各自得到自己的标签')
ok(browser.tabs.every((tab) => tab.before === tab.session), '操作开始与结束时会话一致')
ok(browser.focus === 'B', '未绑定的调用仍读到最后一次设置的环境会话')

const many = await Promise.all(
  Array.from({ length: 20 }, (_unused, i) => browser.forSession(i % 2 ? 'A' : 'B').open(`https://x.example/${i}`))
)
eq(many.map((session, i) => session === (i % 2 ? 'A' : 'B')), many.map(() => true), '二十个交错操作全部落在各自会话')

const bound = scope.bind({ n: 1, f() { return this.n } }, 'Z')
ok(bound.n === 1 && bound.f() === 1, '绑定后非函数属性照常读取，方法的 this 仍是原对象')

console.log(`✓ browser session-scope 测试通过（${checks} 项）`)
