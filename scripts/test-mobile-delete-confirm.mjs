import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const pane = readFileSync('mobile/src/components/DetailPane.tsx', 'utf8')
const client = readFileSync('mobile/src/api/client.ts', 'utf8')

const deleteCalls = [...pane.matchAll(/client\.deleteSession\(/g)]
assert.equal(deleteCalls.length, 1, '详情里只有一处调用删除接口')
const confirmBlock = pane.match(/const confirmDelete = \(\) => Alert\.alert\([\s\S]*?\n  \]\)/)?.[0] ?? ''
assert.ok(confirmBlock.includes("style: 'destructive'") && confirmBlock.includes("style: 'cancel'"), '删除先弹二次确认，带取消与破坏性按钮')
assert.ok(confirmBlock.includes('client.deleteSession(sessionId)'), '只有确认弹窗里的删除按钮才会调用删除接口')
assert.ok(/onPress: confirmDelete/.test(pane) && !/key: 'delete'[^\n]*client\.deleteSession/.test(pane), '菜单项只指向确认弹窗，不直接删除')
assert.ok(/capabilityAllowed\(info, 'session-delete'\)\)\s*items\.push\(\{ key: 'delete'/.test(pane), '删除入口受电脑端能力声明控制')
assert.ok(/danger: true/.test(pane.match(/key: 'delete'[^\n]*/)?.[0] ?? ''), '删除项按危险样式展示')
assert.ok(/deleteSession\(sessionId: string\)[\s\S]{0,200}\/delete`, \{ confirm: true \}/.test(client), '客户端请求带明确 confirm: true')
console.log('mobile-delete-confirm: 删除必须经二次确认并带 confirm 标记')
