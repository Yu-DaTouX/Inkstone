import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { pathToFileURL } from 'node:url'
const { default: register } = await import(pathToFileURL(process.cwd() + '/resources/pi-extensions/service-authority.js').href)
const handlers = new Map()
register({ on: (event, fn) => handlers.set(event, fn) })
const oldFetch = globalThis.fetch, oldUrl = process.env.INKSTONE_AUTHORITY_URL, oldToken = process.env.INKSTONE_AUTHORITY_TOKEN
try {
 process.env.INKSTONE_AUTHORITY_URL = 'https://fixture.invalid'; process.env.INKSTONE_AUTHORITY_TOKEN = 'fixture'
 globalThis.fetch = async () => Response.json({ allowed: false, reason: '找不到执行回执' })
 await assert.rejects(handlers.get('tool_result')({}), /找不到执行回执/)
 globalThis.fetch = async () => Response.json({ allowed: true })
 await handlers.get('tool_result')({})
} finally {
 globalThis.fetch = oldFetch
 if (oldUrl === undefined) delete process.env.INKSTONE_AUTHORITY_URL; else process.env.INKSTONE_AUTHORITY_URL = oldUrl
 if (oldToken === undefined) delete process.env.INKSTONE_AUTHORITY_TOKEN; else process.env.INKSTONE_AUTHORITY_TOKEN = oldToken
}
const source = await readFile('resources/yan-cli/hub-mcp.mjs', 'utf8')
const snippet = source.slice(source.indexOf('async function handle('), source.indexOf("process.stdin.setEncoding"))
const replies = []
const context = { process: { stdout: { write: text => replies.push(JSON.parse(text)) } }, tools: [], rpc: async () => ({ ok: true }) }
runInNewContext(snippet + '\nglobalThis.handle=handle', context)
for (const input of [null, [], 5, 'wrong']) await context.handle(input)
assert.equal(replies.length, 0)
await context.handle({ id: 1, method: 'ping' })
assert.equal(replies[0].id, 1)
console.log('service-receipt-hub-null: rejected receipt + invalid messages + ping passed (无网络/Hub进程)')
