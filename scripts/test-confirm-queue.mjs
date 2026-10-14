/**
 * 应用内确认队列的定向测试。
 *
 * 直接加载真实的 `confirm-queue.ts`（esbuild 转译后在 VM 里执行），
 * 验证排队、结算、卸载/会话切换结算与「只结算一次」的语义 ——
 * 不是源码 regex 匹配。
 *
 * 用法： node scripts/test-confirm-queue.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { transform } from 'esbuild'

const source = await readFile('src/renderer/src/components/ui/confirm-queue.ts', 'utf8')
const { code } = await transform(source, { loader: 'ts', format: 'cjs', target: 'node18' })
const module = { exports: {} }
vm.runInNewContext(code, { module, exports: module.exports, require: () => { throw new Error('no imports expected') } })
const { createConfirmQueue } = module.exports
assert.equal(typeof createConfirmQueue, 'function', '必须导出 createConfirmQueue')

let checks = 0
const check = (condition, message) => { assert.ok(condition, message); checks += 1 }
const options = (title) => ({ title })
const tick = async () => { for (let i = 0; i < 4; i++) await Promise.resolve() }

/* ── 基本排队与首条可见 ── */
const q = createConfirmQueue()
let notifications = 0
const stop = q.subscribe(() => { notifications += 1 })
const scopeA = Symbol('A')
const scopeB = Symbol('B')

const first = q.enqueue(options('first'), scopeA)
const second = q.enqueue(options('second'), scopeB)
check(q.snapshot().length === 2, '两个请求都进队列')
check(q.snapshot()[0].options.title === 'first', '先入队的在队首')
check(q.snapshot()[1].options.title === 'second', '后入队的排第二')
check(notifications === 2, '入队各通知一次订阅者')

/* ── 队首按 true 结算，下一条上位 ── */
const firstId = q.snapshot()[0].id
q.settle(firstId, true)
await tick()
check(await first === true, '队首确认后 resolve true')
check(q.snapshot().length === 1 && q.snapshot()[0].options.title === 'second', '结算后下一条成为队首')

/* ── 重复结算 / 未知 id 结算都是空操作 ── */
q.settle(firstId, false)
q.settle(99999, true)
check(q.snapshot().length === 1, '重复或未知 id 不改变队列')
await tick()
check((await first) === true, '已结算的请求不会被后续结算改写')

/* ── scope 取消只结算自己名下的未决请求 ── */
const third = q.enqueue(options('third'), scopeA)
check(q.snapshot().length === 2, 'scopeA 再入一条')
q.cancelScope(scopeA)
await tick()
check(await third === false, 'scopeA 卸载时其未决请求按 false 结算')
check(q.snapshot().length === 1 && q.snapshot()[0].options.title === 'second', '同队列中 scopeB 的请求不受影响')
const secondId = q.snapshot()[0].id
q.settle(secondId, false)
await tick()
check(await second === false, '取消按钮按 false 结算')

/* ── cancelAll：Provider 卸载 / 会话切换 ── */
const fourth = q.enqueue(options('fourth'), scopeA)
const fifth = q.enqueue(options('fifth'), scopeB)
q.cancelAll()
await tick()
check(await fourth === false && await fifth === false, 'cancelAll 把整条队列按 false 结算')
check(q.snapshot().length === 0, 'cancelAll 后队列清空')
q.cancelAll()
check(q.snapshot().length === 0, '空队列 cancelAll 是空操作')

/* ── 队列可继续复用 ── */
const sixth = q.enqueue(options('sixth'), scopeB)
check(q.snapshot().length === 1, '取消后队列仍可复用')
q.settle(q.snapshot()[0].id, true)
await tick()
check(await sixth === true, '复用后的请求正常结算')

/* ── 订阅取消 ── */
const before = notifications
stop()
q.enqueue(options('quiet'), scopeB)
check(notifications === before, '取消订阅后不再收到通知')
q.cancelAll()

/* ── 结算顺序：先移出队列再 resolve，resolve 内同步回查是安全的 ── */
const racing = createConfirmQueue()
let observedAfterResolve = -1
const pending = racing.enqueue(options('race'), scopeA)
racing.subscribe(() => undefined)
const raceId = racing.snapshot()[0].id
const settlePromise = Promise.resolve(racing.settle(raceId, true))
await settlePromise
observedAfterResolve = racing.snapshot().length
check(observedAfterResolve === 0, '结算时请求已先移出队列')
check(await pending === true, '竞态场景仍按 true 结算')

console.log(`确认队列测试通过：${checks} 项`)
